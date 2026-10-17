import { readFileSync } from "node:fs"
import { parseArgs, type ParseArgsConfig } from "node:util"
import { build } from "./commands/build.ts"
import { check } from "./commands/check.ts"
import { init, PRESETS, type Preset } from "./commands/init.ts"
import { detectRuntime, type RuntimeInfo } from "./config/load.ts"
import { createUi, type UiIo } from "./ui.ts"

export interface Io extends UiIo {
	cwd: string
	runtime?: RuntimeInfo
	fetch?: typeof fetch
}

const HELP = `Usage: installgen <command> [options]

Generate curl | sh and irm | iex installers for prebuilt CLI binaries.

Commands:
  init     write installgen.config.ts from a preset
  build    write install.sh and install.ps1
  check    confirm a release's assets and checksum entries are published

Options:
  -h, --help     show this help
  --version      show the installgen version

Run \`installgen <command> --help\` for a command's options.
`

const COMMANDS = {
	init: {
		usage: `Usage: installgen init [--preset ${PRESETS.join("|")}] [--force]

  --preset <name>   the example to start from (default: raw)
  --force           overwrite an existing config
`,
		options: { preset: { type: "string" }, force: { type: "boolean" } },
	},
	build: {
		usage: `Usage: installgen build [-c <path>] [--out <dir>] [--default-version <version>]

  -c, --config <path>            the config (default: installgen.config.{ts,mts,js,mjs} in this directory)
  --out <dir>                    where to write the scripts (default: the config's outDir, installers)
  --default-version <version>    install this version when the user names none (default: the latest file)
`,
		options: { config: { type: "string", short: "c" }, out: { type: "string" }, "default-version": { type: "string" } },
	},
	check: {
		usage: `Usage: installgen check [-c <path>] [--default-version <version>] [--list]

  -c, --config <path>            the config (default: installgen.config.{ts,mts,js,mjs} in this directory)
  --default-version <version>    check this version (default: read the latest file)
  --list                         print the URLs the installers fetch, without fetching
`,
		options: {
			config: { type: "string", short: "c" },
			"default-version": { type: "string" },
			list: { type: "boolean" },
		},
	},
} as const satisfies Record<string, { usage: string; options: ParseArgsConfig["options"] }>

class UsageError extends Error {}

const isCommand = (name: string): name is keyof typeof COMMANDS => Object.hasOwn(COMMANDS, name)

function version(): string {
	return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version
}

/** The whole CLI, in-process: every effect goes through `io`, so tests run it without spawning. Returns the exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
	const ui = createUi(io)
	const [command, ...rest] = argv
	try {
		if (command === undefined) {
			io.stderr(HELP)
			return 2
		}
		if (command === "--help" || command === "-h") {
			io.stdout(HELP)
			return 0
		}
		if (command === "--version") {
			io.stdout(`${version()}\n`)
			return 0
		}
		if (!isCommand(command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`)

		const spec = COMMANDS[command]
		let values: Record<string, string | boolean | undefined>
		try {
			values = parseArgs({
				args: [...rest],
				options: { ...spec.options, help: { type: "boolean", short: "h" } },
				strict: true,
				allowPositionals: false,
			}).values as Record<string, string | boolean | undefined>
		} catch (error) {
			throw new UsageError((error as Error).message)
		}
		if (values.help) {
			io.stdout(spec.usage)
			return 0
		}

		const runtime = io.runtime ?? detectRuntime()
		const configPath = values.config as string | undefined
		const defaultVersion = values["default-version"] as string | undefined
		if (command === "init") {
			const preset = (values.preset as string | undefined) ?? "raw"
			if (!(PRESETS as readonly string[]).includes(preset)) {
				throw new UsageError(
					`unknown preset ${JSON.stringify(preset)}; use ${PRESETS.slice(0, -1).join(", ")} or ${PRESETS.at(-1)}`,
				)
			}
			init({ cwd: io.cwd, preset: preset as Preset, force: values.force === true }, ui)
			return 0
		}
		if (command === "build") {
			await build({ cwd: io.cwd, configPath, runtime, out: values.out as string | undefined, defaultVersion }, ui)
			return 0
		}
		const problems = await check(
			{
				cwd: io.cwd,
				configPath,
				runtime,
				defaultVersion,
				list: values.list === true,
				...(io.fetch ? { fetch: io.fetch } : {}),
			},
			ui,
		)
		return problems === 0 ? 0 : 1
	} catch (error) {
		if (error instanceof UsageError) {
			ui.error(error.message)
			io.stderr("Run `installgen --help` for usage.\n")
			return 2
		}
		ui.error((error as Error).message)
		return 1
	}
}

/** The slice of `process` that `start` touches. */
export interface Proc {
	stdout: NodeJS.WritableStream & { isTTY?: boolean }
	stderr: NodeJS.WritableStream
	cwd(): string
	env: Record<string, string | undefined>
	exitCode?: number | string | null | undefined
	exit(code?: number): void
}

export async function start(argv: readonly string[] = process.argv.slice(2), proc: Proc = process): Promise<void> {
	/* a reader that closes early (`| head`, `| grep -q`) is done listening: stop writing and leave quietly */
	let closed = false
	const onError = (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error
		closed = true
		proc.exit(Number(proc.exitCode ?? 0))
	}
	proc.stdout.on("error", onError)
	proc.stderr.on("error", onError)
	const write = (stream: NodeJS.WritableStream) => (text: string) => {
		if (!closed) stream.write(text)
	}
	proc.exitCode = await run(argv, {
		cwd: proc.cwd(),
		env: proc.env,
		stdout: write(proc.stdout),
		stderr: write(proc.stderr),
		isTTY: proc.stdout.isTTY === true,
	})
}
