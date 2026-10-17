import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const README = join(HERE, "../../../README.md")
const SOURCE = readFileSync(join(HERE, "../src/config/define-config.ts"), "utf8")

interface Prop {
	type: string
	required: boolean
}

/** `InstallgenConfig`'s props from the source: one per line, `name?: type`. */
function sourceProps(): Map<string, Prop> {
	const body = /export interface InstallgenConfig \{\n([\s\S]*?)\n\}/.exec(SOURCE)?.[1] ?? ""
	const props = new Map<string, Prop>()
	for (const m of body.matchAll(/^\t(\w+)(\?)?: (.+)$/gm)) {
		props.set(m[1] as string, { type: (m[3] as string).trim(), required: m[2] === undefined })
	}
	return props
}

const unquote = (s: string) => s.replace(/^`(.*)`$/, "$1")

/** The README's prop table: `| Prop | Type | Default | Meaning |`. */
function readmeProps(markdown: string): Map<string, Prop & { default: string; meaning: string }> {
	const lines = markdown.split("\n")
	const start = lines.findIndex((l) => /^\| *Prop *\| *Type *\| *Default *\| *Meaning *\|$/.test(l))
	const rows = new Map<string, Prop & { default: string; meaning: string }>()
	for (const line of lines.slice(start + 2)) {
		if (!line.startsWith("|")) break
		const cells = line
			.slice(1, -1)
			.split(/(?<!\\)\|/)
			.map((c) => c.trim().replaceAll("\\|", "|"))
		const [prop = "", type = "", def = "", meaning = ""] = cells
		rows.set(unquote(prop), { type: unquote(type), required: def === "required", default: def, meaning })
	}
	return rows
}

describe("README.md", () => {
	test("exists at the repo root", () => {
		expect(existsSync(README)).toBe(true)
	})

	test("the prop table lists exactly InstallgenConfig's props, with their types and required-ness", () => {
		const fromSource = sourceProps()
		const fromReadme = readmeProps(readFileSync(README, "utf8"))
		expect(fromSource.size).toBeGreaterThan(10)
		expect([...fromReadme.keys()].toSorted()).toEqual([...fromSource.keys()].toSorted())
		for (const [name, prop] of fromSource) {
			const row = fromReadme.get(name)
			expect(row?.type, `${name} type`).toBe(prop.type)
			expect(row?.required, `${name} required`).toBe(prop.required)
			expect(row?.default, `${name} default`).not.toBe("")
			expect(row?.meaning, `${name} meaning`).not.toBe("")
		}
	})

	test("every installgen command line in the README names a real command and option", async () => {
		const { run } = await import("../src/cli.ts")
		const markdown = readFileSync(README, "utf8")
		const commands = [...markdown.matchAll(/^\$ (?:bunx (?:--bun )?(?:@lovrozagar\/)?)?installgen ([^\n#|]*)/gm)].map(
			(m) => (m[1] as string).trim(),
		)
		expect(commands.length).toBeGreaterThan(3)
		for (const line of commands) {
			const [command, ...args] = line.split(/\s+/)
			const err: string[] = []
			/* --help on the same command and options proves they parse; it never touches the filesystem */
			const code = await run([command as string, ...args, "--help"], {
				cwd: HERE,
				env: {},
				stdout: () => {},
				stderr: (t) => void err.push(t),
				isTTY: false,
			})
			expect(code, `installgen ${line}: ${err.join("")}`).toBe(0)
		}
	})
})
