import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PerforceMapHistory } from "@ue-shed/map-history/contract";
import {
	collectCurrentWorldLogActors,
	collectWorldLogActors,
	noWorldLogActorViewFilters,
	worldLogActorLifecycle,
	worldLogActorMatchesQuery,
	worldLogActorMatchesViewFilters,
	worldLogActorMovementEvents
} from "./world-log-actors.js";

const decodeHistory = Schema.decodeUnknownSync(PerforceMapHistory);

function actor(input: {
	readonly classPath?: string;
	readonly guid: string;
	readonly label: string;
	readonly x: number;
	readonly y: number;
}) {
	return {
		actorGuid: input.guid,
		actorPath: `/Game/Maps/L_Example.L_Example:PersistentLevel.${input.label}`,
		classPath: input.classPath ?? "/Script/Game.Npc",
		label: input.label,
		packageName: `/Game/Actors/${input.label}`,
		position: { location: { x: input.x, y: input.y, z: 0 }, status: "resolved" as const }
	};
}

function snapshot(actors: readonly ReturnType<typeof actor>[]) {
	return {
		actors,
		completeness: "complete" as const,
		diagnostics: [],
		mapPackage: "/Game/Maps/L_Example",
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind: "world_partition" as const,
		summary: {
			failedPackages: 0,
			partialPackages: 0,
			resolvedActors: actors.length,
			scannedPackages: actors.length
		}
	};
}

describe("World Log actor projection", () => {
	it("uses the current saved map as the initial actor projection", () => {
		const lamp = actor({ guid: "lamp", label: "Key lamp", x: 10, y: 20 });
		const world = {
			actors: [lamp],
			mapPath: "Content/Maps/L_Example.umap"
		} as unknown as Parameters<typeof collectCurrentWorldLogActors>[0];

		const projected = collectCurrentWorldLogActors(world);

		expect(projected).toEqual([
			{
				actor: lamp,
				changeCount: 0,
				events: [],
				key: "guid:lamp",
				presentAtRangeEnd: true,
				presentAtRangeStart: true
			}
		]);
	});

	it("retains removed actors and gives stable-identity lifecycle, events, movement, and View Filters", () => {
		const departed = actor({ guid: "departed", label: "Departed NPC", x: 10, y: 20 });
		const movedBefore = actor({ guid: "moved", label: "Moved NPC", x: 30, y: 40 });
		const movedAfter = actor({ guid: "moved", label: "Moved NPC", x: 70, y: 80 });
		const unchanged = actor({ guid: "unchanged", label: "Static prop", x: 90, y: 100 });
		const arrived = actor({ guid: "arrived", label: "Arrived NPC", x: 110, y: 120 });
		const history = decodeHistory({
			baseline: { change: 1, status: "available" },
			completeness: "complete",
			diagnostics: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			query: {
				limits: {
					maxChangelists: 25,
					maxConcurrency: 2,
					maxDurationMs: 1000,
					maxMaterializedFiles: 50,
					maxPackages: 50
				},
				mapPath: "Content/Maps/L_Example.umap",
				projectRoot: "C:/Project",
				range: { since: "2026-07-01T00:00:00.000Z", until: "2026-07-02T00:00:00.000Z" }
			},
			rangeEndSnapshot: snapshot([movedAfter, unchanged, arrived]),
			rangeStartSnapshot: snapshot([departed, movedBefore, unchanged]),
			revisions: [
				{
					change: 2,
					changes: [
						{
							after: arrived,
							identity: { actorGuid: "arrived", kind: "actor_guid" },
							kind: "actor_added"
						},
						{
							before: departed,
							identity: { actorGuid: "departed", kind: "actor_guid" },
							kind: "actor_removed"
						},
						{
							after: movedAfter,
							afterLocation: { x: 70, y: 80, z: 0 },
							before: movedBefore,
							beforeLocation: { x: 30, y: 40, z: 0 },
							identity: { actorGuid: "moved", kind: "actor_guid" },
							kind: "actor_moved"
						}
					],
					completeness: "complete",
					diagnostics: [],
					files: [],
					submittedAt: "2026-07-01T12:00:00.000Z",
					unclassifiedPackageChanges: []
				}
			],
			schemaVersion: 1
		});

		const actors = collectWorldLogActors(history);
		const removed = actors.find((entry) => entry.key === "guid:departed");
		const moved = actors.find((entry) => entry.key === "guid:moved");
		const staticProp = actors.find((entry) => entry.key === "guid:unchanged");

		expect(removed).toBeDefined();
		expect(removed?.presentAtRangeEnd).toBe(false);
		expect(removed === undefined ? undefined : worldLogActorLifecycle(removed)).toBe(
			"removed_in_range"
		);
		expect(moved === undefined ? [] : worldLogActorMovementEvents(moved)).toHaveLength(1);
		expect(staticProp?.changeCount).toBe(0);
		expect(
			moved === undefined ? false : worldLogActorMatchesQuery(moved, "label:moved guid:moved")
		).toBe(true);
		expect(
			moved === undefined ? false : worldLogActorMatchesQuery(moved, "package:departed")
		).toBe(false);
		expect(
			staticProp === undefined
				? true
				: worldLogActorMatchesViewFilters(staticProp, {
						...noWorldLogActorViewFilters,
						changedOnly: true
					})
		).toBe(false);
		expect(
			removed === undefined
				? false
				: worldLogActorMatchesViewFilters(removed, {
						...noWorldLogActorViewFilters,
						presence: "removed"
					})
		).toBe(true);
	});
});
