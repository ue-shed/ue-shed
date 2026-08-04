import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Effect } from "effect";
import { AssetReaderError } from "./asset-reader.js";

export interface ResolvedScanTarget {
	/** Roots to enumerate. Empty means the project's whole `Content` directory. */
	readonly paths: readonly string[];
	readonly projectRoot: string;
}

/** Carries an already-explained resolution failure out of the async resolver body. */
class ScanTargetError extends Error {}

async function projectFilesIn(directory: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".uproject")
			.map((entry) => join(directory, entry.name));
	} catch {
		// An unreadable ancestor is not the target's fault; keep walking toward the root.
		return [];
	}
}

/**
 * Resolves any user-supplied path onto a scan target. A project root or `.uproject` file scans the
 * whole project; a subdirectory or a single asset walks up to the owning project and scopes
 * enumeration to that path, so `/Game` object paths stay resolvable either way.
 */
export function resolveScanTarget(
	path: string
): Effect.Effect<ResolvedScanTarget, AssetReaderError> {
	return Effect.tryPromise({
		try: async (): Promise<ResolvedScanTarget> => {
			const target = resolve(path);
			const details = await stat(target).catch(() => {
				throw new ScanTargetError(`Scan target does not exist: ${target}`);
			});
			if (details.isFile() && extname(target).toLowerCase() === ".uproject") {
				return { paths: [], projectRoot: dirname(target) };
			}
			if (details.isDirectory()) {
				const projects = await projectFilesIn(target);
				if (projects.length > 1) {
					throw new ScanTargetError(
						`Project directory contains more than one .uproject file: ${target}`
					);
				}
				if (projects.length === 1) return { paths: [], projectRoot: target };
			}
			let directory = dirname(target);
			for (;;) {
				const projects = await projectFilesIn(directory);
				if (projects.length > 1) {
					throw new ScanTargetError(
						`Project directory containing ${target} has more than one .uproject file: ${directory}`
					);
				}
				if (projects.length === 1) return { paths: [target], projectRoot: directory };
				const parent = dirname(directory);
				if (parent === directory) {
					throw new ScanTargetError(
						`No .uproject file at or above ${target}; scans resolve object paths against a project root.`
					);
				}
				directory = parent;
			}
		},
		catch: (cause) =>
			new AssetReaderError({
				kind: "discovery",
				operation: "discovery",
				message:
					cause instanceof ScanTargetError
						? cause.message
						: `Could not resolve a scan target from ${path}: ${String(cause)}`,
				path,
				retrySafe: false
			})
	}).pipe(Effect.withSpan("unreal_assets.resolve_scan_target"));
}
