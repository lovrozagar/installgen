import { spawnSync } from "node:child_process"
import { describe, expect, test } from "vitest"
import type { Segment } from "../config/types.ts"
import { pwshCommand } from "../../tests/support/shells.ts"
import { psString, shWord } from "./quote.ts"

const lit = (value: string): Segment => ({ kind: "literal", value })
const V: Segment = { kind: "version" }
const T: Segment = { kind: "tag" }

const HOSTILE = [
	"plain",
	"it's",
	"''",
	"$(touch /tmp/installgen-pwned)",
	"${HOME}",
	"$HOME",
	"`id`",
	'"double"',
	"a;b && c || d",
	"line1\nline2",
	"tab\there",
	"back\\slash\\",
	"* ? [a] ~",
	"$env:PATH",
	"@(1,2)",
	"#comment",
	"-dash",
	"%PATH%",
	"",
]

const PWSH = pwshCommand()

/* the shell's own values for the tokens, so a round-trip proves tokens become variable expansions */
function shEval(word: string): string {
	const result = spawnSync("sh", ["-c", `version='1.2.3'; tag='v1.2.3'; printf '%s' ${word}`], { encoding: "utf8" })
	expect(result.status, result.stderr).toBe(0)
	return result.stdout
}

function pwshEval(exprs: readonly string[]): string[] {
	const script = [
		"$ver = '1.2.3'",
		"$tag = 'v1.2.3'",
		...exprs.map(
			(e) =>
				`[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${e}))); [Console]::Out.Write(':')`,
		),
	].join("\n")
	const [bin, ...args] = PWSH as [string, ...string[]]
	const result = spawnSync(bin, [...args, Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" })
	expect(result.status, result.stderr).toBe(0)
	return result.stdout
		.split(":")
		.slice(0, -1)
		.map((b64) => Buffer.from(b64, "base64").toString("utf8"))
}

describe("shWord", () => {
	test("single-quotes literals and expands tokens", () => {
		expect(shWord([lit("a")])).toBe("'a'")
		expect(shWord([T, lit("/app_"), V])).toBe(`"$tag"'/app_'"$version"`)
		expect(shWord([lit("it's")])).toBe(`'it'\\''s'`)
		expect(shWord([])).toBe("''")
	})

	test.each(HOSTILE)("round-trips %j in host sh", (value) => {
		expect(shEval(shWord([lit(value)]))).toBe(value)
	})

	test("round-trips tokens between hostile literals in host sh", () => {
		expect(shEval(shWord([lit("'$("), T, lit("`;\n"), V, lit('"')]))).toBe("'$(v1.2.3`;\n1.2.3\"")
	})
})

describe("psString", () => {
	test("single-quotes literals and concatenates tokens", () => {
		expect(psString([lit("a")])).toBe("'a'")
		expect(psString([T, lit("/app_"), V])).toBe("($tag + '/app_' + $ver)")
		expect(psString([lit("it's")])).toBe("'it''s'")
		expect(psString([V])).toBe("$ver")
		expect(psString([])).toBe("''")
	})

	test.runIf(PWSH)("round-trips every hostile literal and tokens in pwsh (host or Docker)", () => {
		const cases = [...HOSTILE.map((v) => [lit(v)]), [lit("'$("), T, lit("`;\n"), V, lit('"')]]
		expect(pwshEval(cases.map((c) => psString(c)))).toEqual([...HOSTILE, "'$(v1.2.3`;\n1.2.3\""])
	})
})
