import { Effect } from "effect";
import {
	installedEngineRoots,
	queryWindowsRegistry
} from "../packages/engine/src/engine-sources.ts";
import { unrealEngineVersion } from "./unreal-plugin-host.ts";

/**
 * Returns the root of the newest installed engine whose `major.minor` is one of `versions`, or
 * `undefined` when none is installed. Uses the same sources as `@ue-shed/engine` discovery: the
 * Epic Games Launcher's install list and registry keys and `Program Files\Epic Games`.
 */
export async function findUnrealEngine(versions: readonly string[]) {
	const roots = await Effect.runPromise(
		installedEngineRoots({
			platform: process.platform,
			programData: process.env.ProgramData ?? "C:\\ProgramData",
			programFiles: process.env.ProgramFiles ?? "C:\\Program Files",
			queryRegistry: queryWindowsRegistry
		})
	);
	const matches = roots.flatMap((root) => {
		const version = unrealEngineVersion(root);
		return version !== undefined && versions.includes(version.label) ? [{ root, version }] : [];
	});
	return matches.toSorted(
		(a, b) => b.version.major - a.version.major || b.version.minor - a.version.minor
	)[0]?.root;
}
