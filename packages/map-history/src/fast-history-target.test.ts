import type { SavedWorld } from "@ue-shed/protocol";
import { describe, expect, it } from "vitest";
import { MapHistoryError } from "./errors.js";
import {
	fastHistoryActorClassTargetedCoverage,
	fastHistoryTargetedCoverage,
	proveFastHistoryActorClassTargets,
	proveFastHistoryActorTarget
} from "./fast-history-target.js";
import type { ResolvedPerforceMapScope } from "./perforce-map-scope.js";
import type { PerforceDepotPath } from "./schema.js";

const eastPackage =
	"/Game/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC";

const eastActor: SavedWorld["actors"][number] = {
	actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	actorPath:
		"/Game/Fixture/History/L_MapHistoryWorld.L_MapHistoryWorld:PersistentLevel.EastMarker_1",
	classPath: "/Script/Engine.StaticMeshActor",
	label: "East Marker",
	packageName: eastPackage,
	position: { location: { x: 900, y: -320, z: 200 }, status: "resolved" }
};

const worldPartitionScope: ResolvedPerforceMapScope = {
	externalActorDepotRoot:
		"//Project/Main/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld",
	externalActorProjectRoot: "Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld",
	fileSpecs: [
		"//Project/Main/Content/Fixture/History/L_MapHistoryWorld.*",
		"//Project/Main/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/..."
	],
	mapDepotPath: "//Project/Main/Content/Fixture/History/L_MapHistoryWorld.umap",
	mapPackageName: "/Game/Fixture/History/L_MapHistoryWorld",
	mapProjectRelativePath: "Content/Fixture/History/L_MapHistoryWorld.umap",
	sourceKind: "world_partition"
};

function world(actors: SavedWorld["actors"]): SavedWorld {
	return {
		authority: { kind: "project_files", mapPackage: worldPartitionScope.mapPackageName },
		actors,
		completeness: "complete",
		contract: { name: "unreal-saved-world", version: { major: 1, minor: 1 } },
		diagnostics: [],
		externalActorRoot:
			"C:/Project/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld",
		mapPath: worldPartitionScope.mapProjectRelativePath,
		sourceKind: "world_partition",
		summary: {
			failedPackages: 0,
			partialPackages: 0,
			resolvedActors: actors.length,
			scannedPackages: 1 + actors.length
		}
	};
}

describe("proveFastHistoryActorTarget", () => {
	it("proves a World Partition actor package from the SavedWorld projection", () => {
		const proven = proveFastHistoryActorTarget({
			scope: worldPartitionScope,
			target: {
				identity: { actorGuid: eastActor.actorGuid!, kind: "actor_guid" },
				kind: "actor"
			},
			world: world([eastActor])
		});
		expect(proven).toMatchObject({
			packageName: eastPackage,
			packageProjectRelativePath:
				"Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC.uasset"
		});
		expect(proven).not.toBeInstanceOf(MapHistoryError);
	});

	it("rejects an actor package outside the map's proven external-actor scope", () => {
		const proven = proveFastHistoryActorTarget({
			scope: worldPartitionScope,
			target: {
				identity: { actorGuid: "11111111-2222-3333-4444-555555555555", kind: "actor_guid" },
				kind: "actor"
			},
			world: world([
				{
					...eastActor,
					actorGuid: "11111111-2222-3333-4444-555555555555",
					packageName: "/Game/__ExternalActors__/OtherMap/A/Actor"
				}
			])
		});
		expect(proven).toBeInstanceOf(MapHistoryError);
		if (proven instanceof MapHistoryError) {
			expect(proven.kind).toBe("invalid_target");
			expect(proven.message).toContain("outside the selected map");
		}
	});

	it("rejects a missing Investigation Target", () => {
		const proven = proveFastHistoryActorTarget({
			scope: worldPartitionScope,
			target: {
				identity: { actorGuid: "00000000-0000-0000-0000-000000000001", kind: "actor_guid" },
				kind: "actor"
			},
			world: world([eastActor])
		});
		expect(proven).toBeInstanceOf(MapHistoryError);
	});
});

