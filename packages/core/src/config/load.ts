import { existsSync } from "node:fs"
import { basename, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { InstallgenError } from "../errors.ts"
import type { InstallgenConfig } from "./define-config.ts"
import { registerBunHook, type BunLike } from "./hooks/bun.ts"
import { registerNodeHook, type RegisterHooks } from "./hooks/node.ts"

export const CONFIG_FILES = [
	"installgen.config.ts",
	"installgen.config.mts",
	"installgen.config.js",
	"installgen.config.mjs",
] as const

export interface RuntimeInfo {
	runtime: "node" | "bun"
	/** `process.versions.node`; Bun reports the Node version it implements. */
	nodeVersion: string
	bun?: BunLike
}

export function detectRuntime(
	scope: { Bun?: BunLike } = globalThis as { Bun?: BunLike },
	nodeVersion: string = process.versions.node,
): RuntimeInfo {
	return scope.Bun ? { runtime: "bun", nodeVersion, bun: scope.Bun } : { runtime: "node", nodeVersion }
}

type Importer = (url: string) => Promise<Record<string, unknown>>

export interface LoadOptions {
	cwd: string
	/** `-c`: relative to `cwd`. */
	configPath?: string | undefined
	runtime: RuntimeInfo
	/** The running package's entry, which the config's `@lovrozagar/installgen` import resolves to. */
	selfUrl?: string
	importModule?: Importer
	/** Node's `module.registerHooks`. */
	registerHooks?: RegisterHooks
}

export interface LoadedConfig {
	path: string
	config: InstallgenConfig
}

/* Node strips types from .ts without a flag from 22.18, and on 23 from 23.6 */
const CJS_SYNTAX = /Unexpected token 'export'|Cannot use import statement outside a module/

function find(cwd: string, configPath: string | undefined): string {
	if (configPath !== undefined) {
		const path = resolve(cwd, configPath)
		if (!existsSync(path)) throw new InstallgenError(`config file not found: ${path}`)
		return path
	}
	for (const name of CONFIG_FILES) {
		const path = join(cwd, name)
		if (existsSync(path)) return path
	}
	throw new InstallgenError(
		`no installgen.config.{ts,mts,js,mjs} in ${cwd}; run \`installgen init\`, or pass -c <path>`,
	)
}

function stripsTypes(version: string): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number)
	if (major === 22) return minor >= 18
	if (major === 23) return minor >= 6
	return major > 23
}

export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
	const path = find(options.cwd, options.configPath)
	const ext = extname(path)
	const { runtime } = options
	const importModule = options.importModule ?? ((url) => import(url) as Promise<Record<string, unknown>>)
	const selfUrl = options.selfUrl ?? new URL("../index.js", import.meta.url).href

	if (runtime.runtime === "node" && (ext === ".ts" || ext === ".mts") && !stripsTypes(runtime.nodeVersion)) {
		throw new InstallgenError(
			`a TypeScript config needs Node >= 22.18 (23.6 on Node 23; this is ${runtime.nodeVersion}); ` +
				"run `bunx --bun @lovrozagar/installgen` instead, or upgrade Node",
		)
	}

	/* Bun's plugin stays for the process; Node's hook goes once the config is imported */
	let hook: ReturnType<RegisterHooks> | undefined
	if (runtime.bun) await registerBunHook(runtime.bun, selfUrl, importModule)
	else hook = registerNodeHook(selfUrl, options.registerHooks)

	let mod: Record<string, unknown>
	try {
		mod = await importModule(pathToFileURL(path).href)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (CJS_SYNTAX.test(message) && (ext === ".ts" || ext === ".js")) {
			const rename = `${basename(path, ext)}.m${ext.slice(1)}`
			throw new InstallgenError(
				`${path} was loaded as CommonJS: the nearest package.json has no "type": "module"; rename it to ${rename}`,
				{ cause: error },
			)
		}
		throw new InstallgenError(`failed to load ${path}: ${message}`, { cause: error })
	} finally {
		hook?.deregister()
	}

	const config = mod.default
	if (typeof config !== "object" || config === null) {
		throw new InstallgenError(`${path} has no default export; write \`export default defineConfig({ ... })\``)
	}
	return { path, config: config as InstallgenConfig }
}
