import { defineConfig } from "@playwright/test";

export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: true,
	fullyParallel: false,
	outputDir:
		process.env.UE_SHED_RECORDING_OUTPUT_DIR ??
		"../../../../test-results/showcase/unconfigured",
	reporter: "list",
	testDir: ".",
	testMatch: "showcase.recording.ts",
	timeout: 300_000,
	workers: 1
});
