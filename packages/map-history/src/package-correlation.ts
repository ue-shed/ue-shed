import type { SavedWorld, SavedWorldActor } from "@ue-shed/protocol";
import { actorIdentityKey, actorIdentityOf } from "./diff.js";
import type {
	ActorIdentity,
	MapChange,
	MapSnapshotDiff,
	SavedPackageChangeEvidence,
	UnclassifiedPackageChange
} from "./schema.js";

function actorPackagesForChange(change: MapChange): readonly string[] {
	switch (change.kind) {
		case "actor_added":
			return [change.after.packageName];
		case "actor_removed":
			return [change.before.packageName];
		case "actor_moved":
		case "actor_label_changed":
		case "actor_class_changed":
		case "actor_package_changed":
		case "actor_position_resolution_changed":
			return [change.before.packageName, change.after.packageName];
		case "snapshot_coverage_changed":
			return [];
	}
}

function ambiguousPackageNames(world: SavedWorld): ReadonlySet<string> {
	const actorsByIdentity = new Map<string, SavedWorldActor[]>();
	for (const actor of world.actors) {
		const key = actorIdentityKey(actorIdentityOf(actor));
		const actors = actorsByIdentity.get(key);
		if (actors === undefined) actorsByIdentity.set(key, [actor]);
		else actors.push(actor);
	}
	return new Set(
		[...actorsByIdentity.values()]
			.filter((actors) => actors.length > 1)
			.flatMap((actors) => actors.map((actor) => actor.packageName))
	);
}

function identitiesInPackage(
	packageName: string,
	before: SavedWorld,
	after: SavedWorld,
	ambiguousPackages: ReadonlySet<string>
): readonly ActorIdentity[] {
	if (ambiguousPackages.has(packageName)) return [];
	const identities = new Map<string, ActorIdentity>();
	for (const actor of [...before.actors, ...after.actors]) {
		if (actor.packageName !== packageName) continue;
		const identity = actorIdentityOf(actor);
		identities.set(actorIdentityKey(identity), identity);
	}
	return [...identities.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, identity]) => identity);
}

export interface CorrelatePackageChangesOptions {
	readonly after: SavedWorld;
	readonly before: SavedWorld;
	readonly diff: MapSnapshotDiff;
	readonly packageChanges: readonly SavedPackageChangeEvidence[];
}

/**
 * Retains every changed saved package that the supported actor projection cannot explain.
 *
 * `packageName` is supplied by the verified depot-to-project mapping boundary. This function does
 * not infer Unreal package identity from depot strings.
 */
export function findUnclassifiedPackageChanges(
	options: CorrelatePackageChangesOptions
): readonly UnclassifiedPackageChange[] {
	const explainedPackages = new Set(
		options.diff.changes.flatMap((change) => actorPackagesForChange(change))
	);
	const ambiguousPackages = new Set([
		...ambiguousPackageNames(options.before),
		...ambiguousPackageNames(options.after)
	]);
	const snapshotPartial =
		options.before.completeness === "partial" || options.after.completeness === "partial";

	return [...options.packageChanges]
		.sort((left, right) => left.depotPath.localeCompare(right.depotPath))
		.filter((change) => !explainedPackages.has(change.packageName))
		.map((change) => ({
			action: change.action,
			actorIdentities: identitiesInPackage(
				change.packageName,
				options.before,
				options.after,
				ambiguousPackages
			),
			afterRevision: change.afterRevision,
			beforeRevision: change.beforeRevision,
			depotPath: change.depotPath,
			packageName: change.packageName,
			reason: snapshotPartial
				? "snapshot_partial"
				: ambiguousPackages.has(change.packageName)
					? "actor_identity_unavailable"
					: "projection_unchanged"
		}));
}
