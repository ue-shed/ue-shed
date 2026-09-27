import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	outputDir: "../../../../test-results/site",
	forbidOnly: true,
	workers: 1,
	reporter: "list",
	use: { baseURL: "http://127.0.0.1:4175", browserName: "chromium", trace: "retain-on-failure" },
	webServer: {
		command:
			"pnpm --filter @ue-shed/site build && pnpm --filter @ue-shed/site preview --host 127.0.0.1 --port 4175",
		cwd: resolve(import.meta.dirname, "../../../.."),
		url: "http://127.0.0.1:4175",
		timeout: 120_000,
		reuseExistingServer: false
	},
	projects: [
		{ name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
		{ name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true } }
	]
});
