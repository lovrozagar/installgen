export type Os = "linux" | "darwin" | "windows"
export type Arch = "amd64" | "arm64"
export type Platform = `${Os}/${Arch}`

/* Mixed case, so toUpperCase and toLowerCase both change it and the build reports the call as mangled. */
export const VERSION_SENTINEL = "__InstallGen_Version__"
export const TAG_SENTINEL = "__InstallGen_Tag__"

declare const versionBrand: unique symbol
declare const tagBrand: unique symbol

/** The release version without the tag prefix (`1.2.3`). Interpolate it; the script fills it in at install time. */
export interface VersionToken {
	readonly [Symbol.toPrimitive]: (hint: string) => string
	readonly [versionBrand]: true
}

/** The release tag, `tagPrefix` + version (`v1.2.3`). Interpolate it; the script fills it in at install time. */
export interface TagToken {
	readonly [Symbol.toPrimitive]: (hint: string) => string
	readonly [tagBrand]: true
}

export interface PathContext {
	readonly version: VersionToken
	readonly tag: TagToken
	readonly os: Os
	readonly arch: Arch
}

export interface ChecksumsContext extends PathContext {
	/** The asset path `assetPath` returned for this platform. */
	readonly asset: string
}

export interface InstallgenConfig {
	/** The binary name, `^[A-Za-z0-9][A-Za-z0-9._-]*$`. */
	name: string
	/** Where the files live. https only; loopback http is allowed for tests. */
	baseUrl: string
	/** The asset path under `baseUrl`, per platform. Must contain `version` or `tag`. */
	assetPath: (ctx: PathContext) => string
	/** Default: all six. */
	platforms?: readonly Platform[]
	/** A shared `checksums.txt` or a per-asset `<asset>.sha256`, per platform. Unset: no verification. */
	checksumsPath?: (ctx: ChecksumsContext) => string
	/** The file holding the latest version. Default `"latest"`. */
	latestPath?: string
	/** The binary's path inside an archive. Default: search the extracted tree. */
	binaryInArchive?: (ctx: PathContext) => string
	/** Default `"v"`. */
	tagPrefix?: string
	/** Must start with `~/`. Default `"~/.<name>/bin"`. */
	installDir?: string
	/** Prefix of the end-user overrides. Default: `name` uppercased, non-alphanumerics → `_`. */
	envPrefix?: string
	/** Default `true`. */
	modifyPath?: boolean
	/** Printed after a successful install. */
	message?: string
	/** Where the scripts are served. Default `baseUrl/install.sh` and `baseUrl/install.ps1`. */
	scriptUrls?: { sh: string; ps1: string }
	/** Default `"installers"`. */
	outDir?: string
}

export function defineConfig(config: InstallgenConfig): InstallgenConfig {
	return config
}

const token = (sentinel: string) => Object.freeze({ [Symbol.toPrimitive]: () => sentinel })

export const versionToken = token(VERSION_SENTINEL) as unknown as VersionToken
export const tagToken = token(TAG_SENTINEL) as unknown as TagToken
