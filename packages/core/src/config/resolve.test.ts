import { describe, expect, test } from "vitest"
import { defineConfig, TAG_SENTINEL, VERSION_SENTINEL, type InstallgenConfig } from "./define-config.ts"
import { resolveConfig } from "./resolve.ts"
import type { Segment } from "./types.ts"

const V: Segment = { kind: "version" }
const T: Segment = { kind: "tag" }
const lit = (value: string): Segment => ({ kind: "literal", value })
type PathArgs = Parameters<InstallgenConfig["assetPath"]>[0]

const base = {
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ version, os, arch }) => `${version}/my-cli-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
} satisfies InstallgenConfig

/** Loosely typed config, for the runtime checks a JS config reaches past the types. */
const loose = (overrides: Record<string, unknown>): InstallgenConfig =>
	({ ...base, ...overrides }) as unknown as InstallgenConfig

const formatOf = (file: string) =>
	resolveConfig({ ...base, platforms: ["linux/amd64"], assetPath: ({ version }) => `${version}/${file}` }).platforms[0]
		?.format

describe("defineConfig", () => {
	test("returns the config unchanged", () => {
		expect(defineConfig(base)).toBe(base)
	})
})

describe("defaults", () => {
	test("fill every optional prop", () => {
		const r = resolveConfig(base)
		expect(r.name).toBe("my-cli")
		expect(r.baseUrl).toBe("https://dl.example.com/my-cli")
		expect(r.https).toBe(true)
		expect(r.latestPath).toBe("latest")
		expect(r.tagPrefix).toBe("v")
		expect(r.installDir).toBe(".my-cli/bin")
		expect(r.envPrefix).toBe("MY_CLI")
		expect(r.modifyPath).toBe(true)
		expect(r.message).toBeUndefined()
		expect(r.outDir).toBe("installers")
		expect(r.scriptUrls).toEqual({
			sh: "https://dl.example.com/my-cli/install.sh",
			ps1: "https://dl.example.com/my-cli/install.ps1",
		})
		expect(r.platforms.map((p) => p.platform)).toEqual([
			"linux/amd64",
			"linux/arm64",
			"darwin/amd64",
			"darwin/arm64",
			"windows/amd64",
			"windows/arm64",
		])
	})

	test("envPrefix uppercases the name and maps non-alphanumerics to _", () => {
		expect(resolveConfig({ ...base, name: "my.cli_x-2" }).envPrefix).toBe("MY_CLI_X_2")
	})

	test("a derived envPrefix that would start with a digit gets a leading _", () => {
		expect(resolveConfig({ ...base, name: "7zip" }).envPrefix).toBe("_7ZIP")
	})

	test("a trailing slash on baseUrl is dropped", () => {
		const r = resolveConfig({ ...base, baseUrl: "https://dl.example.com/my-cli///" })
		expect(r.baseUrl).toBe("https://dl.example.com/my-cli")
		expect(r.scriptUrls.sh).toBe("https://dl.example.com/my-cli/install.sh")
	})

	test("explicit optional props are kept", () => {
		const r = resolveConfig({
			...base,
			platforms: ["linux/amd64"],
			latestPath: "channels/stable.txt",
			tagPrefix: "",
			installDir: "~/bin",
			envPrefix: "MYCLI",
			modifyPath: false,
			message: "Run my-cli --help to start.",
			scriptUrls: { sh: "https://get.example.com/sh", ps1: "https://get.example.com/ps1" },
			outDir: "public",
		})
		expect(r).toMatchObject({
			latestPath: "channels/stable.txt",
			tagPrefix: "",
			installDir: "bin",
			envPrefix: "MYCLI",
			modifyPath: false,
			message: "Run my-cli --help to start.",
			scriptUrls: { sh: "https://get.example.com/sh", ps1: "https://get.example.com/ps1" },
			outDir: "public",
		})
		expect(r.platforms.map((p) => p.platform)).toEqual(["linux/amd64"])
	})

	test("loopback http is allowed and marked non-https", () => {
		for (const host of ["127.0.0.1:8080", "localhost:3000", "[::1]:9000"]) {
			expect(resolveConfig({ ...base, baseUrl: `http://${host}` }).https).toBe(false)
		}
	})
})

