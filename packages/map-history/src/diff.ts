import type { SavedWorld, SavedWorldActor, SavedWorldPosition } from "@ue-shed/protocol";
import type { ActorIdentity, MapChange, MapHistoryDiagnostic, MapSnapshotDiff } from "./schema.js";

const ZERO_GUID = /^0{8}-0{8}-0{8}-0{8}$/;

export function actorIdentityOf(actor: SavedWorldActor): ActorIdentity {
	if (actor.actorGuid !== undefined && !ZERO_GUID.test(actor.actorGuid)) {
		return { actorGuid: actor.actorGuid, kind: "actor_guid" };
	}
	return {
		actorPath: actor.actorPath,
		kind: "object_path",
		packageName: actor.packageName
	};
}

export function actorIdentityKey(identity: ActorIdentity): string {
	return identity.kind === "actor_guid"
		? `guid:${identity.actorGuid}`
		: `path:${identity.packageName}\u0000${identity.actorPath}`;
}

interface ActorIndex {
	readonly actors: ReadonlyMap<string, SavedWorldActor>;
	readonly identities: ReadonlyMap<string, ActorIdentity>;
	readonly ambiguous: ReadonlySet<string>;
}

function indexActors(actors: readonly SavedWorldActor[]): ActorIndex {
	const indexed = new Map<string, SavedWorldActor>();
	const identities = new Map<string, ActorIdentity>();
	const ambiguous = new Set<string>();
	for (const actor of actors) {
		const identity = actorIdentityOf(actor);
		const key = actorIdentityKey(identity);
		if (indexed.has(key)) {
			ambiguous.add(key);
			indexed.delete(key);
			identities.delete(key);
			continue;
		}
		if (ambiguous.has(key)) continue;
		indexed.set(key, actor);
		identities.set(key, identity);
	}
	return { actors: indexed, identities, ambiguous };
}

function positionsEqual(before: SavedWorldPosition, after: SavedWorldPosition): boolean {
	if (before.status !== after.status) return false;
	switch (before.status) {
		case "resolved":
			return (
				after.status === "resolved" &&
				before.location.x === after.location.x &&
				before.location.y === after.location.y &&
				before.location.z === after.location.z
			);
		case "missing_attachment_parent":
			return (
				after.status === "missing_attachment_parent" &&
				before.parentPath === after.parentPath
			);
		case "missing_root_component":
			return true;
		case "attachment_cycle":
		case "ambiguous_component_path":
		case "unsupported_absolute_transform":
			return after.status === before.status && before.componentPath === after.componentPath;
	}
}

function coverageOf(world: SavedWorld) {
	return {
		completeness: world.completeness,
		failedPackages: world.summary.failedPackages,
		partialPackages: world.summary.partialPackages
	} as const;
}

function compareMatchedActor(
	identity: ActorIdentity,
	before: SavedWorldActor,
	after: SavedWorldActor
): MapChange[] {
	const changes: MapChange[] = [];
	if (before.packageName !== after.packageName || before.actorPath !== after.actorPath) {
		changes.push({ after, before, identity, kind: "actor_package_changed" });
	}
	if (before.classPath !== after.classPath) {
		changes.push({ after, before, identity, kind: "actor_class_changed" });
	}
	if (before.label !== after.label) {
		changes.push({ after, before, identity, kind: "actor_label_changed" });
	}
	if (before.position.status === "resolved" && after.position.status === "resolved") {
		if (
			before.position.location.x !== after.position.location.x ||
			before.position.location.y !== after.position.location.y ||
			before.position.location.z !== after.position.location.z
		) {
			changes.push({
				after,
				afterLocation: after.position.location,
				before,
				beforeLocation: before.position.location,
				identity,
				kind: "actor_moved"
			});
		}
	} else if (!positionsEqual(before.position, after.position)) {
		changes.push({
			after,
			afterPosition: after.position,
			before,
			beforePosition: before.position,
			identity,
			kind: "actor_position_resolution_changed"
		});
	}
	return changes;
}

export function diffSavedWorldSnapshots(before: SavedWorld, after: SavedWorld): MapSnapshotDiff {
	const beforeIndex = indexActors(before.actors);
	const afterIndex = indexActors(after.actors);
	const ambiguous = new Set([...beforeIndex.ambiguous, ...afterIndex.ambiguous]);
	const diagnostics: MapHistoryDiagnostic[] = [...ambiguous].sort().map((key) => ({
		code: "ambiguous_actor_identity",
		message: `Actor continuity is ambiguous for ${key}.`,
		retrySafe: false
	}));
	const changes: MapChange[] = [];
	const keys = new Set([...beforeIndex.actors.keys(), ...afterIndex.actors.keys()]);

	for (const key of [...keys].sort()) {
		if (ambiguous.has(key)) continue;
		const beforeActor = beforeIndex.actors.get(key);
		const afterActor = afterIndex.actors.get(key);
		const identity = beforeIndex.identities.get(key) ?? afterIndex.identities.get(key);
		if (identity === undefined) continue;
		if (beforeActor === undefined && afterActor !== undefined) {
			if (before.completeness === "partial") {
				diagnostics.push({
					code: "actor_addition_withheld_partial_snapshot",
					message: `Actor addition is unproven because the earlier snapshot is partial for ${key}.`,
					retrySafe: false
				});
				continue;
			}
			changes.push({ after: afterActor, identity, kind: "actor_added" });
			continue;
		}
		if (beforeActor !== undefined && afterActor === undefined) {
			if (after.completeness === "partial") {
				diagnostics.push({
					code: "actor_removal_withheld_partial_snapshot",
					message: `Actor removal is unproven because the later snapshot is partial for ${key}.`,
					retrySafe: false
				});
				continue;
			}
			changes.push({ before: beforeActor, identity, kind: "actor_removed" });
			continue;
		}
		if (beforeActor !== undefined && afterActor !== undefined) {
			changes.push(...compareMatchedActor(identity, beforeActor, afterActor));
		}
	}

	const beforeCoverage = coverageOf(before);
	const afterCoverage = coverageOf(after);
	if (JSON.stringify(beforeCoverage) !== JSON.stringify(afterCoverage)) {
		changes.push({
			after: afterCoverage,
			before: beforeCoverage,
			kind: "snapshot_coverage_changed"
		});
	}

	return { changes, diagnostics };
}
