import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";

const cli = join(repositoryRoot, "apps", "cli", "src", "index.ts");
const environment: NodeJS.ProcessEnv = { ...process.env };
if (
	environment.UE_SHED_UASSET_EXECUTABLE === undefined &&
	environment.UE_SHED_UASSET_AUTO_BUILD !== "0"
) {
	environment.UE_SHED_UASSET_EXECUTABLE = ensureUassetExecutable(environment);
}
const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
