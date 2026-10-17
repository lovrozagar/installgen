import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { publish, startServer, type TestServer } from "../tests/support/server.ts"
import { run, start, type Io } from "./cli.ts"
import type { InstallgenConfig } from "./config/define-config.ts"
import { resolveConfig } from "./config/resolve.ts"
import { render } from "./render/render.ts"

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
const VERSION = (JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version
const NODE = { runtime: "node", nodeVersion: "26.0.0" } as const

const dirs: string[] = []
function sandbox(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "installgen-cli-"))
	dirs.push(dir)
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), content)
	}
	return dir
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Captured {
	io: Io
	out: () => string
	err: () => string
}

function capture(cwd: string, options: { isTTY?: boolean; env?: Record<string, string> } = {}): Captured {
	const out: string[] = []
	const err: string[] = []
	return {
		io: {
			cwd,
			env: options.env ?? {},
			stdout: (t) => void out.push(t),
			stderr: (t) => void err.push(t),
			isTTY: options.isTTY ?? false,
			runtime: NODE,
		},
		out: () => out.join(""),
		err: () => err.join(""),
	}
}

async function cli(argv: string[], cwd: string, options: { isTTY?: boolean; env?: Record<string, string> } = {}) {
	const c = capture(cwd, options)
	const code = await run(argv, c.io)
	return { code, out: c.out(), err: c.err() }
}

