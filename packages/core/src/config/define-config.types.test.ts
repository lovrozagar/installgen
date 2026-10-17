import { describe, expectTypeOf, test } from "vitest"
import {
	defineConfig,
	type Arch,
	type InstallgenConfig,
	type Os,
	type Platform,
	type TagToken,
	type VersionToken,
} from "./define-config.ts"

describe("config types", () => {
	test("path functions receive tokens and the real os and arch", () => {
		defineConfig({
			name: "app",
			baseUrl: "https://dl.example.com",
			assetPath: (ctx) => {
				expectTypeOf(ctx.version).toEqualTypeOf<VersionToken>()
				expectTypeOf(ctx.tag).toEqualTypeOf<TagToken>()
				expectTypeOf(ctx.os).toEqualTypeOf<Os>()
				expectTypeOf(ctx.arch).toEqualTypeOf<Arch>()
				return `${ctx.version}/app`
			},
			checksumsPath: (ctx) => {
				expectTypeOf(ctx.asset).toEqualTypeOf<string>()
				return `${ctx.asset}.sha256`
			},
		})
	})

	test("string methods on a token are type errors", () => {
		defineConfig({
			name: "app",
			baseUrl: "https://dl.example.com",
			assetPath: ({ version, tag }) => {
				// @ts-expect-error a token is not a string; interpolate it instead
				version.toUpperCase()
				// @ts-expect-error a token is not a string; interpolate it instead
				tag.slice(1)
				return `${tag}/${version}`
			},
		})
	})

	test("os and arch only take the supported names", () => {
		defineConfig({
			name: "app",
			baseUrl: "https://dl.example.com",
			assetPath: ({ version, os, arch }) => {
				// @ts-expect-error os is "linux" | "darwin" | "windows"
				const mac = os === "macos"
				// @ts-expect-error arch uses Go names
				const x64 = arch === "x86_64"
				return `${version}/${mac}-${x64}`
			},
		})
	})

	test("Platform rejects unknown pairs", () => {
		expectTypeOf<"linux/amd64">().toExtend<Platform>()
		expectTypeOf<"windows/arm64">().toExtend<Platform>()
		// @ts-expect-error 386 is not supported
		const bad: Platform = "linux/386"
		void bad
	})

	test("a type-only config with satisfies", () => {
		const config = {
			name: "app",
			baseUrl: "https://dl.example.com",
			assetPath: ({ version, os, arch }) => `${version}/app-${os}-${arch}`,
			platforms: ["linux/amd64", "darwin/arm64"],
		} satisfies InstallgenConfig
		expectTypeOf(config).toExtend<InstallgenConfig>()

		const missing = {
			name: "app",
			assetPath: ({ version }) => `${version}/app`,
			// @ts-expect-error baseUrl is required
		} satisfies InstallgenConfig
		void missing
	})
})
