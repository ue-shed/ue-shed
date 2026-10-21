import { defineConfig } from "@playwright/test";
import { gateTraceReporters } from "./gate-trace-reporter.ts";

export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: true,
	fullyParallel: false,
	outputDir: "../../../test-results/workbench",
	reporter: gateTraceReporters(),
	testDir: ".",
	testIgnore: ["**/observatory-performance.e2e.ts", "**/site/**"],
	testMatch: "**/*.e2e.ts",
	timeout: 30_000,
	workers: 1
});
