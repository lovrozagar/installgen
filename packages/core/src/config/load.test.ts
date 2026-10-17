import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import type { BunBuild, BunLike } from "./hooks/bun.ts"
import { CONFIG_FILES, detectRuntime, loadConfig, type RuntimeInfo } from "./load.ts"

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..")
const DIST = join(PACKAGE_DIR, "dist")

const NODE: RuntimeInfo = { runtime: "node", nodeVersion: "26.0.0" }

const TS_CONFIG = `import { defineConfig } from "@lovrozagar/installgen"

export default defineConfig({
	name: "demo",
	baseUrl: "https://dl.example.com/demo",
	assetPath: ({ version, os, arch }) => \`\${version}/demo-\${os}-\${arch}\${os === "windows" ? ".zip" : ".tar.gz"}\`,
})
`

const SATISFIES_CONFIG = `import type { InstallgenConfig } from "@lovrozagar/installgen"

export default {
	name: "demo",
	baseUrl: "https://dl.example.com/demo",
	assetPath: ({ version, os, arch }) => \`\${version}/demo-\${os}-\${arch}\`,
} satisfies InstallgenConfig
`

const MJS_CONFIG = `import { defineConfig } from "@lovrozagar/installgen"

export default defineConfig({
	name: "demo",
	baseUrl: "https://dl.example.com/demo",
	assetPath: ({ version, os, arch }) => \`\${version}/demo-\${os}-\${arch}\`,
})
`

/* Fixtures live outside the repo: inside it, package self-reference resolves @lovrozagar/installgen and hides a broken hook. */
const dirs: string[] = []
function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "installgen-load-"))
	dirs.push(dir)
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), content)
	}
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("detectRuntime", () => {
	test("node when there is no Bun global", () => {
		expect(detectRuntime({}, "22.18.0")).toEqual({ runtime: "node", nodeVersion: "22.18.0" })
	})

	test("bun when the Bun global exists", () => {
		const bun: BunLike = { plugin: () => {} }
		expect(detectRuntime({ Bun: bun }, "24.3.0")).toEqual({ runtime: "bun", nodeVersion: "24.3.0", bun })
	})

	test("defaults to the running process", () => {
		expect(detectRuntime()).toEqual({ runtime: "node", nodeVersion: process.versions.node })
	})
})

const importModule = async () => ({ default: { name: "x" } })

describe("discovery", () => {
	test("looks for the config names in order", async () => {
		expect(CONFIG_FILES).toEqual([
			"installgen.config.ts",
			"installgen.config.mts",
			"installgen.config.js",
			"installgen.config.mjs",
		])
		const cwd = fixture({ "installgen.config.mjs": "", "installgen.config.mts": "" })
		const loaded = await loadConfig({ cwd, runtime: NODE, importModule })
		expect(loaded.path).toBe(join(cwd, "installgen.config.mts"))
	})

	test("only in cwd, not in parents or children", async () => {
		const parent = fixture({ "installgen.config.ts": "", "sub/inner/installgen.config.ts": "" })
		await expect(loadConfig({ cwd: join(parent, "sub"), runtime: NODE, importModule })).rejects.toThrow(
			/no installgen\.config\.\{ts,mts,js,mjs\} in .*sub; run `installgen init`/,
		)
	})

	test("-c overrides discovery, relative to cwd", async () => {
		const cwd = fixture({ "installgen.config.ts": "", "conf/release.mjs": "" })
		const loaded = await loadConfig({ cwd, configPath: "conf/release.mjs", runtime: NODE, importModule })
		expect(loaded.path).toBe(join(cwd, "conf/release.mjs"))
	})

	test("a missing -c file errors", async () => {
		const cwd = fixture({})
		await expect(loadConfig({ cwd, configPath: "nope.ts", runtime: NODE, importModule })).rejects.toThrow(
			/config file not found: .*nope\.ts/,
		)
	})
})

