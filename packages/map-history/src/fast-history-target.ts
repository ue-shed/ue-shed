import { resolve } from "node:path";
import type { AssetReader } from "@ue-shed/unreal-assets";
import type { SavedWorld, SavedWorldActor } from "@ue-shed/protocol";
import { Effect } from "effect";
import { actorIdentityKey, actorIdentityOf } from "./diff.js";
import { MapHistoryError } from "./errors.js";
import { PerforceHistorySource } from "./perforce.js";
import {
	depotPackageFileSpec,
	projectRelativePathForPackageName,
	resolvePresentDayMapScope,
	type ResolvedPerforceMapScope
} from "./perforce-map-scope.js";
import type {
	ActorIdentity,
	FastHistoryInvestigationTarget,
	FastHistoryTargetedCoverage,
	PerforceDepotPath,
	PerforceFastMapHistoryQuery
} from "./schema.js";

const ZERO_GUID = /^0{8}-0{8}-0{8}-0{8}$/;

export interface ProvenFastHistoryActorTarget {
	readonly actor: SavedWorldActor;
	readonly identity: ActorIdentity;
	readonly packageName: string;
	readonly packageProjectRelativePath: string;
}

export interface ResolvedPerforceFastMapScope {
	readonly coverage: FastHistoryTargetedCoverage;
	readonly proven: ProvenFastHistoryActorTarget;
	readonly scope: ResolvedPerforceMapScope;
}

function targetError(message: string, recovery: string): MapHistoryError {
	return new MapHistoryError({
		kind: "invalid_target",
		message,
		recovery,
		retrySafe: false
	});
}

function actorsMatchingIdentity(
	actors: readonly SavedWorldActor[],
	identity: ActorIdentity
): readonly SavedWorldActor[] {
	const key = actorIdentityKey(identity);
	return actors.filter((actor) => actorIdentityKey(actorIdentityOf(actor)) === key);
}

function isUsableGuid(guid: string | undefined): guid is string {
	return guid !== undefined && guid.length > 0 && !ZERO_GUID.test(guid);
}

/**
 * Proves one present-day SavedWorld actor is the Investigation Target and derives its package path
 * from the existing actor projection. Returns a typed failure when continuity or package scope
 * cannot be established without guessing.
 */
export function proveFastHistoryActorTarget(options: {
	readonly scope: ResolvedPerforceMapScope;
	readonly target: FastHistoryInvestigationTarget;
	readonly world: SavedWorld;
}): ProvenFastHistoryActorTarget | MapHistoryError {
	if (options.target.kind !== "actor") {
		return targetError(
			"Fast History only supports a single-actor Investigation Target in this slice.",
			"Select one present-day actor by GUID or exact package/object path."
		);
	}
	const matches = actorsMatchingIdentity(options.world.actors, options.target.identity);
	if (matches.length === 0) {
		return targetError(
			"The Investigation Target actor is not present in the selected map's current saved world.",
			"Choose an actor that exists in the present-day map projection, or use Deep History."
		);
	}
	if (matches.length > 1) {
		return targetError(
			"The Investigation Target matches multiple present-day actors, so its package scope is ambiguous.",
			"Identify the actor by a unique GUID or exact package and object path."
		);
	}
	const actor = matches[0];
	if (actor === undefined) {
		return targetError(
			"The Investigation Target actor is not present in the selected map's current saved world.",
			"Choose an actor that exists in the present-day map projection, or use Deep History."
		);
	}

	const packageName = actor.packageName;
	const inMapPackage = packageName === options.scope.mapPackageName;
	let packageProjectRelativePath: string | undefined;
	if (inMapPackage) {
		packageProjectRelativePath = options.scope.mapProjectRelativePath;
	} else {
		packageProjectRelativePath = projectRelativePathForPackageName(packageName, ".uasset");
		if (packageProjectRelativePath === undefined) {
			return targetError(
				`Actor package ${packageName} cannot be converted to a project-relative saved package path.`,
				"Confirm the SavedWorld actor projection reports a /Game package name."
			);
		}
		if (options.scope.sourceKind === "world_partition") {
			const externalRoot = options.scope.externalActorProjectRoot;
			if (externalRoot === undefined) {
				return targetError(
					"The World Partition map did not report an external-actor root for the Investigation Target.",
					"Confirm the map's saved external-actor layout can be read, then retry."
				);
			}
			if (
				packageProjectRelativePath !== externalRoot &&
				!packageProjectRelativePath.startsWith(`${externalRoot}/`)
			) {
				return targetError(
					`Actor package ${packageName} is outside the selected map's proven external-actor scope.`,
					"Select an actor that belongs to the map's matching World Partition external-actor subtree."
				);
			}
		} else {
			return targetError(
				`Conventional map actor package ${packageName} is not the selected map package.`,
				"Select an actor stored in the conventional map package, or use Deep History."
			);
		}
	}

	return {
		actor,
		identity: options.target.identity,
		packageName,
		packageProjectRelativePath
	};
}

