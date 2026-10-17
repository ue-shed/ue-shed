import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, isJsonString } from "./json.ts";
import { readWorkspaceManifests, type WorkspaceManifest } from "./workspace-manifests.ts";

function inside(root: string, path: string) {
	const fromRoot = relative(root, path);
	return (
		fromRoot !== ".." &&
		!fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(fromRoot)
	);
}

export function validateDependencyPaths(
	root: string,
	workspaces: readonly WorkspaceManifest[],
	lockfile: string,
	trackedFiles: readonly string[]
): readonly string[] {
	const failures: string[] = [];
	const tracked = new Set(trackedFiles.map((file) => resolve(root, file)));
	const check = (source: string, directory: string, reference: string) => {
		if (!/^(?:file:|link:|[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/]|~[\\/])/.test(reference)) return;
		const localPath = reference.replace(/^(?:file:|link:)/, "");
		const path = resolve(root, directory, localPath);
		if (
			/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(localPath) ||
			!inside(root, path) ||
			!existsSync(path) ||
			!inside(realpathSync(root), realpathSync(path)) ||
			![...tracked].some(
				(file) =>
					file === path || file.startsWith(`${path}/`) || file.startsWith(`${path}\\`)
			)
		) {
			failures.push(
				`${source}: ${reference} is not a checked-in repository dependency; use a registry version or workspace reference.`
			);
		}
	};
	for (const workspace of workspaces) {
		for (const section of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies"
		]) {
			const dependencies = workspace.manifest[section];
			if (!dependencies || !isJsonObject(dependencies)) continue;
			for (const [name, reference] of Object.entries(dependencies)) {
				if (!isJsonString(reference))
					throw new Error(`${workspace.directory}: invalid ${section}.${name}.`);
				check(
					`${workspace.directory}/package.json ${section}.${name}`,
					workspace.directory,
					reference
				);
			}
		}
	}
	// Local tarball resolutions are relative to the lockfile, independently of importer specifiers.
	for (const match of lockfile.matchAll(
		/\btarball:\s*["']?((?:file:|[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/]|~[\\/])[^\s"',}]+)/g
	)) {
		check("pnpm-lock.yaml tarball", ".", match[1]!);
	}
	return failures;
}

export function checkDependencyPaths(root: string) {
	const tracked = execFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true
	})
		.split("\0")
		.filter(Boolean);
	const failures = validateDependencyPaths(
		root,
		readWorkspaceManifests(root),
		readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"),
		tracked
	);
	if (failures.length) throw new Error(failures.join("\n"));
	console.log(
		"Dependency paths are portable: local references resolve to checked-in repository files."
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	checkDependencyPaths(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
