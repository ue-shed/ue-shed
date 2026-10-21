import { defineConfig } from "@playwright/test";
import { gateTraceReporters } from "./gate-trace-reporter.ts";

/** Real Unreal → Workbench IPC → World Scout paint evidence for the live benchmark command. */
export default defineConfig({
	expect: { timeout: 60_000 },
	forbidOnly: true,
	fullyParallel: false,
	outputDir: "../../../test-results/workbench-observatory-live-performance",
	reporter: gateTraceReporters(),
	testDir: ".",
	testMatch: "observatory-live-performance.e2e.ts",
	timeout: 90_000,
	workers: 1
});
