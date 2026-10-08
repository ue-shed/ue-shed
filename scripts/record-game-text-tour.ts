import { join } from "node:path";
import { ensureUassetExecutable } from "./native-tools.ts";
import { repositoryRoot, runPnpm } from "./workbench-tools.ts";

// A captioned tour of Game Text for people: every flow at reading pace, on a disposable copy of
// the fixture project. Each run writes a new folder; earlier tours are never replaced.
const skipBuild = process.argv.includes("--no-build");
const output = join(
	repositoryRoot,
	"test-results",
	"game-text-tour",
	new Date().toISOString().replaceAll(/[-:.TZ]/g, "")
);
const environment = {
	...process.env,
	UE_SHED_RECORD_GAME_TEXT_TOUR: "true",
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable(),
	UE_SHED_RECORDING_OUTPUT_DIR: output
};

if (!skipBuild) {
	runPnpm(
		["--filter", "@ue-shed/workbench...", "--recursive", "--if-present", "run", "build"],
		environment
	);
}
runPnpm(
	[
		"--filter",
		"@ue-shed/workbench",
		"exec",
		"playwright",
		"test",
		"--config",
		"e2e/recording/playwright.config.ts",
		"game-text-tour.recording.ts"
	],
	environment
);
process.stdout.write(`Game Text tour written under ${output}\n`);
