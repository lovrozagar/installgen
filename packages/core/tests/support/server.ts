import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { crc32, deflateRawSync, gzipSync } from "node:zlib"
import type { InstallgenConfig, Os } from "../../src/config/define-config.ts"
import { resolveConfig } from "../../src/config/resolve.ts"
import type { ResolvedConfig, ResolvedPlatform, Segment } from "../../src/config/types.ts"
import { render } from "../../src/render/render.ts"

/* ---------- archives ---------- */

export interface Entry {
	/** A trailing / makes a directory. */
	name: string
	data?: Buffer | string
	mode?: number
}

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`
}

/** A ustar archive, gzipped. */
export function tarGz(entries: readonly Entry[]): Buffer {
	const blocks: Buffer[] = []
	for (const entry of entries) {
		const dir = entry.name.endsWith("/")
		const data = dir ? Buffer.alloc(0) : Buffer.from(entry.data ?? "")
		const header = Buffer.alloc(512)
		header.write(entry.name, 0, 100, "utf8")
		header.write(octal(entry.mode ?? (dir ? 0o755 : 0o644), 8), 100, "ascii")
		header.write(octal(0, 8), 108, "ascii")
		header.write(octal(0, 8), 116, "ascii")
		header.write(octal(data.length, 12), 124, "ascii")
		header.write(octal(1_700_000_000, 12), 136, "ascii")
		header.write("        ", 148, "ascii")
		header.write(dir ? "5" : "0", 156, "ascii")
		header.write("ustar\0", 257, "ascii")
		header.write("00", 263, "ascii")
		let sum = 0
		for (const byte of header) sum += byte
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
	}
	blocks.push(Buffer.alloc(1024))
	return gzipSync(Buffer.concat(blocks))
}

/** A deflate zip with unix modes. */
export function zip(entries: readonly Entry[]): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	for (const entry of entries) {
		const dir = entry.name.endsWith("/")
		const data = dir ? Buffer.alloc(0) : Buffer.from(entry.data ?? "")
		const packed = deflateRawSync(data)
		const name = Buffer.from(entry.name, "utf8")
		const crc = crc32(data)
		const mode = (dir ? 0o40000 : 0o100000) | (entry.mode ?? (dir ? 0o755 : 0o644))

		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(0, 6)
		local.writeUInt16LE(8, 8)
		local.writeUInt16LE(0, 10)
		local.writeUInt16LE(0x5821, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(packed.length, 18)
		local.writeUInt32LE(data.length, 22)
		local.writeUInt16LE(name.length, 26)
		local.writeUInt16LE(0, 28)
		locals.push(local, name, packed)

		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(0x031e, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(0, 8)
		central.writeUInt16LE(8, 10)
		central.writeUInt16LE(0, 12)
		central.writeUInt16LE(0x5821, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(packed.length, 20)
		central.writeUInt32LE(data.length, 24)
		central.writeUInt16LE(name.length, 28)
		central.writeUInt32LE((mode << 16) >>> 0, 38)
		central.writeUInt32LE(offset, 42)
		centrals.push(central, name)

		offset += local.length + name.length + packed.length
	}
	const cd = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(cd.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, cd, end])
}

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

/** The fake binary: a tiny sh script on Unix, so an installed copy can be run; marked bytes on Windows. */
export function fakeBinary(name: string, version: string, os: Os): Buffer {
	return Buffer.from(
		os === "windows" ? `MZ fake ${name} ${version} windows\r\n` : `#!/bin/sh\necho '${name} ${version} ${os}'\n`,
	)
}

/* ---------- server ---------- */

export interface Served {
	body: Buffer | string
	status?: number
	contentType?: string
	/** Answer HEAD with 405, like hosts that only serve GET. */
	noHead?: boolean
}

export interface LoggedRequest {
	method: string
	path: string
	range: string | undefined
}

export interface TestServer {
	/** `http://127.0.0.1:<port>` */
	url: string
	set(path: string, served: Served | Buffer | string): void
	remove(path: string): void
	get(path: string): Served | undefined
	log: LoggedRequest[]
	/** The request paths under a prefix, prefix stripped. */
	requested(prefix: string): string[]
	close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
	const files = new Map<string, Served>()
	const log: LoggedRequest[] = []
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
		const range = req.headers.range
		log.push({ method: req.method ?? "GET", path, range })
		const file = files.get(path)
		if (file === undefined) {
			res.writeHead(404, { "content-type": "text/plain" }).end("not found\n")
			return
		}
		if (file.noHead && req.method === "HEAD") {
			res.writeHead(405).end()
			return
		}
		const body = Buffer.from(file.body)
		const headers = { "content-type": file.contentType ?? "application/octet-stream" }
		const status = file.status ?? 200
		const ranged = range?.match(/^bytes=(\d+)-(\d*)$/)
		if (status === 200 && ranged) {
			const start = Number(ranged[1])
			const end = ranged[2] ? Math.min(Number(ranged[2]), body.length - 1) : body.length - 1
			res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` })
			res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1))
			return
		}
		res.writeHead(status, { ...headers, "content-length": body.length })
		res.end(req.method === "HEAD" ? undefined : body)
	}
	const server = createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return {
		url: `http://127.0.0.1:${port}`,
		set: (path, served) =>
			void files.set(path, typeof served === "string" || Buffer.isBuffer(served) ? { body: served } : served),
		remove: (path) => void files.delete(path),
		get: (path) => files.get(path),
		log,
		requested: (prefix) =>
			log.filter((r) => r.path.startsWith(`${prefix}/`)).map((r) => r.path.slice(prefix.length + 1)),
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections()
				server.close((error) => (error ? reject(error) : resolve()))
			}),
	}
}

