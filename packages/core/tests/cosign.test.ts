import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { InstallgenConfig } from "../src/config/define-config.ts"
import { resolveConfig } from "../src/config/resolve.ts"
import { render } from "../src/render/render.ts"
import { startServer, type TestServer } from "./support/server.ts"
import { runners, shPipeline } from "./support/shells.ts"

/*
 * The real cosign against a real keyless signature: GoReleaser v2.19.0's checksums.txt and its sigstore bundle,
 * byte for byte from https://github.com/goreleaser/goreleaser/releases/download/v2.19.0/. The served archive is not
 * GoReleaser's, so an accepted signature shows as a Signed row followed by a checksum mismatch. Runs when cosign is on
 * PATH (CI installs it); cosign fetches the sigstore trust root, so it needs the network.
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "sigstore")
const COSIGN = (process.env.PATH ?? "")
	.split(delimiter)
	.filter(Boolean)
	.map((dir) => join(dir, "cosign"))
	.find(existsSync)
const RUNNER = runners().find((r) => r.kind === "sh" && r.name.startsWith("host "))
const ARCHIVE = {
	"linux/amd64": "goreleaser_Linux_x86_64.tar.gz",
	"linux/arm64": "goreleaser_Linux_arm64.tar.gz",
	"darwin/amd64": "goreleaser_Darwin_x86_64.tar.gz",
	"darwin/arm64": "goreleaser_Darwin_arm64.tar.gz",
} as const
const HOST =
	`${process.platform === "darwin" ? "darwin" : "linux"}/${process.arch === "arm64" ? "arm64" : "amd64"}` as const
const WORKFLOW = "https://github.com/goreleaser/goreleaser/.github/workflows/release.yml@refs/tags/"

/* cosign and a host sh come from the environment; say so rather than report an empty file */
if (!COSIGN || !RUNNER) test.skip("real cosign: no cosign on PATH, or no host sh runner", () => {})

describe.runIf(COSIGN && RUNNER)("real cosign on GoReleaser v2.19.0", () => {
	let server: TestServer
	let cases = 0
	const roots: string[] = []
	beforeAll(async () => {
		server = await startServer()
	})
	afterAll(async () => {
		await server.close()
		for (const r of roots) rmSync(r, { recursive: true, force: true })
	})

	async function install(
		signature: NonNullable<InstallgenConfig["signature"]>,
		checksums = readFileSync(join(FIXTURES, "checksums.txt")),
	) {
		const prefix = `/real${++cases}`
		const resolved = resolveConfig({
			name: "goreleaser",
			baseUrl: `${server.url}${prefix}`,
			platforms: [HOST],
			assetPath: ({ tag }) => `${tag}/${ARCHIVE[HOST]}`,
			checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
			signature,
		})
		const sh = render(resolved, { defaultVersion: "2.19.0" }).sh as string
		server.set(`${prefix}/install.sh`, sh)
		server.set(`${prefix}/v2.19.0/${ARCHIVE[HOST]}`, Buffer.from("not goreleaser"))
		server.set(`${prefix}/v2.19.0/checksums.txt`, checksums)
		server.set(
			`${prefix}/v2.19.0/checksums.txt.sigstore.json`,
			readFileSync(join(FIXTURES, "checksums.txt.sigstore.json")),
		)

		const root = mkdtempSync(join(tmpdir(), "installgen-cosign-"))
		roots.push(root)
		const home = join(root, "home")
		const shims = join(root, "shims")
		mkdirSync(home)
		mkdirSync(shims)
		symlinkSync(COSIGN as string, join(shims, "cosign"))
		const runner = RUNNER as NonNullable<typeof RUNNER>
		return runner.run({
			command: shPipeline(runner, `${server.url}${prefix}/install.sh`),
			cwd: root,
			env: { HOME: home, PATH: `${shims}:${runner.systemPath}`, SHELL: "/bin/sh" },
		})
	}

	test("accepts the release workflow's signature for its own tag", async () => {
		const r = await install({ identity: ({ tag }) => `${WORKFLOW}${tag}` })
		expect(r.stdout, r.stdout + r.stderr).toMatch(/Signed +cosign/)
		expect(r.stderr).toContain(`checksum mismatch for ${ARCHIVE[HOST]}`)
	})

	test("refuses the signature under another tag's identity", async () => {
		const r = await install({ identity: () => `${WORKFLOW}v2.18.0` })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain(`checksums.txt: cosign could not verify it as signed by ${WORKFLOW}v2.18.0`)
	})

	test("refuses a checksums file changed by one byte", async () => {
		const tampered = Buffer.concat([readFileSync(join(FIXTURES, "checksums.txt")), Buffer.from("\n")])
		const r = await install({ identity: ({ tag }) => `${WORKFLOW}${tag}` }, tampered)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("cosign could not verify it as signed by")
	})
})
