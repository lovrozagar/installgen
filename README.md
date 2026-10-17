# installgen

Generate `curl -fsSL <url> | sh` and `irm <url> | iex` installers for the prebuilt binaries of your CLI. You keep your release pipeline, your file names and your host; installgen writes the two scripts that find the right binary, verify it, install it without admin rights and put it on `PATH`.

Package: [`@lovrozagar/installgen`](https://www.npmjs.com/package/@lovrozagar/installgen). The CLI binary is `installgen`.

```console
$ curl -fsSL https://dl.example.com/my-cli/install.sh | sh
my-cli installer
✓ Detected   linux/amd64
✓ Version    1.2.3 (latest)
✓ Download   my-cli_1.2.3_linux_amd64.tar.gz
✓ Verified   sha256
✓ Installed  ~/.my-cli/bin/my-cli
✓ PATH       added to ~/.bashrc

my-cli 1.2.3 installed.
Run `my-cli --help` to get started.
Restart your shell, or run: export PATH="$HOME/.my-cli/bin:$PATH"
To uninstall: rm ~/.my-cli/bin/my-cli
To update: curl -fsSL https://dl.example.com/my-cli/install.sh | sh
```

That is a real run of a generated `install.sh` on a terminal, with the test server's URL replaced by `dl.example.com`. On a terminal the download shows curl's progress bar, which is erased once the file is in. Piped output has no color, no bar, and `+` in place of `✓`.

## Table of contents

- [Why](#why)
- [Install](#install)
- [Quick start](#quick-start)
- [Config](#config)
  - [Props](#props)
  - [Path functions, `version` and `tag`](#path-functions-version-and-tag)
  - [Loading the config](#loading-the-config)
- [CLI](#cli)
  - [`installgen init`](#installgen-init)
  - [`installgen build`](#installgen-build)
  - [`installgen check`](#installgen-check)
- [What the scripts do](#what-the-scripts-do)
  - [End-user overrides](#end-user-overrides)
  - [Checksum formats](#checksum-formats)
  - [Old Windows PowerShell 5.1](#old-windows-powershell-51)
- [Hosting](#hosting)
  - [Layout](#layout)
  - [Release order](#release-order)
- [Security model](#security-model)
- [Non-goals](#non-goals)
- [Library exports](#library-exports)
- [Develop](#develop)
- [License](#license)

## Why

Every CLI that ships binaries ends up hand-writing the same two scripts: detect the OS and CPU, map them to your file names, download, verify, extract, install, edit `PATH`, and do it again in PowerShell. The existing generators each take part of that away from you:

- [binstaller](https://github.com/binary-install/binstaller): GitHub Releases only, sh only, no `PATH` edit.
- [dist](https://axodotdev.github.io/cargo-dist/book/reference/config.html) (cargo-dist): owns your build and CI, names files by Rust target triple, and bakes the release tag into each release's installer.
- [eish](https://docs.rs/crate/eish/0.1.0): GitHub Releases only, no checksums.
- [godownloader](https://github.com/goreleaser/godownloader): archived; [GoReleaser #4565](https://github.com/goreleaser/goreleaser/issues/4565), its replacement, is still open.

installgen takes your prebuilt binaries under your own names, on any https host, and writes both scripts, with checksums and `PATH`. Its scripts read the version at install time, so one pair serves every release.

## Install

installgen runs on Node 22.18 or later (23.6 or later on Node 23) and on Bun. It has no runtime dependencies.

```bash
bun add -d @lovrozagar/installgen   # then: bunx installgen <command>
```

Zero-install, from any directory:

```bash
bunx @lovrozagar/installgen build
```

`bunx` honors the bin's `#!/usr/bin/env node` shebang, so these run on Node. `bunx --bun @lovrozagar/installgen` runs them on Bun, which also loads a `.ts` config on a Node older than 22.18.

## Quick start

```console
$ bunx installgen init --preset goreleaser
+ wrote         installgen.config.mts (preset goreleaser)
Set baseUrl and assetPath for your releases, then run `installgen build`.
```

The preset is a complete config for the archive names `goreleaser init` writes:

```ts
import { defineConfig, type Arch, type Os } from "@lovrozagar/installgen"

const osName: Record<Os, string> = { linux: "Linux", darwin: "Darwin", windows: "Windows" }
const archName: Record<Arch, string> = { amd64: "x86_64", arm64: "arm64" }

export default defineConfig({
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ tag, os, arch }) =>
		`${tag}/my-cli_${osName[os]}_${archName[arch]}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag, version }) => `${tag}/my-cli_${version}_checksums.txt`,
	message: "Run `my-cli --help` to get started.",
})
```

Point `baseUrl` at your host, then build:

```console
$ bunx installgen build
+ wrote         installers/install.sh
+ wrote         installers/install.ps1
```

Upload both next to your releases, and your users run:

```bash
curl -fsSL https://dl.example.com/my-cli/install.sh | sh
powershell -c "irm https://dl.example.com/my-cli/install.ps1 | iex"
```

## Config

`installgen.config.ts` default-exports `defineConfig({ ... })`. `defineConfig` returns its argument; it is there for the types. A config with no runtime import works too: `import type { InstallgenConfig } from "@lovrozagar/installgen"` and `export default { ... } satisfies InstallgenConfig`.

### Props

| Prop              | Type                                | Default                                     | Meaning                                                                                                |
| ----------------- | ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `name`            | `string`                            | required                                    | The binary name, `^[A-Za-z0-9][A-Za-z0-9._-]*$`; Windows installs `<name>.exe`.                        |
| `baseUrl`         | `string`                            | required                                    | Where the files live. https only; http is allowed on 127.0.0.1, localhost and [::1] for tests.         |
| `assetPath`       | `(ctx: PathContext) => string`      | required                                    | The asset's path under `baseUrl`, per platform. Must use `version` or `tag`.                           |
| `platforms`       | `readonly Platform[]`               | all six                                     | Which of `linux`, `darwin`, `windows` × `amd64`, `arm64` you ship.                                     |
| `checksumsPath`   | `(ctx: ChecksumsContext) => string` | none: no verification, and a warning        | A shared `checksums.txt` or a per-asset `<asset>.sha256`, per platform; `ctx.asset` is the asset path. |
| `latestPath`      | `string`                            | `"latest"`                                  | The file under `baseUrl` that holds the latest version (`1.2.3` or `v1.2.3`).                          |
| `binaryInArchive` | `(ctx: PathContext) => string`      | search the archive                          | The binary's path inside an archive. The search wants exactly one file named `<name>`.                 |
| `tagPrefix`       | `string`                            | `"v"`                                       | `tag` is `tagPrefix` + `version`; `^[A-Za-z0-9._-]*$`, empty allowed.                                  |
| `installDir`      | `string`                            | `"~/.<name>/bin"`                           | Must start with `~/`: `$HOME` in sh, the user profile in ps1. Letters, digits, space, `.`, `_`, `-`.   |
| `envPrefix`       | `string`                            | `name` uppercased, non-alphanumerics → `_`  | The prefix of the end-user overrides: `my-cli` → `MY_CLI_VERSION`.                                     |
| `modifyPath`      | `boolean`                           | `true`                                      | Whether the scripts add the install dir to `PATH`.                                                     |
| `message`         | `string`                            | none                                        | Printed after a successful install. ASCII only.                                                        |
| `scriptUrls`      | `{ sh: string; ps1: string }`       | `baseUrl/install.sh`, `baseUrl/install.ps1` | Where you serve the scripts; the scripts print them in their hints.                                    |
| `outDir`          | `string`                            | `"installers"`                              | Where `installgen build` writes. Not `dist/`: `goreleaser release --clean` wipes it.                   |

`Os` is `"linux" | "darwin" | "windows"`, `Arch` is `"amd64" | "arm64"` (Go's names), and `Platform` is `` `${Os}/${Arch}` ``. Every value that reaches a script must be ASCII: Windows PowerShell 5.1 reads a script with no charset as ISO-8859-1.

### Path functions, `version` and `tag`

`assetPath`, `checksumsPath` and `binaryInArchive` are functions of `{ version, tag, os, arch }` (`checksumsPath` also gets `asset`). `build` calls each once per platform, with the real `os` and `arch`, so you can map names, pick extensions, or skip a platform's suffix in plain TypeScript.

`version` and `tag` are not strings. The version is only known at install time, so they are tokens you interpolate: `` `${tag}/my-cli_${version}.tar.gz` ``. The script fills them in when it runs. String methods on a token are type errors (`version.toUpperCase()` does not compile). For GoReleaser and GitHub, the tag is `v1.2.3` while file names carry `1.2.3`, which is why both exist.

The format comes from the asset's extension: `.tar.gz` and `.tgz` extract with tar, `.zip` with unzip (or bsdtar on Windows), and anything else installs as the raw binary.

`build` refuses, with the prop and the platform named:

- a path that starts with a scheme or `/`, or is empty
- an `assetPath` with neither token
- two platforms with the same asset, except darwin/amd64 + darwin/arm64 (a universal binary)
- a token run through a string method: `` `${version}`.toUpperCase() ``, `.replace(/_/g, "-")` and the like are reported as mangled
- a non-ASCII character, an invalid `name`, `envPrefix`, `installDir` or `tagPrefix`, a non-https `baseUrl` or `scriptUrls`

A known false positive: the mangle check reads every literal piece of a path, so a literal containing `installgen` followed by `version` or `tag` (`installgen_tag`, `InstallGen-Version`) is reported as mangled. `installgen_1.2.3_linux_amd64.tar.gz`, built as `` `installgen_${version}_${os}_${arch}.tar.gz` ``, is fine.

### Loading the config

`installgen` looks for `installgen.config.ts`, `.mts`, `.js` and `.mjs` in the current directory, in that order; `-c <path>` names another file. It never searches parent directories.

The config's `import ... from "@lovrozagar/installgen"` resolves to the running installgen, so it works with no local install. On Node that is a `module.registerHooks` resolve hook, removed again once the config is loaded; on Bun a `Bun.plugin` module.

Node runs a `.ts` config by stripping its types, which has limits:

- Node 22.18 or later, or 23.6 or later on 23. Older versions fail with a hint to run `bunx --bun @lovrozagar/installgen` or upgrade Node.
- Type-only imports need `type`: write `import { defineConfig, type Arch } from "@lovrozagar/installgen"`. Without it Node fails with "does not provide an export named".
- No `enum`, `namespace` or parameter properties: Node fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
- In a CommonJS project, where the nearest `package.json` has `"type": "commonjs"`, a `.ts` config fails with "Unexpected token 'export'". Rename it to `installgen.config.mts`. `installgen init` writes `.mts` unless the nearest `package.json` has `"type": "module"`.

## CLI

```console
$ installgen --help
Usage: installgen <command> [options]

Generate curl | sh and irm | iex installers for prebuilt CLI binaries.

Commands:
  init     write installgen.config.ts from a preset
  build    write install.sh and install.ps1
  check    confirm a release's assets and checksum entries are published

Options:
  -h, --help     show this help
  --version      show the installgen version

Run `installgen <command> --help` for a command's options.
```

A usage error exits 2; any other error prints one `error:` line and exits 1.

### `installgen init`

```console
$ installgen init --preset github
```

Writes a preset as your config: `raw` (the default: raw binaries on your own host), `goreleaser` (`goreleaser init` archive names under the tag), or `github` (GitHub Releases, reading the latest version through `releases/latest/download/`). It refuses to overwrite an existing config without `--force`. The presets are in [`packages/core/examples`](packages/core/examples).

### `installgen build`

```console
$ installgen build --out public --default-version v1.2.3
```

| option                        | default                                               |
| ----------------------------- | ----------------------------------------------------- |
| `-c, --config <path>`         | `installgen.config.{ts,mts,js,mjs}` in this directory |
| `--out <dir>`                 | the config's `outDir` (`installers`)                  |
| `--default-version <version>` | none: the scripts read `latestPath`                   |

Writes `install.sh` (mode 0755) and `install.ps1` (0644). A script whose OS has no platforms in the config is skipped, with a line that says so. Without `checksumsPath`, `build` warns that the installers will not verify downloads. `--default-version` bakes in the version the scripts install when the user names none; the `latest` file is then never read.

### `installgen check`

Confirms a release is complete before you point `latest` at it: it reads the version from `latestPath` (or `--default-version`), sends a HEAD for every platform's asset (a one-byte ranged GET where the host refuses HEAD), and finds every asset's line in its checksums file.

Against a release whose files are named `my-cli_<version>_<os>_<arch>`, with one archive not uploaded yet:

```console
$ installgen check
+ latest        1.2.3 (https://dl.example.com/my-cli/latest)
+ linux/amd64   https://dl.example.com/my-cli/v1.2.3/my-cli_1.2.3_linux_amd64.tar.gz, sha256 listed
+ linux/arm64   https://dl.example.com/my-cli/v1.2.3/my-cli_1.2.3_linux_arm64.tar.gz, sha256 listed
+ darwin/amd64  https://dl.example.com/my-cli/v1.2.3/my-cli_1.2.3_darwin_amd64.tar.gz, sha256 listed
x darwin/arm64  missing https://dl.example.com/my-cli/v1.2.3/my-cli_1.2.3_darwin_arm64.tar.gz (404)
+ windows/amd64 https://dl.example.com/my-cli/v1.2.3/my-cli_1.2.3_windows_amd64.zip, sha256 listed
+ windows/arm64 https://dl.example.com/my-cli/v1.2.3/my-cli_1.2.3_windows_arm64.zip, sha256 listed
1 problem
```

It exits 1 when anything is missing. `--list` prints every URL the installers fetch, without fetching, with `{version}` and `{tag}` where no `--default-version` is given:

```console
$ installgen check --list
latest https://dl.example.com/my-cli/latest
linux/amd64 https://dl.example.com/my-cli/{tag}/my-cli_Linux_x86_64.tar.gz
linux/amd64 https://dl.example.com/my-cli/{tag}/my-cli_{version}_checksums.txt
linux/arm64 https://dl.example.com/my-cli/{tag}/my-cli_Linux_arm64.tar.gz
linux/arm64 https://dl.example.com/my-cli/{tag}/my-cli_{version}_checksums.txt
darwin/amd64 https://dl.example.com/my-cli/{tag}/my-cli_Darwin_x86_64.tar.gz
darwin/amd64 https://dl.example.com/my-cli/{tag}/my-cli_{version}_checksums.txt
darwin/arm64 https://dl.example.com/my-cli/{tag}/my-cli_Darwin_arm64.tar.gz
darwin/arm64 https://dl.example.com/my-cli/{tag}/my-cli_{version}_checksums.txt
windows/amd64 https://dl.example.com/my-cli/{tag}/my-cli_Windows_x86_64.zip
windows/amd64 https://dl.example.com/my-cli/{tag}/my-cli_{version}_checksums.txt
windows/arm64 https://dl.example.com/my-cli/{tag}/my-cli_Windows_arm64.zip
windows/arm64 https://dl.example.com/my-cli/{tag}/my-cli_{version}_checksums.txt
```

## What the scripts do

`install.sh` is POSIX sh: it runs under dash, bash 3.2+, zsh and busybox ash, needs curl or wget, and runs everything from one `main` call on its last line, so a truncated download runs nothing. `install.ps1` runs on Windows PowerShell 5.1 and PowerShell 7+, needs the FullLanguage mode, and throws on failure instead of exiting, so `irm | iex` never closes the user's window.

In order, both scripts:

1. **Detect** the platform. sh reads `uname`; an x86_64 shell under Rosetta (`sysctl.proc_translated`) still gets the arm64 build. ps1 reads the real CPU from the registry, so an emulated x64 PowerShell on ARM64 still counts as arm64. Without a native build, darwin/arm64 falls back to darwin/amd64 with a warning that Rosetta 2 is needed, and windows/arm64 to windows/amd64 under emulation. Git Bash, MSYS and Cygwin get the `irm | iex` line instead.
2. **Check the tools** before the first download: tar and gzip for `.tar.gz`; unzip, busybox unzip or bsdtar for `.zip`; sha256sum, shasum or openssl when checksums are configured. A missing tool is named.
3. **Resolve the version**: the argument, then `<PREFIX>_VERSION`, then the baked `--default-version`, then the `latest` file. `1.2.3` and `v1.2.3` both work; whitespace and CR are stripped, and anything but `[A-Za-z0-9._+-]` is refused.
4. **Download**, with curl's progress bar (sh) or a redrawn bar (ps1) on a terminal. With an https `baseUrl`, curl gets `--proto '=https' --tlsv1.2` and GNU wget `--https-only`.
5. **Verify** the sha256, or show a `!` row when no checksums are published.
6. **Install** into `installDir`. sh stages the file next to the target and renames it over; ps1 renames a running `.exe` aside before copying the new one in. A re-run says "Updated".
7. **Update `PATH`**, unless the dir is already on it:
   - sh appends one line to the profile of `$SHELL`: `${ZDOTDIR:-$HOME}/.zshrc`, `.bash_profile` on macOS and `.bashrc` elsewhere for bash, `conf.d/<name>.fish` with `fish_add_path`, otherwise `.profile`. A re-run finds the line and adds nothing.
   - ps1 prepends the dir to the user `Path` in the registry (read unexpanded, written as `REG_EXPAND_SZ`), tells Explorer, and updates the current session.
   - Both append to `$GITHUB_PATH` when it is set, and warn when another copy of the binary comes first on `PATH`.

### End-user overrides

| sh                                   | ps1                                     | effect                              |
| ------------------------------------ | --------------------------------------- | ----------------------------------- |
| `curl -fsSL <url> \| sh -s -- 1.2.3` | `iex "& {$(irm <url>)} -Version 1.2.3"` | install that version                |
| `MY_CLI_VERSION=1.2.3`               | `$env:MY_CLI_VERSION = '1.2.3'`         | the same, through the environment   |
| `MY_CLI_INSTALL_DIR=/opt/my-cli/bin` | `$env:MY_CLI_INSTALL_DIR = 'D:\tools'`  | install somewhere else              |
| `MY_CLI_NO_MODIFY_PATH=1`            | `$env:MY_CLI_NO_MODIFY_PATH = '1'`      | leave `PATH` and the profiles alone |
| `NO_COLOR=1`                         | `$env:NO_COLOR = '1'`                   | no color                            |

`MY_CLI` is the `envPrefix`.

### Checksum formats

The scripts and `installgen check` find the asset's line by exact file name, in any of:

```text
<sha256>  my-cli_1.2.3_linux_amd64.tar.gz        sha256sum, GoReleaser
<sha256> *my-cli_1.2.3_linux_amd64.tar.gz        sha256sum --binary
SHA256 (my-cli_1.2.3_linux_amd64.tar.gz) = <sha256>   BSD, shasum --tag
<sha256>                                          a per-asset .sha256 holding one hash
```

Uppercase hex is accepted.

### Old Windows PowerShell 5.1

The script switches on TLS 1.2 itself, but only after the first `irm` has fetched it. On an old Windows PowerShell 5.1 whose .NET defaults to TLS 1.0, that first request fails against a TLS 1.2-only host. Users there prefix the line:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://dl.example.com/my-cli/install.ps1 | iex
```

## Hosting

The scripts fetch from `baseUrl` over https, or http on loopback. Where those files live is up to you.

### Layout

With the `goreleaser` preset:

```text
my-cli/
  install.sh
  install.ps1
  latest                              "v1.2.3"
  v1.2.3/
    my-cli_Linux_x86_64.tar.gz
    my-cli_Darwin_arm64.tar.gz
    my-cli_Windows_x86_64.zip
    ...
    my-cli_1.2.3_checksums.txt
```

### Release order

1. Upload the versioned files: the archives and the checksums file.
2. Run `installgen check --default-version v1.2.3`. It fails while anything is missing.
3. Overwrite `latest` with `v1.2.3`. Until this step, new installs keep getting the previous release, never a half-uploaded one.

The scripts only change when your config does; upload them again after a `build` that changed them.

With the `github` preset, upload the scripts and a `version.txt` holding the tag to every release, so `releases/latest/download/` serves the newest of each:

```bash
printf 'v1.2.3\n' > version.txt
gh release upload v1.2.3 installers/install.sh installers/install.ps1 version.txt --clobber
```

If users fetch the scripts from a shorter URL that redirects to them, set `scriptUrls` to it, so the scripts print it in their hints.

## Security model

The checksums come from the same host as the binaries. They catch a truncated or corrupted download, a stale CDN copy, and a half-finished upload. They do not protect against a compromised host or leaked bucket credentials: whoever can replace the binary can replace its checksum too. The scripts add no signature check (minisign, cosign); that is a non-goal for now.

What the scripts guarantee themselves: every value from your config is single-quoted, so nothing in it runs; the version from `latest` or the user is validated before use; with an https `baseUrl`, curl and GNU wget refuse to follow a redirect to http, and `install.ps1` refuses one too (Windows PowerShell 5.1's .NET Framework would otherwise follow it); and the scripts are ASCII, so no encoding changes what they say.

`curl | sh` runs whatever the host serves at that moment. Users who want to read first can download the script, read it, and run it.

## Non-goals

- musl versus glibc detection; 386, armv7 and `.tar.xz`
- elevation, system-wide installs, an uninstall command (the scripts print the one-line `rm`)
- uploading: installgen writes the scripts, your pipeline uploads them
- a JSON config
- signatures, shell completions, standalone installgen binaries

## Library exports

`@lovrozagar/installgen` exports `defineConfig` and the types `InstallgenConfig`, `PathContext`, `ChecksumsContext`, `VersionToken`, `TagToken`, `Os`, `Arch` and `Platform`. The CLI is the bin; it has no programmatic API.

## Develop

Requires [Bun](https://bun.sh) 1.4.3 (the root `packageManager`) and Node 22.18 or later.

```bash
bun install
bun run fmt          # oxfmt, rewrites in place (CI runs fmt:check)
bun run lint         # oxlint
bun run typecheck
bun run test         # tsc, then vitest with 100% per-file coverage
bun run test:e2e     # also the Docker runners: dash, bash, zsh, busybox and pwsh
bun run verify       # every gate; stamps the commit when they all pass
```

The e2e suites serve real releases from a local server and run the generated scripts as `curl … | sh` and `irm … | iex`. `INSTALLGEN_E2E_SHELLS` lists the host shells (default `sh`; `sh,pwsh` adds a host PowerShell), and `INSTALLGEN_E2E_DOCKER=1` adds the Docker runners plus shellcheck and PSScriptAnalyzer on the rendered scripts. The rendered examples are checked in under `packages/core/tests/golden`; refresh them with `UPDATE_GOLDEN=1 bun run test`.

Release: bump `packages/core/package.json`, commit, tag `vX.Y.Z` matching that version, and push the tag. `.github/workflows/release.yml` publishes `@lovrozagar/installgen` to npm through GitHub Actions OIDC trusted publishing. Never `npm publish` from a laptop.

## License

MIT. Copyright (c) 2026 Lovro Žagar.
