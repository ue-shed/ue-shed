import type { ActorIdentity, MapChange, PerforceMapHistory } from "@ue-shed/map-history/contract";
import type { SavedWorldActor } from "@ue-shed/protocol";

const zeroActorGuid = /^0{8}-0{8}-0{8}-0{8}$/;

export interface WorldLogActor {
	readonly actor: SavedWorldActor;
	readonly changeCount: number;
	readonly key: string;
	readonly presentAtRangeEnd: boolean;
}

export function actorKeyFromIdentity(identity: ActorIdentity): string {
	return identity.kind === "actor_guid"
		? `guid:${identity.actorGuid}`
		: `path:${identity.packageName}\u0000${identity.actorPath}`;
}

export function actorKeyFromSavedActor(actor: SavedWorldActor): string {
	return actor.actorGuid !== undefined && !zeroActorGuid.test(actor.actorGuid)
		? `guid:${actor.actorGuid}`
		: `path:${actor.packageName}\u0000${actor.actorPath}`;
}

export function actorKeyFromChange(change: MapChange): string | undefined {
	return change.kind === "snapshot_coverage_changed"
		? undefined
		: actorKeyFromIdentity(change.identity);
}

function actorEvidenceFromChange(change: MapChange): SavedWorldActor | undefined {
	switch (change.kind) {
		case "actor_added":
			return change.after;
		case "actor_removed":
			return change.before;
		case "actor_moved":
		case "actor_label_changed":
		case "actor_class_changed":
		case "actor_package_changed":
		case "actor_position_resolution_changed":
			return change.after;
		case "snapshot_coverage_changed":
			return undefined;
	}
}

function actorSortLabel(actor: SavedWorldActor): string {
	return actor.label ?? actor.actorPath;
}

/**
 * Merges the range-end snapshot with actor evidence from the changelist timeline. Removed actors
 * remain searchable as history-only entries, while unchanged actors retain a zero event count.
 */
export function collectWorldLogActors(history: PerforceMapHistory): readonly WorldLogActor[] {
	const entries = new Map<
		string,
		{ actor: SavedWorldActor; changeCount: number; presentAtRangeEnd: boolean }
	>();
	for (const actor of history.rangeEndSnapshot?.actors ?? []) {
		entries.set(actorKeyFromSavedActor(actor), {
			actor,
			changeCount: 0,
			presentAtRangeEnd: true
		});
	}
	for (const revision of history.revisions) {
		for (const change of revision.changes) {
			const key = actorKeyFromChange(change);
			const evidence = actorEvidenceFromChange(change);
			if (key === undefined || evidence === undefined) continue;
			const existing = entries.get(key);
			entries.set(key, {
				actor: existing?.actor ?? evidence,
				changeCount: (existing?.changeCount ?? 0) + 1,
				presentAtRangeEnd: existing?.presentAtRangeEnd ?? false
			});
		}
	}
	return [...entries.entries()]
		.map(([key, entry]) => ({ ...entry, key }))
		.toSorted((left, right) => {
			if (left.presentAtRangeEnd !== right.presentAtRangeEnd)
				return left.presentAtRangeEnd ? -1 : 1;
			return actorSortLabel(left.actor).localeCompare(actorSortLabel(right.actor));
		});
}

export function worldLogActorMatchesQuery(actor: WorldLogActor, query: string): boolean {
	const normalized = query.trim().toLocaleLowerCase();
	if (normalized.length === 0) return true;
	return [
		actor.actor.label,
		actor.actor.actorPath,
		actor.actor.classPath,
		actor.actor.packageName
	]
		.filter((value): value is string => value !== undefined)
		.some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function changeMatchesActor(change: MapChange, actorKey: string | undefined): boolean {
	return actorKey === undefined || actorKeyFromChange(change) === actorKey;
}

export interface WorldLogMapBounds {
	readonly maxX: number;
	readonly maxY: number;
	readonly minX: number;
	readonly minY: number;
}

export function worldLogMapBounds(actors: readonly WorldLogActor[]): WorldLogMapBounds | undefined {
	const resolved = actors.filter(
		(entry) => entry.presentAtRangeEnd && entry.actor.position.status === "resolved"
	);
	if (resolved.length === 0) return undefined;
	const xs = resolved.map((entry) =>
		entry.actor.position.status === "resolved" ? entry.actor.position.location.x : 0
	);
	const ys = resolved.map((entry) =>
		entry.actor.position.status === "resolved" ? entry.actor.position.location.y : 0
	);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const span = Math.max(maxX - minX, maxY - minY, 100);
	const padding = span * 0.1;
	return {
		maxX: maxX + padding,
		maxY: maxY + padding,
		minX: minX - padding,
		minY: minY - padding
	};
}
