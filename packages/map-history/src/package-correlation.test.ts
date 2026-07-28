import type { SavedWorld, SavedWorldActor } from "@ue-shed/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { diffSavedWorldSnapshots } from "./diff.js";
import { findUnclassifiedPackageChanges } from "./package-correlation.js";
import {
	SavedPackageChangeEvidence,
	type SavedPackageChangeEvidence as SavedPackageChangeEvidenceType
} from "./schema.js";

const MAP_PACKAGE = "/Game/Maps/L_Example";
const MAP_DEPOT_PATH = "//Project/Main/Content/Maps/L_Example.umap";

function actor(overrides: Partial<SavedWorldActor> = {}): SavedWorldActor {
	return {
		actorGuid: "00000001-00000002-00000003-00000004",
		actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Actor",
		classPath: "/Script/Engine.StaticMeshActor",
		label: "Actor",
		packageName: MAP_PACKAGE,
		position: { location: { x: 1, y: 2, z: 3 }, status: "resolved" },
		...overrides
	};
}

function world(
	actors: readonly SavedWorldActor[],
	completeness: SavedWorld["completeness"] = "complete"
): SavedWorld {
	return {
		actors,
		authority: { kind: "project_files", mapPackage: MAP_PACKAGE },
		completeness,
		contract: { name: "unreal-saved-world", version: { major: 1, minor: 1 } },
		diagnostics: [],
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind: "level",
		summary: {
			failedPackages: completeness === "partial" ? 1 : 0,
			partialPackages: 0,
			resolvedActors: actors.filter((entry) => entry.position.status === "resolved").length,
			scannedPackages: 1
		}
	};
}

function packageChange(
	overrides: Partial<{
		readonly action: string;
		readonly afterRevision: number | null;
		readonly beforeRevision: number | null;
		readonly depotPath: string;
		readonly packageName: string;
	}> = {}
): SavedPackageChangeEvidenceType {
	return Schema.decodeUnknownSync(SavedPackageChangeEvidence)({
		action: "edit",
		afterRevision: 2,
		beforeRevision: 1,
		depotPath: MAP_DEPOT_PATH,
		packageName: MAP_PACKAGE,
		...overrides
	});
}

describe("findUnclassifiedPackageChanges", () => {
	it("recognizes a package explained by a semantic actor change", () => {
		const before = world([actor()]);
		const after = world([
			actor({ position: { location: { x: 10, y: 2, z: 3 }, status: "resolved" } })
		]);
		const diff = diffSavedWorldSnapshots(before, after);

		expect(
			findUnclassifiedPackageChanges({
				after,
				before,
				diff,
				packageChanges: [packageChange()]
			})
		).toEqual([]);
	});

	it("retains projection-unchanged package evidence with attributable actors", () => {
		const before = world([actor()]);
		const after = world([actor()]);
		const diff = diffSavedWorldSnapshots(before, after);

		const result = findUnclassifiedPackageChanges({
			after,
			before,
			diff,
			packageChanges: [packageChange()]
		});

		expect(result).toMatchObject([
			{
				action: "edit",
				actorIdentities: [
					{
						actorGuid: "00000001-00000002-00000003-00000004",
						kind: "actor_guid"
					}
				],
				afterRevision: 2,
				beforeRevision: 1,
				depotPath: MAP_DEPOT_PATH,
				packageName: MAP_PACKAGE,
				reason: "projection_unchanged"
			}
		]);
	});

	it("marks evidence partial when a missing actor cannot prove removal", () => {
		const before = world([actor()]);
		const after = world([], "partial");
		const diff = diffSavedWorldSnapshots(before, after);

		const result = findUnclassifiedPackageChanges({
			after,
			before,
			diff,
			packageChanges: [packageChange()]
		});

		expect(result[0]?.reason).toBe("snapshot_partial");
		expect(diff.changes.some((change) => change.kind === "actor_removed")).toBe(false);
	});

	it("withholds actor attribution when duplicate GUID evidence is ambiguous", () => {
		const duplicate = actor({
			actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Duplicate"
		});
		const before = world([actor(), duplicate]);
		const after = world([actor(), duplicate]);
		const diff = diffSavedWorldSnapshots(before, after);

		const result = findUnclassifiedPackageChanges({
			after,
			before,
			diff,
			packageChanges: [packageChange()]
		});

		expect(result[0]?.reason).toBe("actor_identity_unavailable");
		expect(result[0]?.actorIdentities).toEqual([]);
	});

	it("uses proven GUID continuity to explain both sides of a package transition", () => {
		const externalPackage = "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor";
		const before = world([actor()]);
		const after = world([actor({ packageName: externalPackage })]);
		const diff = diffSavedWorldSnapshots(before, after);

		const result = findUnclassifiedPackageChanges({
			after,
			before,
			diff,
			packageChanges: [
				packageChange(),
				packageChange({
					depotPath:
						"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset",
					packageName: externalPackage
				})
			]
		});

		expect(result).toEqual([]);
	});
});
