import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import type { InstallgenConfig } from "../src/config/define-config.ts"
import { resolveConfig } from "../src/config/resolve.ts"
import { render } from "../src/render/render.ts"
import { assertStructure } from "./support/structure.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const UPDATE = process.env.UPDATE_GOLDEN === "1"

/* The examples are what `installgen init --preset` writes; their renders are checked in as golden files. */
describe.each(["raw", "goreleaser", "github"])("examples/%s.config.ts", (example) => {
	test("renders to the golden install.sh and install.ps1", async () => {
		const { default: config } = (await import(`../examples/${example}.config.ts`)) as { default: InstallgenConfig }
		const out = render(resolveConfig(config), {})
		assertStructure(out, true)
		const dir = join(HERE, "golden", example)
		for (const [file, content] of [
			["install.sh", out.sh],
			["install.ps1", out.ps1],
		] as const) {
			const path = join(dir, file)
			if (UPDATE) {
				mkdirSync(dir, { recursive: true })
				writeFileSync(path, content ?? "")
			}
			expect(existsSync(path), `${path} is missing; run UPDATE_GOLDEN=1 bun run test`).toBe(true)
			expect(content, `${path} is stale; run UPDATE_GOLDEN=1 bun run test`).toBe(readFileSync(path, "utf8"))
		}
		const syntax = spawnSync("sh", ["-n", join(dir, "install.sh")], { encoding: "utf8" })
		expect(syntax.status, syntax.stderr).toBe(0)
	})
})