describe("proveFastHistoryActorClassTargets", () => {
	it("proves every current actor with the exact requested class", () => {
		const proven = proveFastHistoryActorClassTargets({
			scope: worldPartitionScope,
			target: { classPath: eastActor.classPath, kind: "actor_class" },
			world: world([eastActor])
		});
		expect(proven).not.toBeInstanceOf(MapHistoryError);
		if (proven instanceof MapHistoryError) return;
		expect(proven).toHaveLength(1);
		expect(proven[0]).toMatchObject({
			actor: eastActor,
			packageName: eastPackage
		});
	});

	it("rejects a class with no current actors instead of guessing historical membership", () => {
		const proven = proveFastHistoryActorClassTargets({
			scope: worldPartitionScope,
			target: { classPath: "/Script/Game.Npc", kind: "actor_class" },
			world: world([eastActor])
		});
		expect(proven).toBeInstanceOf(MapHistoryError);
		if (proven instanceof MapHistoryError) {
			expect(proven.kind).toBe("invalid_target");
			expect(proven.message).toContain("No current actors match class");
			expect(proven.recovery).toContain("deleted or reclassified");
		}
	});
});

describe("fastHistoryTargetedCoverage", () => {
	it("never claims complete map or historical class coverage", () => {
		const proven = proveFastHistoryActorTarget({
			scope: worldPartitionScope,
			target: {
				identity: { actorGuid: eastActor.actorGuid!, kind: "actor_guid" },
				kind: "actor"
			},
			world: world([eastActor])
		});
		expect(proven).not.toBeInstanceOf(MapHistoryError);
		if (proven instanceof MapHistoryError) return;
		const coverage = fastHistoryTargetedCoverage({
			mapDepotFileSpec:
				"//Project/Main/Content/Fixture/History/L_MapHistoryWorld.*" as PerforceDepotPath,
			mapPackageName: worldPartitionScope.mapPackageName,
			proven,
			targetDepotFileSpec:
				"//Project/Main/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC.*" as PerforceDepotPath
		});
		expect(coverage).toEqual({
			acquiredPackages: [
				{
					depotFileSpec: "//Project/Main/Content/Fixture/History/L_MapHistoryWorld.*",
					packageName: "/Game/Fixture/History/L_MapHistoryWorld",
					role: "selected_map"
				},
				{
					depotFileSpec:
						"//Project/Main/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC.*",
					packageName: eastPackage,
					role: "investigation_target_actor"
				}
			],
			claimsCompleteMapCoverage: false,
			claimsHistoricalClassCoverage: false,
			investigationTarget: {
				actorGuid: eastActor.actorGuid,
				actorPath: eastActor.actorPath,
				classPath: eastActor.classPath,
				identity: { actorGuid: eastActor.actorGuid, kind: "actor_guid" },
				kind: "actor",
				packageName: eastPackage
			},
			kind: "targeted"
		});
	});

	it("labels class targeting as current-only coverage", () => {
		const proven = proveFastHistoryActorClassTargets({
			scope: worldPartitionScope,
			target: { classPath: eastActor.classPath, kind: "actor_class" },
			world: world([eastActor])
		});
		expect(proven).not.toBeInstanceOf(MapHistoryError);
		if (proven instanceof MapHistoryError) return;
		const coverage = fastHistoryActorClassTargetedCoverage({
			mapDepotFileSpec:
				"//Project/Main/Content/Fixture/History/L_MapHistoryWorld.*" as PerforceDepotPath,
			mapPackageName: worldPartitionScope.mapPackageName,
			proven,
			target: { classPath: eastActor.classPath, kind: "actor_class" },
			targetPackages: [
				{
					depotFileSpec:
						"//Project/Main/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC.*" as PerforceDepotPath,
					proven: proven[0]!
				}
			]
		});
		expect(coverage.investigationTarget).toEqual({
			classPath: eastActor.classPath,
			currentActorCount: 1,
			kind: "actor_class"
		});
		expect(coverage.acquiredPackages[1]?.role).toBe("investigation_target_class");
		expect(coverage.claimsCompleteMapCoverage).toBe(false);
		expect(coverage.claimsHistoricalClassCoverage).toBe(false);
	});
});
