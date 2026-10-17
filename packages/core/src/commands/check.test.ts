import { describe, expect, test } from "vitest"
import { findChecksum } from "./check.ts"

const H = "a".repeat(64)

describe("findChecksum", () => {
	test.each([
		["hash  file", `${"b".repeat(64)}  other.tar.gz\n${H}  app.tar.gz\n`],
		["hash *file", `${H} *app.tar.gz\n`],
		["CRLF", `${H}  app.tar.gz\r\n`],
		["BSD", `SHA256 (other) = ${"b".repeat(64)}\nSHA256 (app.tar.gz) = ${H}\n`],
		["one bare hash", `${H}\n`],
	])("%s", (_name, text) => {
		expect(findChecksum(text, "app.tar.gz")).toBe(H)
	})

	test.each([
		["another file only", `${H}  other.tar.gz\n`],
		["a prefix of the name", `${H}  app.tar\n`],
		["two bare lines", `${H}\n${H}\n`],
		["empty", ""],
	])("%s: none", (_name, text) => {
		expect(findChecksum(text, "app.tar.gz")).toBeUndefined()
	})
})
