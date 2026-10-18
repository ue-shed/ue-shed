import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./native-tools.ts";

// Event-loop gaps measure the whole process, so this test file runs alone.
const result = spawnSync(
	process.execPath,
	[
		join(repositoryRoot, "scripts/test.ts"),
		"--config",
		"vitest.node.config.ts",
		"packages/game-text/src/host-responsiveness.test.ts",
		...process.argv.slice(2)
	],
	{
		cwd: repositoryRoot,
		env: { ...process.env, UE_SHED_HOST_RESPONSIVENESS: "1" },
		stdio: "inherit",
		windowsHide: true
	}
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
