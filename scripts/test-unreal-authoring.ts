import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";
import { reportUnrealTestGates } from "./test-gates.ts";

const build = spawnSync(process.execPath, ["scripts/unreal-fixture.ts", "build"], {
	cwd: repositoryRoot,
	stdio: "inherit",
	windowsHide: true
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const environment = {
	...process.env,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable(),
	UE_SHED_UNREAL_INTEGRATION: "1"
};
const testFile = "packages/authoring/src/unreal-mutation.integration.test.ts";
reportUnrealTestGates(environment, [testFile]);
const result = spawnSync(process.execPath, [vitest, "run", testFile], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
