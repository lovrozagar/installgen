import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"
import { run } from "../src/cli.ts"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/installgen.js")
const sink = () => {}
const dirs: string[] = []
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/* The only spawns: the real bin, the real Node loader, the self-resolve hook. cli.test.ts carries coverage. */
describe("bin/installgen.js", () => {
	test("--help", () => {
		const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" })
		expect(r.status, r.stderr).toBe(0)
		expect(r.stdout).toContain("Usage: installgen <command>")
	})

	test("a reader that closes early (| head) gets no EPIPE crash", async () => {
		const dir = mkdtempSync(join(tmpdir(), "installgen-bin-"))
		dirs.push(dir)
		writeFileSync(
			join(dir, "installgen.config.mjs"),
			'export default { name: "my-cli", baseUrl: "https://dl.example.com", assetPath: ({ version, os, arch }) => `${version}/${os}-${arch}` }\n',
		)
		const child = spawn(process.execPath, [BIN, "check", "--list"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
		/* close the read end before the child writes, so every write hits a closed pipe */
		child.stdout.destroy()
		let stderr = ""
		child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d))
		const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
		expect(stderr).not.toContain("EPIPE")
		expect(stderr).not.toMatch(/^\s+at /m)
		expect(code).toBe(0)
	})

	test("init, then the real bin builds the .mts it wrote with no local install", async () => {
		/* outside the repo, with no node_modules: the config's package import resolves only through the hook */
		const dir = mkdtempSync(join(tmpdir(), "installgen-bin-"))
		dirs.push(dir)
		const code = await run(["init", "--preset", "goreleaser"], {
			cwd: dir,
			env: {},
			stdout: sink,
			stderr: sink,
			isTTY: false,
		})
		expect(code).toBe(0)
		const r = spawnSync(process.execPath, [BIN, "build"], { cwd: dir, encoding: "utf8" })
		expect(r.status, r.stderr).toBe(0)
		expect(statSync(join(dir, "installers/install.sh")).mode & 0o777).toBe(0o755)
		expect(readFileSync(join(dir, "installers/install.ps1"), "utf8")).toContain("my-cli_Windows_")
		const syntax = spawnSync("sh", ["-n", join(dir, "installers/install.sh")], { encoding: "utf8" })
		expect(syntax.status, syntax.stderr).toBe(0)
	})
})
