import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./native-tools.ts";

// The sweep needs the native reader: it converts package text to columns (Plan 059 Phase 4.5,
// decision 8). `--native` adds the native persisted join sweep beside the TypeScript join's.
const args = process.argv.slice(2);
const native = args.includes("--native");
const result = spawnSync(
	process.execPath,
	[
		join(repositoryRoot, "scripts/test.ts"),
		"--config",
		"vitest.node.config.ts",
		"scripts/columnar-join-fuzz-sweep.test.ts",
		...(native ? ["scripts/native-game-text-join.test.ts"] : []),
		...args.filter((arg) => arg !== "--native")
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