describe("loading in-process", () => {
	test("imports the file with the default importer and returns its default export", async () => {
		const cwd = fixture({ "installgen.config.mjs": 'export default { name: "plain" }\n' })
		const loaded = await loadConfig({ cwd, runtime: NODE })
		expect(loaded.config).toEqual({ name: "plain" })
	})

	test("passes the file URL to the importer", async () => {
		const cwd = fixture({ "installgen.config.ts": "" })
		const urls: string[] = []
		await loadConfig({
			cwd,
			runtime: NODE,
			selfUrl: "file:///self/index.js",
			importModule: async (url) => {
				urls.push(url)
				return { default: { name: "x" } }
			},
		})
		expect(urls).toEqual([pathToFileURL(join(cwd, "installgen.config.ts")).href])
	})

	test("a missing default export errors clearly", async () => {
		const cwd = fixture({ "installgen.config.mjs": "" })
		await expect(loadConfig({ cwd, runtime: NODE, importModule: async () => ({ config: {} }) })).rejects.toThrow(
			/installgen\.config\.mjs has no default export; write `export default defineConfig\(\{ \.\.\. \}\)`/,
		)
	})

	test("a non-object default export errors clearly", async () => {
		const cwd = fixture({ "installgen.config.mjs": "" })
		await expect(loadConfig({ cwd, runtime: NODE, importModule: async () => ({ default: 1 }) })).rejects.toThrow(
			/has no default export/,
		)
	})

	test.each([
		["installgen.config.ts", "Unexpected token 'export'", "installgen.config.mts"],
		["installgen.config.js", "Cannot use import statement outside a module", "installgen.config.mjs"],
	])("%s loaded as CommonJS gets the rename hint", async (file, error, rename) => {
		const cwd = fixture({ [file]: "" })
		const throwing = async () => {
			throw new SyntaxError(error)
		}
		await expect(loadConfig({ cwd, runtime: NODE, importModule: throwing })).rejects.toThrow(
			new RegExp(`loaded as CommonJS.*"type": "module".*rename it to ${rename.replaceAll(".", "\\.")}`),
		)
	})

	test("other import errors are wrapped with the path and keep the cause", async () => {
		const cwd = fixture({ "installgen.config.mts": "" })
		const cause = new Error("boom")
		const err = await loadConfig({
			cwd,
			runtime: NODE,
			importModule: async () => {
				throw cause
			},
		}).then(
			() => new Error("resolved"),
			(error: unknown) => error as Error,
		)
		expect(err.message).toMatch(/failed to load .*installgen\.config\.mts: boom/)
		expect(err.cause).toBe(cause)
	})

	test("a thrown non-Error is wrapped too", async () => {
		const cwd = fixture({ "installgen.config.mjs": "" })
		await expect(
			loadConfig({
				cwd,
				runtime: NODE,
				importModule: async () => {
					throw "plain"
				},
			}),
		).rejects.toThrow(/failed to load .*: plain/)
	})
})

describe("node version gate", () => {
	test.each(["installgen.config.ts", "installgen.config.mts"])("%s on Node 22.17.0 errors", async (file) => {
		const cwd = fixture({ [file]: "" })
		await expect(
			loadConfig({ cwd, runtime: { runtime: "node", nodeVersion: "22.17.0" }, importModule }),
		).rejects.toThrow(
			/TypeScript config needs Node >= 22\.18.*22\.17\.0.*bunx --bun @lovrozagar\/installgen.*upgrade Node/,
		)
	})

	test.each(["21.9.0", "20.18.1"])("an older major %s errors too", async (nodeVersion) => {
		const cwd = fixture({ "installgen.config.ts": "" })
		await expect(loadConfig({ cwd, runtime: { runtime: "node", nodeVersion }, importModule })).rejects.toThrow(
			/needs Node >= 22\.18/,
		)
	})

	test.each(["22.18.0", "23.0.0"])("Node %s loads a .ts config", async (nodeVersion) => {
		const cwd = fixture({ "installgen.config.ts": "" })
		await expect(loadConfig({ cwd, runtime: { runtime: "node", nodeVersion }, importModule })).resolves.toMatchObject({
			config: { name: "x" },
		})
	})

	test("a .mjs config is not gated", async () => {
		const cwd = fixture({ "installgen.config.mjs": "" })
		await expect(
			loadConfig({ cwd, runtime: { runtime: "node", nodeVersion: "22.17.0" }, importModule }),
		).resolves.toMatchObject({ config: { name: "x" } })
	})

	test("Bun is not gated", async () => {
		const cwd = fixture({ "installgen.config.ts": "" })
		const bun: BunLike = { plugin: () => {} }
		await expect(
			loadConfig({ cwd, runtime: { runtime: "bun", nodeVersion: "22.6.0", bun }, importModule }),
		).resolves.toMatchObject({ config: { name: "x" } })
	})
})

