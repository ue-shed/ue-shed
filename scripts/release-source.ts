import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export interface ReleaseSourceState {
	readonly changes: string;
	readonly head: string;
}

export function validateCleanReleaseSource(
	{ changes, head }: ReleaseSourceState,
	expectedCommit?: string
) {
	if (expectedCommit !== undefined && head !== expectedCommit) {
		throw new Error(
			`Release commit ${expectedCommit} does not match checked-out HEAD ${head}.`
		);
	}
	if (changes.trim() !== "") {
		throw new Error("Release artifact generation requires a clean worktree.");
	}
	return head;
}

function git(args: readonly string[]) {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		shell: false
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	return result.stdout.trim();
}

export function assertCleanReleaseSource(expectedCommit?: string) {
	return validateCleanReleaseSource(
		{
			changes: git(["status", "--porcelain", "--untracked-files=all"]),
			head: git(["rev-parse", "HEAD"])
		},
		expectedCommit
	);
}
