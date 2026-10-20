import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";
import { reportUnrealTestGates } from "./test-gates.ts";

// The mutation test drives the plugin through Remote Control, as hosts do, so it needs the live
// fixture editor rather than commandlets. `pnpm check:unreal` starts one before running this.
const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
if (!endpoint) {
	console.error(
		"Live authoring mutation requires UE_SHED_REMOTE_CONTROL_ENDPOINT.\n" +
			"Start a fresh fixture editor first: pnpm fixture:launch-authoring"
	);
	process.exit(1);
}

const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const environment = {
	...process.env,
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable()
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
