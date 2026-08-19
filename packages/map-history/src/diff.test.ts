import type { SavedWorld, SavedWorldActor } from "@ue-shed/protocol";
import { describe, expect, it } from "vitest";
import { diffSavedWorldSnapshots } from "./diff.js";

function resolvedTransform(location = { x: 1, y: 2, z: 3 }) {
	return {
		location,
		rotation: { w: 1, x: 0, y: 0, z: 0 },
		scale: { x: 1, y: 1, z: 1 },
		status: "resolved" as const
	};
}

function actor(overrides: Partial<SavedWorldActor> = {}): SavedWorldActor {
	return {
		actorGuid: "00000001-00000002-00000003-00000004",
		actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Actor",
		classPath: "/Script/Engine.StaticMeshActor",
		label: "Actor",
		packageName: "/Game/Maps/L_Example",
		transform: resolvedTransform(),
		...overrides
	};
}

function actorWithoutGuid(overrides: Partial<SavedWorldActor> = {}): SavedWorldActor {
	const { actorGuid: _actorGuid, ...withoutGuid } = actor(overrides);
	return withoutGuid;
}

function world(
	actors: readonly SavedWorldActor[],
	completeness: SavedWorld["completeness"] = "complete"
): SavedWorld {
	return {
		actors,
		authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Example" },
		completeness,
		contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
		diagnostics: [],
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind: "level",
		summary: {
			failedPackages: completeness === "partial" ? 1 : 0,
			partialPackages: 0,
			resolvedActors: actors.filter((entry) => entry.transform.status === "resolved").length,
			scannedPackages: 1
		}
	};
}

describe("diffSavedWorldSnapshots", () => {
	it("matches GUID continuity and reports semantic changes", () => {
		const before = actor();
		const after = actor({
			actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Renamed",
			classPath: "/Script/Engine.Light",
			label: "Renamed",
			packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor",
			transform: resolvedTransform({ x: 10, y: 20, z: 30 })
		});

		const result = diffSavedWorldSnapshots(world([before]), world([after]));

		expect(result.changes.map((change) => change.kind)).toEqual([
			"actor_package_changed",
			"actor_class_changed",
			"actor_label_changed",
			"actor_moved"
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("uses exact path fallback without inferring continuity across a path change", () => {
		const before = actorWithoutGuid();
		const after = actorWithoutGuid({
			actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Other"
		});

		const result = diffSavedWorldSnapshots(world([before]), world([after]));

		expect(result.changes.map((change) => change.kind)).toEqual([
			"actor_removed",
			"actor_added"
		]);
	});

	it("reports transform resolution and snapshot coverage changes", () => {
		const before = actor();
		const after = actor({ transform: { status: "missing_root_component" } });

		const result = diffSavedWorldSnapshots(world([before]), world([after], "partial"));

		expect(result.changes.map((change) => change.kind)).toEqual([
			"actor_transform_resolution_changed",
			"snapshot_coverage_changed"
		]);
	});

	it.each([
		{ status: "missing_root_component" as const },
		{
			parentPath: "/Game/Maps/L_Example.Parent",
			status: "missing_attachment_parent" as const
		},
		{
			componentPath: "/Game/Maps/L_Example.Cycle",
			status: "attachment_cycle" as const
		},
		{
			componentPath: "/Game/Maps/L_Example.Ambiguous",
			status: "ambiguous_component_path" as const
		},
		{
			componentPath: "/Game/Maps/L_Example.Absolute",
			status: "unsupported_absolute_transform" as const
		},
		{
			componentPath: "/Game/Maps/L_Example.NonFinite",
			status: "non_finite_transform" as const
		}
	])("reports a transition from resolved to $status", (transform) => {
		const result = diffSavedWorldSnapshots(world([actor()]), world([actor({ transform })]));

		expect(result.changes.map((change) => change.kind)).toEqual([
			"actor_transform_resolution_changed"
		]);
	});

	it("reports effective rotation, scale, and direct attachment changes", () => {
		const before = actor({
			attachment: { componentPath: "Child", parentComponentPath: "Parent" }
		});
		const after = actor({
			attachment: { componentPath: "Child", parentComponentPath: "OtherParent" },
			transform: {
				...resolvedTransform(),
				rotation: { w: 0, x: 0, y: 0, z: 1 },
				scale: { x: 2, y: 1, z: 1 }
			}
		});

		const result = diffSavedWorldSnapshots(world([before]), world([after]));

		expect(result.changes.map((change) => change.kind)).toEqual([
			"actor_attachment_changed",
			"actor_transform_changed"
		]);
	});

	it("does not report antipodal quaternion representations as transform changes", () => {
		const before = actor({
			transform: {
				...resolvedTransform(),
				rotation: { w: 0.5, x: -0.5, y: 0.5, z: -0.5 }
			}
		});
		const after = actor({
			transform: {
				...resolvedTransform(),
				rotation: { w: -0.5, x: 0.5, y: -0.5, z: 0.5 }
			}
		});

		const result = diffSavedWorldSnapshots(world([before]), world([after]));

		expect(result.changes).toEqual([]);
	});

	it("does not invent removals from an incomplete later snapshot", () => {
		const result = diffSavedWorldSnapshots(world([actor()]), world([], "partial"));

		expect(result.changes.map((change) => change.kind)).toEqual(["snapshot_coverage_changed"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"actor_removal_withheld_partial_snapshot"
		);
	});

	it("does not invent additions from an incomplete earlier snapshot", () => {
		const result = diffSavedWorldSnapshots(world([], "partial"), world([actor()]));

		expect(result.changes.map((change) => change.kind)).toEqual(["snapshot_coverage_changed"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"actor_addition_withheld_partial_snapshot"
		);
	});

	it("is insensitive to actor enumeration order", () => {
		const first = actor();
		const second = actor({
			actorGuid: "00000005-00000006-00000007-00000008",
			actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Second"
		});

		expect(diffSavedWorldSnapshots(world([first, second]), world([second, first]))).toEqual({
			changes: [],
			diagnostics: []
		});
	});

	it("withholds changes for duplicate identity evidence", () => {
		const first = actor();
		const duplicate = actor({
			actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Duplicate"
		});

		const result = diffSavedWorldSnapshots(world([first, duplicate]), world([]));

		expect(result.changes).toEqual([]);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.code).toBe("ambiguous_actor_identity");
	});
});
