import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { InstallgenConfig, PathContext } from "../config/define-config.ts"
import { resolveConfig } from "../config/resolve.ts"
import { assertStructure } from "../../tests/support/structure.ts"
import { placeholders, readTemplates, render } from "./render.ts"

const base = {
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies InstallgenConfig

const resolve = (overrides: Partial<InstallgenConfig> = {}) => resolveConfig({ ...base, ...overrides })

function shSyntaxOk(script: string): void {
	const dir = mkdtempSync(join(tmpdir(), "installgen-render-"))
	try {
		writeFileSync(join(dir, "install.sh"), script)
		const result = spawnSync("sh", ["-n", join(dir, "install.sh")], { encoding: "utf8" })
		expect(result.status, result.stderr).toBe(0)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

describe("render", () => {
	test("renders both scripts that meet the structural contract, https", () => {
		const out = render(resolve(), {})
		assertStructure(out, true)
		shSyntaxOk(out.sh as string)
	})

	test("loopback http baseUrl: no https-only flags", () => {
		const out = render(resolve({ baseUrl: "http://127.0.0.1:8080" }), {})
		assertStructure(out, false)
		expect(out.sh).not.toContain("--proto")
		expect(out.sh).not.toContain("--https-only")
		expect(placeholders(resolve({ baseUrl: "http://127.0.0.1:8080" }), {}).sh.WGET_FLAGS).toBe("''")
	})

	test("fills every placeholder of the real templates, and every value is used", () => {
		const templates = readTemplates()
		const values = placeholders(resolve(), {})
		for (const kind of ["sh", "ps1"] as const) {
			const used = new Set([...templates[kind].matchAll(/@@([A-Z0-9_]+)@@/g)].map((m) => m[1]))
			expect([...used].toSorted()).toEqual(Object.keys(values[kind]).toSorted())
		}
	})

	test("an unknown placeholder in a template is an error", () => {
		expect(() => render(resolve(), {}, { sh: "#!/bin/sh\n@@NOPE@@\n", ps1: "" })).toThrow(
			/unknown placeholder @@NOPE@@ in install\.sh/,
		)
	})

	test("a script is skipped when its OS has no platforms", () => {
		const unix = render(resolve({ platforms: ["linux/amd64", "darwin/arm64"] }), {})
		expect(unix.sh).toBeDefined()
		expect(unix.ps1).toBeUndefined()
		const win = render(resolve({ platforms: ["windows/amd64"] }), {})
		expect(win.sh).toBeUndefined()
		expect(win.ps1).toBeDefined()
	})

	test("without Unix platforms the ps1 hint has no sh URL", () => {
		expect(placeholders(resolve({ platforms: ["windows/amd64"] }), {}).ps1.SH_URL).toBe("''")
		expect(placeholders(resolve({ platforms: ["darwin/arm64", "windows/amd64"] }), {}).ps1.SH_URL).toBe(
			"'https://dl.example.com/my-cli/install.sh'",
		)
	})

	test("without Windows platforms the sh hint has no ps1 URL", () => {
		expect(placeholders(resolve({ platforms: ["linux/amd64"] }), {}).sh.PS1_URL).toBe("''")
		expect(placeholders(resolve({ platforms: ["linux/amd64", "windows/arm64"] }), {}).sh.PS1_URL).toBe(
			"'https://dl.example.com/my-cli/install.ps1'",
		)
	})

	test("the platform list and cases only name the configured platforms", () => {
		const values = placeholders(resolve({ platforms: ["linux/amd64", "darwin/arm64", "windows/arm64"] }), {})
		expect(values.sh.PLATFORMS).toBe("'linux/amd64' | 'darwin/arm64'")
		expect(values.ps1.PLATFORMS).toBe("@('windows/arm64')")
		expect(values.sh.PLATFORM_CASES).toContain("'linux/amd64')")
		expect(values.sh.PLATFORM_CASES).not.toContain("windows")
		expect(values.ps1.PLATFORM_CASES).toContain("'windows/arm64' {")
		expect(values.ps1.PLATFORM_CASES).not.toContain("linux")
	})
})

const dir = (installDir: string) => placeholders(resolve({ installDir }), {}).ps1.INSTALL_DIR

describe("placeholder values", () => {
	test("sh", () => {
		const values = placeholders(resolve({ message: "Run 'my-cli --help'." }), { defaultVersion: "v1.2.3" })
		expect(values.sh).toMatchObject({
			NAME: "'my-cli'",
			ENV_PREFIX: "MY_CLI",
			BASE_URL: "'https://dl.example.com/my-cli'",
			LATEST_URL: "'https://dl.example.com/my-cli/latest'",
			DEFAULT_VERSION: "'v1.2.3'",
			TAG_PREFIX: "'v'",
			INSTALL_DIR: `"$HOME"'/.my-cli/bin'`,
			INSTALL_DIR_DISPLAY: "'~/.my-cli/bin'",
			MODIFY_PATH: "1",
			MESSAGE: `'Run '\\''my-cli --help'\\''.'`,
			SH_URL: "'https://dl.example.com/my-cli/install.sh'",
			PS1_URL: "'https://dl.example.com/my-cli/install.ps1'",
			CURL_FLAGS: "--proto '=https' --tlsv1.2",
			WGET_FLAGS: "'--https-only'",
		})
		expect(values.sh.PLATFORM_CASES).toContain(
			[
				"\t\t'linux/amd64')",
				`\t\t\tasset_path="$tag"'/my-cli_'"$version"'_linux_amd64.tar.gz'`,
				"\t\t\tformat='tar.gz'",
				`\t\t\tchecksums_path="$tag"'/checksums.txt'`,
				"\t\t\tbinary_in_archive=''",
				"\t\t\t;;",
			].join("\n"),
		)
	})

	test("ps1", () => {
		const values = placeholders(resolve({ message: "It's done", modifyPath: false }), {})
		expect(values.ps1).toMatchObject({
			NAME: "'my-cli'",
			ENV_PREFIX: "MY_CLI",
			BASE_URL: "'https://dl.example.com/my-cli'",
			LATEST_URL: "'https://dl.example.com/my-cli/latest'",
			DEFAULT_VERSION: "''",
			TAG_PREFIX: "'v'",
			INSTALL_DIR:
				"[IO.Path]::Combine([string[]](@([Environment]::GetFolderPath('UserProfile')) + @('.my-cli', 'bin')))",
			INSTALL_DIR_DISPLAY: "'~\\.my-cli\\bin'",
			MODIFY_PATH: "$false",
			MESSAGE: "'It''s done'",
			SH_URL: "'https://dl.example.com/my-cli/install.sh'",
			PS1_URL: "'https://dl.example.com/my-cli/install.ps1'",
		})
		expect(values.ps1.PLATFORM_CASES).toContain(
			[
				"\t\t'windows/amd64' {",
				"\t\t\t$assetPath = ($tag + '/my-cli_' + $ver + '_windows_amd64.zip')",
				"\t\t\t$format = 'zip'",
				"\t\t\t$checksumsPath = ($tag + '/checksums.txt')",
				"\t\t\t$binaryInArchive = ''",
				"\t\t}",
			].join("\n"),
		)
	})

	test("the ps1 install dir is one quoted literal per segment, joined natively", () => {
		expect(dir("~/My Tools/bin")).toBe(
			"[IO.Path]::Combine([string[]](@([Environment]::GetFolderPath('UserProfile')) + @('My Tools', 'bin')))",
		)
		expect(dir("~/.local/bin")).toContain("+ @('.local', 'bin')))")
		expect(dir("~/tools")).toContain("+ @('tools')))")
		expect(dir("~/a/b/c")).not.toContain("\\")
	})

	test("no message, no checksums, a binaryInArchive", () => {
		const values = placeholders(
			resolve({
				checksumsPath: undefined,
				binaryInArchive: ({ os }: PathContext) => `bin/${os}/my-cli`,
			} as unknown as Partial<InstallgenConfig>),
			{},
		)
		expect(values.sh.MESSAGE).toBe("''")
		expect(values.ps1.MESSAGE).toBe("''")
		expect(values.sh.PLATFORM_CASES).toContain("\t\t\tchecksums_path=''\n\t\t\tbinary_in_archive='bin/linux/my-cli'")
		expect(values.ps1.PLATFORM_CASES).toContain(
			"\t\t\t$checksumsPath = ''\n\t\t\t$binaryInArchive = 'bin/windows/my-cli'",
		)
	})
})

describe("ASCII and version checks", () => {
	test.each([
		["message", { message: "Fertig ✓" }],
		["baseUrl", { baseUrl: "https://dl.exämple.com" }],
		["latestPath", { latestPath: "lätest" }],
		["scriptUrls.sh", { scriptUrls: { sh: "https://get.example.com/ß", ps1: "https://get.example.com/ps1" } }],
		["scriptUrls.ps1", { scriptUrls: { sh: "https://get.example.com/sh", ps1: "https://get.example.com/ps1/é" } }],
		["assetPath", { assetPath: ({ version, os, arch }: PathContext) => `${version}/app-ü-${os}-${arch}.tar.gz` }],
		["checksumsPath", { checksumsPath: ({ version }: PathContext) => `${version}/sümme.txt` }],
		["binaryInArchive", { binaryInArchive: () => "bin/äpp" }],
	])("a non-ASCII %s is rejected", (field, overrides) => {
		expect(() => render(resolve(overrides as Partial<InstallgenConfig>), {})).toThrow(
			new RegExp(`${field.replace(".", "\\.")} .*non-ASCII`),
		)
	})

	test("a non-ASCII byte from a template is caught too", () => {
		expect(() => render(resolve(), {}, { sh: "#!/bin/sh\n# café\n", ps1: "" })).toThrow(/install\.sh .*non-ASCII/)
	})

	test.each(["1.2.3", "v1.2.3", "1.2.3-rc.1+build.5", "2026.10.17"])(
		"--default-version %s is baked",
		(defaultVersion) => {
			expect(render(resolve(), { defaultVersion }).sh).toContain(`default_version='${defaultVersion}'`)
		},
	)

	test.each(["1.2.3 ", "1.2.3;rm", "$(x)", "1.2.3\n", "ü"])("an invalid --default-version %j", (defaultVersion) => {
		expect(() => render(resolve(), { defaultVersion })).toThrow(/default version/)
	})
})
