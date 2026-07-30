import type { SavedWorldActor } from "@ue-shed/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	applyMapHistoryRevision,
	createMapHistoryPlaybackState,
	mapHistoryPlaybackFrameAt,
	mapHistoryPlaybackMatchesRangeEnd,
	revertMapHistoryRevision
} from "./playback.js";
import { PerforceMapHistory } from "./schema.js";

function actor(overrides: Partial<SavedWorldActor> = {}): SavedWorldActor {
	return {
		actorGuid: "00000001-00000002-00000003-00000004",
		actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Actor",
		classPath: "/Script/Engine.StaticMeshActor",
		label: "Actor",
		packageName: "/Game/Maps/L_Example",
		position: { location: { x: 1, y: 2, z: 3 }, status: "resolved" },
		...overrides
	};
}

function snapshot(
	actors: readonly SavedWorldActor[],
	completeness: "complete" | "partial" = "complete"
) {
	return {
		actors,
		completeness,
		diagnostics: [],
		mapPackage: "/Game/Maps/L_Example",
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind: "level" as const,
		summary: {
			failedPackages: completeness === "partial" ? 1 : 0,
			partialPackages: 0,
			resolvedActors: actors.filter((entry) => entry.position.status === "resolved").length,
			scannedPackages: 1
		}
	};
}

function history(input: {
	readonly end: readonly SavedWorldActor[];
	readonly endCompleteness?: "complete" | "partial";
	readonly revisions: readonly unknown[];
	readonly start?: readonly SavedWorldActor[];
	readonly startCompleteness?: "complete" | "partial";
}) {
	return Schema.decodeUnknownSync(PerforceMapHistory)({
		baseline:
			input.start === undefined
				? { status: "map_not_yet_created" }
				: { change: 9, status: "available" },
		completeness: input.endCompleteness ?? "complete",
		diagnostics: [],
		mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
		query: {
			limits: {
				maxChangelists: 10,
				maxConcurrency: 2,
				maxDurationMs: 60_000,
				maxMaterializedFiles: 100,
				maxPackages: 100
			},
			mapPath: "Content/Maps/L_Example.umap",
			projectRoot: "C:/Project",
			range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-28T00:00:00.000Z" }
		},
		...(input.start === undefined
			? {}
			: { rangeStartSnapshot: snapshot(input.start, input.startCompleteness) }),
		rangeEndSnapshot: snapshot(input.end, input.endCompleteness),
		revisions: input.revisions,
		schemaVersion: 1
	});
}

function revision(input: {
	readonly change: number;
	readonly changes: readonly unknown[];
	readonly completeness?: "complete" | "partial";
	readonly unclassifiedPackageChanges?: readonly unknown[];
}) {
	return {
		change: input.change,
		changes: input.changes,
		completeness: input.completeness ?? "complete",
		diagnostics: [],
		files: [],
		submittedAt: "2026-07-22T00:00:00.000Z",
		unclassifiedPackageChanges: input.unclassifiedPackageChanges ?? []
	};
}

