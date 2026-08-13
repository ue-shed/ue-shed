import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";

const executable = ensureUassetExecutable();
const cli = join(repositoryRoot, "apps", "cli", "src", "index.ts");
const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], {
	cwd: repositoryRoot,
	env: {
		...process.env,
		UE_SHED_UASSET_EXECUTABLE: executable
	},
	stdio: "inherit",
	windowsHide: true
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
