import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.mjs";
import { reportUnrealTestGates } from "./test-gates.mjs";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
if (!endpoint) {
	console.error(
		"Map Review C++ wire evidence requires UE_SHED_REMOTE_CONTROL_ENDPOINT.\n" +
			"Start the fixture editor first: pnpm fixture:launch-authoring"
	);
	process.exit(1);
}

const build = spawnSync(process.execPath, ["scripts/unreal-fixture.mjs", "build"], {
	cwd: repositoryRoot,
	stdio: "inherit",
	windowsHide: true
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const environment = {
	...process.env,
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable()
};
const testFile = "packages/cameras/src/review-unreal.integration.test.ts";
reportUnrealTestGates(environment, [testFile]);
const result = spawnSync(process.execPath, [vitest, "run", testFile], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
