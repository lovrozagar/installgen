import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { InstallgenConfig, PathContext } from "../src/config/define-config.ts"
import {
	fakeBinary,
	publish,
	startServer,
	type ChecksumStyle,
	type ReleaseOptions,
	type TestServer,
} from "./support/server.ts"
import { runners, shPipeline, type Runner, type RunResult } from "./support/shells.ts"

const SH_RUNNERS = runners().filter((r) => r.kind === "sh")
const HOST = `${process.platform === "darwin" ? "darwin" : "linux"}/${process.arch === "arm64" ? "arm64" : "amd64"}`

const CHECK = "✓"
const ERASE = "\x1b[1A\x1b[2K"

const config = {
	name: "my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies Omit<InstallgenConfig, "baseUrl">
const { checksumsPath: _checksums, ...noChecksums } = config

let server: TestServer
let cases = 0
beforeAll(async () => {
	server = await startServer()
})
afterAll(async () => {
	await server.close()
})

const roots: string[] = []
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true })
})

interface Sandbox {
	root: string
	home: string
	shims: string
}

function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "installgen-sh-"))
	roots.push(root)
	const home = join(root, "home")
	const shims = join(root, "shims")
	mkdirSync(home)
	mkdirSync(shims)
	return { root, home, shims }
}

function shim(box: Sandbox, name: string, body: string): void {
	writeFileSync(join(box.shims, name), `#!/bin/sh\n${body}\n`)
	chmodSync(join(box.shims, name), 0o755)
}

function release(options: Partial<Omit<ReleaseOptions, "prefix">> = {}) {
	return publish(server, { prefix: `/c${++cases}`, config, versions: ["1.2.0", "1.2.3"], ...options })
}

interface InstallOptions {
	args?: string[]
	env?: Record<string, string>
	tty?: boolean
	/** Replace PATH with symlinks to just these tools. */
	only?: readonly string[]
}

function install(runner: Runner, box: Sandbox, url: string, options: InstallOptions = {}): Promise<RunResult> {
	let command = shPipeline(runner, url, options.args)
	if (options.only) {
		const tools = options.only.join(" ")
		command =
			`R="$PWD/restricted"; mkdir -p "$R"; for t in ${tools}; do p=$(command -v "$t") && ln -sf "$p" "$R/$t"; done; ` +
			`PATH="$R"; export PATH; ${command}`
	}
	return runner.run({
		command,
		cwd: box.root,
		tty: options.tty,
		env: { HOME: box.home, PATH: `${box.shims}:${runner.systemPath}`, SHELL: "/bin/sh", ...options.env },
	})
}

const target = (box: Sandbox) => join(box.home, ".my-cli/bin/my-cli")
const output = (r: RunResult) => r.stdout + r.stderr
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")
const plain = (text: string) => text.replaceAll(ANSI, "").replaceAll("\r", "")

function expectInstalled(
	box: Sandbox,
	version: string,
	os = HOST.split("/")[0] as "linux" | "darwin",
	path = target(box),
) {
	expect(readFileSync(path)).toEqual(fakeBinary("my-cli", version, os))
	expect(statSync(path).mode & 0o111).not.toBe(0)
}

/* Every tool the script and the pipeline use, for the restricted-PATH cases */
const TOOLS = [
	"sh",
	"dash",
	"bash",
	"zsh",
	"curl",
	"wget",
	"uname",
	"mkdir",
	"mktemp",
	"rm",
	"mv",
	"cp",
	"chmod",
	"cat",
	"tr",
	"awk",
	"head",
	"basename",
	"dirname",
	"find",
	"grep",
	"sed",
	"printf",
	"gzip",
	"tar",
	"unzip",
	"sha256sum",
	"shasum",
	"openssl",
	"sysctl",
	"id",
	"sort",
	"wc",
	"ls",
	"sleep",
]

