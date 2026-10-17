/** A user-facing error: the CLI prints its message without a stack. */
export class InstallgenError extends Error {
	override name = "InstallgenError"
}
