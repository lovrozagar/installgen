import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"

/*
 * A stand-in for cosign. It records its argv in `<dir>/cosign.args`, one per line, and exits 0 only when the file after
 * `--bundle` holds `good`. On Windows it is a `cosign.cmd` that runs the same logic in Windows PowerShell, which
 * `Get-Command -CommandType Application` finds through PATHEXT; elsewhere a POSIX sh script, for the host and Docker
 * shells and Docker pwsh alike.
 */

const SH = `#!/bin/sh
dir=$(dirname "$0")
: >"$dir/cosign.args"
for a in "$@"; do printf '%s\\n' "$a" >>"$dir/cosign.args"; done
while [ $# -gt 0 ]; do
	if [ "$1" = --bundle ]; then
		[ "$(cat "$2")" = good ] && exit 0
		echo 'Error: none of the expected identities matched' >&2
		exit 1
	fi
	shift
done
exit 1
`

const PS1 = `$args | Set-Content -Path (Join-Path $PSScriptRoot 'cosign.args')
$i = [array]::IndexOf($args, '--bundle')
if ($i -ge 0 -and (Get-Content -Raw $args[$i + 1]).Trim() -eq 'good') { exit 0 }
[Console]::Error.WriteLine('Error: none of the expected identities matched')
exit 1
`

export function fakeCosign(dir: string, windows = process.platform === "win32"): void {
	if (windows) {
		writeFileSync(join(dir, "cosign-fake.ps1"), PS1)
		writeFileSync(
			join(dir, "cosign.cmd"),
			`@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cosign-fake.ps1" %*\r\n@exit /b %ERRORLEVEL%\r\n`,
		)
		return
	}
	writeFileSync(join(dir, "cosign"), SH)
	chmodSync(join(dir, "cosign"), 0o755)
}

/** The argv the fake cosign in `dir` last saw, or undefined when it never ran. */
export function cosignArgs(dir: string): string[] | undefined {
	const file = join(dir, "cosign.args")
	return existsSync(file) ? readFileSync(file, "utf8").replaceAll("\r", "").split("\n").filter(Boolean) : undefined
}

/** `path` without the directories that hold a real cosign, so only a test's own shim can answer to the name. */
export function withoutCosign(path: string): string {
	return path
		.split(delimiter)
		.filter((dir) => dir === "" || !["cosign", "cosign.exe"].some((bin) => existsSync(join(dir, bin))))
		.join(delimiter)
}
