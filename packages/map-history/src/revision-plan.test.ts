import { describe, expect, it } from "vitest";
import { planScopedRevision } from "./revision-plan.js";

const map = {
	depotPath: "//Project/Main/Content/Maps/L_Example.umap",
	packageName: "/Game/Maps/L_Example",
	projectRelativePath: "Content/Maps/L_Example.umap"
};

const externalActor = {
	depotPath: "//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset",
	packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor",
	projectRelativePath: "Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset"
};

const removedActor = {
	depotPath: "//Project/Main/Content/__ExternalActors__/Maps/L_Example/C/D/Removed.uasset",
	packageName: "/Game/__ExternalActors__/Maps/L_Example/C/D/Removed",
	projectRelativePath: "Content/__ExternalActors__/Maps/L_Example/C/D/Removed.uasset"
};

describe("planScopedRevision", () => {
	it("keeps only exact map-scope files and preserves add, edit, and delete semantics", () => {
		const result = planScopedRevision({
			files: [
				{ action: "edit", depotPath: map.depotPath, revision: 7, type: "binary" },
				{
					action: "move/add",
					depotPath: externalActor.depotPath,
					revision: 2,
					type: "binary"
				},
				{
					action: "delete",
					depotPath:
						"//Project/Main/Content/__ExternalActors__/Maps/L_Example/C/D/Removed.uasset",
					revision: 3,
					type: "binary"
				},
				{
					action: "edit",
					depotPath: "//Project/Main/Content/Maps/L_Unrelated.umap",
					revision: 12,
					type: "binary"
				}
			],
			scope: [map, externalActor, removedActor]
		});

		expect(result).toEqual({
			kind: "ready",
			files: [
				{
					action: "edit",
					depotPath: map.depotPath,
					packageName: map.packageName,
					projectRelativePath: map.projectRelativePath,
					revision: 7,
					type: "binary"
				},
				{
					action: "add",
					depotPath: externalActor.depotPath,
					packageName: externalActor.packageName,
					projectRelativePath: externalActor.projectRelativePath,
					revision: 2,
					type: "binary"
				},
				{
					action: "delete",
					depotPath: removedActor.depotPath,
					packageName: removedActor.packageName,
					projectRelativePath: removedActor.projectRelativePath
				}
			],
			packageChanges: [
				{
					action: "edit",
					afterRevision: 7,
					beforeRevision: 6,
					depotPath: map.depotPath,
					packageName: map.packageName
				},
				{
					action: "move/add",
					afterRevision: 2,
					beforeRevision: null,
					depotPath: externalActor.depotPath,
					packageName: externalActor.packageName
				},
				{
					action: "delete",
					afterRevision: null,
					beforeRevision: 2,
					depotPath: removedActor.depotPath,
					packageName: removedActor.packageName
				}
			]
		});
	});

	it("fails when an in-scope materialized file lacks exact Perforce revision metadata", () => {
		const result = planScopedRevision({
			files: [{ action: "edit", depotPath: map.depotPath, revision: null, type: "binary" }],
			scope: [map]
		});

		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.error.kind).toBe("materialization");
	});

	it("fails before materialization when a changelist describes the same target twice", () => {
		const result = planScopedRevision({
			files: [
				{ action: "edit", depotPath: map.depotPath, revision: 7, type: "binary" },
				{ action: "edit", depotPath: map.depotPath, revision: 8, type: "binary" }
			],
			scope: [map]
		});

		expect(result.kind).toBe("invalid");
	});
});