describe("bun runtime", () => {
	test("registers the self-resolve plugin before importing the config", async () => {
		const cwd = fixture({ "installgen.config.ts": "" })
		const order: string[] = []
		const modules = new Map<string, () => unknown>()
		const bun: BunLike = {
			plugin(plugin) {
				order.push(`plugin:${plugin.name}`)
				const build: BunBuild = { module: (specifier, load) => void modules.set(specifier, load) }
				void plugin.setup(build)
			},
		}
		const self = { defineConfig: (c: unknown) => c }
		const loaded = await loadConfig({
			cwd,
			runtime: { runtime: "bun", nodeVersion: "24.3.0", bun },
			selfUrl: "file:///self/index.js",
			importModule: async (url) => {
				order.push(url)
				return url === "file:///self/index.js" ? self : { default: { name: "bun" } }
			},
		})
		expect(order).toEqual([
			"file:///self/index.js",
			"plugin:installgen-self",
			pathToFileURL(join(cwd, "installgen.config.ts")).href,
		])
		expect(modules.get("@lovrozagar/installgen")?.()).toEqual({ exports: self, loader: "object" })
		expect(loaded.config).toEqual({ name: "bun" })
	})
})

/* The real runtimes, against the built package: v8 cannot see these, the in-process cases above carry coverage. */
describe("subprocess, against dist", () => {
	const driver = `
		import { detectRuntime, loadConfig } from ${JSON.stringify(pathToFileURL(join(DIST, "config/load.js")).href)}
		import { resolveConfig } from ${JSON.stringify(pathToFileURL(join(DIST, "config/resolve.js")).href)}
		try {
			const { config } = await loadConfig({ cwd: process.cwd(), runtime: detectRuntime() })
			const resolved = resolveConfig(config)
			console.log(JSON.stringify({ name: resolved.name, platforms: resolved.platforms.length, format: resolved.platforms[0].format }))
		} catch (error) {
			console.log(JSON.stringify({ error: error.message }))
		}
	`
	function run(command: string[], cwd: string): Record<string, unknown> {
		const scripts = fixture({ "driver.mjs": driver })
		const [bin, ...args] = command as [string, ...string[]]
		const result = spawnSync(bin, [...args, join(scripts, "driver.mjs")], { cwd, encoding: "utf8" })
		expect(result.status, result.stderr).toBe(0)
		return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>
	}
	const runtimes = [
		["node", ["node"]],
		["bun --bun", ["bun", "--bun"]],
	] as const

	test.each(runtimes)("a .ts config importing @lovrozagar/installgen loads under %s", (_name, command) => {
		const cwd = fixture({ "installgen.config.ts": TS_CONFIG })
		expect(run([...command], cwd)).toEqual({ name: "demo", platforms: 6, format: "tar.gz" })
	})

	test.each(runtimes)("the .mjs form loads under %s", (_name, command) => {
		const cwd = fixture({ "installgen.config.mjs": MJS_CONFIG })
		expect(run([...command], cwd)).toEqual({ name: "demo", platforms: 6, format: "raw" })
	})

	test.each(runtimes)("the satisfies form loads under %s", (_name, command) => {
		const cwd = fixture({ "installgen.config.ts": SATISFIES_CONFIG })
		expect(run([...command], cwd)).toEqual({ name: "demo", platforms: 6, format: "raw" })
	})

	test("a CommonJS package.json + .ts gives the .mts hint under node", () => {
		const cwd = fixture({
			"package.json": '{ "name": "cjs-project", "type": "commonjs" }\n',
			"installgen.config.ts": TS_CONFIG,
		})
		expect(run(["node"], cwd).error).toMatch(/loaded as CommonJS.*rename it to installgen\.config\.mts/)
	})

	test("the same config renamed to .mts loads in that CommonJS project", () => {
		const cwd = fixture({
			"package.json": '{ "name": "cjs-project", "type": "commonjs" }\n',
			"installgen.config.mts": TS_CONFIG,
		})
		expect(run(["node"], cwd)).toEqual({ name: "demo", platforms: 6, format: "tar.gz" })
	})
})
