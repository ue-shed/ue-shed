import type {
	ActorIdentity,
	MapChange,
	PerforceMapHistory,
	PerforceMapRevision
} from "@ue-shed/map-history/contract";
import type { SavedWorldActor } from "@ue-shed/protocol";

const zeroActorGuid = /^0{8}-0{8}-0{8}-0{8}$/;

export interface WorldLogActor {
	readonly actor: SavedWorldActor;
	readonly changeCount: number;
	readonly events: ReadonlyArray<WorldLogActorEvent>;
	readonly key: string;
	readonly presentAtRangeEnd: boolean;
	readonly presentAtRangeStart: boolean;
}

export interface WorldLogActorEvent {
	readonly change: MapChange;
	readonly changeIndex: number;
	readonly revision: PerforceMapRevision;
	readonly revisionIndex: number;
}

export type WorldLogActorLifecycle =
	| "added_in_range"
	| "created_and_removed_in_range"
	| "present_throughout_range"
	| "removed_in_range";

export interface WorldLogActorViewFilters {
	readonly changedOnly: boolean;
	readonly classPath: string | undefined;
	readonly presence: "all" | "present" | "removed";
	readonly query: string;
	readonly resolution: "all" | "resolved" | "unresolved";
}

export const noWorldLogActorViewFilters: WorldLogActorViewFilters = {
	changedOnly: false,
	classPath: undefined,
	presence: "all",
	query: "",
	resolution: "all"
};

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
		{
			actor: SavedWorldActor;
			events: WorldLogActorEvent[];
			presentAtRangeEnd: boolean;
			presentAtRangeStart: boolean;
		}
	>();
	for (const actor of history.rangeEndSnapshot?.actors ?? []) {
		entries.set(actorKeyFromSavedActor(actor), {
			actor,
			events: [],
			presentAtRangeEnd: true,
			presentAtRangeStart: false
		});
	}
	for (const actor of history.rangeStartSnapshot?.actors ?? []) {
		const key = actorKeyFromSavedActor(actor);
		const existing = entries.get(key);
		entries.set(key, {
			actor: existing?.actor ?? actor,
			events: existing?.events ?? [],
			presentAtRangeEnd: existing?.presentAtRangeEnd ?? false,
			presentAtRangeStart: true
		});
	}
	for (const [revisionIndex, revision] of history.revisions.entries()) {
		for (const [changeIndex, change] of revision.changes.entries()) {
			const key = actorKeyFromChange(change);
			const evidence = actorEvidenceFromChange(change);
			if (key === undefined || evidence === undefined) continue;
			const existing = entries.get(key);
			entries.set(key, {
				actor: existing?.actor ?? evidence,
				events: [
					...(existing?.events ?? []),
					{ change, changeIndex, revision, revisionIndex }
				],
				presentAtRangeEnd: existing?.presentAtRangeEnd ?? false,
				presentAtRangeStart: existing?.presentAtRangeStart ?? false
			});
		}
	}
	return [...entries.entries()]
		.map(([key, entry]) => ({ ...entry, changeCount: entry.events.length, key }))
		.toSorted((left, right) => {
			if (left.presentAtRangeEnd !== right.presentAtRangeEnd)
				return left.presentAtRangeEnd ? -1 : 1;
			return actorSortLabel(left.actor).localeCompare(actorSortLabel(right.actor));
		});
}

function textIncludes(value: string | undefined, query: string): boolean {
	return value?.toLocaleLowerCase().includes(query) ?? false;
}

function matchesSearchTerm(actor: WorldLogActor, term: string): boolean {
	const separator = term.indexOf(":");
	const field = separator < 1 ? undefined : term.slice(0, separator).toLocaleLowerCase();
	const query = (separator < 1 ? term : term.slice(separator + 1)).toLocaleLowerCase();
	if (query.length === 0) return true;
	switch (field) {
		case "label":
			return textIncludes(actor.actor.label, query);
		case "class":
			return textIncludes(actor.actor.classPath, query);
		case "path":
			return textIncludes(actor.actor.actorPath, query);
		case "package":
			return textIncludes(actor.actor.packageName, query);
		case "guid":
			return textIncludes(actor.actor.actorGuid, query);
		case undefined:
			return [
				actor.actor.label,
				actor.actor.actorPath,
				actor.actor.classPath,
				actor.actor.packageName,
				actor.actor.actorGuid
			].some((value) => textIncludes(value, query));
		default:
			return false;
	}
}

export function worldLogActorMatchesQuery(actor: WorldLogActor, query: string): boolean {
	return query
		.trim()
		.split(/\s+/)
		.filter((term) => term.length > 0)
		.every((term) => matchesSearchTerm(actor, term));
}

export function worldLogActorLifecycle(actor: WorldLogActor): WorldLogActorLifecycle {
	if (actor.presentAtRangeStart && actor.presentAtRangeEnd) return "present_throughout_range";
	if (actor.presentAtRangeStart) return "removed_in_range";
	return actor.presentAtRangeEnd ? "added_in_range" : "created_and_removed_in_range";
}

export function worldLogActorMatchesViewFilters(
	actor: WorldLogActor,
	filters: WorldLogActorViewFilters
): boolean {
	if (filters.changedOnly && actor.changeCount === 0) return false;
	if (filters.classPath !== undefined && actor.actor.classPath !== filters.classPath)
		return false;
	if (filters.presence === "present" && !actor.presentAtRangeEnd) return false;
	if (filters.presence === "removed" && actor.presentAtRangeEnd) return false;
	if (filters.resolution === "resolved" && actor.actor.position.status !== "resolved")
		return false;
	if (filters.resolution === "unresolved" && actor.actor.position.status === "resolved")
		return false;
	return worldLogActorMatchesQuery(actor, filters.query);
}

export function worldLogActorMovementEvents(
	actor: WorldLogActor
): ReadonlyArray<WorldLogActorEvent> {
	return actor.events.filter((event) => event.change.kind === "actor_moved");
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
