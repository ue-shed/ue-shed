import { defineConfig } from "@playwright/test";

export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: true,
	fullyParallel: false,
	outputDir: "../../../test-results/workbench",
	reporter: "list",
	testDir: ".",
	testIgnore: ["**/observatory-performance.e2e.ts", "**/site/**"],
	testMatch: "**/*.e2e.ts",
	timeout: 30_000,
	workers: 1
});
