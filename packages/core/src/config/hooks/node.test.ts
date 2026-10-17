import { describe, expect, test } from "vitest"
import { PACKAGE_NAME } from "./bun.ts"
import { registerNodeHook, type RegisterHooks } from "./node.ts"

type Hooks = Parameters<RegisterHooks>[0]

const context = { conditions: [], importAttributes: {}, parentURL: undefined }
const unreachable = () => {
	throw new Error("not reached")
}
const passOn = (specifier: string) => ({ url: `file:///resolved/${specifier}` })

function capture(): { register: RegisterHooks; hooks: () => Hooks } {
	let hooks: Hooks | undefined
	return {
		register: (h) => {
			hooks = h
			return { deregister: () => {} }
		},
		hooks: () => hooks as Hooks,
	}
}

describe("registerNodeHook", () => {
	test("maps the package name to the running package", () => {
		const { register, hooks } = capture()
		registerNodeHook("file:///pkg/dist/index.js", register)
		expect(hooks().resolve?.(PACKAGE_NAME, context, unreachable)).toEqual({
			url: "file:///pkg/dist/index.js",
			format: "module",
			shortCircuit: true,
		})
	})

	test("returns the deregister handle", () => {
		const handle = { deregister: () => {} }
		expect(registerNodeHook("file:///pkg/dist/index.js", () => handle)).toBe(handle)
	})

	test("passes every other specifier on", () => {
		const { register, hooks } = capture()
		registerNodeHook("file:///pkg/dist/index.js", register)
		expect(hooks().resolve?.("node:fs", context, passOn)).toEqual({ url: "file:///resolved/node:fs" })
		expect(hooks().resolve?.(`${PACKAGE_NAME}/package.json`, context, passOn)).toEqual({
			url: `file:///resolved/${PACKAGE_NAME}/package.json`,
		})
	})

	test("defaults to node:module registerHooks", async () => {
		const { default: module } = await import("node:module")
		const before = module.registerHooks
		const calls: unknown[] = []
		module.registerHooks = ((hooks: Hooks) => {
			calls.push(hooks)
			return { deregister: () => {} }
		}) as RegisterHooks
		try {
			registerNodeHook("file:///pkg/dist/index.js")
		} finally {
			module.registerHooks = before
		}
		expect(calls).toHaveLength(1)
	})
})
