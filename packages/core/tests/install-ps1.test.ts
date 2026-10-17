import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { InstallgenConfig } from "../src/config/define-config.ts"
import { fakeBinary, publish, startServer, type ReleaseOptions, type TestServer } from "./support/server.ts"
import { runners, type Runner, type RunResult } from "./support/shells.ts"

const PS_RUNNERS = runners().filter((r) => r.kind === "ps1")
const WIN = process.platform === "win32"
/* Windows reads the arch from the registry; other hosts are the pwsh test seam and install the Windows build too */
const ARCH = process.arch === "arm64" ? "arm64" : "amd64"

const config = {
	name: "my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies Omit<InstallgenConfig, "baseUrl">

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
}

function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "installgen-ps1-"))
	roots.push(root)
	const home = join(root, "home")
	mkdirSync(home)
	return { root, home }
}

function release(options: Partial<Omit<ReleaseOptions, "prefix">> = {}) {
	return publish(server, { prefix: `/p${++cases}`, config, versions: ["1.2.0", "1.2.3"], ...options })
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`

interface InstallOptions {
	/** `-Version` through `iex "& {$(irm …)} -Version X"`. */
	version?: string
	env?: Record<string, string>
	/** PowerShell run after the install, in the same session. */
	after?: string
	/** Let the script edit PATH. On Windows that is the registry, so it is off unless a test asks (and restores it). */
	modify?: boolean
}

function install(runner: Runner, box: Sandbox, url: string, options: InstallOptions = {}): Promise<RunResult> {
	const run =
		options.version === undefined ? `irm ${q(url)} | iex` : `iex "& {$(irm ${q(url)})} -Version ${options.version}"`
	const command = options.after === undefined ? run : `${run}; ${options.after}`
	/* USERPROFILE is what GetFolderPath('UserProfile') reads on Windows; HOME on the other hosts */
	return runner.run({
		command,
		cwd: box.root,
		env: {
			HOME: box.home,
			USERPROFILE: box.home,
			PATH: runner.systemPath,
			...(WIN ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: box.root, TMP: box.root } : {}),
			...(WIN && !options.modify ? { MY_CLI_NO_MODIFY_PATH: "1" } : {}),
			...options.env,
		},
	})
}

const userPath = async (r: Runner) =>
	(
		await r.run({
			command:
				"[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
			cwd: tmpdir(),
			env: { PATH: r.systemPath, SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
		})
	).stdout.trim()

/** Runs `fn` and puts the registry user PATH back afterwards (Windows); elsewhere just runs it. */
async function keepingUserPath(runner: Runner, fn: () => Promise<void>): Promise<void> {
	if (!WIN) return fn()
	const env = { PATH: runner.systemPath, SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
	const read =
		"[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')"
	const before = (await runner.run({ command: read, cwd: tmpdir(), env })).stdout.trim()
	try {
		await fn()
	} finally {
		await runner.run({
			command: `[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue('Path', ${q(before)}, 'ExpandString')`,
			cwd: tmpdir(),
			env,
		})
	}
}

const target = (box: Sandbox) => join(box.home, ".my-cli", "bin", "my-cli.exe")
const output = (r: RunResult) => r.stdout + r.stderr

function expectInstalled(box: Sandbox, version: string) {
	expect(readFileSync(target(box))).toEqual(fakeBinary("my-cli", version, "windows"))
}

/* the runners come from the environment; say so rather than report an empty file */
if (PS_RUNNERS.length === 0) {
	test.skip("install.ps1: no PowerShell runner (INSTALLGEN_E2E_SHELLS=pwsh or INSTALLGEN_E2E_DOCKER=1)", () => {})
}

describe.each(PS_RUNNERS)("install.ps1 under $name", (runner) => {
	describe("formats", () => {
		test.each([
			["zip", "zip", false],
			["tar.gz", "tar.gz", false],
			["raw .exe", "exe", false],
			["wrapped-folder zip, searched", "zip", true],
		])("%s installs", async (_name, ext, wrap) => {
			const box = sandbox()
			const rel = release({
				wrap,
				config: {
					...config,
					assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}.${ext}`,
				},
			})
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, "1.2.3")
			expect(r.stdout).toContain("Installed")
			expect(r.stdout).toMatch(/Verified +sha256/)
			expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset(`windows/${ARCH}`, "1.2.3"))
		})

		test("two files named like the binary fail, asking for binaryInArchive", async () => {
			const box = sandbox()
			const rel = release({ wrap: true, extra: [{ name: "bin/" }, { name: "bin/my-cli.exe", data: "MZ stray" }] })
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status).not.toBe(0)
			expect(output(r)).toContain("holds 2 files named my-cli.exe; set binaryInArchive")
			expect(existsSync(target(box))).toBe(false)
		})
	})

	describe("versions", () => {
		test.each([
			["-Version without v", { version: "1.2.0" }, "1.2.0"],
			["-Version with v", { version: "v1.2.0" }, "1.2.0"],
			["env without v", { env: { MY_CLI_VERSION: "1.2.0" } }, "1.2.0"],
			["env with v", { env: { MY_CLI_VERSION: "v1.2.0" } }, "1.2.0"],
			["-Version over env", { version: "1.2.0", env: { MY_CLI_VERSION: "1.2.3" } }, "1.2.0"],
			["latest by default", {}, "1.2.3"],
		])("pinning: %s", async (_name, options, version) => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.ps1Url, options)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, version)
			expect(r.stdout).toContain(version)
		})

		test("a latest file with CRLF", async () => {
			const box = sandbox()
			const rel = release({ latest: "v1.2.0\r\n" })
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status, output(r)).toBe(0)
			expectInstalled(box, "1.2.0")
		})

		test("an invalid latest is rejected", async () => {
			const box = sandbox()
			const rel = release({ latest: "1.2.3; Remove-Item x" })
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status).not.toBe(0)
			expect(output(r)).toContain("invalid version")
			expect(existsSync(target(box))).toBe(false)
		})
	})

	describe("failures keep the session", () => {
		test("a checksum mismatch fails without closing the session; a later command still runs", async () => {
			const box = sandbox()
			const rel = release({ checksums: "wrong" })
			const r = await install(runner, box, rel.ps1Url, {
				after: "Write-Output 'still here'",
			})
			const caught = await runner.run({
				command: `try { irm ${q(rel.ps1Url)} | iex } catch { Write-Output "caught: $($_.Exception.Message)" }; Write-Output 'still here'`,
				cwd: box.root,
				env: { HOME: box.home, USERPROFILE: box.home, PATH: runner.systemPath },
			})
			expect(r.status).not.toBe(0)
			expect(output(r)).toContain("checksum mismatch")
			expect(caught.status, output(caught)).toBe(0)
			expect(caught.stdout).toMatch(/caught: .*checksum mismatch/)
			expect(caught.stdout).toContain("still here")
			expect(existsSync(target(box))).toBe(false)
		})

		test("the script never calls exit", () => {
			const rel = release()
			expect(rel.ps1).not.toMatch(/\bexit\b/i)
		})
	})

	describe("install", () => {
		test("a re-run says Updated", async () => {
			const box = sandbox()
			const rel = release()
			const first = await install(runner, box, rel.ps1Url, { version: "1.2.0" })
			expect(first.status, output(first)).toBe(0)
			expect(first.stdout).toContain("Installed")
			const second = await install(runner, box, rel.ps1Url)
			expect(second.status, output(second)).toBe(0)
			expect(second.stdout).toContain("Updated")
			expectInstalled(box, "1.2.3")
			expect(readdirSync(join(box.home, ".my-cli", "bin"))).toEqual(["my-cli.exe"])
		})

		test("MY_CLI_INSTALL_DIR overrides the install dir", async () => {
			const box = sandbox()
			const rel = release()
			const dir = join(box.root, "custom bin")
			const r = await install(runner, box, rel.ps1Url, { env: { MY_CLI_INSTALL_DIR: dir } })
			expect(r.status, output(r)).toBe(0)
			expect(readFileSync(join(dir, "my-cli.exe"))).toEqual(fakeBinary("my-cli", "1.2.3", "windows"))
		})

		test("no checksumsPath: a warn row, and the install goes on", async () => {
			const box = sandbox()
			const { checksumsPath: _checksums, ...noChecksums } = config
			const rel = release({ config: noChecksums })
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toMatch(/! Verified +skipped: no checksums published/)
			expectInstalled(box, "1.2.3")
		})

		test("the message and the uninstall hint close the run", async () => {
			const box = sandbox()
			const rel = release({ config: { ...config, message: "Run 'my-cli --help' to start." } })
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toContain("Run 'my-cli --help' to start.")
			expect(r.stdout).toMatch(/To uninstall: Remove-Item .*my-cli\.exe/)
		})

		test("$GITHUB_PATH gets the install dir appended", async () => {
			await keepingUserPath(runner, async () => {
				const box = sandbox()
				const rel = release()
				const ghPath = join(box.root, "github_path")
				writeFileSync(ghPath, "")
				const r = await install(runner, box, rel.ps1Url, { modify: true, env: { GITHUB_PATH: ghPath } })
				expect(r.status, output(r)).toBe(0)
				expect(readFileSync(ghPath, "utf8").trim()).toBe(join(box.home, ".my-cli", "bin"))
			})
		})

		test("NO_MODIFY_PATH is honored", async () => {
			const box = sandbox()
			const rel = release()
			const ghPath = join(box.root, "github_path")
			writeFileSync(ghPath, "")
			const r = await install(runner, box, rel.ps1Url, { env: { GITHUB_PATH: ghPath, MY_CLI_NO_MODIFY_PATH: "1" } })
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toMatch(/PATH +not changed/)
			expect(readFileSync(ghPath, "utf8")).toBe("")
		})
	})

	describe("output", () => {
		test("non-TTY output is plain", async () => {
			const box = sandbox()
			const rel = release()
			const r = await install(runner, box, rel.ps1Url)
			expect(r.status, output(r)).toBe(0)
			expect(output(r)).not.toContain("\x1b")
			expect(output(r)).not.toContain("\u2713")
			for (const row of ["Detected", "Version", "Download", "Verified", "Installed", "PATH"]) {
				expect(r.stdout).toMatch(new RegExp(`^[+!] ${row} `, "m"))
			}
		})
	})

	test.runIf(runner.tty)("a TTY run draws the progress bar and colored rows", async () => {
		const box = sandbox()
		const rel = release()
		const r = await runner.run({
			command: `irm ${q(rel.ps1Url)} | iex`,
			cwd: box.root,
			tty: true,
			env: { HOME: box.home, USERPROFILE: box.home, PATH: runner.systemPath, TERM_PROGRAM: "test" },
		})
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/\[#+ *\] +\d+%/)
		expect(r.stdout).toContain("\u2713")
		expect(r.stdout).toContain("\x1b[")
		expectInstalled(box, "1.2.3")
	})

	describe.runIf(WIN)("Windows only", () => {
		test("the user PATH in the registry gets the install dir once, and the session PATH too", async () => {
			await keepingUserPath(runner, async () => {
				const box = sandbox()
				const rel = release()
				const dir = join(box.home, ".my-cli", "bin")
				const r = await install(runner, box, rel.ps1Url, { modify: true, after: 'Write-Output "session: $env:PATH"' })
				expect(r.status, output(r)).toBe(0)
				expect(r.stdout).toContain(`session: ${dir}`)
				await install(runner, box, rel.ps1Url, { modify: true })
				const entries = (await userPath(runner)).split(";")
				expect(entries.filter((e) => e.toLowerCase() === dir.toLowerCase())).toHaveLength(1)
			})
		})

		test.runIf(process.arch === "arm64")("ARM64 without a native build installs the x64 build", async () => {
			const box = sandbox()
			const rel = release({ config: { ...config, platforms: ["windows/amd64", "linux/amd64"] } })
			const r = await install(runner, box, rel.ps1Url, { env: { MY_CLI_NO_MODIFY_PATH: "1" } })
			expect(r.status, output(r)).toBe(0)
			expect(output(r)).toContain("emulation")
			expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset("windows/amd64", "1.2.3"))
		})

		test("a running exe is renamed aside and replaced", async () => {
			const box = sandbox()
			/* a real executable that stays running: ping, served as the raw asset */
			const ping = readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"))
			const { checksumsPath: _checksums, ...raw } = config
			const rel = release({
				config: { ...raw, assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}.exe` },
			})
			const prefix = rel.baseUrl.slice(server.url.length)
			for (const v of ["1.2.0", "1.2.3"]) server.set(`${prefix}/${rel.asset(`windows/${ARCH}`, v)}`, ping)
			const first = await install(runner, box, rel.ps1Url, { version: "1.2.0" })
			expect(first.status, output(first)).toBe(0)
			const r = await runner.run({
				command:
					`$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ${q(target(box))} -ArgumentList '-n','30','127.0.0.1'; ` +
					`Start-Sleep -Milliseconds 500; irm ${q(rel.ps1Url)} | iex; $p | Stop-Process -Force`,
				cwd: box.root,
				env: {
					HOME: box.home,
					USERPROFILE: box.home,
					PATH: runner.systemPath,
					SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
					MY_CLI_NO_MODIFY_PATH: "1",
				},
			})
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toContain("Updated")
			expect(readFileSync(target(box))).toEqual(ping)
		})
	})
})
