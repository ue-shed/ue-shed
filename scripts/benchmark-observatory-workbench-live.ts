import { createWorkbenchEnvironment, runPnpm } from "./workbench-tools.ts";

const environment = await createWorkbenchEnvironment({
	...process.env,
	UE_SHED_OBSERVATORY_LIVE_E2E: "1",
	UE_SHED_REMOTE_CONTROL_ENDPOINT:
		process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
});

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
		"e2e/playwright.live-performance.config.ts"
	],
	environment
);
