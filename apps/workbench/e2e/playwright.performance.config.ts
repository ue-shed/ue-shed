import { defineConfig } from "@playwright/test";
import { gateTraceReporters } from "./gate-trace-reporter.ts";

/** Timing-sensitive Observatory Canvas bench; invoked by `pnpm benchmark:observatory`. */
export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: true,
	fullyParallel: false,
	outputDir: "../../../test-results/workbench-observatory-performance",
	reporter: gateTraceReporters(),
	testDir: ".",
	testMatch: "observatory-performance.e2e.ts",
	timeout: 300_000,
	workers: 1,
	use: {
		browserName: "chromium"
	}
});
