import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const shouldBuild = !arguments_.includes("--no-build") && !arguments_.includes("--help");
const pnpmEntrypoint = process.env.npm_execpath;

if (pnpmEntrypoint === undefined) {
	throw new Error("Run the project-index benchmark through pnpm benchmark:project-index.");
}

function run(command: string, commandArguments: readonly string[]) {
	const result = spawnSync(command, commandArguments, {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (shouldBuild) {
	run(process.execPath, [pnpmEntrypoint, "--filter", "@ue-shed/unreal-assets", "build"]);
}
run(process.execPath, [
	pnpmEntrypoint,
	"--filter",
	"@ue-shed/workbench",
	"exec",
	"tsx",
	"scripts/benchmark-project-index.ts",
	...arguments_
]);
