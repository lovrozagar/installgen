import module from "node:module"
import { PACKAGE_NAME } from "./bun.ts"

export type RegisterHooks = typeof module.registerHooks

/**
 * Maps the config's `@lovrozagar/installgen` import to the running package, so a config in a project without
 * a local install (zero-install `bunx`) still resolves. `module.register` is deprecated on Node 26 (DEP0205).
 * Reached through the default export: Bun's `node:module` has no `registerHooks`, and a named import would fail to link.
 */
export function registerNodeHook(selfUrl: string, register: RegisterHooks = module.registerHooks): void {
	register({
		resolve(specifier, context, nextResolve) {
			if (specifier === PACKAGE_NAME) return { url: selfUrl, format: "module", shortCircuit: true }
			return nextResolve(specifier, context)
		},
	})
}