describe.each(SH_RUNNERS)("install.sh under $name", async (runner) => {
	describe("formats", () => {
		test.each([
			["tar.gz", "tar.gz", {}],
			["zip", "zip", {}],
			["raw", "", {}],
			["wrapped-folder tar.gz, searched", "tar.gz", { wrap: true }],
			["wrapped-folder zip, searched", "zip", { wrap: true }],
			[
				"tar.gz with binaryInArchive",
				"tar.gz",
				{ binaryInArchive: ({ tag, os, arch }: PathContext) => `my-cli-${tag}-${os}-${arch}/bin/my-cli` },
			],
		])("%s installs", async (_name, ext, extra) => {
			const box = sandbox()
			const { wrap, ...rest } = extra as { wrap?: boolean }
			const rel = release({
				wrap: wrap ?? false,
				config: {
					...config,
					assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}${ext ? `.${ext}` : ""}`,
					...rest,
				},
			})
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, "1.2.3")
			expect(r.stdout).toContain("Installed")
			expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset(HOST, "1.2.3"))
		})
	})

	describe("versions", () => {
		test.each([
			["$1 without v", { args: ["1.2.0"] }, "1.2.0"],
			["$1 with v", { args: ["v1.2.0"] }, "1.2.0"],
			["env without v", { env: { MY_CLI_VERSION: "1.2.0" } }, "1.2.0"],
			["env with v", { env: { MY_CLI_VERSION: "v1.2.0" } }, "1.2.0"],
			["$1 latest", { args: ["latest"] }, "1.2.3"],
			["$1 over env", { args: ["1.2.0"], env: { MY_CLI_VERSION: "1.2.3" } }, "1.2.0"],
			["latest by default", {}, "1.2.3"],
		])("pinning: %s", async (_name, options, version) => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, options)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, version)
			expect(r.stdout).toContain(version)
		})

		test("a baked default version", async () => {
			const box = sandbox()
			const rel = release({ defaultVersion: "v1.2.0" })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, "1.2.0")
		})

		test("a latest file with CRLF and spaces", async () => {
			const box = sandbox()
			const rel = release({ latest: "  v1.2.0\r\n" })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, "1.2.0")
		})

		test.each(["1.2.3; touch pwned", "$(id)", "", "1.2.3/../x"])("an invalid latest %j is rejected", async (latest) => {
			const box = sandbox()
			const rel = release({ latest })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status).not.toBe(0)
			expect(r.stderr).toMatch(/invalid version|could not resolve the latest version/)
			expect(existsSync(target(box))).toBe(false)
			expect(existsSync(join(box.root, "pwned"))).toBe(false)
		})

		test("a version that does not exist fails on the download", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { args: ["9.9.9"] })
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("download failed")
			expect(existsSync(target(box))).toBe(false)
		})
	})

	describe("checksums", () => {
		test.each<ChecksumStyle>(["plain", "star", "upper", "bsd"])(
			"the %s checksums.txt format verifies",
			async (style) => {
				const box = sandbox()
				const rel = release({ checksums: style })
				const r = await install(runner, box, rel.shUrl)
				expect(r.status, output(r)).toBe(0)
				expect(r.stdout).toMatch(/Verified +sha256/)
				expectInstalled(box, "1.2.3")
			},
		)

		test("a per-asset .sha256 file with a single bare hash verifies", async () => {
			const box = sandbox()
			const rel = release({ checksums: "bare", config: { ...config, checksumsPath: ({ asset }) => `${asset}.sha256` } })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toMatch(/Verified +sha256/)
		})

		test("a mismatch fails and leaves nothing installed", async () => {
			const box = sandbox()
			const rel = release({ checksums: "wrong" })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("checksum mismatch")
			expect(existsSync(join(box.home, ".my-cli"))).toBe(false)
		})

		test("an asset missing from checksums.txt fails", async () => {
			const box = sandbox()
			const rel = release()
			const prefix = rel.baseUrl.slice(server.url.length)
			server.set(`${prefix}/v1.2.3/checksums.txt`, "0000  some-other-file.tar.gz\n")
			const r = await install(runner, box, rel.shUrl)
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("no checksum for")
		})

		test("no checksumsPath: a warn row, and the install goes on", async () => {
			const box = sandbox()
			const rel = release({ config: noChecksums })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toMatch(/! Verified +skipped: no checksums published/)
			expectInstalled(box, "1.2.3")
		})
	})

	describe("preflight", () => {
		const shell = runner.shell.split(" ")[0] as string
		test("a missing tar fails with the tool named, before downloading", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { only: [...TOOLS.filter((t) => t !== "tar"), shell, "busybox"] })
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("tar is required")
			expect(server.requested(rel.baseUrl.slice(server.url.length))).not.toContain(rel.asset(HOST, "1.2.3"))
		})

		test("no hashing tool fails when checksums are configured", async () => {
			const box = sandbox()
			const rel = release()
			const hashers = ["sha256sum", "shasum", "openssl"]
			const r = await install(runner, box, rel.shUrl, { only: [...TOOLS.filter((t) => !hashers.includes(t)), shell] })
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("sha256sum, shasum or openssl is required")
		})

		test("no unzip, busybox or bsdtar fails for a zip", async () => {
			const box = sandbox()
			const rel = release({
				config: { ...config, assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}.zip` },
			})
			const r = await install(runner, box, rel.shUrl, { only: [...TOOLS.filter((t) => t !== "unzip"), shell] })
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("unzip is required")
		})
	})

	describe("platforms", () => {
		test("an unsupported platform fails", async () => {
			const box = sandbox()
			shim(box, "uname", 'case "$1" in -m) echo riscv64 ;; *) echo Linux ;; esac')
			const rel = release()
			const r = await install(runner, box, rel.shUrl)
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("unsupported architecture: riscv64")
		})

		test("a platform the release does not ship fails", async () => {
			const box = sandbox()
			shim(box, "uname", 'case "$1" in -m) echo aarch64 ;; *) echo Linux ;; esac')
			const rel = release({ config: { ...config, platforms: ["linux/amd64", "windows/amd64"] } })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain("no my-cli build for linux/arm64")
		})

		test.each(["MINGW64_NT-10.0-19045", "MSYS_NT-10.0", "CYGWIN_NT-10.0"])(
			"%s prints the ps1 one-liner",
			async (uname) => {
				const box = sandbox()
				shim(box, "uname", `case "$1" in -m) echo x86_64 ;; *) echo ${uname} ;; esac`)
				const rel = release()
				const r = await install(runner, box, rel.shUrl)
				expect(r.status).not.toBe(0)
				expect(output(r)).toContain(`powershell -c "irm ${rel.ps1Url} | iex"`)
				expect(existsSync(join(box.home, ".my-cli"))).toBe(false)
			},
		)

		test("darwin arm64 without a native build falls back to amd64 with a Rosetta warning", async () => {
			const box = sandbox()
			shim(box, "uname", 'case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac')
			shim(box, "sysctl", "echo 0")
			shim(box, "xattr", `printf '%s\\n' "$*" >> "${box.root}/xattr.log"`)
			const rel = release({ config: { ...config, platforms: ["darwin/amd64", "linux/amd64"] } })
			const r = await install(runner, box, rel.shUrl, { env: { SHELL: "/bin/bash" } })
			expect(r.status, output(r)).toBe(0)
			expect(output(r)).toContain("Rosetta 2")
			expectInstalled(box, "1.2.3", "darwin")
			expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset("darwin/amd64", "1.2.3"))
			expect(readFileSync(join(box.root, "xattr.log"), "utf8")).toContain(`-d com.apple.quarantine ${target(box)}`)
			expect(readFileSync(join(box.home, ".bash_profile"), "utf8")).toContain('export PATH="$HOME/.my-cli/bin:$PATH"')
		})

		test("an x86_64 shell under Rosetta installs the native arm64 build", async () => {
			const box = sandbox()
			shim(box, "uname", 'case "$1" in -m) echo x86_64 ;; *) echo Darwin ;; esac')
			shim(box, "sysctl", '[ "$2" = sysctl.proc_translated ] && echo 1')
			shim(box, "xattr", "true")
			const rel = release()
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset("darwin/arm64", "1.2.3"))
			expect(r.stdout).toContain("darwin/arm64")
		})
	})

	describe("install and PATH", () => {
		test("a re-run says Updated and leaves one profile line", async () => {
			const box = sandbox()
			const rel = release()
			const env = { SHELL: "/bin/bash" }
			const first = await install(runner, box, rel.shUrl, { env, args: ["1.2.0"] })
			expect(first.status, output(first)).toBe(0)
			expect(first.stdout).toContain("Installed")
			const second = await install(runner, box, rel.shUrl, { env })
			expect(second.status, output(second)).toBe(0)
			expect(second.stdout).toContain("Updated")
			expectInstalled(box, "1.2.3")
			const profile = HOST.startsWith("darwin") ? ".bash_profile" : ".bashrc"
			const lines = readFileSync(join(box.home, profile), "utf8").split("\n")
			expect(lines.filter((l) => l === 'export PATH="$HOME/.my-cli/bin:$PATH"')).toHaveLength(1)
			expect(second.stdout).toContain("rm ~/.my-cli/bin/my-cli")
		})

		test.each([
			["/bin/zsh", {}, ".zshrc", 'export PATH="$HOME/.my-cli/bin:$PATH"'],
			["/usr/bin/zsh", { ZDOTDIR: "ZDOT" }, "ZDOT/.zshrc", 'export PATH="$HOME/.my-cli/bin:$PATH"'],
			["/bin/sh", {}, ".profile", 'export PATH="$HOME/.my-cli/bin:$PATH"'],
			["/usr/bin/fish", {}, ".config/fish/conf.d/my-cli.fish", 'fish_add_path "$HOME/.my-cli/bin"'],
			["/usr/bin/fish", { XDG_CONFIG_HOME: "XDG" }, "XDG/fish/conf.d/my-cli.fish", 'fish_add_path "$HOME/.my-cli/bin"'],
		])("SHELL=%s %j writes %s", async (shellPath, extra, profile, line) => {
			const box = sandbox()
			const rel = release()
			const env: Record<string, string> = { SHELL: shellPath }
			for (const [k, v] of Object.entries(extra)) env[k] = join(box.home, v)
			const r = await install(runner, box, rel.shUrl, { env })
			expect(r.status, output(r)).toBe(0)
			expect(readFileSync(join(box.home, profile), "utf8")).toContain(line)
		})

		test("NO_MODIFY_PATH is honored", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_NO_MODIFY_PATH: "1", SHELL: "/bin/bash" } })
			expect(r.status, output(r)).toBe(0)
			expect(existsSync(join(box.home, ".bashrc"))).toBe(false)
			expect(existsSync(join(box.home, ".bash_profile"))).toBe(false)
			expect(r.stdout).toMatch(/PATH +not changed/)
		})

		test("modifyPath: false is honored", async () => {
			const box = sandbox()
			const rel = release({ config: { ...config, modifyPath: false } })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expect(existsSync(join(box.home, ".profile"))).toBe(false)
		})

		test("an install dir already on PATH is left alone", async () => {
			const box = sandbox()
			const rel = release()
			const dir = join(box.home, ".my-cli/bin")
			const r = await install(runner, box, rel.shUrl, { env: { PATH: `${dir}:${box.shims}:${runner.systemPath}` } })
			expect(r.status, output(r)).toBe(0)
			expect(existsSync(join(box.home, ".profile"))).toBe(false)
			expect(r.stdout).toMatch(/PATH +already set/)
		})

		test("MY_CLI_INSTALL_DIR overrides the install dir", async () => {
			const box = sandbox()
			const rel = release()
			const dir = join(box.root, "custom bin")
			const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_INSTALL_DIR: dir } })
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, "1.2.3", undefined, join(dir, "my-cli"))
			expect(readFileSync(join(box.home, ".profile"), "utf8")).toContain(`export PATH="${dir}:$PATH"`)
		})

		test("$GITHUB_PATH gets the install dir appended", async () => {
			const box = sandbox()
			const rel = release()
			const ghPath = join(box.root, "github_path")
			writeFileSync(ghPath, "/existing\n")
			const r = await install(runner, box, rel.shUrl, { env: { GITHUB_PATH: ghPath } })
			expect(r.status, output(r)).toBe(0)
			expect(readFileSync(ghPath, "utf8")).toBe(`/existing\n${join(box.home, ".my-cli/bin")}\n`)
		})

		test("another copy first on PATH gets a shadowing warning", async () => {
			const box = sandbox()
			shim(box, "my-cli", "echo old")
			const rel = release()
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expect(output(r)).toContain(`${join(box.shims, "my-cli")} comes first on PATH`)
		})

		test("the message and the uninstall hint close the run", async () => {
			const box = sandbox()
			const rel = release({ config: { ...config, message: "Run 'my-cli --help' to start." } })
			const r = await install(runner, box, rel.shUrl)
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toContain("Run 'my-cli --help' to start.")
			expect(r.stdout).toContain("To uninstall: rm ~/.my-cli/bin/my-cli")
			expect(r.stdout).toContain(`export PATH="$HOME/.my-cli/bin:$PATH"`)
		})
	})

	describe("output", () => {
		test("non-TTY output has no ESC bytes and no progress bar", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { env: { LANG: "C.UTF-8" } })
			expect(r.status, output(r)).toBe(0)
			expect(output(r)).not.toContain("\x1b")
			expect(r.stderr).not.toContain("#")
			for (const row of ["Detected", "Version", "Download", "Verified", "Installed", "PATH"]) {
				expect(r.stdout).toMatch(new RegExp(`^${CHECK} ${row} `, "m"))
			}
		})

		test.runIf(runner.tty)("a UTF-8 TTY gets check rows, color, and the bar erased", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { tty: true, env: { LANG: "C.UTF-8" } })
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toContain(`${CHECK}`)
			expect(r.stdout).toContain("\x1b[32m")
			expect(r.stdout).toContain(ERASE)
		})

		test.runIf(runner.tty)("a C locale TTY uses ASCII glyphs", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { tty: true, env: { LANG: "C", LC_ALL: "C" } })
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).not.toContain(CHECK)
			expect(plain(r.stdout)).toMatch(/^\+ Detected +/m)
		})

		test.runIf(runner.tty)("NO_COLOR on a TTY: no color, no bar", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.shUrl, { tty: true, env: { LANG: "C.UTF-8", NO_COLOR: "1" } })
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).not.toContain("\x1b[")
			expect(r.stdout).toContain(CHECK)
		})
	})
})
