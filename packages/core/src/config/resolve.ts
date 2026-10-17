import { InstallgenError } from "../errors.ts"
import {
	TAG_SENTINEL,
	VERSION_SENTINEL,
	tagToken,
	versionToken,
	type Arch,
	type InstallgenConfig,
	type Os,
	type Platform,
} from "./define-config.ts"
import type { Format, ResolvedConfig, ResolvedPlatform, Segment } from "./types.ts"

export const ALL_PLATFORMS: readonly Platform[] = [
	"linux/amd64",
	"linux/arm64",
	"darwin/amd64",
	"darwin/arm64",
	"windows/amd64",
	"windows/arm64",
]

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ENV_PREFIX = /^[A-Z_][A-Z0-9_]*$/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const SENTINELS = new RegExp(`(${VERSION_SENTINEL}|${TAG_SENTINEL})`)
const MANGLED = /installgen(version|tag)/

const fail = (message: string): never => {
	throw new InstallgenError(message)
}

type Raw = Record<string, unknown>

function string(config: Raw, key: string): string | undefined {
	const value = config[key]
	if (value === undefined) return undefined
	return typeof value === "string" ? value : fail(`config.${key} must be a string`)
}

function required<T>(value: T | undefined, key: string, kind: string): T {
	return value ?? fail(`config.${key} must be ${kind}`)
}

function func(config: Raw, key: string): ((ctx: object) => unknown) | undefined {
	const value = config[key]
	if (value === undefined) return undefined
	return typeof value === "function" ? (value as (ctx: object) => unknown) : fail(`config.${key} must be a function`)
}

/** https, or http on loopback; returns whether it is https. */
function checkUrl(field: string, url: string): boolean {
	let parsed: URL | undefined
	try {
		parsed = new URL(url)
	} catch {
		// reported below
	}
	if (parsed?.protocol === "https:" && parsed.host !== "") return true
	if (parsed?.protocol === "http:" && LOOPBACK.has(parsed.hostname)) return false
	return fail(`config.${field} must be an https URL (http is allowed only on loopback), got ${JSON.stringify(url)}`)
}

function checkRelative(field: string, path: string): void {
	if (path === "" || path.startsWith("/") || SCHEME.test(path)) {
		fail(`config.${field} must be a path relative to baseUrl, got ${JSON.stringify(path)}`)
	}
}

function noSentinel(field: string, value: string | undefined): void {
	if (value?.includes(VERSION_SENTINEL) || value?.includes(TAG_SENTINEL)) {
		fail(`config.${field} cannot hold a version or tag token; only path functions can`)
	}
}

