# Changelog

All notable changes to [`@lovrozagar/installgen`](https://www.npmjs.com/package/@lovrozagar/installgen) are documented in this file.

## 0.1.0

### Added

- `defineConfig` and the `InstallgenConfig` types: `name`, `baseUrl` and `assetPath` are required; `platforms`, `checksumsPath`, `latestPath`, `binaryInArchive`, `tagPrefix`, `installDir`, `envPrefix`, `modifyPath`, `message`, `scriptUrls` and `outDir` are optional. Path props are functions of `{ version, tag, os, arch }`, called once per platform; `version` and `tag` are tokens the scripts fill in at install time.
- Build-time checks, each naming the prop and the platform: paths with a scheme or a leading `/`, an `assetPath` without a token, duplicate assets (a darwin universal binary excepted), a token run through a string method, non-ASCII output, and invalid `name`, `envPrefix`, `installDir`, `tagPrefix`, `baseUrl` and `scriptUrls`.
- `install.sh`: POSIX sh for dash, bash 3.2+, zsh and busybox ash, with curl or wget. It detects Rosetta, falls back from darwin/arm64 to amd64 with a warning, checks its tools before downloading, verifies sha256 checksums in GNU, `*`, BSD and bare formats, installs by staged rename, and adds the install dir to the right shell profile once.
- `install.ps1`: Windows PowerShell 5.1 and PowerShell 7+. It reads the real CPU from the registry, falls back from ARM64 to x64, shows a progress bar, verifies checksums, renames a running `.exe` aside before replacing it, and prepends the install dir to the user `Path` in the registry. It throws instead of exiting, so `irm | iex` keeps the window open.
- Both scripts: version pinning by argument or `<PREFIX>_VERSION`, `v1.2.3` or `1.2.3`; `<PREFIX>_INSTALL_DIR` and `<PREFIX>_NO_MODIFY_PATH`; `$GITHUB_PATH`; a shadowing warning; color and check marks on a terminal only; ASCII output.
- `installgen init` with the `raw`, `goreleaser` and `github` presets, writing `.mts` unless the project's `package.json` has `"type": "module"`.
- `installgen build`, writing `installers/install.sh` (0755) and `install.ps1` (0644), with `--out` and `--default-version`.
- `installgen check`, confirming every platform's asset (HEAD, then a ranged GET) and checksum entry for the latest or a given version, and `check --list` to print every URL without fetching.
- Config loading for `.ts`, `.mts`, `.js` and `.mjs` on Node 22.18+ and Bun, with the config's `@lovrozagar/installgen` import resolved to the running package, so no local install is needed.
