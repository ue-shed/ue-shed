import { Effect } from "effect";
import { expect, it } from "vitest";
import { decodeSavedWorld } from "./index.js";

it("decodes saved-world authority, partial coverage, transforms, and attachments", () => {
	const world = Effect.runSync(
		decodeSavedWorld({
			authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Example" },
			completeness: "partial",
			contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
			diagnostics: [
				{
					code: "export_decode",
					message: "One package had an unrelated export gap",
					retrySafe: true
				}
			],
			externalActorRoot: "C:/Fixture/Content/__ExternalActors__/Maps/L_Example",
			mapPath: "C:/Fixture/Content/Maps/L_Example.umap",
			sourceKind: "world_partition",
			actors: [
				{
					actorGuid: "00000001-00000002-00000003-00000004",
					actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.ExampleActor",
					attachment: {
						componentPath:
							"/Game/Maps/L_Example.L_Example:PersistentLevel.ExampleActor.Root",
						parentComponentPath:
							"/Game/Maps/L_Example.L_Example:PersistentLevel.ParentActor.Root"
					},
					classPath: "/Script/Engine.StaticMeshActor",
					label: "Example Actor",
					packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Example",
					transform: {
						location: { x: 125.5, y: -42.25, z: 0 },
						rotation: { w: 1, x: 0, y: 0, z: 0 },
						scale: { x: 2, y: 2, z: 1 },
						status: "resolved"
					}
				}
			],
			summary: {
				failedPackages: 0,
				partialPackages: 1,
				resolvedActors: 1,
				scannedPackages: 2
			}
		})
	);

	expect(world.authority).toEqual({ kind: "project_files", mapPackage: "/Game/Maps/L_Example" });
	expect(world.actors[0]?.transform).toEqual({
		location: { x: 125.5, y: -42.25, z: 0 },
		rotation: { w: 1, x: 0, y: 0, z: 0 },
		scale: { x: 2, y: 2, z: 1 },
		status: "resolved"
	});
	expect(world.actors[0]?.attachment?.parentComponentPath).toContain("ParentActor.Root");
	expect(world.completeness).toBe("partial");
});

it("decodes a conventional level without an external-actor root", () => {
	const world = Effect.runSync(
		decodeSavedWorld({
			authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Conventional" },
			completeness: "complete",
			contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
			diagnostics: [],
			mapPath: "Content/Maps/L_Conventional.umap",
			sourceKind: "level",
			actors: [],
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 0,
				scannedPackages: 1
			}
		})
	);

	expect(world.sourceKind).toBe("level");
	expect(world.externalActorRoot).toBeUndefined();
});

it("rejects non-finite saved transforms at the public boundary", () => {
	expect(() =>
		Effect.runSync(
			decodeSavedWorld({
				authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Invalid" },
				completeness: "complete",
				contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
				diagnostics: [],
				mapPath: "Content/Maps/L_Invalid.umap",
				sourceKind: "level",
				actors: [
					{
						actorPath: "InvalidActor",
						classPath: "/Script/Engine.Actor",
						packageName: "/Game/Maps/L_Invalid",
						transform: {
							location: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
							rotation: { w: 1, x: 0, y: 0, z: 0 },
							scale: { x: 1, y: 1, z: 1 },
							status: "resolved"
						}
					}
				],
				summary: {
					failedPackages: 0,
					partialPackages: 0,
					resolvedActors: 1,
					scannedPackages: 1
				}
			})
		)
	).toThrow();
});

it("decodes contract 2.1 held-by, per-actor decode, and package errors", () => {
	const level = "/Game/Maps/L_Example.L_Example:PersistentLevel";
	const world = Effect.runSync(
		decodeSavedWorld({
			authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Example" },
			completeness: "partial",
			contract: { name: "unreal-saved-world", version: { major: 2, minor: 1 } },
			diagnostics: [],
			mapPath: "Content/Maps/L_Example.umap",
			packageErrors: [
				{
					package: "/Game/__ExternalActors__/Maps/L_Example/A/B/Lost",
					export: `${level}.LostActor`,
					category: "export_malformed_data",
					detail: "name index must be non-negative, got -1",
					actorDropped: true
				},
				{
					package: "/Game/__ExternalActors__/Maps/L_Example/A/B/Unreadable",
					category: "asset_io",
					detail: "access denied",
					actorDropped: true
				}
			],
			sourceKind: "world_partition",
			actors: [
				{
					actorPath: `${level}.Chest`,
					classPath: "/Game/Items/BP_Chest.BP_Chest_C",
					decode: "complete",
					heldBy: `${level}.SpawnVolume`,
					packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Volume",
					parentComponent: `${level}.SpawnVolume.PreviewComponent`,
					transform: { status: "missing_root_component" }
				}
			],
			summary: {
				failedPackages: 1,
				partialPackages: 1,
				resolvedActors: 0,
				scannedPackages: 3
			}
		})
	);

	expect(world.contract.version).toEqual({ major: 2, minor: 1 });
	expect(world.actors[0]?.heldBy).toBe(`${level}.SpawnVolume`);
	expect(world.actors[0]?.parentComponent).toBe(`${level}.SpawnVolume.PreviewComponent`);
	expect(world.actors[0]?.decode).toBe("complete");
	expect(world.packageErrors?.map((error) => error.export)).toEqual([
		`${level}.LostActor`,
		undefined
	]);
});

it("rejects unknown saved-world minor versions and actor decode values", () => {
	const base = {
		authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Invalid" },
		completeness: "complete",
		diagnostics: [],
		mapPath: "Content/Maps/L_Invalid.umap",
		sourceKind: "level",
		summary: { failedPackages: 0, partialPackages: 0, resolvedActors: 0, scannedPackages: 1 }
	};
	const actor = {
		actorPath: "Actor",
		classPath: "/Script/Engine.Actor",
		packageName: "/Game/Maps/L_Invalid",
		transform: { status: "missing_root_component" }
	};
	expect(() =>
		Effect.runSync(
			decodeSavedWorld({
				...base,
				contract: { name: "unreal-saved-world", version: { major: 2, minor: 2 } },
				actors: []
			})
		)
	).toThrow();
	expect(() =>
		Effect.runSync(
			decodeSavedWorld({
				...base,
				contract: { name: "unreal-saved-world", version: { major: 2, minor: 1 } },
				actors: [{ ...actor, decode: "mostly" }]
			})
		)
	).toThrow();
});
