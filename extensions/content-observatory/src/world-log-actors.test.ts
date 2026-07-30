import { PerforceMapHistory } from "@ue-shed/map-history/contract";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	actorKeyFromSavedActor,
	changeMatchesActor,
	collectWorldLogActors,
	worldLogActorMatchesQuery,
	worldLogMapBounds
} from "./world-log-actors.js";

const history = Schema.decodeUnknownSync(PerforceMapHistory)({
	baseline: { change: 9, status: "available" },
	completeness: "complete",
	diagnostics: [],
	mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
	query: {
		limits: {
			maxChangelists: 10,
			maxConcurrency: 2,
			maxDurationMs: 1000,
			maxMaterializedFiles: 10,
			maxPackages: 10
		},
		mapPath: "Content/Maps/L_Example.umap",
		projectRoot: "C:/Project",
		range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-21T00:00:00.000Z" }
	},
	rangeEndSnapshot: {
		actors: [
			{
				actorGuid: "guid-present",
				actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Lamp",
				classPath: "/Script/Engine.PointLight",
				label: "Key lamp",
				packageName: "/Game/Actors/Lamp",
				position: { location: { x: 120, y: 220, z: 30 }, status: "resolved" }
			},
			{
				actorGuid: "guid-static",
				actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Floor",
				classPath: "/Script/Engine.StaticMeshActor",
				label: "Floor",
				packageName: "/Game/Actors/Floor",
				position: { location: { x: 420, y: 520, z: 0 }, status: "resolved" }
			}
		],
		completeness: "complete",
		diagnostics: [],
		mapPackage: "/Game/Maps/L_Example",
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind: "level",
		summary: { failedPackages: 0, partialPackages: 0, resolvedActors: 2, scannedPackages: 1 }
	},
	revisions: [
		{
			change: 10,
			changes: [
				{
					after: {
						actorGuid: "guid-present",
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Lamp",
						classPath: "/Script/Engine.PointLight",
						label: "Key lamp",
						packageName: "/Game/Actors/Lamp",
						position: { location: { x: 120, y: 220, z: 30 }, status: "resolved" }
					},
					identity: { actorGuid: "guid-present", kind: "actor_guid" },
					kind: "actor_added"
				},
				{
					before: {
						actorGuid: "guid-removed",
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.OldLight",
						classPath: "/Script/Engine.PointLight",
						label: "Old lamp",
						packageName: "/Game/Actors/OldLamp",
						position: { location: { x: -50, y: 20, z: 0 }, status: "resolved" }
					},
					identity: { actorGuid: "guid-removed", kind: "actor_guid" },
					kind: "actor_removed"
				}
			],
			completeness: "complete",
			diagnostics: [],
			files: [],
			submittedAt: "2026-07-20T12:00:00.000Z",
			unclassifiedPackageChanges: []
		}
	],
	schemaVersion: 1
});

describe("World Log actor presentation", () => {
	it("keeps the range-end map complete while retaining removed actors in the outliner", () => {
		const actors = collectWorldLogActors(history);
		expect(
			actors.map((actor) => [actor.actor.label, actor.changeCount, actor.presentAtRangeEnd])
		).toEqual([
			["Floor", 0, true],
			["Key lamp", 1, true],
			["Old lamp", 1, false]
		]);
		expect(worldLogMapBounds(actors)).toEqual({ maxX: 450, maxY: 550, minX: 90, minY: 190 });
	});

	it("matches actor identity and exact outliner search across saved actor facts", () => {
		const actors = collectWorldLogActors(history);
		const keyLamp = actors.find((actor) => actor.actor.label === "Key lamp")!;
		const floor = actors.find((actor) => actor.actor.label === "Floor")!;
		expect(actorKeyFromSavedActor(keyLamp.actor)).toBe(keyLamp.key);
		expect(worldLogActorMatchesQuery(keyLamp, "pointlight")).toBe(true);
		expect(worldLogActorMatchesQuery(floor, "lamp")).toBe(false);
		expect(changeMatchesActor(history.revisions[0]!.changes[0]!, keyLamp.key)).toBe(true);
		expect(changeMatchesActor(history.revisions[0]!.changes[1]!, keyLamp.key)).toBe(false);
	});
});