/** Splits on the exact sentinels; a sentinel a string method rewrote is still recognizable in a literal piece. */
function split(field: string, platform: Platform, path: string): Segment[] {
	const segments: Segment[] = []
	for (const piece of path.split(SENTINELS)) {
		if (piece === VERSION_SENTINEL) segments.push({ kind: "version" })
		else if (piece === TAG_SENTINEL) segments.push({ kind: "tag" })
		else if (piece !== "") {
			if (MANGLED.test(piece.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
				fail(
					`config.${field} for ${platform} returned a mangled version or tag token (${JSON.stringify(path)}); ` +
						"interpolate it as-is, without string methods",
				)
			}
			segments.push({ kind: "literal", value: piece })
		}
	}
	return segments
}

function evaluate(field: string, fn: (ctx: object) => unknown, platform: Platform, ctx: object): string {
	const out = fn(ctx)
	if (typeof out !== "string") return fail(`config.${field} must return a string, got ${typeof out} for ${platform}`)
	checkRelative(field, out)
	return out
}

function formatOf(asset: string): Format {
	const tail = asset.toLowerCase()
	if (tail.endsWith(".tar.gz") || tail.endsWith(".tgz")) return "tar.gz"
	if (tail.endsWith(".zip")) return "zip"
	return "raw"
}

function platformsOf(config: Raw): readonly Platform[] {
	const value = config.platforms
	if (value === undefined) return ALL_PLATFORMS
	if (!Array.isArray(value)) return fail("config.platforms must be an array")
	if (value.length === 0) fail("config.platforms must list at least one platform")
	const seen = new Set<string>()
	for (const p of value) {
		if (!ALL_PLATFORMS.includes(p as Platform)) {
			fail(`config.platforms has unknown platform ${JSON.stringify(p)}; use one of ${ALL_PLATFORMS.join(", ")}`)
		}
		if (seen.has(p as string)) fail(`config.platforms lists ${p as string} twice`)
		seen.add(p as string)
	}
	return value as Platform[]
}

const key = (segments: readonly Segment[]) =>
	segments.map((s) => (s.kind === "literal" ? `L${s.value}` : s.kind)).join("\0")

/* GoReleaser universal_binaries: one asset serves both macOS architectures */
const universal = (a: Platform, b: Platform) => a.startsWith("darwin/") && b.startsWith("darwin/")

export function resolveConfig(input: InstallgenConfig): ResolvedConfig {
	if (typeof input !== "object" || input === null) return fail("config must be an object")
	const config = input as unknown as Raw

	const name = required(string(config, "name"), "name", "a string")
	if (!NAME.test(name)) fail(`config.name must match ${NAME.source}, got ${JSON.stringify(name)}`)

	const baseUrl = required(string(config, "baseUrl"), "baseUrl", "a string").replace(/\/+$/, "")
	const https = checkUrl("baseUrl", baseUrl)

	const assetPath = required(func(config, "assetPath"), "assetPath", "a function")
	const checksumsPath = func(config, "checksumsPath")
	const binaryInArchive = func(config, "binaryInArchive")

	const latestPath = string(config, "latestPath") ?? "latest"
	checkRelative("latestPath", latestPath)

	const tagPrefix = string(config, "tagPrefix") ?? "v"

	const installDir = string(config, "installDir") ?? `~/.${name}/bin`
	if (!installDir.startsWith("~/") || installDir.length === 2) {
		fail(`config.installDir must start with ~/ and name a directory, got ${JSON.stringify(installDir)}`)
	}

	const derived = name.toUpperCase().replace(/[^A-Z0-9]/g, "_")
	const envPrefix = string(config, "envPrefix") ?? (/^[0-9]/.test(derived) ? `_${derived}` : derived)
	if (!ENV_PREFIX.test(envPrefix))
		fail(`config.envPrefix must match ${ENV_PREFIX.source}, got ${JSON.stringify(envPrefix)}`)

	const modifyPathRaw = config.modifyPath ?? true
	const modifyPath = typeof modifyPathRaw === "boolean" ? modifyPathRaw : fail("config.modifyPath must be a boolean")

	const message = string(config, "message")

	const outDir = string(config, "outDir") ?? "installers"
	if (outDir === "") fail("config.outDir must not be empty")

	let scriptUrls = { sh: `${baseUrl}/install.sh`, ps1: `${baseUrl}/install.ps1` }
	if (config.scriptUrls !== undefined) {
		if (typeof config.scriptUrls !== "object" || config.scriptUrls === null) fail("config.scriptUrls must be an object")
		const urls = config.scriptUrls as Raw
		const sh = required(string(urls, "sh"), "scriptUrls.sh", "a string")
		const ps1 = required(string(urls, "ps1"), "scriptUrls.ps1", "a string")
		checkUrl("scriptUrls.sh", sh)
		checkUrl("scriptUrls.ps1", ps1)
		scriptUrls = { sh, ps1 }
	}

	for (const [field, value] of [
		["name", name],
		["baseUrl", baseUrl],
		["latestPath", latestPath],
		["tagPrefix", tagPrefix],
		["installDir", installDir],
		["envPrefix", envPrefix],
		["message", message],
		["outDir", outDir],
		["scriptUrls.sh", scriptUrls.sh],
		["scriptUrls.ps1", scriptUrls.ps1],
	] as const) {
		noSentinel(field, value)
	}

	const platforms: ResolvedPlatform[] = []
	const assets = new Map<string, Platform>()
	for (const platform of platformsOf(config)) {
		const [os, arch] = platform.split("/") as [Os, Arch]
		const ctx = { version: versionToken, tag: tagToken, os, arch }

		const assetRaw = evaluate("assetPath", assetPath, platform, ctx)
		const asset = split("assetPath", platform, assetRaw)
		if (asset.every((s) => s.kind === "literal")) {
			fail(`config.assetPath for ${platform} must contain the version or tag token, got ${JSON.stringify(assetRaw)}`)
		}
		const prior = assets.get(key(asset))
		if (prior !== undefined && !universal(prior, platform)) {
			fail(`config.assetPath gives ${prior} and ${platform} the same asset ${JSON.stringify(assetRaw)}`)
		}
		assets.set(key(asset), platform)

		platforms.push({
			platform,
			os,
			arch,
			asset,
			format: formatOf(assetRaw),
			checksums:
				checksumsPath &&
				split(
					"checksumsPath",
					platform,
					evaluate("checksumsPath", checksumsPath, platform, { ...ctx, asset: assetRaw }),
				),
			binaryInArchive:
				binaryInArchive &&
				split("binaryInArchive", platform, evaluate("binaryInArchive", binaryInArchive, platform, ctx)),
		})
	}

	return {
		name,
		baseUrl,
		https,
		latestPath,
		tagPrefix,
		installDir: installDir.slice(2),
		envPrefix,
		modifyPath,
		message,
		scriptUrls,
		outDir,
		platforms,
	}
}
