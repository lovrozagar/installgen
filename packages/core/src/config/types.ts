import type { Arch, Os, Platform } from "./define-config.ts"

/** A path split on the sentinels: literal text, and the places the script puts the version or the tag. */
export type Segment =
	| { readonly kind: "literal"; readonly value: string }
	| { readonly kind: "version" }
	| { readonly kind: "tag" }

export type Format = "tar.gz" | "zip" | "raw"

export interface ResolvedPlatform {
	readonly platform: Platform
	readonly os: Os
	readonly arch: Arch
	readonly asset: readonly Segment[]
	readonly format: Format
	readonly checksums: readonly Segment[] | undefined
	readonly binaryInArchive: readonly Segment[] | undefined
}

export interface ResolvedConfig {
	readonly name: string
	/** No trailing slash. */
	readonly baseUrl: string
	readonly https: boolean
	readonly latestPath: string
	readonly tagPrefix: string
	/** Relative to the home directory: `~/` is stripped. */
	readonly installDir: string
	readonly envPrefix: string
	readonly modifyPath: boolean
	readonly message: string | undefined
	readonly scriptUrls: { readonly sh: string; readonly ps1: string }
	readonly outDir: string
	readonly platforms: readonly ResolvedPlatform[]
}
