import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonNumber, isJsonObject, parseJson } from "./json.ts";
import { readWorkspaceManifests, type WorkspaceManifest } from "./workspace-manifests.ts";

export interface CiScope {
	readonly uasset_io: boolean;
	readonly uasset_libraries: boolean;
	readonly catalog_oracle: boolean;
	readonly site: boolean;
}

export function siteWorkspaceDirectories(
	workspaces: readonly WorkspaceManifest[]
): readonly string[] {
	const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
	const visited = new Set<string>();
	const visit = (name: string) => {
		if (visited.has(name)) return;
		const workspace = byName.get(name);
		if (!workspace) throw new Error(`Missing website workspace dependency ${name}.`);
		visited.add(name);
		for (const section of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies"
		]) {
			const dependencies = workspace.manifest[section];
			if (!dependencies || !isJsonObject(dependencies)) continue;
			for (const dependency of Object.keys(dependencies)) {
				if (byName.has(dependency)) visit(dependency);
			}
		}
	};
	visit("@ue-shed/site");
	return [...visited].map((name) => byName.get(name)!.directory);
}

export function selectCiScope(
	files: readonly string[],
	siteDirectories: readonly string[],
	full: boolean
): CiScope {
	const all =
		full ||
		files.some(
			(path) =>
				/^(?:package\.json|pnpm-(?:lock|workspace)\.yaml|Cargo\.(?:toml|lock)|\.node-version|tsconfig[^/]*|vitest[^/]*|oxlint\.config\.ts|\.oxfmtrc\.json)$/.test(
					path
				) ||
				path.endsWith("/package.json") ||
				path.startsWith("patches/") ||
				path.startsWith(".cargo/") ||
				path === ".github/workflows/portable.yml" ||
				/^scripts\/(?:ci-scope|workspace-manifests|check-dependency-paths|native-tools|json|test)(?:\.test)?\.ts$/.test(
					path
				)
		);
	const libraries =
		all ||
		files.some(
			(path) =>
				/^crates\/uasset-(?:parser|source-gen|inspection|inspection-wasm)\//.test(path) ||
				/^scripts\/.*uasset/.test(path) ||
				/^fixtures\/.*\.(?:uasset|umap)$/.test(path)
		);
	const io =
		libraries ||
		files.some(
			(path) =>
				/^(?:crates\/(?:uasset-io|game-text-index|unreal-code)|packages\/(?:uasset|uasset-win32-x64|unreal-assets|blueprints|game-text|enhanced-input|authoring|protocol)|apps\/cli|fixtures)\//.test(
					path
				) ||
				/^scripts\/(?:test-saved-review|native-game-text-join|columnar-join-fuzz\.test-support|package-text-.*)\.(?:test\.)?ts$/.test(
					path
				)
		);
	return {
		uasset_io: io,
		uasset_libraries:
			libraries || files.some((path) => path.startsWith("packages/uasset-inspection-wasm/")),
		catalog_oracle: all || files.some((path) => path.startsWith("crates/uasset-io/")),
		site:
			libraries ||
			files.some(
				(path) =>
					siteDirectories.some((directory) => path.startsWith(`${directory}/`)) ||
					path.startsWith("apps/workbench/e2e/site/") ||
					path.startsWith("fixtures/unreal-project/") ||
					path.startsWith("scripts/site-") ||
					path === "scripts/clean-package-dist.ts"
			)
	};
}

/** Only release notes: what `pnpm release:prepare --record` changes after the gates ran. */
export function releaseNotesOnly(files: readonly string[]) {
	return files.length > 0 && files.every((path) => /^docs\/releases\/[^/]+\.md$/.test(path));
}

/**
 * Whether the Portable workflow already succeeded for `sha`. Read-only: the job's token needs
 * `actions: read`. Any failure to find out answers no.
 */
