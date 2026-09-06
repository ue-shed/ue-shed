import { createWorkbenchEnvironment, runPnpm } from "./workbench-tools.ts";

const skipBuild = process.argv.includes("--no-build");
const playwrightArgs = process.argv.slice(2).filter((argument) => argument !== "--no-build");
const environment = await createWorkbenchEnvironment();

if (!skipBuild)
	runPnpm(
		["--filter", "@ue-shed/workbench...", "--recursive", "--if-present", "run", "build"],
		environment
	);
runPnpm(
	[
		"--filter",
		"@ue-shed/workbench",
		"exec",
		"playwright",
		"test",
		"--config",
		"e2e/playwright.config.ts",
		...playwrightArgs
	],
	environment
);
