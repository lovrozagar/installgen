import { expect } from "vitest"

/** The structural contract every rendered pair meets: render.test.ts and the golden examples both assert it. */
export function assertStructure(out: { sh?: string | undefined; ps1?: string | undefined }, https: boolean): void {
	for (const script of [out.sh, out.ps1]) {
		if (script === undefined) continue
		expect(script).not.toMatch(/[\u0080-\uffff]/)
		expect(script).not.toMatch(/installgen_(version|tag)/i)
		expect(script).not.toMatch(/@@[A-Z0-9_]+@@/)
	}
	if (out.sh !== undefined) {
		expect(out.sh.startsWith("#!/bin/sh\n")).toBe(true)
		expect(out.sh.endsWith('\nmain "$@"\n')).toBe(true)
		expect(out.sh).toMatch(/^main\(\) \{$/m)
		expect(out.sh.includes("--proto '=https' --tlsv1.2")).toBe(https)
		expect(out.sh.includes("--https-only")).toBe(https)
	}
	if (out.ps1 !== undefined) {
		expect(out.ps1.startsWith("param([string]$Version)\n")).toBe(true)
		expect(out.ps1).toMatch(/^& \{$/m)
		expect(out.ps1.trimEnd().endsWith("}")).toBe(true)
		expect(out.ps1).not.toMatch(/\bexit\b/i)
	}
}