/* ---------- releases ---------- */

export type ChecksumStyle = "plain" | "star" | "upper" | "bare" | "bsd" | "wrong"

export interface ReleaseOptions {
	/** The URL path prefix this release lives under, e.g. `/case-3`. */
	prefix: string
	config: Omit<InstallgenConfig, "baseUrl"> & { baseUrl?: string }
	/** Every version to publish; the last is `latest` unless `latest` is given. */
	versions: readonly string[]
	/** The raw `latest` file content. Default: `<tagPrefix><last version>\n`. */
	latest?: string
	checksums?: ChecksumStyle
	defaultVersion?: string
	/** GoReleaser `wrap_in_directory`: archives hold `<name>_<version>_<os>_<arch>/<binary>`. */
	wrap?: boolean
	/** More archive entries, e.g. a second file with the binary's name. */
	extra?: readonly Entry[]
}

export interface Release {
	baseUrl: string
	resolved: ResolvedConfig
	sh: string | undefined
	ps1: string | undefined
	shUrl: string
	ps1Url: string
	/** The asset path for a platform and version. */
	asset(platform: string, version: string): string
}

export function expand(segments: readonly Segment[], version: string, tagPrefix: string): string {
	return segments
		.map((s) => (s.kind === "literal" ? s.value : s.kind === "version" ? version : tagPrefix + version))
		.join("")
}

function packageFor(
	p: ResolvedPlatform,
	resolved: ResolvedConfig,
	version: string,
	wrap: boolean,
	extra: readonly Entry[],
): Buffer {
	const binary = fakeBinary(resolved.name, version, p.os)
	if (p.format === "raw") return binary
	const exe = p.os === "windows" ? `${resolved.name}.exe` : resolved.name
	const inside = p.binaryInArchive
		? expand(p.binaryInArchive, version, resolved.tagPrefix)
		: wrap
			? `${resolved.name}_${version}_${p.os}_${p.arch}/${exe}`
			: exe
	const dirs = inside
		.split("/")
		.slice(0, -1)
		.map((_, i, parts) => `${parts.slice(0, i + 1).join("/")}/`)
	const entries: Entry[] = [
		...dirs.map((name) => ({ name })),
		{ name: inside, data: binary, mode: 0o755 },
		{ name: "README.md", data: `# ${resolved.name}\n` },
		...extra,
	]
	return p.format === "zip" ? zip(entries) : tarGz(entries)
}

function checksumLine(style: ChecksumStyle, hash: string, file: string): string {
	if (style === "star") return `${hash} *${file}`
	if (style === "upper") return `${hash.toUpperCase()}  ${file}`
	if (style === "bare") return hash
	if (style === "bsd") return `SHA256 (${file}) = ${hash}`
	if (style === "wrong") return `${sha256("tampered")}  ${file}`
	return `${hash}  ${file}`
}

export function publish(server: TestServer, options: ReleaseOptions): Release {
	const baseUrl = `${server.url}${options.prefix}`
	const resolved = resolveConfig({ ...options.config, baseUrl } as InstallgenConfig)
	const style = options.checksums ?? "plain"
	const assetOf = (p: ResolvedPlatform, version: string) => expand(p.asset, version, resolved.tagPrefix)

	for (const version of options.versions) {
		const sums = new Map<string, string[]>()
		for (const p of resolved.platforms) {
			const asset = assetOf(p, version)
			const data = packageFor(p, resolved, version, options.wrap ?? false, options.extra ?? [])
			server.set(`${options.prefix}/${asset}`, data)
			if (p.checksums) {
				const path = expand(p.checksums, version, resolved.tagPrefix)
				const file = asset.slice(asset.lastIndexOf("/") + 1)
				const lines = sums.get(path) ?? (style === "bare" ? [] : [`${sha256("other")}  ${file}.sbom.json`])
				if (!lines.includes(checksumLine(style, sha256(data), file)))
					lines.push(checksumLine(style, sha256(data), file))
				sums.set(path, lines)
			}
		}
		for (const [path, lines] of sums) server.set(`${options.prefix}/${path}`, `${lines.join("\n")}\n`)
	}
	server.set(
		`${options.prefix}/${resolved.latestPath}`,
		options.latest ?? `${resolved.tagPrefix}${options.versions.at(-1) ?? ""}\n`,
	)

	const out = render(resolved, { defaultVersion: options.defaultVersion })
	if (out.sh !== undefined)
		server.set(`${options.prefix}/install.sh`, { body: out.sh, contentType: "text/plain; charset=utf-8" })
	if (out.ps1 !== undefined) {
		server.set(`${options.prefix}/install.ps1`, { body: out.ps1, contentType: "text/plain; charset=utf-8" })
	}
	return {
		baseUrl,
		resolved,
		sh: out.sh,
		ps1: out.ps1,
		shUrl: `${baseUrl}/install.sh`,
		ps1Url: `${baseUrl}/install.ps1`,
		asset: (platform, version) => {
			const p = resolved.platforms.find((x) => x.platform === platform)
			return p ? assetOf(p, version) : ""
		},
	}
}
