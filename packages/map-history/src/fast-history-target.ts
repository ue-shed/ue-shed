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
	PerforceFastMapHistoryQuery
} from "./schema.js";
import { PerforceDepotPath } from "./schema.js";

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
	readonly provenTargets: readonly ProvenFastHistoryActorTarget[];
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

function proveActorPackage(options: {
	readonly actor: SavedWorldActor;
	readonly identity: ActorIdentity;
	readonly scope: ResolvedPerforceMapScope;
}): ProvenFastHistoryActorTarget | MapHistoryError {
	const { actor, identity, scope } = options;
	const packageName = actor.packageName;
	const inMapPackage = packageName === scope.mapPackageName;
	let packageProjectRelativePath: string | undefined;
	if (inMapPackage) {
		packageProjectRelativePath = scope.mapProjectRelativePath;
	} else {
		packageProjectRelativePath = projectRelativePathForPackageName(packageName, ".uasset");
		if (packageProjectRelativePath === undefined) {
			return targetError(
				`Actor package ${packageName} cannot be converted to a project-relative saved package path.`,
				"Confirm the SavedWorld actor projection reports a /Game package name."
			);
		}
		if (scope.sourceKind === "world_partition") {
			const externalRoot = scope.externalActorProjectRoot;
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
		identity,
		packageName,
		packageProjectRelativePath
	};
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

	return proveActorPackage({
		actor,
		identity: options.target.identity,
		scope: options.scope
	});
}

/** Proves every current actor in an exact class target without inferring historical membership. */
export function proveFastHistoryActorClassTargets(options: {
	readonly scope: ResolvedPerforceMapScope;
	readonly target: FastHistoryInvestigationTarget;
	readonly world: SavedWorld;
}): readonly ProvenFastHistoryActorTarget[] | MapHistoryError {
	if (options.target.kind !== "actor_class") {
		return targetError(
			"Fast History class targeting requires an exact actor class path.",
			"Choose a class path or select one present-day actor."
		);
	}
	const classPath = options.target.classPath;
	const matches = options.world.actors.filter((actor) => actor.classPath === classPath);
	if (matches.length === 0) {
		return targetError(
			`No current actors match class ${classPath} in the selected map.`,
			"Choose a class with current actors, or use Deep History to find deleted or reclassified actors."
		);
	}
	const proven: ProvenFastHistoryActorTarget[] = [];
	for (const actor of matches) {
		const target = proveActorPackage({
			actor,
			identity: actorIdentityOf(actor),
			scope: options.scope
		});
		if (target instanceof MapHistoryError) return target;
		proven.push(target);
	}
	return proven;
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
			...(isUsableGuid(actor.actorGuid) ? { actorGuid: actor.actorGuid } : undefined),
			actorPath: actor.actorPath,
			classPath: actor.classPath,
			identity,
			kind: "actor",
			packageName
		},
		kind: "targeted"
	};
}

/** Builds explicit coverage metadata for an exact current actor-class target. */
export function fastHistoryActorClassTargetedCoverage(options: {
	readonly mapDepotFileSpec: PerforceDepotPath;
	readonly mapPackageName: string;
	readonly proven: readonly ProvenFastHistoryActorTarget[];
	readonly target: Extract<FastHistoryInvestigationTarget, { kind: "actor_class" }>;
	readonly targetPackages: readonly {
		readonly depotFileSpec: PerforceDepotPath;
		readonly proven: ProvenFastHistoryActorTarget;
	}[];
}): FastHistoryTargetedCoverage {
	const acquiredPackages: Array<FastHistoryTargetedCoverage["acquiredPackages"][number]> = [
		{
			depotFileSpec: options.mapDepotFileSpec,
			packageName: options.mapPackageName,
			role: "selected_map"
		}
	];
	const acquiredPackageNames = new Set([options.mapPackageName]);
	for (const targetPackage of options.targetPackages) {
		if (acquiredPackageNames.has(targetPackage.proven.packageName)) continue;
		acquiredPackageNames.add(targetPackage.proven.packageName);
		acquiredPackages.push({
			depotFileSpec: targetPackage.depotFileSpec,
			packageName: targetPackage.proven.packageName,
			role: "investigation_target_class"
		});
	}
	return {
		acquiredPackages,
		claimsCompleteMapCoverage: false,
		claimsHistoricalClassCoverage: false,
		investigationTarget: {
			classPath: options.target.classPath,
			currentActorCount: options.proven.length,
			kind: "actor_class"
		},
		kind: "targeted"
	};
}

/**
 * Resolves Fast History acquisition to the selected map plus proven Investigation Target packages.
 * Unrelated external-actor packages never enter the Perforce file specs or allowlist.
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
		const provenTargets =
			query.target.kind === "actor"
				? (() => {
						const proven = proveFastHistoryActorTarget({
							scope: mapScope,
							target: query.target,
							world
						});
						return proven instanceof MapHistoryError ? proven : [proven];
					})()
				: proveFastHistoryActorClassTargets({
						scope: mapScope,
						target: query.target,
						world
					});
		if (provenTargets instanceof MapHistoryError) return yield* Effect.fail(provenTargets);
		const proven = provenTargets[0];
		if (proven === undefined) {
			return yield* Effect.fail(
				targetError(
					"Fast History could not prove any current Investigation Target package.",
					"Choose a current actor or class, then retry."
				)
			);
		}

		const mapDepotFileSpec = PerforceDepotPath.make(
			depotPackageFileSpec(mapScope.mapDepotPath)
		);
		const targetPackages: Array<{
			readonly depotFileSpec: PerforceDepotPath;
			readonly proven: ProvenFastHistoryActorTarget;
		}> = [];
		const mappedPackageNames = new Set<string>();
		for (const target of provenTargets) {
			if (
				target.packageName === mapScope.mapPackageName ||
				mappedPackageNames.has(target.packageName)
			)
				continue;
			mappedPackageNames.add(target.packageName);
			const targetLocalPath = resolve(query.projectRoot, target.packageProjectRelativePath);
			const targetMapping = yield* perforce.resolveLocalPath(targetLocalPath);
			targetPackages.push({
				depotFileSpec: PerforceDepotPath.make(
					depotPackageFileSpec(targetMapping.depotPath)
				),
				proven: target
			});
		}
		const allowedPackageNames = new Set([
			mapScope.mapPackageName,
			...provenTargets.map((target) => target.packageName)
		]);
		const fileSpecs = [
			mapDepotFileSpec,
			...targetPackages.map((target) => target.depotFileSpec)
		];
		const coverage =
			query.target.kind === "actor_class"
				? fastHistoryActorClassTargetedCoverage({
						mapDepotFileSpec,
						mapPackageName: mapScope.mapPackageName,
						proven: provenTargets,
						target: query.target,
						targetPackages
					})
				: fastHistoryTargetedCoverage({
						mapDepotFileSpec,
						mapPackageName: mapScope.mapPackageName,
						proven,
						targetDepotFileSpec: targetPackages[0]?.depotFileSpec ?? mapDepotFileSpec
					});
		return {
			coverage,
			proven,
			provenTargets,
			scope: {
				...mapScope,
				allowedPackageNames,
				fileSpecs
			}
		};
	})();
}
