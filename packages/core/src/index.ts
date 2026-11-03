import type { InstallgenConfig } from "./config/define-config.ts"
import { resolveConfig } from "./config/resolve.ts"
import { render, type Rendered, type RenderOptions } from "./render/render.ts"

export { defineConfig } from "./config/define-config.ts"
export type {
	Arch,
	BundleContext,
	ChecksumsContext,
	InstallgenConfig,
	Os,
	PathContext,
	Platform,
	SignatureConfig,
	TagToken,
	VersionToken,
} from "./config/define-config.ts"
export { InstallgenError } from "./errors.ts"
export type { Rendered, RenderOptions } from "./render/render.ts"

/**
 * `install.sh` and `install.ps1` for `config`, exactly as `installgen build` writes them, for a tool that places the
 * files itself; a script is absent when no platform needs it. Throws `InstallgenError` on a config `build` refuses.
 */
export function generateInstallers(config: InstallgenConfig, options: RenderOptions = {}): Rendered {
	return render(resolveConfig(config), options)
}
