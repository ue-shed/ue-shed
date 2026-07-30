import { isAbsolute, relative, resolve } from "node:path";
import { AssetReader, type AssetReaderError } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { MapHistoryError } from "./errors.js";
import { PerforceHistorySource } from "./perforce.js";
import type { ScopedPerforceFile } from "./revision-plan.js";
import type { PerforceMapHistoryQuery } from "./schema.js";

export interface ResolvedPerforceMapScope {
	readonly externalActorDepotRoot?: string;
	readonly externalActorProjectRoot?: string;
	readonly fileSpecs: readonly string[];
	readonly mapDepotPath: string;
	readonly mapPackageName: string;
	readonly mapProjectRelativePath: string;
	readonly sourceKind: "level" | "world_partition";
}

function savedWorldError(error: AssetReaderError): MapHistoryError {
	return new MapHistoryError({
		kind: error.kind === "resource_limit" ? "resource_limit" : "saved_world_decode",
		message: `Could not resolve the saved map scope: ${error.message}`,
		recovery:
			error.kind === "resource_limit"
				? "Narrow the map scope or raise maxPackages explicitly."
				: "Confirm that the selected map can be read from the project and retry.",
		retrySafe: error.retrySafe
	});
}

function invalidScope(message: string): MapHistoryError {
	return new MapHistoryError({
		kind: "invalid_target",
		message,
		recovery: "Select a map and external-actor root contained by the project root.",
		retrySafe: false
	});
}

function depotSubtree(root: string): string {
	return `${root.replace(/\/+$/, "")}/...`;
}

function depotPackageFileSpec(depotPath: string): string {
	const extensionIndex = depotPath.lastIndexOf(".");
	const separatorIndex = depotPath.lastIndexOf("/");
	return extensionIndex > separatorIndex ? `${depotPath.slice(0, extensionIndex)}.*` : depotPath;
}

function normalizeDepotRoot(path: string): string {
	return path.replace(/\/+$/, "");
}

