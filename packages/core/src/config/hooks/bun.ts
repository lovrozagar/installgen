export const PACKAGE_NAME = "@lovrozagar/installgen"

export interface BunBuild {
	module(specifier: string, load: () => { exports: Record<string, unknown>; loader: "object" }): void
}

export interface BunPlugin {
	name: string
	setup(build: BunBuild): void | Promise<void>
}

/** The slice of the `Bun` global the loader uses. */
export interface BunLike {
	plugin(plugin: BunPlugin): void
}

type Importer = (url: string) => Promise<Record<string, unknown>>

/**
 * Bun's `onResolve` never sees the imports a runtime-loaded config makes; `build.module` does. The config's
 * `@lovrozagar/installgen` import becomes a virtual module holding the running package's exports.
 */
export async function registerBunHook(
	bun: BunLike,
	selfUrl: string,
	importModule: Importer = (url) => import(url) as Promise<Record<string, unknown>>,
): Promise<void> {
	const exports = await importModule(selfUrl)
	bun.plugin({
		name: "installgen-self",
		setup(build) {
			build.module(PACKAGE_NAME, () => ({ exports, loader: "object" }))
		},
	})
}
