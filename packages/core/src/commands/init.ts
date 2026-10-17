import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CONFIG_FILES } from "../config/load.ts"
import { InstallgenError } from "../errors.ts"
import type { Ui } from "../ui.ts"

export const PRESETS = ["raw", "goreleaser", "github"] as const
export type Preset = (typeof PRESETS)[number]

export interface InitOptions {
	cwd: string
	preset: Preset
	force: boolean
}

/** Node runs a .ts as CommonJS unless the nearest package.json says `"type": "module"`; .mts is always ESM. */
function isModuleProject(cwd: string): boolean {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const pkg = join(dir, "package.json")
		if (existsSync(pkg)) {
			try {
				return (JSON.parse(readFileSync(pkg, "utf8")) as { type?: unknown }).type === "module"
			} catch {
				return false
			}
		}
		if (dirname(dir) === dir) return false
	}
}

export function init(options: InitOptions, ui: Ui): void {
	const existing = CONFIG_FILES.find((name) => existsSync(join(options.cwd, name)))
	if (existing !== undefined && !options.force) {
		throw new InstallgenError(`${existing} already exists; pass --force to overwrite it`)
	}
	const file = isModuleProject(options.cwd) ? "installgen.config.ts" : "installgen.config.mts"
	const example = readFileSync(new URL(`../../examples/${options.preset}.config.ts`, import.meta.url), "utf8")
	writeFileSync(join(options.cwd, file), example)
	ui.ok("wrote", `${file} (preset ${options.preset})`)
	ui.info(`Set baseUrl and assetPath for your releases, then run \`installgen build\`.`)
}