async function portableRunPassed(sha: string) {
	const token = process.env.GITHUB_TOKEN;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!token || !repository || !/^[0-9a-f]{40}$/.test(sha)) return false;
	const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
	try {
		const response = await fetch(
			`${api}/repos/${repository}/actions/workflows/portable.yml/runs?head_sha=${sha}&status=success&per_page=1`,
			{ headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } }
		);
		if (!response.ok) return false;
		const body = parseJson(await response.text());
		return isJsonObject(body) && isJsonNumber(body.total_count) && body.total_count > 0;
	} catch {
		return false;
	}
}

/**
 * Whether `head` already contains the base branch's tip `base`. Pull request runs test the merge
 * of the head into the base; when the previous head contained the current base tip, that merge was
 * the previous head itself, so its run tested the same code a release-notes-only push now has. If
 * the base moved on since, the new merge result has never been tested and gets the full gate.
 */
export function containsBase(root: string, base: string, head: string) {
	if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) return false;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", base, head], {
			cwd: root,
			stdio: "ignore",
			windowsHide: true
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * The base GitHub merged `head` into for this run: the first parent of the checked-out test merge
 * commit, when its second parent is `head`. Undefined when the checkout is not that merge.
 */
export function testedBase(root: string, head: string) {
	const revision = (name: string) => {
		try {
			return execFileSync("git", ["rev-parse", "--verify", "--quiet", name], {
				cwd: root,
				encoding: "utf8",
				windowsHide: true
			}).trim();
		} catch {
			return undefined;
		}
	};
	return revision("HEAD^2") === head ? revision("HEAD^1") : undefined;
}

export function changedFiles(root: string, base: string, head: string, pullRequest: boolean) {
	if (!head || (pullRequest && !base))
		throw new Error("CI scope requires explicit base/head commits.");
	const range =
		base && !/^0+$/.test(base)
			? `${base}${pullRequest ? "..." : ".."}${head}`
			: `${head}^..${head}`;
	return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", range], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true
	})
		.split("\0")
		.filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const pullRequest = process.env.EVENT_NAME === "pull_request";
	const files = changedFiles(
		root,
		pullRequest ? (process.env.BASE_SHA ?? "") : (process.env.BEFORE_SHA ?? ""),
		process.env.HEAD_SHA ?? "",
		pullRequest
	);
	// A pull request push that only records release-notes evidence on top of a commit whose run
	// passed reuses that run: the code is unchanged, so only the release text is checked again.
	const before = process.env.BEFORE_SHA ?? "";
	let reusePreviousRun = false;
	if (pullRequest && process.env.PR_ACTION === "synchronize" && before !== "") {
		try {
			const pushed = changedFiles(root, before, process.env.HEAD_SHA ?? "", false);
			reusePreviousRun =
				releaseNotesOnly(pushed) &&
				containsBase(
					root,
					testedBase(root, process.env.HEAD_SHA ?? "") ?? process.env.BASE_SHA ?? "",
					before
				) &&
				(await portableRunPassed(before));
		} catch {
			reusePreviousRun = false;
		}
	}
	const scope = reusePreviousRun
		? { uasset_io: false, uasset_libraries: false, catalog_oracle: false, site: false }
		: selectCiScope(
				files,
				siteWorkspaceDirectories(readWorkspaceManifests(root)),
				!pullRequest
			);
	console.log("Changed files:\n" + files.map((path) => `  ${path}`).join("\n"));
	if (reusePreviousRun) {
		console.log(`Only release notes changed since ${before}, whose Portable run passed.`);
	}
	const outputs =
		[...Object.entries(scope), ["reuse_previous_run", reusePreviousRun] as const]
			.map(([name, enabled]) => `${name}=${enabled}`)
			.join("\n") + "\n";
	console.log(outputs);
	if (!process.env.GITHUB_OUTPUT)
		throw new Error("GITHUB_OUTPUT is required to publish CI scope.");
	appendFileSync(process.env.GITHUB_OUTPUT, outputs);
}
