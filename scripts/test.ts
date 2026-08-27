import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";
import { reportPerforceMapHistoryTestGate, reportUnrealTestGates } from "./test-gates.ts";

const withoutUassetFlag = "--without-uasset";
const testArguments = process.argv.slice(2);
const withoutUasset = testArguments.includes(withoutUassetFlag);
const vitestArguments = testArguments.filter((argument) => argument !== withoutUassetFlag);
const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const environment: NodeJS.ProcessEnv = { ...process.env };
if (withoutUasset) delete environment.UE_SHED_UASSET_EXECUTABLE;
else environment.UE_SHED_UASSET_EXECUTABLE = ensureUassetExecutable();
reportUnrealTestGates(environment, vitestArguments);
reportPerforceMapHistoryTestGate(environment, vitestArguments);
const result = spawnSync(process.execPath, [vitest, "run", ...vitestArguments], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
