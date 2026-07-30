import type { SavedWorldActor } from "@ue-shed/protocol";
import { actorIdentityKey, actorIdentityOf, savedWorldPositionsEqual } from "./diff.js";
import type {
	ActorIdentity,
	MapHistoryDiagnostic,
	PerforceMapHistory,
	PerforceMapRevision,
	UnclassifiedPackageChange
} from "./schema.js";

export interface MapHistoryPlaybackActor {
	readonly actor: SavedWorldActor;
	readonly identity: ActorIdentity;
	/** Stable GUID-first key shared with Map History changes and World Log selection. */
	readonly key: string;
}

export interface MapHistoryPlaybackState {
	readonly actors: ReadonlyMap<string, MapHistoryPlaybackActor>;
	/** Diagnostics caused by preserving actor identity while constructing the local playback state. */
	readonly diagnostics: ReadonlyArray<MapHistoryDiagnostic>;
}

export type MapHistoryPlaybackFrame =
	| {
			readonly actors: ReadonlyArray<MapHistoryPlaybackActor>;
			readonly completeness: "complete" | "partial";
			readonly diagnostics: ReadonlyArray<MapHistoryDiagnostic>;
			readonly kind: "range_start";
			readonly state: MapHistoryPlaybackState;
			readonly unclassifiedPackageChanges: ReadonlyArray<UnclassifiedPackageChange>;
	  }
	| {
			readonly actors: ReadonlyArray<MapHistoryPlaybackActor>;
			readonly completeness: "complete" | "partial";
			readonly diagnostics: ReadonlyArray<MapHistoryDiagnostic>;
			readonly kind: "revision";
			readonly revision: PerforceMapRevision;
			readonly revisionIndex: number;
			readonly state: MapHistoryPlaybackState;
			readonly unclassifiedPackageChanges: ReadonlyArray<UnclassifiedPackageChange>;
	  };

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function playbackActor(
	actor: SavedWorldActor,
	identity = actorIdentityOf(actor)
): MapHistoryPlaybackActor {
	return { actor, identity, key: actorIdentityKey(identity) };
}

function ambiguousIdentityDiagnostic(key: string): MapHistoryDiagnostic {
	return {
		code: "ambiguous_actor_identity",
		message: `Playback withheld ambiguous actor identity ${key}.`,
		retrySafe: false
	};
}

function stateFromActors(actors: readonly SavedWorldActor[]): MapHistoryPlaybackState {
	const indexed = new Map<string, MapHistoryPlaybackActor>();
	const ambiguous = new Set<string>();
	for (const actor of actors) {
		const entry = playbackActor(actor);
		if (ambiguous.has(entry.key)) continue;
		if (indexed.has(entry.key)) {
			indexed.delete(entry.key);
			ambiguous.add(entry.key);
			continue;
		}
		indexed.set(entry.key, entry);
	}
	return {
		actors: indexed,
		diagnostics: [...ambiguous].sort(compareText).map(ambiguousIdentityDiagnostic)
	};
}

function writeAfterChange(
	actors: Map<string, MapHistoryPlaybackActor>,
	change: PerforceMapRevision["changes"][number]
): void {
	switch (change.kind) {
		case "actor_added":
			actors.set(
				actorIdentityKey(change.identity),
				playbackActor(change.after, change.identity)
			);
			return;
		case "actor_removed":
			actors.delete(actorIdentityKey(change.identity));
			return;
		case "snapshot_coverage_changed":
			return;
		default:
			actors.set(
				actorIdentityKey(change.identity),
				playbackActor(change.after, change.identity)
			);
	}
}

function writeBeforeChange(
	actors: Map<string, MapHistoryPlaybackActor>,
	change: PerforceMapRevision["changes"][number]
): void {
	switch (change.kind) {
		case "actor_added":
			actors.delete(actorIdentityKey(change.identity));
			return;
		case "actor_removed":
			actors.set(
				actorIdentityKey(change.identity),
				playbackActor(change.before, change.identity)
			);
			return;
		case "snapshot_coverage_changed":
			return;
		default:
			actors.set(
				actorIdentityKey(change.identity),
				playbackActor(change.before, change.identity)
			);
	}
}

function orderedActors(state: MapHistoryPlaybackState): ReadonlyArray<MapHistoryPlaybackActor> {
	return [...state.actors.values()].sort((left, right) => compareText(left.key, right.key));
}

function savedWorldActorsEqual(left: SavedWorldActor, right: SavedWorldActor): boolean {
	return (
		left.actorGuid === right.actorGuid &&
		left.actorPath === right.actorPath &&
		left.classPath === right.classPath &&
		left.label === right.label &&
		left.packageName === right.packageName &&
		savedWorldPositionsEqual(left.position, right.position)
	);
}

