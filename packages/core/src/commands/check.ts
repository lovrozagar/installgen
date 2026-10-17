import type { ResolvedConfig, Segment } from "../config/types.ts"
import { InstallgenError } from "../errors.ts"
import type { Ui } from "../ui.ts"
import { loadResolved, warnUnverified, type ConfigOptions } from "./build.ts"

export interface CheckOptions extends ConfigOptions {
	defaultVersion: string | undefined
	list: boolean
	fetch?: typeof fetch
}

/* the same rules the scripts apply at install time */
const VERSION = /^[A-Za-z0-9._+-]+$/
const TIMEOUT_MS = 15_000

function expand(segments: readonly Segment[], version: string, tag: string): string {
	return segments.map((s) => (s.kind === "literal" ? s.value : s.kind === "version" ? version : tag)).join("")
}

/** `hash  file`, `hash *file`, BSD `SHA256 (file) = hash`, or a file holding one bare hash. */
export function findChecksum(text: string, file: string): string | undefined {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "")
	for (const line of lines) {
		const fields = line.trim().split(/\s+/)
		if (fields[0] === "SHA256" && fields[1] === `(${file})` && fields[2] === "=") return fields[3]
		if (fields.length >= 2 && fields[1]?.replace(/^\*/, "") === file) return fields[0]
	}
	const only = lines.length === 1 ? lines[0]?.trim().split(/\s+/) : undefined
	return only?.length === 1 ? only[0] : undefined
}

type Probe = { ok: true; body: string } | { ok: false; reason: string }

/* fetch rejects with a TypeError whose cause says why (ECONNREFUSED, a timeout) */
function failure(error: unknown): string {
	const e = error as Error
	return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message
}

/** Strip whitespace and the tag prefix, then validate, as the scripts do. */
function normalize(raw: string, tagPrefix: string, what: string): string {
	let version = raw.replaceAll(/\s/g, "")
	if (version.startsWith(tagPrefix)) version = version.slice(tagPrefix.length)
	if (!VERSION.test(version)) throw new InstallgenError(`invalid ${what} version ${JSON.stringify(version)}`)
	return version
}

export async function check(options: CheckOptions, ui: Ui): Promise<number> {
	const resolved = await loadResolved(options)
	const doFetch = options.fetch ?? fetch
	const get = (url: string, init: RequestInit = {}) =>
		doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), ...init })

	if (options.list) {
		list(resolved, options.defaultVersion, ui)
		return 0
	}
	warnUnverified(resolved, ui)

	const version = await resolveVersion(resolved, options.defaultVersion, get, ui)
	const tag = resolved.tagPrefix + version

	/* HEAD first; hosts that refuse it get a one-byte ranged GET */
	const exists = async (url: string): Promise<string | undefined> => {
		try {
			const head = await get(url, { method: "HEAD" })
			if (head.ok) return undefined
			const ranged = await get(url, { headers: { range: "bytes=0-0" } })
			await ranged.arrayBuffer()
			return ranged.ok ? undefined : `missing ${url} (${ranged.status})`
		} catch (error) {
			return `unreachable ${url}: ${failure(error)}`
		}
	}
	const sums = new Map<string, Promise<Probe>>()
	const checksums = (url: string) => {
		let probe = sums.get(url)
		if (probe === undefined) {
			probe = get(url).then(
				async (res): Promise<Probe> =>
					res.ok ? { ok: true, body: await res.text() } : { ok: false, reason: `missing ${url} (${res.status})` },
				(error: unknown): Probe => ({ ok: false, reason: `unreachable ${url}: ${failure(error)}` }),
			)
			sums.set(url, probe)
		}
		return probe
	}

	let problems = 0
	for (const p of resolved.platforms) {
		const asset = expand(p.asset, version, tag)
		const assetUrl = `${resolved.baseUrl}/${asset}`
		const found: string[] = []
		const missing = await exists(assetUrl)
		if (missing === undefined) found.push(assetUrl)
		else {
			problems++
			ui.bad(p.platform, missing)
		}
		if (p.checksums !== undefined) {
			const sumsUrl = `${resolved.baseUrl}/${expand(p.checksums, version, tag)}`
			const file = asset.slice(asset.lastIndexOf("/") + 1)
			const probe = await checksums(sumsUrl)
			if (!probe.ok) {
				problems++
				ui.bad(p.platform, probe.reason)
			} else if (findChecksum(probe.body, file) === undefined) {
				problems++
				ui.bad(p.platform, `no checksum for ${file} in ${sumsUrl}`)
			} else found.push("sha256 listed")
		}
		if (found.length === (p.checksums === undefined ? 1 : 2)) ui.ok(p.platform, found.join(", "))
	}
	if (problems === 0) ui.info(`all ${resolved.platforms.length} platforms ok for ${version}`)
	else ui.info(`${problems} problem${problems === 1 ? "" : "s"}`)
	return problems
}

async function resolveVersion(
	resolved: ResolvedConfig,
	defaultVersion: string | undefined,
	get: (url: string) => Promise<Response>,
	ui: Ui,
): Promise<string> {
	if (defaultVersion !== undefined) return normalize(defaultVersion, resolved.tagPrefix, "default")
	const latestUrl = `${resolved.baseUrl}/${resolved.latestPath}`
	let res: Response
	try {
		res = await get(latestUrl)
	} catch (error) {
		throw new InstallgenError(`could not read the latest version from ${latestUrl}: ${failure(error)}`)
	}
	if (!res.ok) throw new InstallgenError(`could not read the latest version from ${latestUrl} (${res.status})`)
	const version = normalize(await res.text(), resolved.tagPrefix, "latest")
	ui.ok("latest", `${version} (${latestUrl})`)
	return version
}

function list(resolved: ResolvedConfig, defaultVersion: string | undefined, ui: Ui): void {
	const version = defaultVersion === undefined ? "{version}" : normalize(defaultVersion, resolved.tagPrefix, "default")
	const tag = defaultVersion === undefined ? "{tag}" : resolved.tagPrefix + version
	ui.info(`latest ${resolved.baseUrl}/${resolved.latestPath}`)
	for (const p of resolved.platforms) {
		ui.info(`${p.platform} ${resolved.baseUrl}/${expand(p.asset, version, tag)}`)
		if (p.checksums !== undefined) ui.info(`${p.platform} ${resolved.baseUrl}/${expand(p.checksums, version, tag)}`)
	}
}
