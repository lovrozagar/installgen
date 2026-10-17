import type { Segment } from "../config/types.ts"

/*
 * Literals are single-quoted, where neither shell expands anything; the tokens become the scripts' own variables.
 * sh: `$version` / `$tag`. ps1: `$ver` / `$tag` (PowerShell names are case-insensitive, so `$version` would be the
 * `-Version` parameter).
 */

/** One sh word: adjacent quoted pieces, so no separator is needed. */
export function shWord(segments: readonly Segment[]): string {
	if (segments.length === 0) return "''"
	return segments
		.map((s) => {
			if (s.kind === "version") return '"$version"'
			if (s.kind === "tag") return '"$tag"'
			return `'${s.value.replaceAll("'", "'\\''")}'`
		})
		.join("")
}

/** One PowerShell expression of type string. */
export function psString(segments: readonly Segment[]): string {
	if (segments.length === 0) return "''"
	const parts = segments.map((s) => {
		if (s.kind === "version") return "$ver"
		if (s.kind === "tag") return "$tag"
		return `'${s.value.replaceAll("'", "''")}'`
	})
	return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" + ")})`
}

export const shLiteral = (value: string): string => shWord([{ kind: "literal", value }])
export const psLiteral = (value: string): string => psString([{ kind: "literal", value }])
