import { defineConfig } from "@lovrozagar/installgen"

/*
 * Raw binaries on your own host:
 *
 *   1.2.3/my-cli-linux-amd64
 *   1.2.3/my-cli-windows-amd64.exe
 *   1.2.3/checksums.txt        sha256sum output for every binary
 *   latest                     "1.2.3"
 */
export default defineConfig({
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ version, os, arch }) => `${version}/my-cli-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
	checksumsPath: ({ version }) => `${version}/checksums.txt`,
	tagPrefix: "",
})
