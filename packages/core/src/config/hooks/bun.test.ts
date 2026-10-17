import { describe, expect, test } from "vitest"
import { PACKAGE_NAME, registerBunHook, type BunBuild, type BunLike, type BunPlugin } from "./bun.ts"

describe("registerBunHook", () => {
	test("serves the running package's exports as a virtual module", async () => {
		const plugins: BunPlugin[] = []
		const bun: BunLike = { plugin: (p) => void plugins.push(p) }
		const self = { defineConfig: (c: unknown) => c }
		await registerBunHook(bun, "file:///pkg/dist/index.js", async (url) => {
			expect(url).toBe("file:///pkg/dist/index.js")
			return self
		})

		expect(plugins.map((p) => p.name)).toEqual(["installgen-self"])
		const modules = new Map<string, () => unknown>()
		const build: BunBuild = { module: (specifier, load) => void modules.set(specifier, load) }
		void plugins[0]?.setup(build)
		expect([...modules.keys()]).toEqual([PACKAGE_NAME])
		expect(modules.get(PACKAGE_NAME)?.()).toEqual({ exports: self, loader: "object" })
	})

	test("imports the package with import() by default", async () => {
		const plugins: BunPlugin[] = []
		await registerBunHook({ plugin: (p) => void plugins.push(p) }, "node:path")
		const modules = new Map<string, () => unknown>()
		void plugins[0]?.setup({ module: (specifier, load) => void modules.set(specifier, load) })
		const loaded = modules.get(PACKAGE_NAME)?.() as { exports: { join: unknown } }
		expect(typeof loaded.exports.join).toBe("function")
	})
})
