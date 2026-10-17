import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		coverage: {
			/* every source file at 100%; index and type-only files carry no statements */
			exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts", "src/**/types.ts"],
			include: ["src/**"],
			provider: "v8",
			thresholds: { branches: 100, functions: 100, lines: 100, perFile: true, statements: 100 },
		},
		include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
		passWithNoTests: true,
		/* Docker e2e cases pull images and start containers */
		testTimeout: 60_000,
	},
})