describe("per-platform evaluation", () => {
	test("runs each path function once per platform with the real os and arch", () => {
		const seen: string[] = []
		resolveConfig({
			...base,
			assetPath: ({ version, os, arch }) => {
				seen.push(`${os}/${arch}`)
				return `${version}/${os}-${arch}`
			},
		})
		expect(seen).toEqual([
			"linux/amd64",
			"linux/arm64",
			"darwin/amd64",
			"darwin/arm64",
			"windows/amd64",
			"windows/arm64",
		])
	})

	test("name maps and per-OS extensions", () => {
		const osName = { linux: "Linux", darwin: "Darwin", windows: "Windows" } as const
		const archName = { amd64: "x86_64", arm64: "arm64" } as const
		const r = resolveConfig({
			...base,
			assetPath: ({ tag, version, os, arch }) =>
				`${tag}/my-cli_${version}_${osName[os]}_${archName[arch]}${os === "windows" ? ".zip" : ".tar.gz"}`,
		})
		const linux = r.platforms.find((p) => p.platform === "linux/amd64")
		const win = r.platforms.find((p) => p.platform === "windows/arm64")
		expect(linux?.asset).toEqual([T, lit("/my-cli_"), V, lit("_Linux_x86_64.tar.gz")])
		expect(linux?.format).toBe("tar.gz")
		expect(linux?.os).toBe("linux")
		expect(linux?.arch).toBe("amd64")
		expect(win?.asset).toEqual([T, lit("/my-cli_"), V, lit("_Windows_arm64.zip")])
		expect(win?.format).toBe("zip")
	})
})

describe("format inference", () => {
	test.each([
		["app.tar.gz", "tar.gz"],
		["app.TGZ", "tar.gz"],
		["app.tgz", "tar.gz"],
		["app.zip", "zip"],
		["app.exe", "raw"],
		["app", "raw"],
		["app.gz", "raw"],
	])("%s is %s", (file, format) => {
		expect(formatOf(file)).toBe(format)
	})

	test("an asset ending in a token is raw", () => {
		const r = resolveConfig({ ...base, platforms: ["linux/amd64"], assetPath: ({ version }) => `app-${version}` })
		expect(r.platforms[0]?.format).toBe("raw")
	})
})

describe("version and tag splitting", () => {
	test("multiple occurrences of both tokens split into segments", () => {
		const r = resolveConfig({
			...base,
			platforms: ["darwin/arm64"],
			assetPath: ({ version, tag, os }) => `${tag}/${version}/${os}-${version}-${tag}`,
		})
		expect(r.platforms[0]?.asset).toEqual([T, lit("/"), V, lit("/darwin-"), V, lit("-"), T])
	})

	test("a tag-only asset path is accepted", () => {
		const r = resolveConfig({ ...base, platforms: ["linux/amd64"], assetPath: ({ tag }) => `${tag}/app` })
		expect(r.platforms[0]?.asset).toEqual([T, lit("/app")])
	})

	test("the tokens stringify to their sentinels", () => {
		let out = ""
		resolveConfig({
			...base,
			platforms: ["linux/amd64"],
			assetPath: ({ version, tag }) => (out = `${version}|${tag}|${String(version)}|${version as unknown as string}`),
		})
		expect(out).toBe(`${VERSION_SENTINEL}|${TAG_SENTINEL}|${VERSION_SENTINEL}|${VERSION_SENTINEL}`)
	})
})

describe("checksums and binaryInArchive", () => {
	test("checksumsPath receives the asset, per platform", () => {
		const assets: string[] = []
		const r = resolveConfig({
			...base,
			platforms: ["linux/amd64", "windows/amd64"],
			checksumsPath: ({ asset }) => {
				assets.push(asset)
				return `${asset}.sha256`
			},
		})
		expect(assets).toEqual([`${VERSION_SENTINEL}/my-cli-linux-amd64`, `${VERSION_SENTINEL}/my-cli-windows-amd64.exe`])
		expect(r.platforms[1]?.checksums).toEqual([V, lit("/my-cli-windows-amd64.exe.sha256")])
	})

	test("a shared checksums file", () => {
		const r = resolveConfig({ ...base, checksumsPath: ({ version }) => `${version}/checksums.txt` })
		for (const p of r.platforms) expect(p.checksums).toEqual([V, lit("/checksums.txt")])
	})

	test("unset checksumsPath and binaryInArchive resolve to undefined", () => {
		const r = resolveConfig(base)
		for (const p of r.platforms) {
			expect(p.checksums).toBeUndefined()
			expect(p.binaryInArchive).toBeUndefined()
		}
	})

	test("binaryInArchive is split per platform", () => {
		const r = resolveConfig({
			...base,
			platforms: ["linux/arm64"],
			assetPath: ({ version }) => `${version}/app.tar.gz`,
			binaryInArchive: ({ version, os, arch }) => `app-${version}-${os}-${arch}/app`,
		})
		expect(r.platforms[0]?.binaryInArchive).toEqual([lit("app-"), V, lit("-linux-arm64/app")])
	})
})

