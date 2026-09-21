import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = join(repositoryRoot, "fixtures", "unreal-project");

/** Keep saved-package inventory assertions independent of locally generated stress fixtures. */
export function useSavedFixtureProject() {
	let root: string | undefined;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "ue-shed-saved-fixture-"));
		const files = execFileSync("git", ["ls-files", "-z", "--", "fixtures/unreal-project"], {
			cwd: repositoryRoot,
			encoding: "utf8",
			windowsHide: true
		}).split("\0");
		for (const file of files.filter(Boolean)) {
			const source = join(repositoryRoot, file);
			const target = join(root, relative(sourceRoot, source));
			await mkdir(dirname(target), { recursive: true });
			await copyFile(source, target);
		}
	}, 30_000);
	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});
	return {
		get root() {
			if (!root) throw new Error("Saved fixture project is unavailable before setup.");
			return root;
		}
	};
}
