import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./native-tools.ts";

// `--native` adds the native persisted join sweep, which needs the native reader build. Without
// it the sweep stays TypeScript-only, as the hosted repository job runs it on every change.
const args = process.argv.slice(2);
const native = args.includes("--native");
const result = spawnSync(
	process.execPath,
	[
		join(repositoryRoot, "scripts/test.ts"),
		...(native ? [] : ["--without-uasset"]),
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
