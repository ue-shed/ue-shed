import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./native-tools.ts";

const result = spawnSync(
	process.execPath,
	[
		join(repositoryRoot, "scripts/test.ts"),
		"--without-uasset",
		"--config",
		"vitest.node.config.ts",
		"scripts/columnar-join-fuzz-sweep.test.ts",
		...process.argv.slice(2)
	],
	{
		cwd: repositoryRoot,
		env: {
			...process.env,
			UE_SHED_JOIN_FUZZ_SWEEP: "1",
			UE_SHED_JOIN_FUZZ_SEEDS: process.env.UE_SHED_JOIN_FUZZ_SEEDS ?? "2000"
		},
		stdio: "inherit",
		windowsHide: true
	}
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
