import { readFileSync } from "node:fs"
import type { ResolvedConfig, ResolvedPlatform, Segment } from "../config/types.ts"
import { InstallgenError } from "../errors.ts"
import { psLiteral, psString, shLiteral, shWord } from "./quote.ts"

export interface RenderOptions {
	/** Baked in as the version to install when neither the argument nor `<PREFIX>_VERSION` names one. */
	defaultVersion?: string | undefined
}

export interface Templates {
	sh: string
	ps1: string
}

export interface Rendered {
	sh?: string
	ps1?: string
}

/* The scripts validate the same pattern at install time, after stripping the tag prefix */
const VERSION = /^[A-Za-z0-9._+-]+$/
/* in non-unicode mode an astral character is two surrogates, both in this range */
const NON_ASCII = /[\u0080-\uffff]/
const PLACEHOLDER = /@@([A-Z0-9_]+)@@/g

const readTemplate = (file: string) => readFileSync(new URL(`../../templates/${file}`, import.meta.url), "utf8")

export function readTemplates(): Templates {
	return { sh: readTemplate("install.sh"), ps1: readTemplate("install.ps1") }
}

function ascii(field: string, value: string | undefined): void {
	if (value !== undefined && NON_ASCII.test(value)) {
		throw new InstallgenError(
			`${field} has a non-ASCII character (${JSON.stringify(value)}); the scripts must stay ASCII for Windows PowerShell 5.1`,
		)
	}
}

const literals = (segments: readonly Segment[] | undefined) =>
	(segments ?? []).map((s) => (s.kind === "literal" ? s.value : "")).join("")

function checkAscii(resolved: ResolvedConfig): void {
	ascii("config.message", resolved.message)
	ascii("config.baseUrl", resolved.baseUrl)
	ascii("config.latestPath", resolved.latestPath)
	ascii("config.scriptUrls.sh", resolved.scriptUrls.sh)
	ascii("config.scriptUrls.ps1", resolved.scriptUrls.ps1)
	for (const p of resolved.platforms) {
		ascii(`config.assetPath for ${p.platform}`, literals(p.asset))
		ascii(`config.checksumsPath for ${p.platform}`, literals(p.checksums))
		ascii(`config.binaryInArchive for ${p.platform}`, literals(p.binaryInArchive))
	}
}

function shCase(p: ResolvedPlatform): string {
	return [
		`\t\t'${p.platform}')`,
		`\t\t\tasset_path=${shWord(p.asset)}`,
		`\t\t\tformat=${shLiteral(p.format)}`,
		`\t\t\tchecksums_path=${shWord(p.checksums ?? [])}`,
		`\t\t\tbinary_in_archive=${shWord(p.binaryInArchive ?? [])}`,
		"\t\t\t;;",
	].join("\n")
}

function psCase(p: ResolvedPlatform): string {
	return [
		`\t\t'${p.platform}' {`,
		`\t\t\t$assetPath = ${psString(p.asset)}`,
		`\t\t\t$format = ${psLiteral(p.format)}`,
		`\t\t\t$checksumsPath = ${psString(p.checksums ?? [])}`,
		`\t\t\t$binaryInArchive = ${psString(p.binaryInArchive ?? [])}`,
		"\t\t}",
	].join("\n")
}

/** The value of each `@@KEY@@` in install.sh and install.ps1, already quoted for its shell. */
export function placeholders(
	resolved: ResolvedConfig,
	options: RenderOptions,
): { sh: Record<string, string>; ps1: Record<string, string> } {
	const unix = resolved.platforms.filter((p) => p.os !== "windows")
	const windows = resolved.platforms.filter((p) => p.os === "windows")
	const latestUrl = `${resolved.baseUrl}/${resolved.latestPath}`
	const defaultVersion = options.defaultVersion ?? ""
	const message = resolved.message ?? ""

	return {
		sh: {
			NAME: shLiteral(resolved.name),
			ENV_PREFIX: resolved.envPrefix,
			BASE_URL: shLiteral(resolved.baseUrl),
			LATEST_URL: shLiteral(latestUrl),
			DEFAULT_VERSION: shLiteral(defaultVersion),
			TAG_PREFIX: shLiteral(resolved.tagPrefix),
			INSTALL_DIR: `"$HOME"${shLiteral(`/${resolved.installDir}`)}`,
			INSTALL_DIR_DISPLAY: shLiteral(`~/${resolved.installDir}`),
			MODIFY_PATH: resolved.modifyPath ? "1" : "0",
			MESSAGE: shLiteral(message),
			SH_URL: shLiteral(resolved.scriptUrls.sh),
			/* with no Windows build there is no install.ps1 to point Git Bash users at */
			PS1_URL: shLiteral(windows.length > 0 ? resolved.scriptUrls.ps1 : ""),
			CURL_FLAGS: resolved.https ? "--proto '=https' --tlsv1.2" : "",
			WGET_FLAGS: resolved.https ? "--https-only" : "",
			PLATFORMS: unix.map((p) => p.platform).join(" "),
			PLATFORM_CASES: unix.map(shCase).join("\n"),
		},
		ps1: {
			NAME: psLiteral(resolved.name),
			ENV_PREFIX: resolved.envPrefix,
			BASE_URL: psLiteral(resolved.baseUrl),
			LATEST_URL: psLiteral(latestUrl),
			DEFAULT_VERSION: psLiteral(defaultVersion),
			TAG_PREFIX: psLiteral(resolved.tagPrefix),
			/* $env:USERPROFILE is unset on non-Windows pwsh and in some service contexts, and a literal \ is a filename
			 * character off Windows: Combine(params string[]) (.NET 4, so 5.1 too) joins with the native separator */
			INSTALL_DIR: `[IO.Path]::Combine([string[]](@([Environment]::GetFolderPath('UserProfile')) + @(${resolved.installDir
				.split("/")
				.map(psLiteral)
				.join(", ")})))`,
			INSTALL_DIR_DISPLAY: psLiteral(`~\\${resolved.installDir.replaceAll("/", "\\")}`),
			MODIFY_PATH: resolved.modifyPath ? "$true" : "$false",
			MESSAGE: psLiteral(message),
			SH_URL: psLiteral(unix.length > 0 ? resolved.scriptUrls.sh : ""),
			PS1_URL: psLiteral(resolved.scriptUrls.ps1),
			PLATFORMS: `@(${windows.map((p) => psLiteral(p.platform)).join(", ")})`,
			PLATFORM_CASES: windows.map(psCase).join("\n"),
		},
	}
}

function fill(file: string, template: string, values: Record<string, string>): string {
	const out = template.replace(PLACEHOLDER, (_match, key: string) => {
		const value = values[key]
		if (value === undefined) throw new InstallgenError(`unknown placeholder @@${key}@@ in ${file}`)
		return value
	})
	ascii(file, out)
	return out
}

export function render(
	resolved: ResolvedConfig,
	options: RenderOptions,
	templates: Templates = readTemplates(),
): Rendered {
	if (options.defaultVersion !== undefined && !VERSION.test(options.defaultVersion)) {
		throw new InstallgenError(
			`the default version must match ${VERSION.source}, got ${JSON.stringify(options.defaultVersion)}`,
		)
	}
	checkAscii(resolved)

	const values = placeholders(resolved, options)
	const out: Rendered = {}
	if (resolved.platforms.some((p) => p.os !== "windows")) out.sh = fill("install.sh", templates.sh, values.sh)
	if (resolved.platforms.some((p) => p.os === "windows")) out.ps1 = fill("install.ps1", templates.ps1, values.ps1)
	return out
}
