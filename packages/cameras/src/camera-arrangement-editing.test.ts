import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ArrangementCameraId,
	createCameraArrangementFromSelection,
	CameraArrangementCommand,
	applyCameraArrangementCommand,
	effectiveCameraArrangementVisibility,
	exportCameraArrangementRecipe,
	importCameraArrangementRecipe,
	proposeCameraLayout,
	resolveArrangementCamera,
	type CameraArrangement
} from "./camera-arrangement.js";
import { ReviewViewId } from "./review-schema.js";
import {
	CameraApproval,
	makeCameraAuthoringStore,
	writeCameraVisibilityPreset,
	readCameraVisibilityPreset
} from "./camera-authoring-store.js";
import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";

const edit = (a: CameraArrangement, fields: Schema.JsonObject) =>
	applyCameraArrangementCommand(
		a,
		Schema.decodeUnknownSync(CameraArrangementCommand)({
			arrangementId: a.id,
			expectedRevision: a.revision,
			operationId: `edit-${a.revision}`,
			...fields
		})
	);
const actor = (name: string) => ({
	label: name,
	locator: {
		kind: "actor_path" as const,
		actorPath: `/Game/Fixture.Fixture:PersistentLevel.${name}`
	}
});
describe("complete camera arrangement editing", () => {
	it("starts a selected actor with one fitted camera and independent durable identities", () => {
		const original = fixtureArrangement();
		const created = createCameraArrangementFromSelection({
			id: original.id,
			projectName: original.projectName,
			selection: {
				contract: { name: "ue-shed-review-selection", version: { major: 1, minor: 1 } },
				status: "selected",
				displayName: "Subject",
				actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject",
				bounds: original.bounds,
				mapPath: original.mapPath
			}
		});
		expect(created.arrangement.cameras).toHaveLength(1);
		expect(created.arrangement.cameras[0]!.manualPose).toBeUndefined();
		expect(created.arrangement.subject).toMatchObject({
			actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject"
		});
		expect(created.reviewSet.views).toHaveLength(0);
		expect(
			resolveArrangementCamera(created.arrangement, "camera-1").location.z
		).toBeGreaterThan(original.bounds.center.z);
	});
	it("keeps map-specific visibility presets immutable and allows retrying the same export", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-preset-"));
		try {
			const path = join(root, "visibility.json");
			const preset = {
				version: 1 as const,
				id: "preset-one",
				name: "Columns",
				projectName: "Fixture",
				mapPath: "/Game/Fixture",
				actors: { hide: [actor("Column")], protect: [] }
			};
			await Effect.runPromise(writeCameraVisibilityPreset(path, preset));
			await Effect.runPromise(writeCameraVisibilityPreset(path, preset));
			await expect(
				Effect.runPromise(
					writeCameraVisibilityPreset(path, {
						...preset,
						id: "replacement",
						actors: { hide: [], protect: [] }
					})
				)
			).rejects.toThrow("immutable");
			expect(await Effect.runPromise(readCameraVisibilityPreset(path))).toEqual(preset);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("inherits fields through a group, resets only the chosen field, and preserves manual poses", () => {
		let a = edit(fixtureArrangement(), {
			kind: "group",
			group: { id: "entrances", name: "Entrances", overrides: { fieldOfViewDegrees: 45 } },
			cameraIds: ["camera-0", "camera-1"]
		});
		a = edit(a, {
			kind: "batch",
			scope: { kind: "cameras", cameraIds: ["camera-0"] },
			settings: { fieldOfViewDegrees: 55, heightOffset: 80 },
			resetFields: []
		});
		a = edit(a, {
			kind: "batch",
			scope: { kind: "cameras", cameraIds: ["camera-0"] },
			settings: {},
			resetFields: ["fieldOfViewDegrees"]
		});
		expect(resolveArrangementCamera(a, "camera-0")).toMatchObject({
			fieldOfViewDegrees: 45,
			location: { z: 180 }
		});
		expect(resolveArrangementCamera(a, "camera-2").fieldOfViewDegrees).toBe(60);
		a = edit(a, {
			kind: "nudge",
			scope: { kind: "cameras", cameraIds: ["camera-0"] },
			translation: { x: 0, y: 0, z: 20 },
			dolly: 10
		});
		const pinned = resolveArrangementCamera(a, "camera-0");
		a = edit(a, {
			kind: "batch",
			scope: { kind: "arrangement" },
			settings: { distanceScale: 2, heightOffset: 100 },
			resetFields: []
		});
		expect(resolveArrangementCamera(a, "camera-0").location).toEqual(pinned.location);
		expect(() =>
			edit(a, {
				kind: "batch",
				scope: { kind: "cameras", cameraIds: ["camera-0", "foreign-camera"] },
				settings: { fieldOfViewDegrees: 30 },
				resetFields: []
			})
		).toThrow("arrangement");
	});
	it("composes shared exclusions and per-camera protection without replacing other local entries", () => {
		let a = edit(fixtureArrangement(), {
			kind: "edit_visibility",
			scope: { kind: "arrangement" },
			list: "hide",
			operation: "add",
			entries: [actor("Column")]
		});
		a = edit(a, {
			kind: "edit_visibility",
			scope: { kind: "cameras", cameraIds: ["camera-0"] },
			list: "hide",
			operation: "add",
			entries: [actor("Wall")]
		});
		a = edit(a, {
			kind: "edit_visibility",
			scope: { kind: "cameras", cameraIds: ["camera-0", "camera-1"] },
			list: "protect",
			operation: "add",
			entries: [actor("Column")]
		});
		expect(
			effectiveCameraArrangementVisibility(a, a.cameras[0]!).hide.map((entry) => entry.label)
		).toEqual(["Wall"]);
		expect(effectiveCameraArrangementVisibility(a, a.cameras[1]!).hide).toEqual([]);
		expect(
			effectiveCameraArrangementVisibility(a, a.cameras[2]!).hide.map((entry) => entry.label)
		).toEqual(["Column"]);
	});
	it("previews count changes, retains IDs and exceptions, and prevents silent removal", () => {
		let a = edit(fixtureArrangement(), {
			kind: "override",
			cameraId: "camera-5",
			overrides: { fieldOfViewDegrees: 55 }
		});
		const identities = a.cameras.slice(0, 3).map(({ id, viewId }) => ({ id, viewId }));
		const proposal = proposeCameraLayout(
			a,
			{ kind: "arc", count: 3, startDegrees: 10, spanDegrees: 90, orientation: "world" },
			identities
		);
		expect(proposal.cameras.map((camera) => camera.yawDegrees)).toEqual([10, 55, 100]);
		expect(proposal.customized).toEqual(["camera-5"]);
		expect(() =>
			edit(a, { kind: "regenerate", cameras: proposal.cameras, discardCustomizedIds: [] })
		).toThrow("acknowledge");
		a = edit(a, {
			kind: "regenerate",
			cameras: proposal.cameras,
			discardCustomizedIds: proposal.customized
		});
		expect(a.retiredCameraIds).toContain("camera-5");
	});
	it("exports portable framing and relocates pinned poses without carrying actor exclusions or IDs", () => {
		let a = edit(fixtureArrangement(), {
			kind: "nudge",
			scope: { kind: "cameras", cameraIds: ["camera-0"] },
			translation: { x: 10, y: 0, z: 30 },
			dolly: 0
		});
		a = edit(a, {
			kind: "edit_visibility",
			scope: { kind: "arrangement" },
			list: "hide",
			operation: "add",
			entries: [actor("Column")]
		});
		const recipe = exportCameraArrangementRecipe(a, "Exterior");
		expect(JSON.stringify(recipe)).not.toContain("Column");
		expect(JSON.stringify(recipe)).not.toContain("view-0");
		const target = {
			...fixtureArrangement(),
			bounds: { ...a.bounds, center: { x: 1000, y: 2000, z: 3000 } }
		};
		const imported = importCameraArrangementRecipe(
			target,
			recipe,
			a.cameras.map((_, index) => ({
				id: ArrangementCameraId.make(`copy-${index}`),
				viewId: ReviewViewId.make(`copy-view-${index}`)
			}))
		);
		expect(
			resolveArrangementCamera(imported, "copy-0").location.x -
				resolveArrangementCamera(a, "camera-0").location.x
		).toBe(1000);
		expect(imported.visibility).toBeUndefined();
	});
	it("atomically approves a batch and explicitly removes only its retired saved Views", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-arrangement-batch-"));
		try {
			const store = makeCameraAuthoringStore(join(root, "draft.json"));
			let a = fixtureArrangement();
			await Effect.runPromise(store.create(a, fixtureSet()));
			await Effect.runPromise(
				store.approve(
					Schema.decodeUnknownSync(CameraApproval)({
						operationId: "save-1",
						expectedRevision: 0,
						cameraIds: ["camera-0", "camera-1"],
						removeRetiredViewIds: [],
						destination: join(root, "set.json")
					})
				)
			);
			const remove = Schema.decodeUnknownSync(CameraArrangementCommand)({
				arrangementId: a.id,
				expectedRevision: 0,
				operationId: "remove",
				kind: "remove",
				cameraIds: ["camera-1"],
				discardCustomizedIds: []
			});
			a = (await Effect.runPromise(store.mutate(remove))).arrangement;
			const approved = await Effect.runPromise(
				store.approve(
					Schema.decodeUnknownSync(CameraApproval)({
						operationId: "save-2",
						expectedRevision: a.revision,
						cameraIds: ["camera-0"],
						removeRetiredViewIds: ["view-1"],
						destination: join(root, "set.json")
					})
				)
			);
			expect(approved.reviewSet.views.map((view) => view.id)).toEqual(["view-0"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
