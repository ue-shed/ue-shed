/**
 * Skips an UnrealBuildTool run whose inputs have not changed since its last successful run. Even
 * an up-to-date fixture or plugin build costs UnrealBuildTool 4-8 s, and Unreal gates build before
 * every commandlet. Set `UE_SHED_FIXTURE_REBUILD=1` to always build.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, isJsonString, type JsonValue, parseJsonObject } from "./json.ts";

// Build outputs and editor state, not inputs.
const outputDirectories = new Set(["Binaries", "Intermediate", "Saved", "DerivedDataCache", ".vs"]);

/**
 * Fingerprints `paths` (files, or directories walked without their build outputs) by path, size and
 * modification time, as Make does, together with `values` such as engine identity and arguments.
 */
export function buildInputStamp(paths: readonly string[], values: readonly string[] = []) {
	const hash = createHash("sha256");
	for (const value of values) hash.update(`value\0${value}\0`);
	const visit = (path: string) => {
		if (!existsSync(path)) {
			hash.update(`missing\0${path}\0`);
			return;
		}
		const stat = statSync(path);
		if (!stat.isDirectory()) {
			hash.update(`file\0${path}\0${stat.size}\0${stat.mtimeMs}\0`);
			return;
		}
		for (const entry of readdirSync(path).toSorted()) {
			if (!outputDirectories.has(entry)) visit(join(path, entry));
		}
	};
	for (const path of paths) visit(path);
	return hash.digest("hex");
}

/** Identifies the engine build: its root, `Build.version` and editor module build ID. */
export function engineBuildIdentity(engineRoot: string, editorTarget = "UnrealEditor") {
	const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "missing");
	return [
		engineRoot.toLowerCase(),
		read(join(engineRoot, "Engine", "Build", "Build.version")),
		read(join(engineRoot, "Engine", "Binaries", "Win64", `${editorTarget}.modules`))
	];
}

/**
 * Lists an UnrealBuildTool module manifest (`<Target>.modules`) and the module binaries it maps, so
 * a deleted DLL fails the output check. Only the manifest is listed while it is missing or
 * unreadable, which already forces a build.
 */
export function moduleManifestOutputs(manifest: string) {
	if (!existsSync(manifest)) return [manifest];
	let modules: JsonValue;
	try {
		modules = parseJsonObject(readFileSync(manifest, "utf8")).Modules ?? null;
	} catch {
		return [manifest];
	}
	const binaries = modules !== null && isJsonObject(modules) ? Object.values(modules) : [];
	return [
		manifest,
		...binaries.filter(isJsonString).map((binary) => join(dirname(manifest), binary))
	];
}

/**
 * Runs `build` unless `stampFile` holds `stamp` from a previous successful build and every output
 * exists. The stamp is removed first, so a failed or interrupted build always reruns.
 */
export function buildUnlessUnchanged({
	stampFile,
	stamp,
	outputs,
	build
}: {
	readonly stampFile: string;
	readonly stamp: string;
	readonly outputs: readonly string[];
	readonly build: () => void;
}) {
	const unchanged =
		process.env.UE_SHED_FIXTURE_REBUILD !== "1" &&
		existsSync(stampFile) &&
		readFileSync(stampFile, "utf8").trim() === stamp &&
		outputs.every((output) => existsSync(output));
	if (unchanged) {
		process.stdout.write(`Build inputs unchanged; skipping UnrealBuildTool (${stampFile}).\n`);
		return;
	}
	rmSync(stampFile, { force: true });
	build();
	mkdirSync(dirname(stampFile), { recursive: true });
	writeFileSync(stampFile, `${stamp}\n`);
}
