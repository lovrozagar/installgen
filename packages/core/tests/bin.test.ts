import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"
import { run } from "../src/cli.ts"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/installgen.js")
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

	test("init, then the real bin builds the .mts it wrote with no local install", async () => {
		/* outside the repo, with no node_modules: the config's package import resolves only through the hook */
		const dir = mkdtempSync(join(tmpdir(), "installgen-bin-"))
		dirs.push(dir)
		const sink = () => {}
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
