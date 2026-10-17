/** Rows like the installers': a mark, a label, a value. Marks and color on a TTY; plain `+`, `x`, `!` otherwise. */
export interface Ui {
	ok(label: string, value: string): void
	bad(label: string, value: string): void
	info(text: string): void
	warn(text: string): void
	error(text: string): void
}

export interface UiIo {
	stdout(text: string): void
	stderr(text: string): void
	isTTY: boolean
	env: Record<string, string | undefined>
}

const ESC = String.fromCharCode(27)

export function createUi(io: UiIo): Ui {
	const color = io.isTTY && !io.env.NO_COLOR
	const paint = (code: number, text: string) => (color ? `${ESC}[${code}m${text}${ESC}[0m` : text)
	const mark = { ok: io.isTTY ? "✓" : "+", bad: io.isTTY ? "✗" : "x" }
	const row = (glyph: string, label: string, value: string) => `${glyph} ${label.padEnd(13)} ${value}\n`
	return {
		ok: (label, value) => io.stdout(row(paint(32, mark.ok), label, value)),
		bad: (label, value) => io.stdout(row(paint(31, mark.bad), label, value)),
		info: (text) => io.stdout(`${text}\n`),
		warn: (text) => io.stderr(`${paint(33, "warning:")} ${text}\n`),
		error: (text) => io.stderr(`${paint(31, io.isTTY ? `${mark.bad} error:` : "error:")} ${text}\n`),
	}
}