function normalizeLocalPath(path: string): string {
	return process.platform === "win32" && path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function projectRelativePath(projectRoot: string, localPath: string): string {
	const resolvedProjectRoot = resolve(normalizeLocalPath(projectRoot));
	const resolvedPath = resolve(normalizeLocalPath(localPath));
	const path = relative(resolvedProjectRoot, resolvedPath);
	if (
		path.length === 0 ||
		isAbsolute(path) ||
		path === ".." ||
		path.startsWith("..\\") ||
		path.startsWith("../")
	) {
		throw invalidScope(`${localPath} is not a file or directory inside ${projectRoot}.`);
	}
	return path.replaceAll("\\", "/");
}

function packageNameForProjectPath(projectRelativePath: string): string | undefined {
	const normalized = projectRelativePath.replaceAll("\\", "/");
	if (!normalized.startsWith("Content/")) return undefined;
	const sourcePath = normalized.slice("Content/".length);
	const extension = /(?:\.(?:uasset|umap|uexp|uptnl)|(?:\.m)?\.ubulk)$/i;
	if (!extension.test(sourcePath)) return undefined;
	return `/Game/${sourcePath.replace(extension, "")}`;
}

/**
 * Converts a depot path to one exact, supported saved-package file in the selected map scope.
 * Paths outside the map or current external-actor subtree, including unrelated depot metadata,
 * deliberately return `undefined` rather than becoming historical project files.
 */
export function scopedPerforceFile(
	scope: ResolvedPerforceMapScope,
	depotPath: string
): ScopedPerforceFile | undefined {
	const mapExtensionIndex = scope.mapDepotPath.lastIndexOf(".");
	const mapDepotStem =
		mapExtensionIndex > scope.mapDepotPath.lastIndexOf("/")
			? scope.mapDepotPath.slice(0, mapExtensionIndex)
			: scope.mapDepotPath;
	const mapRelativeExtensionIndex = scope.mapProjectRelativePath.lastIndexOf(".");
	const mapProjectRelativeStem =
		mapRelativeExtensionIndex > scope.mapProjectRelativePath.lastIndexOf("/")
			? scope.mapProjectRelativePath.slice(0, mapRelativeExtensionIndex)
			: scope.mapProjectRelativePath;
	const mapSuffix = depotPath.startsWith(`${mapDepotStem}.`)
		? depotPath.slice(mapDepotStem.length)
		: undefined;
	if (
		depotPath === scope.mapDepotPath ||
		(mapSuffix !== undefined && /(?:\.(?:umap|uexp|uptnl)|(?:\.m)?\.ubulk)$/i.test(mapSuffix))
	) {
		return {
			depotPath,
			packageName: scope.mapPackageName,
			projectRelativePath:
				depotPath === scope.mapDepotPath
					? scope.mapProjectRelativePath
					: `${mapProjectRelativeStem}${mapSuffix}`
		};
	}
	if (
		scope.externalActorDepotRoot === undefined ||
		scope.externalActorProjectRoot === undefined
	) {
		return undefined;
	}
	const externalRoot = normalizeDepotRoot(scope.externalActorDepotRoot);
	if (!depotPath.startsWith(`${externalRoot}/`)) return undefined;
	const suffix = depotPath.slice(externalRoot.length + 1);
	if (
		suffix.length === 0 ||
		suffix.includes("\\") ||
		suffix.split("/").some((part) => part === "." || part === "..")
	) {
		return undefined;
	}
	const projectRelativePath = `${scope.externalActorProjectRoot}/${suffix}`;
	const packageName = packageNameForProjectPath(projectRelativePath);
	return packageName === undefined ? undefined : { depotPath, packageName, projectRelativePath };
}

/** Resolves the selected saved map and its present-day World Partition actor subtree to P4 scopes. */
export function resolvePerforceMapScope(
	query: PerforceMapHistoryQuery
): Effect.Effect<ResolvedPerforceMapScope, MapHistoryError, AssetReader | PerforceHistorySource> {
	return Effect.fn("MapHistory.resolvePerforceMapScope")(function* () {
		const reader = yield* AssetReader;
		const perforce = yield* PerforceHistorySource;
		const world = yield* reader
			.readSavedWorld({
				concurrency: query.limits.maxConcurrency,
				mapPath: query.mapPath,
				maximumAssets: query.limits.maxPackages,
				projectRoot: query.projectRoot
			})
			.pipe(Effect.mapError(savedWorldError));
		const mapLocalPath = resolve(query.projectRoot, query.mapPath);
		const mapProjectRelativePath = yield* Effect.try({
			try: () => projectRelativePath(query.projectRoot, mapLocalPath),
			catch: (cause) =>
				cause instanceof MapHistoryError
					? cause
					: invalidScope(
							`Could not resolve ${query.mapPath} beneath the selected project.`
						)
		});
		const mapMapping = yield* perforce.resolveLocalPath(mapLocalPath);
		if (world.externalActorRoot === undefined) {
			if (world.sourceKind === "world_partition") {
				return yield* Effect.fail(
					new MapHistoryError({
						kind: "saved_world_decode",
						message:
							"The World Partition map did not report its external-actor root, so its actor history cannot be scoped safely.",
						recovery:
							"Confirm the map's saved external-actor layout can be read, then retry.",
						retrySafe: false
					})
				);
			}
			return {
				fileSpecs: [depotPackageFileSpec(mapMapping.depotPath)],
				mapDepotPath: mapMapping.depotPath,
				mapPackageName: world.authority.mapPackage,
				mapProjectRelativePath,
				sourceKind: world.sourceKind
			};
		}
		const externalActorRoot = normalizeLocalPath(world.externalActorRoot);
		const externalActorProjectRoot = yield* Effect.try({
			try: () => projectRelativePath(query.projectRoot, externalActorRoot),
			catch: (cause) =>
				cause instanceof MapHistoryError
					? cause
					: invalidScope("Could not resolve the external-actor root beneath the project.")
		});
		const externalActorMapping = yield* perforce.resolveLocalPath(externalActorRoot);
		return {
			externalActorDepotRoot: normalizeDepotRoot(externalActorMapping.depotPath),
			externalActorProjectRoot,
			fileSpecs: [
				depotPackageFileSpec(mapMapping.depotPath),
				depotSubtree(externalActorMapping.depotPath)
			],
			mapDepotPath: mapMapping.depotPath,
			mapPackageName: world.authority.mapPackage,
			mapProjectRelativePath,
			sourceKind: world.sourceKind
		};
	})();
}