function initialSnapshot(history: PerforceMapHistory) {
	if (history.rangeStartSnapshot !== undefined) return history.rangeStartSnapshot;
	if (history.baseline.status === "map_not_yet_created") return undefined;
	throw new Error(
		"Map History has a baseline but no rangeStartSnapshot. Re-run the scan with a playback-capable Map History producer."
	);
}

/** Creates the actor state immediately before the requested history range. */
export function createMapHistoryPlaybackState(input: {
	readonly history: PerforceMapHistory;
}): MapHistoryPlaybackState {
	return stateFromActors(initialSnapshot(input.history)?.actors ?? []);
}

/** Applies one submitted map revision to a playback state without mutating the prior state. */
export function applyMapHistoryRevision(input: {
	readonly revision: PerforceMapRevision;
	readonly state: MapHistoryPlaybackState;
}): MapHistoryPlaybackState {
	const actors = new Map(input.state.actors);
	for (const change of input.revision.changes) writeAfterChange(actors, change);
	return { actors, diagnostics: input.state.diagnostics };
}

/** Reverts one submitted map revision without mutating the later playback state. */
export function revertMapHistoryRevision(input: {
	readonly revision: PerforceMapRevision;
	readonly state: MapHistoryPlaybackState;
}): MapHistoryPlaybackState {
	const actors = new Map(input.state.actors);
	for (const change of [...input.revision.changes].reverse()) writeBeforeChange(actors, change);
	return { actors, diagnostics: input.state.diagnostics };
}

/**
 * Reconstructs the range-start frame or the saved state immediately after one in-range submitted
 * changelist. This performs no Perforce or filesystem work and retains only the requested state.
 */
export function mapHistoryPlaybackFrameAt(input: {
	readonly history: PerforceMapHistory;
	readonly revisionIndex: number | undefined;
}): MapHistoryPlaybackFrame {
	const startSnapshot = initialSnapshot(input.history);
	let state = createMapHistoryPlaybackState({ history: input.history });
	if (input.revisionIndex === undefined) {
		return {
			actors: orderedActors(state),
			completeness: startSnapshot?.completeness ?? "complete",
			diagnostics: [...(startSnapshot?.diagnostics ?? []), ...state.diagnostics],
			kind: "range_start",
			state,
			unclassifiedPackageChanges: []
		};
	}
	if (
		!Number.isInteger(input.revisionIndex) ||
		input.revisionIndex < 0 ||
		input.revisionIndex >= input.history.revisions.length
	) {
		throw new RangeError(
			`Map History revision index ${input.revisionIndex} is outside this result.`
		);
	}
	for (let index = 0; index <= input.revisionIndex; index += 1) {
		const revision = input.history.revisions[index];
		if (revision === undefined) throw new Error(`Missing Map History revision ${index}.`);
		state = applyMapHistoryRevision({ revision, state });
	}
	const revision = input.history.revisions[input.revisionIndex];
	if (revision === undefined)
		throw new Error(`Missing Map History revision ${input.revisionIndex}.`);
	return {
		actors: orderedActors(state),
		completeness: revision.completeness,
		diagnostics: [...revision.diagnostics, ...state.diagnostics],
		kind: "revision",
		revision,
		revisionIndex: input.revisionIndex,
		state,
		unclassifiedPackageChanges: revision.unclassifiedPackageChanges
	};
}

/**
 * Returns `undefined` when a complete comparison is impossible; otherwise verifies that replayed
 * actor facts exactly equal the retained end-of-range saved-world projection.
 */
export function mapHistoryPlaybackMatchesRangeEnd(input: {
	readonly history: PerforceMapHistory;
}): boolean | undefined {
	const snapshot = input.history.rangeEndSnapshot;
	if (snapshot === undefined || snapshot.completeness !== "complete") return undefined;
	const frame = mapHistoryPlaybackFrameAt({
		history: input.history,
		revisionIndex:
			input.history.revisions.length === 0 ? undefined : input.history.revisions.length - 1
	});
	if (frame.completeness !== "complete") return undefined;
	const expected = stateFromActors(snapshot.actors);
	if (expected.diagnostics.length > 0 || frame.state.diagnostics.length > 0) return false;
	if (frame.state.actors.size !== expected.actors.size) return false;
	for (const [key, expectedActor] of expected.actors) {
		const actualActor = frame.state.actors.get(key);
		if (
			actualActor === undefined ||
			!savedWorldActorsEqual(actualActor.actor, expectedActor.actor)
		) {
			return false;
		}
	}
	return true;
}
