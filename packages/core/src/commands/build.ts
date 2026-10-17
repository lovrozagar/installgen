import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { loadConfig, type RuntimeInfo } from "../config/load.ts"
import { resolveConfig } from "../config/resolve.ts"
import type { ResolvedConfig } from "../config/types.ts"
import { render } from "../render/render.ts"
import type { Ui } from "../ui.ts"

export interface ConfigOptions {
	cwd: string
	configPath: string | undefined
	runtime: RuntimeInfo
}

export async function loadResolved(options: ConfigOptions): Promise<ResolvedConfig> {
	const { config } = await loadConfig({ cwd: options.cwd, configPath: options.configPath, runtime: options.runtime })
	return resolveConfig(config)
}

export function warnUnverified(resolved: ResolvedConfig, ui: Ui): void {
	if (resolved.platforms.every((p) => p.checksums === undefined)) {
		ui.warn("no checksumsPath; the installers will not verify downloads (they show a warning row instead)")
	}
}

export interface BuildOptions extends ConfigOptions {
	out: string | undefined
	defaultVersion: string | undefined
}

export async function build(options: BuildOptions, ui: Ui): Promise<void> {
	const resolved = await loadResolved(options)
	const out = render(resolved, { defaultVersion: options.defaultVersion })
	const dir = resolve(options.cwd, options.out ?? resolved.outDir)
	mkdirSync(dir, { recursive: true })
	for (const [file, content, mode, reason] of [
		["install.sh", out.sh, 0o755, "no linux or darwin platforms"],
		["install.ps1", out.ps1, 0o644, "no windows platforms"],
	] as const) {
		if (content === undefined) {
			ui.info(`  ${file} skipped: ${reason}`)
			continue
		}
		const path = join(dir, file)
		writeFileSync(path, content)
		chmodSync(path, mode)
		ui.ok("wrote", relative(options.cwd, path))
	}
	warnUnverified(resolved, ui)
}
