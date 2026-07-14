import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
const rules = join(fixtureRoot, "FixtureSource", "Audits", "texture-rules.json");
const pnpmScript = process.env.npm_execpath;
const command = pnpmScript ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commandPrefix = pnpmScript ? [pnpmScript] : [];
const environment = {
	...process.env,
	UE_SHED_PROJECT_ROOT: process.env.UE_SHED_PROJECT_ROOT ?? fixtureRoot,
	UE_SHED_TEXTURE_AUDIT_RULES: process.env.UE_SHED_TEXTURE_AUDIT_RULES ?? rules
};

function run(args) {
	const result = spawnSync(command, [...commandPrefix, ...args], {
		cwd: repositoryRoot,
		env: environment,
		shell: !pnpmScript && process.platform === "win32",
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["--filter", "@ue-shed/workbench", "build"]);
run(["--filter", "@ue-shed/workbench", "start"]);
