import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * The checkout that owns the repository's `.git` directory. A linked worktree (a release worktree,
 * or the temporary checkout of `release:pack:clean-check`) shares it with the main checkout.
 */
export function mainCheckoutRoot(cwd = repositoryRoot) {
	const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
		windowsHide: true
	});
	if (result.status !== 0) return cwd;
	const commonDirectory = result.stdout.trim();
	return basename(commonDirectory) === ".git" ? dirname(commonDirectory) : cwd;
}

/**
 * Cargo output directory for release work: an explicit `CARGO_TARGET_DIR`, otherwise the main
 * checkout's `target`. A new release worktree then starts from the main checkout's compiled
 * dependencies instead of rebuilding them, and its build and package assembly agree on one
 * directory. Cargo locks the directory, so concurrent builds wait instead of corrupting it.
 */
export function releaseCargoTargetDirectory(
	environment: NodeJS.ProcessEnv = process.env,
	cwd = repositoryRoot
) {
	const explicit = environment.CARGO_TARGET_DIR;
	return explicit ? resolve(cwd, explicit) : resolve(mainCheckoutRoot(cwd), "target");
}
