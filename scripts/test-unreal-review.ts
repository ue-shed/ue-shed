import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";
import { reportUnrealTestGates } from "./test-gates.ts";
import { loadFixtureEditorMap } from "./workbench-tools.ts";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
if (!endpoint) {
	console.error(
		"Map Review C++ wire evidence requires UE_SHED_REMOTE_CONTROL_ENDPOINT.\n" +
			"Start the fixture editor first: pnpm fixture:launch-authoring"
	);
	process.exit(1);
}

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
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable()
};
await loadFixtureEditorMap(endpoint, "/Game/Fixture/Cameras/L_CameraLoad");
const testFiles = [
	"packages/cameras/src/review-unreal.integration.test.ts",
	"packages/cameras/src/map-tile-unreal.integration.test.ts"
];
reportUnrealTestGates(environment, testFiles);
const result = spawnSync(process.execPath, [vitest, "run", ...testFiles], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const flows = spawnSync(process.execPath, ["scripts/test-map-review-flow.ts"], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});
if (flows.error) throw flows.error;
process.exit(flows.status ?? 1);
