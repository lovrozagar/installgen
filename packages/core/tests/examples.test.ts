import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import type { InstallgenConfig } from "../src/config/define-config.ts"
import { resolveConfig } from "../src/config/resolve.ts"
import { render } from "../src/render/render.ts"
import { assertStructure } from "./support/structure.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const UPDATE = process.env.UPDATE_GOLDEN === "1"
const DOCKER = process.env.INSTALLGEN_E2E_DOCKER === "1"
/* the newest PSScriptAnalyzer needs pwsh 7.4.6; the powershell image's latest tag is 7.4.2 */
const PSSA_VERSION = "1.23.0"

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

/* A config whose literals hold everything a shell treats specially, rendered beside the goldens for the linters */
const HOSTILE: InstallgenConfig = {
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ version, os, arch }) => `${version}/my-cli-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
	message: "Use $HOME, `my-cli --help`, ~/x, $(id), 'single' and \"double\" quotes; 100% done",
	installDir: "~/My Tools/bin",
}

function lintDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "installgen-lint-"))
	cpSync(join(HERE, "golden"), dir, { recursive: true })
	const out = render(resolveConfig(HOSTILE), {})
	mkdirSync(join(dir, "hostile"))
	writeFileSync(join(dir, "hostile", "install.sh"), out.sh ?? "")
	writeFileSync(join(dir, "hostile", "install.ps1"), out.ps1 ?? "")
	return dir
}

describe.runIf(DOCKER)("static analysis of the rendered scripts", () => {
	test("shellcheck -s sh finds nothing", () => {
		const dir = lintDir()
		try {
			const files = ["raw", "goreleaser", "github", "hostile"].map((d) => `${d}/install.sh`)
			const r = spawnSync(
				"docker",
				["run", "--rm", "-v", `${dir}:/mnt`, "-w", "/mnt", "koalaman/shellcheck:stable", "-s", "sh", ...files],
				{ encoding: "utf8" },
			)
			expect(r.status, r.stdout + r.stderr).toBe(0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("PSScriptAnalyzer finds nothing, PSUseCompatibleSyntax 5.1 and 7.0 included", () => {
		const dir = lintDir()
		try {
			const settings =
				"@{ExcludeRules=@('PSAvoidUsingWriteHost','PSReviewUnusedParameter');" +
				"Rules=@{PSUseCompatibleSyntax=@{Enable=$true;TargetVersions=@('5.1','7.0')}}}"
			const script =
				`Install-Module PSScriptAnalyzer -RequiredVersion ${PSSA_VERSION} -Force -Scope CurrentUser; ` +
				`Invoke-ScriptAnalyzer -Path /w -Recurse -Settings ${settings} -EnableExit`
			const r = spawnSync(
				"docker",
				[
					"run",
					"--rm",
					"-v",
					`${dir}:/w`,
					"mcr.microsoft.com/powershell:latest",
					"pwsh",
					"-NoProfile",
					"-Command",
					script,
				],
				{ encoding: "utf8", timeout: 170_000 },
			)
			expect(r.status, r.stdout + r.stderr).toBe(0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 180_000)
})
