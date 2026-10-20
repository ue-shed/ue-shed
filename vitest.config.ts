import { defineConfig } from "vitest/config";

const test = {
	// Keep isolated workers from starving process and native-reader integration tests.
	maxWorkers: 4,
	coverage: {
		exclude: [
			"**/*.d.ts",
			"**/*.test.{ts,tsx}",
			"**/*.test-support.{ts,tsx}",
			"**/*.integration.test.{ts,tsx}",
			"**/*.e2e.{ts,tsx}"
		],
		include: [
			"apps/*/src/**/*.{ts,tsx}",
			"extensions/*/src/**/*.{ts,tsx}",
			"packages/*/src/**/*.{ts,tsx}"
		],
		provider: "v8" as const,
		reporter: [["text", { skipFull: true }], "html", "json-summary"] as const,
		reportsDirectory: "coverage"
	},
	projects: ["./vitest.node.config.ts", "./vitest.component.config.ts"]
};

export default defineConfig({
	// `pnpm check:time` adds a reporter that records a span per test file and test (see
	// scripts/gate-trace.ts). Otherwise `reporters` stays absent: Vitest reads an explicit
	// `undefined` as no reporters at all, which also drops its GitHub annotations in CI.
	test: process.env.UE_SHED_TRACE_FILE
		? { ...test, reporters: ["default", "./scripts/vitest-trace-reporter.ts"] }
		: test
});
