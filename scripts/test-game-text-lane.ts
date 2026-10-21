import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./native-tools.ts";

const lanes = {
	benchmark: {
		file: "scripts/game-text-benchmark.integration.test.ts",
		environment: "UE_SHED_GAME_TEXT_BENCHMARK"
	},
	scale: {
		file: "packages/game-text/src/query-scale.test.ts",
		environment: "UE_SHED_GAME_TEXT_SCALE"
	},
	soak: {
		file: "packages/game-text/src/native-index-lifecycle.integration.test.ts",
		environment: "UE_SHED_GAME_TEXT_SOAK"
	}
};
const lane = process.argv[2];
if (lane !== "benchmark" && lane !== "scale" && lane !== "soak")
	throw new Error("Choose the Game Text benchmark, scale or soak lane.");
const selected = lanes[lane];
const result = spawnSync(
	process.execPath,
	[
		join(repositoryRoot, "scripts/test.ts"),
		"--config",
		"vitest.node.config.ts",
		selected.file,
		"--maxWorkers",
		"1",
		...process.argv.slice(3)
	],
	{
		cwd: repositoryRoot,
		env: { ...process.env, [selected.environment]: "1" },
		stdio: "inherit",
		windowsHide: true
	}
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