describe("Map History playback", () => {
	it("replays semantic transitions, additions, and removals at submitted states", () => {
		const before = actor();
		const moved = actor({
			label: "Moved actor",
			position: { location: { x: 100, y: 200, z: 300 }, status: "resolved" }
		});
		const arrival = actor({
			actorGuid: "00000005-00000006-00000007-00000008",
			actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Arrival",
			label: "Arrival"
		});
		const identity = { actorGuid: before.actorGuid, kind: "actor_guid" };
		const arrivalIdentity = { actorGuid: arrival.actorGuid, kind: "actor_guid" };
		const result = history({
			end: [arrival],
			revisions: [
				revision({
					change: 10,
					changes: [
						{
							after: moved,
							afterLocation:
								moved.position.status === "resolved"
									? moved.position.location
									: undefined,
							before,
							beforeLocation:
								before.position.status === "resolved"
									? before.position.location
									: undefined,
							identity,
							kind: "actor_moved"
						},
						{ after: moved, before, identity, kind: "actor_label_changed" }
					]
				}),
				revision({
					change: 11,
					changes: [{ after: arrival, identity: arrivalIdentity, kind: "actor_added" }]
				}),
				revision({
					change: 12,
					changes: [{ before: moved, identity, kind: "actor_removed" }]
				})
			],
			start: [before]
		});

		expect(
			mapHistoryPlaybackFrameAt({ history: result, revisionIndex: undefined }).actors
		).toEqual([{ actor: before, identity, key: `guid:${before.actorGuid}` }]);
		expect(
			mapHistoryPlaybackFrameAt({ history: result, revisionIndex: 0 }).actors.map(
				(entry) => entry.actor
			)
		).toEqual([moved]);
		expect(
			mapHistoryPlaybackFrameAt({ history: result, revisionIndex: 1 }).actors.map(
				(entry) => entry.actor.label
			)
		).toEqual(["Moved actor", "Arrival"]);
		expect(
			mapHistoryPlaybackFrameAt({ history: result, revisionIndex: 2 }).actors.map(
				(entry) => entry.actor.label
			)
		).toEqual(["Arrival"]);
		expect(mapHistoryPlaybackMatchesRangeEnd({ history: result })).toBe(true);
	});

	it("applies and reverts a changelist without mutating the prior state", () => {
		const before = actor();
		const after = actor({ label: "Renamed" });
		const identity = { actorGuid: before.actorGuid, kind: "actor_guid" };
		const result = history({
			end: [after],
			revisions: [
				revision({
					change: 10,
					changes: [{ after, before, identity, kind: "actor_label_changed" }]
				})
			],
			start: [before]
		});
		const start = createMapHistoryPlaybackState({ history: result });
		const firstRevision = result.revisions[0];
		if (firstRevision === undefined) throw new Error("Playback fixture has no revision.");
		const afterRevision = applyMapHistoryRevision({ revision: firstRevision, state: start });
		const reverted = revertMapHistoryRevision({
			revision: firstRevision,
			state: afterRevision
		});

		expect([...start.actors.values()].map((entry) => entry.actor.label)).toEqual(["Actor"]);
		expect([...afterRevision.actors.values()].map((entry) => entry.actor.label)).toEqual([
			"Renamed"
		]);
		expect([...reverted.actors.values()]).toEqual([...start.actors.values()]);
	});

	it("starts from an explicit empty state when the map was created inside the range", () => {
		const created = actor();
		const identity = { actorGuid: created.actorGuid, kind: "actor_guid" };
		const result = history({
			end: [created],
			revisions: [
				revision({
					change: 10,
					changes: [{ after: created, identity, kind: "actor_added" }]
				})
			]
		});

		expect(
			mapHistoryPlaybackFrameAt({ history: result, revisionIndex: undefined })
		).toMatchObject({
			actors: [],
			kind: "range_start"
		});
		expect(
			mapHistoryPlaybackFrameAt({ history: result, revisionIndex: 0 }).actors.map(
				(entry) => entry.actor.label
			)
		).toEqual(["Actor"]);
	});

	it("keeps partial coverage and unclassified package evidence on the active frame", () => {
		const retained = actor();
		const result = history({
			end: [retained],
			endCompleteness: "partial",
			revisions: [
				revision({
					change: 10,
					changes: [
						{
							after: {
								completeness: "partial",
								failedPackages: 1,
								partialPackages: 0
							},
							before: {
								completeness: "complete",
								failedPackages: 0,
								partialPackages: 0
							},
							kind: "snapshot_coverage_changed"
						}
					],
					completeness: "partial",
					unclassifiedPackageChanges: [
						{
							action: "edit",
							actorIdentities: [],
							afterRevision: 2,
							beforeRevision: 1,
							depotPath: "//Project/Main/Content/Maps/L_Example.umap",
							packageName: "/Game/Maps/L_Example",
							reason: "projection_unchanged"
						}
					]
				})
			],
			start: [retained]
		});
		const frame = mapHistoryPlaybackFrameAt({ history: result, revisionIndex: 0 });

		expect(frame.completeness).toBe("partial");
		expect(frame.actors.map((entry) => entry.actor.label)).toEqual(["Actor"]);
		expect(frame.unclassifiedPackageChanges).toHaveLength(1);
		expect(mapHistoryPlaybackMatchesRangeEnd({ history: result })).toBeUndefined();
	});

	it("rejects a baseline result missing the required playback snapshot", () => {
		const encoded = Schema.encodeSync(PerforceMapHistory)(
			history({ end: [], revisions: [], start: [] })
		);
		const { rangeStartSnapshot: _rangeStartSnapshot, ...missingSnapshot } = encoded;
		const malformed = Schema.decodeUnknownSync(PerforceMapHistory)(missingSnapshot);

		expect(() => createMapHistoryPlaybackState({ history: malformed })).toThrow(
			"no rangeStartSnapshot"
		);
	});
});