describe("validation errors", () => {
	test.each([
		["", /name/],
		["-cli", /name/],
		["my cli", /name/],
		["a/b", /name/],
	])("an invalid name %j", (name, message) => {
		expect(() => resolveConfig({ ...base, name })).toThrow(message)
	})

	test.each([
		"http://dl.example.com",
		"ftp://dl.example.com",
		"dl.example.com",
		"http://127.0.0.2.example.com",
		"https://",
	])("a non-https baseUrl %j", (baseUrl) => {
		expect(() => resolveConfig({ ...base, baseUrl })).toThrow(/baseUrl/)
	})

	test.each([
		["assetPath", { assetPath: () => "https://x.example.com/a" }],
		["assetPath", { assetPath: () => "/abs/path" }],
		["assetPath", { assetPath: () => "" }],
		["checksumsPath", { checksumsPath: () => "s3://bucket/checksums.txt" }],
		["checksumsPath", { checksumsPath: () => "/checksums.txt" }],
		["binaryInArchive", { binaryInArchive: () => "/bin/app" }],
		["latestPath", { latestPath: "https://dl.example.com/latest" }],
		["latestPath", { latestPath: "/latest" }],
		["latestPath", { latestPath: "" }],
	])("%s that starts with a scheme or / or is empty", (field, overrides) => {
		const config = { ...base, ...overrides } as InstallgenConfig
		expect(() => resolveConfig(config)).toThrow(new RegExp(field))
	})

	test("an assetPath without a version or tag token", () => {
		expect(() => resolveConfig({ ...base, assetPath: ({ os, arch }) => `latest/${os}-${arch}` })).toThrow(
			/assetPath.*linux\/amd64.*version or tag/,
		)
	})

	test("duplicate asset paths across platforms", () => {
		expect(() => resolveConfig({ ...base, assetPath: ({ version, os }) => `${version}/app-${os}` })).toThrow(
			/linux\/amd64 and linux\/arm64.*same asset/,
		)
	})

	test("a duplicate across OSes is an error", () => {
		expect(() =>
			resolveConfig({
				...base,
				platforms: ["darwin/arm64", "windows/arm64"],
				assetPath: ({ version }) => `${version}/app`,
			}),
		).toThrow(/darwin\/arm64 and windows\/arm64.*same asset/)
	})

	test("a universal binary shared by darwin/amd64 and darwin/arm64 is allowed", () => {
		const r = resolveConfig({
			...base,
			assetPath: ({ version, os, arch }) => `${version}/app-${os}-${os === "darwin" ? "all" : arch}`,
		})
		const darwin = r.platforms.filter((p) => p.os === "darwin")
		expect(darwin.map((p) => p.asset)).toEqual([
			[V, lit("/app-darwin-all")],
			[V, lit("/app-darwin-all")],
		])
	})

	test.each([
		["toUpperCase", ({ version, os, arch }: PathArgs) => `${version}`.toUpperCase() + `/${os}-${arch}`],
		["toLowerCase", ({ version, os, arch }: PathArgs) => `${version}`.toLowerCase() + `/${os}-${arch}`],
		['replace(/_/g, "-")', ({ tag, os, arch }: PathArgs) => `${tag}`.replace(/_/g, "-") + `/${os}-${arch}`],
		["slice", ({ tag, os, arch }: PathArgs) => `${tag}`.slice(1) + `/${os}-${arch}`],
	])("a sentinel mangled by %s fails, naming the prop and platform", (_how, assetPath) => {
		expect(() => resolveConfig({ ...base, assetPath })).toThrow(/assetPath.*linux\/amd64.*mangled/)
	})

	test("a mangled sentinel in checksumsPath", () => {
		expect(() =>
			resolveConfig({ ...base, checksumsPath: ({ version }) => `${version}`.toLowerCase() + "/checksums.txt" }),
		).toThrow(/checksumsPath.*linux\/amd64.*mangled/)
	})

	test("a mangled sentinel in binaryInArchive", () => {
		expect(() => resolveConfig({ ...base, binaryInArchive: ({ tag }) => `${tag}`.toUpperCase() })).toThrow(
			/binaryInArchive.*linux\/amd64.*mangled/,
		)
	})

	test("legit paths containing installgen are not mangled", () => {
		const r = resolveConfig({
			...base,
			name: "installgen",
			platforms: ["linux/amd64"],
			assetPath: ({ tag, version, os, arch }) => `${tag}/installgen_${version}_${os}_${arch}.tar.gz`,
			binaryInArchive: ({ tag }) => `installgen-${tag}-version/installgen`,
		})
		expect(r.platforms[0]?.asset).toEqual([T, lit("/installgen_"), V, lit("_linux_amd64.tar.gz")])
		expect(r.platforms[0]?.binaryInArchive).toEqual([lit("installgen-"), T, lit("-version/installgen")])
	})

	test.each([
		["message", { message: `see ${VERSION_SENTINEL}` }],
		["latestPath", { latestPath: `channels/${TAG_SENTINEL}` }],
		["outDir", { outDir: VERSION_SENTINEL }],
		["tagPrefix", { tagPrefix: TAG_SENTINEL }],
		[
			"scriptUrls.sh",
			{ scriptUrls: { sh: `https://x.example.com/${VERSION_SENTINEL}`, ps1: "https://x.example.com/p" } },
		],
	])("a sentinel in the non-path field %s", (field, overrides) => {
		expect(() => resolveConfig({ ...base, ...overrides })).toThrow(new RegExp(`${field}.*version or tag token`))
	})

	test.each(["MY-CLI", "1ABC", "my_cli", ""])("an invalid envPrefix %j", (envPrefix) => {
		expect(() => resolveConfig({ ...base, envPrefix })).toThrow(/envPrefix/)
	})

	test.each(["/opt/my-cli", "~", "~/", "bin", "$HOME/bin", "~user/bin"])("an invalid installDir %j", (installDir) => {
		expect(() => resolveConfig({ ...base, installDir })).toThrow(/installDir/)
	})

	test.each([
		["http://example.com/install.sh", "sh"],
		["not a url", "ps1"],
	])("a non-https scriptUrls entry %j", (url, key) => {
		const scriptUrls = { sh: "https://x.example.com/sh", ps1: "https://x.example.com/ps1", [key]: url }
		expect(() => resolveConfig({ ...base, scriptUrls })).toThrow(new RegExp(`scriptUrls.${key}`))
	})

	test("an empty outDir", () => {
		expect(() => resolveConfig({ ...base, outDir: "" })).toThrow(/outDir/)
	})

	test("an empty platforms list", () => {
		expect(() => resolveConfig({ ...base, platforms: [] })).toThrow(/platforms/)
	})

	test("an unknown platform from an untyped config", () => {
		expect(() => resolveConfig(loose({ platforms: ["linux/386"] }))).toThrow(/platforms.*linux\/386/)
	})

	test("a repeated platform", () => {
		expect(() => resolveConfig({ ...base, platforms: ["linux/amd64", "linux/amd64"] })).toThrow(/platforms.*twice/)
	})

	test.each([
		["config", null],
		["config", "nope"],
	])("a non-object %s", (_field, value) => {
		expect(() => resolveConfig(value as unknown as InstallgenConfig)).toThrow(/config must be an object/)
	})

	test.each([
		["name", { name: 1 }, /name must be a string/],
		["baseUrl", { baseUrl: undefined }, /baseUrl must be a string/],
		["assetPath", { assetPath: "x" }, /assetPath must be a function/],
		["checksumsPath", { checksumsPath: "x" }, /checksumsPath must be a function/],
		["binaryInArchive", { binaryInArchive: 1 }, /binaryInArchive must be a function/],
		["latestPath", { latestPath: 1 }, /latestPath must be a string/],
		["modifyPath", { modifyPath: "yes" }, /modifyPath must be a boolean/],
		["message", { message: 1 }, /message must be a string/],
		["platforms", { platforms: "linux/amd64" }, /platforms must be an array/],
		["scriptUrls", { scriptUrls: "x" }, /scriptUrls must be an object/],
		["scriptUrls", { scriptUrls: null }, /scriptUrls must be an object/],
		["scriptUrls.ps1", { scriptUrls: { sh: "https://x.example.com/sh" } }, /scriptUrls.ps1 must be a string/],
		["assetPath result", { assetPath: () => 1 }, /assetPath must return a string.*linux\/amd64/],
	])("a wrong type for %s", (_field, overrides, message) => {
		expect(() => resolveConfig(loose(overrides))).toThrow(message)
	})
})
