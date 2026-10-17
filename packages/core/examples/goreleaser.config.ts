import { defineConfig, type Arch, type Os } from "@lovrozagar/installgen"

/*
 * GoReleaser's `goreleaser init` archive names, uploaded to your own host under the tag:
 *
 *   v1.2.3/my-cli_1.2.3_Linux_x86_64.tar.gz
 *   v1.2.3/my-cli_1.2.3_Windows_arm64.zip
 *   v1.2.3/my-cli_1.2.3_checksums.txt
 *   latest                                   "v1.2.3"
 */
const osName: Record<Os, string> = { linux: "Linux", darwin: "Darwin", windows: "Windows" }
const archName: Record<Arch, string> = { amd64: "x86_64", arm64: "arm64" }

export default defineConfig({
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${osName[os]}_${archName[arch]}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag, version }) => `${tag}/my-cli_${version}_checksums.txt`,
	message: "Run `my-cli --help` to get started.",
})