/* A plain .mjs config: it needs no package import, so it loads in-process (tests/bin.test.ts covers the hook) */
const configSource = (baseUrl: string, extra = "") => `export default {
	name: "my-cli",
	baseUrl: ${JSON.stringify(baseUrl)},
	assetPath: ({ tag, version, os, arch }) => \`\${tag}/my-cli_\${version}_\${os}_\${arch}\${os === "windows" ? ".zip" : ".tar.gz"}\`,
	checksumsPath: ({ tag }) => \`\${tag}/checksums.txt\`,
	${extra}
}
`
/* the same config as an object, for publish() and expected renders */
const config = {
	name: "my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies Omit<InstallgenConfig, "baseUrl">

describe("usage", () => {
	test.each([["--help"], ["-h"]])("%s prints usage and exits 0", async (flag) => {
		const r = await cli([flag], sandbox())
		expect(r.code).toBe(0)
		expect(r.out).toContain("Usage: installgen <command>")
		for (const cmd of ["init", "build", "check"]) expect(r.out).toContain(`  ${cmd} `)
	})

	test.each(["init", "build", "check"])("%s --help prints the command's usage", async (cmd) => {
		const r = await cli([cmd, "--help"], sandbox())
		expect(r.code).toBe(0)
		expect(r.out).toContain(`Usage: installgen ${cmd}`)
	})

	test("--version prints the package version", async () => {
		const r = await cli(["--version"], sandbox())
		expect(r.code).toBe(0)
		expect(r.out).toBe(`${VERSION}\n`)
	})

	test("no command prints the usage to stderr: exit 2", async () => {
		const r = await cli([], sandbox())
		expect(r.code).toBe(2)
		expect(r.out).toBe("")
		expect(r.err).toContain("Usage: installgen <command>")
	})

	test.each([
		[["frob"], /unknown command "frob"/],
		[["build", "--nope"], /Unknown option '--nope'/],
		[["build", "-c"], /Option '-c, --config <value>' argument missing/],
		[["build", "extra"], /Unexpected argument 'extra'/],
		[["init", "--preset", "nope"], /unknown preset "nope"; use raw, goreleaser or github/],
		[["--bogus"], /unknown command "--bogus"/],
	])("%j is a usage error: exit 2", async (argv, message) => {
		const r = await cli(argv, sandbox())
		expect(r.code).toBe(2)
		expect(r.err).toMatch(message)
		expect(r.err).toContain("installgen --help")
	})
})

const example = (preset: string) => readFileSync(join(PACKAGE_DIR, "examples", `${preset}.config.ts`), "utf8")

describe("init", () => {
	test("writes the raw preset as .mts where no package.json says type module", async () => {
		const dir = sandbox()
		const r = await cli(["init"], dir)
		expect(r.code, r.err).toBe(0)
		expect(readFileSync(join(dir, "installgen.config.mts"), "utf8")).toBe(example("raw"))
		expect(r.out).toContain("installgen.config.mts")
		expect(r.out).toContain("installgen build")
	})

	test.each(["raw", "goreleaser", "github"])("--preset %s writes that example", async (preset) => {
		const dir = sandbox({ "package.json": '{ "type": "module" }\n' })
		const r = await cli(["init", "--preset", preset], dir)
		expect(r.code, r.err).toBe(0)
		expect(readFileSync(join(dir, "installgen.config.ts"), "utf8")).toBe(example(preset))
	})

	test.each([
		['{ "type": "commonjs" }', "installgen.config.mts"],
		['{ "name": "x" }', "installgen.config.mts"],
		['{ "type": "module" }', "installgen.config.ts"],
	])("package.json %s gets %s", async (pkg, file) => {
		const dir = sandbox({ "package.json": pkg })
		const r = await cli(["init"], dir)
		expect(r.code, r.err).toBe(0)
		expect(statSync(join(dir, file)).isFile()).toBe(true)
	})

	test("the nearest package.json counts, found from a subdirectory", async () => {
		const dir = sandbox({ "package.json": '{ "type": "module" }\n', "tools/.keep": "" })
		const r = await cli(["init"], join(dir, "tools"))
		expect(r.code, r.err).toBe(0)
		expect(statSync(join(dir, "tools", "installgen.config.ts")).isFile()).toBe(true)
	})

	test("a package.json that is not JSON counts as no type module", async () => {
		const dir = sandbox({ "package.json": "{ not json" })
		const r = await cli(["init"], dir)
		expect(r.code, r.err).toBe(0)
		expect(statSync(join(dir, "installgen.config.mts")).isFile()).toBe(true)
	})

	test("refuses to overwrite any existing config without --force", async () => {
		const dir = sandbox({ "installgen.config.mjs": "export default {}\n" })
		const r = await cli(["init"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toMatch(/installgen\.config\.mjs already exists; pass --force to overwrite/)
		expect(readFileSync(join(dir, "installgen.config.mjs"), "utf8")).toBe("export default {}\n")
	})

	test("--force overwrites", async () => {
		const dir = sandbox({ "installgen.config.mts": "old\n" })
		const r = await cli(["init", "--force", "--preset", "github"], dir)
		expect(r.code, r.err).toBe(0)
		expect(readFileSync(join(dir, "installgen.config.mts"), "utf8")).toBe(example("github"))
	})
})

describe("build", () => {
	test("writes installers/install.sh (0755) and install.ps1 (0644), and prints both paths", async () => {
		const dir = sandbox({ "installgen.config.mjs": configSource("https://dl.example.com/my-cli") })
		const r = await cli(["build"], dir)
		expect(r.code, r.err).toBe(0)
		const expected = render(resolveConfig({ ...config, baseUrl: "https://dl.example.com/my-cli" }), {})
		expect(readFileSync(join(dir, "installers/install.sh"), "utf8")).toBe(expected.sh)
		expect(readFileSync(join(dir, "installers/install.ps1"), "utf8")).toBe(expected.ps1)
		expect(statSync(join(dir, "installers/install.sh")).mode & 0o777).toBe(0o755)
		expect(statSync(join(dir, "installers/install.ps1")).mode & 0o777).toBe(0o644)
		expect(r.out).toContain(join("installers", "install.sh"))
		expect(r.out).toContain(join("installers", "install.ps1"))
		expect(r.err).not.toContain("warning")
	})

	test("--out, -c and --default-version", async () => {
		const dir = sandbox({ "conf/release.mjs": configSource("https://dl.example.com/my-cli") })
		const r = await cli(["build", "-c", "conf/release.mjs", "--out", "public/get", "--default-version", "v1.2.3"], dir)
		expect(r.code, r.err).toBe(0)
		expect(readFileSync(join(dir, "public/get/install.sh"), "utf8")).toContain("default_version='v1.2.3'")
		expect(readFileSync(join(dir, "public/get/install.ps1"), "utf8")).toContain("$defaultVersion = 'v1.2.3'")
	})

	test("the config's outDir", async () => {
		const dir = sandbox({
			"installgen.config.mjs": configSource("https://dl.example.com/my-cli", 'outDir: "dist-installers",'),
		})
		const r = await cli(["build"], dir)
		expect(r.code, r.err).toBe(0)
		expect(statSync(join(dir, "dist-installers/install.sh")).isFile()).toBe(true)
	})

	test("an invalid --default-version is an error", async () => {
		const dir = sandbox({ "installgen.config.mjs": configSource("https://dl.example.com/my-cli") })
		const r = await cli(["build", "--default-version", "1.2.3;x"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toMatch(/error: the default version must match/)
	})

	test("no checksumsPath: the build warns", async () => {
		const dir = sandbox({
			"installgen.config.mjs": `export default { name: "my-cli", baseUrl: "https://dl.example.com", assetPath: ({ version, os, arch }) => \`\${version}/\${os}-\${arch}\` }\n`,
		})
		const r = await cli(["build"], dir)
		expect(r.code, r.err).toBe(0)
		expect(r.err).toMatch(/warning: no checksumsPath; the installers will not verify downloads/)
	})

	test("a Windows-only config writes only install.ps1 and says why", async () => {
		const dir = sandbox({
			"installgen.config.mjs": configSource("https://dl.example.com/my-cli", 'platforms: ["windows/amd64"],'),
		})
		const r = await cli(["build"], dir)
		expect(r.code, r.err).toBe(0)
		expect(statSync(join(dir, "installers/install.ps1")).isFile()).toBe(true)
		expect(() => statSync(join(dir, "installers/install.sh"))).toThrow()
		expect(r.out).toMatch(/install\.sh skipped: no linux or darwin platforms/)
	})

	test("a Unix-only config writes only install.sh", async () => {
		const dir = sandbox({
			"installgen.config.mjs": configSource("https://dl.example.com/my-cli", 'platforms: ["linux/amd64"],'),
		})
		const r = await cli(["build"], dir)
		expect(r.code, r.err).toBe(0)
		expect(r.out).toMatch(/install\.ps1 skipped: no windows platforms/)
	})

	test("no config is an error", async () => {
		const r = await cli(["build"], sandbox())
		expect(r.code).toBe(1)
		expect(r.err).toMatch(/error: no installgen\.config\.\{ts,mts,js,mjs\} in/)
	})

	test("a config error is reported without a stack", async () => {
		const dir = sandbox({ "installgen.config.mjs": 'export default { name: "bad name" }\n' })
		const r = await cli(["build"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toBe('error: config.name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$, got "bad name"\n')
	})

	test("a filesystem error is reported too", async () => {
		const dir = sandbox({ "installgen.config.mjs": configSource("https://dl.example.com/my-cli"), blocker: "a file" })
		const r = await cli(["build", "--out", "blocker/sub"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toMatch(/^error: .*(ENOTDIR|EEXIST)/)
	})
})

describe("check", () => {
	let server: TestServer
	let n = 0
	beforeAll(async () => {
		server = await startServer()
	})
	afterAll(async () => {
		await server.close()
	})

	function released(options: { noHead?: boolean } = {}) {
		const prefix = `/check${++n}`
		const rel = publish(server, { prefix, config, versions: ["1.2.3"] })
		if (options.noHead) {
			for (const p of rel.resolved.platforms) {
				const path = `${prefix}/${rel.asset(p.platform, "1.2.3")}`
				const served = server.get(path)
				if (served) server.set(path, { ...served, noHead: true })
			}
		}
		const dir = sandbox({ "installgen.config.mjs": configSource(rel.baseUrl) })
		return { rel, prefix, dir }
	}
	const requests = (prefix: string) => server.log.filter((r) => r.path.startsWith(`${prefix}/`))

	test("passes when every asset and checksum entry exists, resolving latest, with HEAD", async () => {
		const { prefix, dir } = released()
		const r = await cli(["check"], dir)
		expect(r.code, r.out + r.err).toBe(0)
		expect(r.out).toMatch(/latest +1\.2\.3/)
		for (const p of ["linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64", "windows/amd64", "windows/arm64"]) {
			expect(r.out).toMatch(new RegExp(`\\+ ${p} +.*my-cli_1\\.2\\.3_`))
		}
		expect(r.out).toContain("all 6 platforms ok")
		const assetRequests = requests(prefix).filter((q) => q.path.includes("my-cli_1.2.3_"))
		expect(assetRequests.every((q) => q.method === "HEAD")).toBe(true)
		expect(assetRequests).toHaveLength(6)
	})

	test("--default-version skips latest", async () => {
		const { prefix, dir } = released()
		const r = await cli(["check", "--default-version", "v1.2.3"], dir)
		expect(r.code, r.out + r.err).toBe(0)
		expect(requests(prefix).some((q) => q.path.endsWith("/latest"))).toBe(false)
	})

	test("a host without HEAD gets a ranged GET", async () => {
		const { prefix, dir } = released({ noHead: true })
		const r = await cli(["check"], dir)
		expect(r.code, r.out + r.err).toBe(0)
		const ranged = requests(prefix).filter((q) => q.method === "GET" && q.range === "bytes=0-0")
		expect(ranged).toHaveLength(6)
	})

	test("a missing asset and a missing checksum entry are each listed, and it fails", async () => {
		const { rel, prefix, dir } = released()
		server.remove(`${prefix}/${rel.asset("darwin/arm64", "1.2.3")}`)
		const sums = String(server.get(`${prefix}/v1.2.3/checksums.txt`)?.body)
		const file = rel.asset("windows/amd64", "1.2.3").split("/").at(-1) as string
		server.set(
			`${prefix}/v1.2.3/checksums.txt`,
			sums
				.split("\n")
				.filter((l) => !l.endsWith(file))
				.join("\n"),
		)
		const r = await cli(["check"], dir)
		expect(r.code).toBe(1)
		expect(r.out).toMatch(/x darwin\/arm64 +missing .*my-cli_1\.2\.3_darwin_arm64\.tar\.gz \(404\)/)
		expect(r.out).toMatch(
			new RegExp(`x windows/amd64 +no checksum for ${file.replaceAll(".", "\\.")} in .*checksums\\.txt`),
		)
		expect(r.out).toContain("2 problems")
	})

	test("a missing checksums file is listed for every platform that uses it", async () => {
		const { prefix, dir } = released()
		server.remove(`${prefix}/v1.2.3/checksums.txt`)
		const r = await cli(["check"], dir)
		expect(r.code).toBe(1)
		expect(r.out).toMatch(/x linux\/amd64 +missing .*checksums\.txt \(404\)/)
		expect(r.out).toContain("6 problems")
	})

	test.each([
		["unreachable", undefined, /could not read the latest version from .*latest \(404\)/],
		["invalid", "1.2.3; rm -rf /\n", /invalid latest version "1\.2\.3;rm-rf\/"/],
	])("an %s latest is an error", async (_name, latest, message) => {
		const { prefix, dir } = released()
		if (latest === undefined) server.remove(`${prefix}/latest`)
		else server.set(`${prefix}/latest`, latest)
		const r = await cli(["check"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toMatch(message)
	})

	test("an unreachable host is reported as a problem", async () => {
		const dir = sandbox({ "installgen.config.mjs": configSource("http://127.0.0.1:9", 'platforms: ["linux/amd64"],') })
		const r = await cli(["check", "--default-version", "1.2.3"], dir)
		expect(r.code).toBe(1)
		expect(r.out).toMatch(/x linux\/amd64 +unreachable /)
	})

	test("one problem is singular", async () => {
		const { rel, prefix, dir } = released()
		server.remove(`${prefix}/${rel.asset("linux/arm64", "1.2.3")}`)
		const r = await cli(["check"], dir)
		expect(r.code).toBe(1)
		expect(r.out).toMatch(/^1 problem$/m)
	})

	test("an unreachable latest is an error", async () => {
		const dir = sandbox({ "installgen.config.mjs": configSource("http://127.0.0.1:9", 'platforms: ["linux/amd64"],') })
		const r = await cli(["check"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toMatch(/could not read the latest version from http:\/\/127\.0\.0\.1:9\/latest: fetch failed: /)
	})

	test("an invalid --default-version is an error", async () => {
		const { dir } = released()
		const r = await cli(["check", "--default-version", "1.2.3;x"], dir)
		expect(r.code).toBe(1)
		expect(r.err).toMatch(/invalid default version "1\.2\.3;x"/)
	})

	test("an empty tagPrefix: v-less versions", async () => {
		const prefix = `/check${++n}`
		const rel = publish(server, { prefix, config: { ...config, tagPrefix: "" }, versions: ["2.0.0"] })
		const dir = sandbox({ "installgen.config.mjs": configSource(rel.baseUrl, 'tagPrefix: "",') })
		const r = await cli(["check"], dir)
		expect(r.code, r.out + r.err).toBe(0)
		expect(r.out).toContain("2.0.0/my-cli_2.0.0_linux_amd64.tar.gz")
	})

	test("a fetch error without a cause is still named", async () => {
		const { dir } = released()
		const c = capture(dir)
		const code = await run(["check", "--default-version", "1.2.3"], {
			...c.io,
			fetch: async () => {
				throw new Error("boom")
			},
		})
		expect(code).toBe(1)
		expect(c.out()).toMatch(/x linux\/amd64 +unreachable .*: boom/)
	})

	test("--list prints every URL without a request, with placeholders", async () => {
		const { prefix, dir, rel } = released()
		const before = requests(prefix).length
		const r = await cli(["check", "--list"], dir)
		expect(r.code, r.err).toBe(0)
		expect(requests(prefix)).toHaveLength(before)
		expect(r.out).toContain(`latest ${rel.baseUrl}/latest`)
		expect(r.out).toContain(`linux/amd64 ${rel.baseUrl}/{tag}/my-cli_{version}_linux_amd64.tar.gz`)
		expect(r.out).toContain(`linux/amd64 ${rel.baseUrl}/{tag}/checksums.txt`)
	})

	test("--list with --default-version fills the version in", async () => {
		const { dir, rel } = released()
		const r = await cli(["check", "--list", "--default-version", "1.2.3"], dir)
		expect(r.code, r.err).toBe(0)
		expect(r.out).toContain(`windows/arm64 ${rel.baseUrl}/v1.2.3/my-cli_1.2.3_windows_arm64.zip`)
	})

	test("no checksumsPath: check warns and still checks the assets", async () => {
		const prefix = `/check${++n}`
		const { checksumsPath: _c, ...noSums } = config
		const rel = publish(server, { prefix, config: noSums, versions: ["1.2.3"] })
		const dir = sandbox({
			"installgen.config.mjs": `export default { name: "my-cli", baseUrl: ${JSON.stringify(rel.baseUrl)}, assetPath: ({ tag, version, os, arch }) => \`\${tag}/my-cli_\${version}_\${os}_\${arch}\${os === "windows" ? ".zip" : ".tar.gz"}\` }\n`,
		})
		const r = await cli(["check"], dir)
		expect(r.code, r.out + r.err).toBe(0)
		expect(r.err).toContain("warning: no checksumsPath")
		const listed = await cli(["check", "--list"], dir)
		expect(listed.out.trim().split("\n")).toHaveLength(7)
		expect(listed.out).not.toContain("checksums")
	})
})

const build = (options: { isTTY: boolean; env?: Record<string, string> }) =>
	cli(["build"], sandbox({ "installgen.config.mjs": configSource("https://dl.example.com/my-cli") }), options)

describe("terminal output", () => {
	test("a TTY gets check marks and color", async () => {
		const r = await build({ isTTY: true })
		expect(r.out).toContain("✓")
		expect(r.out).toContain("\x1b[32m")
	})

	test("NO_COLOR keeps the marks, drops the color", async () => {
		const r = await build({ isTTY: true, env: { NO_COLOR: "1" } })
		expect(r.out).toContain("✓")
		expect(r.out).not.toContain("\x1b[")
	})

	test("a pipe gets plain text", async () => {
		const r = await build({ isTTY: false })
		expect(r.out).not.toContain("✓")
		expect(r.out).not.toContain("\x1b[")
		expect(r.out).toMatch(/^\+ wrote /m)
	})

	test("errors on a TTY are red, with a cross", async () => {
		const r = await cli(["build"], sandbox(), { isTTY: true })
		expect(r.err).toContain("\x1b[31m")
		expect(r.err).toContain("✗")
	})
})

describe("start", () => {
	test("runs against the real process and sets the exit code", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const before = process.exitCode
		try {
			await start(["--version"])
			expect(write).toHaveBeenCalledWith(`${VERSION}\n`)
			expect(process.exitCode).toBe(0)
		} finally {
			write.mockRestore()
			process.exitCode = before
		}
	})

	test("usage errors go to stderr with exit code 2", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const before = process.exitCode
		try {
			await start(["frob"])
			expect(process.exitCode).toBe(2)
		} finally {
			write.mockRestore()
			process.exitCode = before
		}
	})
})
