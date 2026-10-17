import { spawn, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * Who runs the generated scripts. `INSTALLGEN_E2E_SHELLS` lists host shells (default `sh` on Linux and macOS, none on
 * Windows, where host `sh` is Git Bash). `INSTALLGEN_E2E_DOCKER=1` adds dash, bash, zsh, busybox ash and pwsh in Docker.
 */

export interface RunOptions {
	/** Runs under `sh -c` (host) or the image's `sh -c` (Docker). */
	command: string
	env: Record<string, string>
	cwd: string
	/** Run under a pseudo-terminal (`script`), so the scripts see a TTY. */
	tty?: boolean | undefined
}

export interface RunResult {
	status: number
	stdout: string
	stderr: string
}

export interface Runner {
	name: string
	kind: "sh" | "ps1"
	/** The shell that reads the piped script, e.g. `sh`, `dash`, `busybox sh`, `pwsh`, `powershell`. */
	shell: string
	/** The downloader the pipeline uses. */
	fetch: "curl" | "wget" | "irm"
	/** PATH outside the test's shims. */
	systemPath: string
	/** Whether `tty: true` is supported. */
	tty: boolean
	/** Async: the test server runs in this process, so a blocking spawn would starve it. */
	run(options: RunOptions): Promise<RunResult>
}

const HERE = dirname(fileURLToPath(import.meta.url))
export const shQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
export const DOCKERFILE_DIR = join(HERE, "../fixtures")
const IMAGE = "installgen-e2e:debian"
const PWSH_IMAGE = "mcr.microsoft.com/powershell:latest"
const BUSYBOX_IMAGE = "busybox:stable"
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

/** `script` differs: util-linux takes `-qec cmd /dev/null`, BSD/macOS takes `-q /dev/null cmd...`. */
function ttyArgs(command: string, platform: NodeJS.Platform): [string, string[]] {
	return platform === "darwin"
		? ["script", ["-q", "/dev/null", "sh", "-c", command]]
		: ["script", ["-qec", command, "/dev/null"]]
}

function exec(
	bin: string,
	args: readonly string[],
	options: { env?: Record<string, string>; cwd?: string; timeout: number },
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d))
		child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d))
		const timer = setTimeout(() => {
			stderr += `\n[timed out after ${options.timeout} ms]`
			child.kill("SIGKILL")
		}, options.timeout)
		child.on("error", (error) => {
			clearTimeout(timer)
			resolve({ status: 127, stdout, stderr: `${stderr}${String(error)}` })
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ status: code ?? 1, stdout, stderr })
		})
	})
}

function hostRunner(shell: string): Runner {
	const kind = shell === "pwsh" || shell === "powershell" ? "ps1" : "sh"
	return {
		name: `host ${shell}`,
		kind,
		shell,
		fetch: kind === "ps1" ? "irm" : "curl",
		systemPath: process.env.PATH ?? "",
		tty: process.platform !== "win32",
		run({ command, env, cwd, tty }) {
			const full = { ...env, TERM: env.TERM ?? "xterm-256color" }
			if (kind === "ps1") {
				const args = ["-NoProfile", "-NonInteractive", "-Command", command]
				if (!tty) return exec(shell, args, { env: full, cwd, timeout: 50_000 })
				const [bin, ttyArgv] = ttyArgs([shell, ...args].map(shQuote).join(" "), process.platform)
				return exec(bin, ttyArgv, { env: full, cwd, timeout: 50_000 })
			}
			const [bin, args] = tty ? ttyArgs(command, process.platform) : ["sh", ["-c", command]]
			return exec(bin, args, { env: full, cwd, timeout: 50_000 })
		},
	}
}

let imageBuilt = false
function ensureImage(): void {
	if (imageBuilt) return
	const built = spawnSync("docker", ["build", "-q", "-t", IMAGE, DOCKERFILE_DIR], { encoding: "utf8" })
	if (built.status !== 0) throw new Error(`docker build failed: ${built.stderr}`)
	imageBuilt = true
}

/**
 * The test's temp dirs are mounted at the same path, and the host network is shared, so paths and the
 * 127.0.0.1 server look the same inside and out.
 */
function dockerRunner(
	name: string,
	image: string,
	shell: string,
	fetch: Runner["fetch"],
	kind: Runner["kind"],
): Runner {
	return {
		name: `docker ${name}`,
		kind,
		shell,
		fetch,
		systemPath: CONTAINER_PATH,
		tty: kind === "sh" && image === IMAGE,
		run({ command, env, cwd, tty }) {
			if (image === IMAGE) ensureImage()
			const mounts = [...new Set([cwd, env.HOME].filter((d): d is string => !!d))].flatMap((d) => ["-v", `${d}:${d}`])
			const envArgs = Object.entries({ TERM: "xterm-256color", ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`])
			const inner =
				kind === "ps1"
					? ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command]
					: tty
						? ["script", "-qec", command, "/dev/null"]
						: ["sh", "-c", command]
			const args = ["run", "--rm", "--network", "host", "-u", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`]
			return exec("docker", [...args, ...mounts, ...envArgs, "-w", cwd, image, ...inner], { timeout: 55_000 })
		},
	}
}

export function runners(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Runner[] {
	const listed = env.INSTALLGEN_E2E_SHELLS ?? (platform === "win32" ? "" : "sh")
	const out = listed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map(hostRunner)
	if (env.INSTALLGEN_E2E_DOCKER === "1") {
		out.push(
			dockerRunner("dash", IMAGE, "dash", "curl", "sh"),
			dockerRunner("bash", IMAGE, "bash", "curl", "sh"),
			dockerRunner("zsh", IMAGE, "zsh", "curl", "sh"),
			dockerRunner("busybox", BUSYBOX_IMAGE, "sh", "wget", "sh"),
			dockerRunner("pwsh", PWSH_IMAGE, "pwsh", "irm", "ps1"),
		)
	}
	return out
}

/**
 * A host `pwsh` from INSTALLGEN_E2E_SHELLS, else Docker pwsh under INSTALLGEN_E2E_DOCKER=1, else none. Append a
 * base64 UTF-16LE script: `-Command -` reads stdin line by line, which splits multi-line literals.
 */
export function pwshCommand(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
	const listed = (env.INSTALLGEN_E2E_SHELLS ?? "").split(",").map((s) => s.trim())
	const host = listed.find((s) => s === "pwsh" || s === "powershell")
	if (host) return [host, "-NoProfile", "-NonInteractive", "-EncodedCommand"]
	if (env.INSTALLGEN_E2E_DOCKER === "1") {
		return ["docker", "run", "--rm", PWSH_IMAGE, "pwsh", "-NoProfile", "-NonInteractive", "-EncodedCommand"]
	}
	return undefined
}

/** `curl … | sh -s -- args` (or wget) for the runner's shell. */
export function shPipeline(runner: Runner, url: string, args: readonly string[] = []): string {
	const fetch = runner.fetch === "wget" ? `wget -qO- '${url}'` : `curl -fsSL '${url}'`
	const rest = args.map(shQuote).join(" ")
	return `${fetch} | ${runner.shell} -s --${rest ? ` ${rest}` : ""}`
}
