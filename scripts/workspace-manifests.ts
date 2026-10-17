import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonString, parseJsonObject, type JsonObject } from "./json.ts";

export interface WorkspaceManifest {
	readonly directory: string;
	readonly name: string;
	readonly manifest: JsonObject;
}

export function readWorkspaceManifests(root: string): readonly WorkspaceManifest[] {
	return [
		"package.json",
		...globSync("{apps,examples,extensions,packages}/*/package.json", { cwd: root })
	]
		.sort()
		.map((path) => {
			const manifest = parseJsonObject(readFileSync(join(root, path), "utf8"));
			const name = manifest.name;
			if (!name || !isJsonString(name)) {
				throw new Error(`${path}: expected a package name.`);
			}
			return {
				directory:
					path === "package.json"
						? "."
						: path.replaceAll("\\", "/").replace(/\/package\.json$/, ""),
				name,
				manifest
			};
		});
}