/** Builds the explicit targeted-coverage document Fast History must return with every result. */
export function fastHistoryTargetedCoverage(options: {
	readonly mapDepotFileSpec: PerforceDepotPath;
	readonly mapPackageName: string;
	readonly proven: ProvenFastHistoryActorTarget;
	readonly targetDepotFileSpec: PerforceDepotPath;
}): FastHistoryTargetedCoverage {
	const { actor, identity, packageName } = options.proven;
	const mapPackage = {
		depotFileSpec: options.mapDepotFileSpec,
		packageName: options.mapPackageName,
		role: "selected_map" as const
	};
	const acquiredPackages =
		packageName === options.mapPackageName
			? [mapPackage]
			: [
					mapPackage,
					{
						depotFileSpec: options.targetDepotFileSpec,
						packageName,
						role: "investigation_target_actor" as const
					}
				];
	return {
		acquiredPackages,
		claimsCompleteMapCoverage: false,
		claimsHistoricalClassCoverage: false,
		investigationTarget: {
			...(isUsableGuid(actor.actorGuid) ? { actorGuid: actor.actorGuid } : {}),
			actorPath: actor.actorPath,
			classPath: actor.classPath,
			identity,
			kind: "actor",
			packageName
		},
		kind: "targeted"
	};
}

/**
 * Resolves Fast History acquisition to the selected map plus one proven Investigation Target actor
 * package. Unrelated external-actor packages never enter the Perforce file specs or allowlist.
 */
export function resolvePerforceFastMapScope(
	query: PerforceFastMapHistoryQuery
): Effect.Effect<
	ResolvedPerforceFastMapScope,
	MapHistoryError,
	AssetReader | PerforceHistorySource
> {
	return Effect.fn("MapHistory.resolvePerforceFastMapScope")(function* () {
		const perforce = yield* PerforceHistorySource;
		const { scope: mapScope, world } = yield* resolvePresentDayMapScope(query);
		const proven = proveFastHistoryActorTarget({
			scope: mapScope,
			target: query.target,
			world
		});
		if (proven instanceof MapHistoryError) return yield* Effect.fail(proven);

		const mapDepotFileSpec = depotPackageFileSpec(mapScope.mapDepotPath) as PerforceDepotPath;
		if (proven.packageName === mapScope.mapPackageName) {
			return {
				coverage: fastHistoryTargetedCoverage({
					mapDepotFileSpec,
					mapPackageName: mapScope.mapPackageName,
					proven,
					targetDepotFileSpec: mapDepotFileSpec
				}),
				proven,
				scope: {
					...mapScope,
					allowedPackageNames: new Set([mapScope.mapPackageName]),
					fileSpecs: [mapDepotFileSpec]
				}
			};
		}

		const targetLocalPath = resolve(query.projectRoot, proven.packageProjectRelativePath);
		const targetMapping = yield* perforce.resolveLocalPath(targetLocalPath);
		const targetDepotFileSpec = depotPackageFileSpec(
			targetMapping.depotPath
		) as PerforceDepotPath;
		return {
			coverage: fastHistoryTargetedCoverage({
				mapDepotFileSpec,
				mapPackageName: mapScope.mapPackageName,
				proven,
				targetDepotFileSpec
			}),
			proven,
			scope: {
				...mapScope,
				allowedPackageNames: new Set([mapScope.mapPackageName, proven.packageName]),
				fileSpecs: [mapDepotFileSpec, targetDepotFileSpec]
			}
		};
	})();
}
