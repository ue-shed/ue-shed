import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "./json.ts";
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
				/^(?:crates\/(?:uasset-io|game-text-index)|packages\/(?:uasset|uasset-win32-x64|unreal-assets|blueprints|game-text|enhanced-input|authoring|protocol)|apps\/cli|fixtures)\//.test(
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
	const scope = selectCiScope(
		files,
		siteWorkspaceDirectories(readWorkspaceManifests(root)),
		!pullRequest
	);
	console.log("Changed files:\n" + files.map((path) => `  ${path}`).join("\n"));
	const outputs =
		Object.entries(scope)
			.map(([name, enabled]) => `${name}=${enabled}`)
			.join("\n") + "\n";
	console.log(outputs);
	if (!process.env.GITHUB_OUTPUT)
		throw new Error("GITHUB_OUTPUT is required to publish CI scope.");
	appendFileSync(process.env.GITHUB_OUTPUT, outputs);
}
