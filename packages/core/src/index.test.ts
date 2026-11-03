import { describe, expect, test } from "vitest"
import { generateInstallers, InstallgenError, type InstallgenConfig } from "./index.ts"

/* The GitHub layout from examples/github.config.ts, signed by the repository's release workflow on the tag */
const github = {
	name: "my-cli",
	baseUrl: "https://github.com/acme/my-cli/releases",
	assetPath: ({ tag, os, arch }) => `download/${tag}/my-cli_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `download/${tag}/checksums.txt`,
	latestPath: "latest/download/version.txt",
	signature: {
		identity: ({ tag }) => `https://github.com/acme/my-cli/.github/workflows/release.yml@refs/tags/${tag}`,
	},
} satisfies InstallgenConfig

describe("generateInstallers", () => {
	test("renders both scripts from a config, as build writes them", () => {
		const { sh, ps1 } = generateInstallers(github)
		for (const script of [sh, ps1]) {
			expect(script).toContain("https://github.com/acme/my-cli/releases")
			expect(script).toContain("latest/download/version.txt")
			expect(script).toContain("/.github/workflows/release.yml@refs/tags/")
			expect(script).toContain("checksums.txt")
		}
	})

	test("bakes the default version in", () => {
		expect(generateInstallers(github, { defaultVersion: "1.2.3" }).sh).toContain("1.2.3")
	})

	test("leaves out the script no platform needs", () => {
		const out = generateInstallers({ ...github, platforms: ["linux/amd64", "darwin/arm64"] })
		expect(out.sh).toBeDefined()
		expect(out.ps1).toBeUndefined()
	})

	test("refuses a config as build does", () => {
		expect(() => generateInstallers({ ...github, baseUrl: "http://dl.example.com" })).toThrow(InstallgenError)
	})
})
