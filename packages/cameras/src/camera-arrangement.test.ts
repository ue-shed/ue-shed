import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArrangementCameraId,
	CameraOperationId,
	CameraArrangement,
	CameraArrangementCommand,
	applyCameraArrangementCommand,
	resolveArrangementCamera,
	previewArrangementRegeneration,
	arrangementFitDistance,
	approveArrangementCamera
} from "./camera-arrangement.js";
import { makeCameraAuthoringStore } from "./camera-authoring-store.js";
import { decodeReviewSet, ReviewSet, ReviewSubjectActorPath } from "./review-schema.js";

import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";
const decodeCommand = Schema.decodeUnknownSync(CameraArrangementCommand);
const command = (arrangement: CameraArrangement, fields: Schema.JsonObject) =>
	decodeCommand({
		arrangementId: arrangement.id,
		expectedRevision: arrangement.revision,
		operationId: `op-${arrangement.revision}`,
		...fields
	});
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function paths() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-camera-"));
	roots.push(root);
	return { draft: join(root, "draft.json"), destination: join(root, "approved.json") };
}

describe("actor-scoped camera arrangements", () => {
	it("tunes six cameras while retaining independent pose and lens exceptions", () => {
		let a = fixtureArrangement();
		a = applyCameraArrangementCommand(
			a,
			command(a, {
				kind: "override",
				cameraId: "camera-1",
				overrides: { fieldOfViewDegrees: 55 }
			})
		);
		const manual = {
			...resolveArrangementCamera(a, "camera-2"),
			location: { x: 12, y: 34, z: 56 }
		};
		a = applyCameraArrangementCommand(
			a,
			command(a, {
				kind: "pose",
				cameraId: "camera-2",
				pose: manual,
				poseChanged: true,
				lensChanged: false
			})
		);
		a = applyCameraArrangementCommand(
			a,
			command(a, {
				kind: "tune",
				settings: { fieldOfViewDegrees: 40, distanceScale: 1.25, heightOffset: 100 }
			})
		);
		expect(resolveArrangementCamera(a, "camera-0").location.z).toBe(200);
		expect(resolveArrangementCamera(a, "camera-1").fieldOfViewDegrees).toBe(55);
		expect(resolveArrangementCamera(a, "camera-2")).toMatchObject({
			location: manual.location,
			fieldOfViewDegrees: 40
		});
		const other = { ...fixtureArrangement(), id: "other" };
		expect(() =>
			applyCameraArrangementCommand(
				a,
				command(a, {
					kind: "tune",
					arrangementId: other.id,
					settings: { heightOffset: 999 }
				})
			)
		).toThrow("another arrangement");
		expect(other.settings.heightOffset).toBe(0);
	});
	it("requires explicit removal of custom cameras and never reassigns retired identities", () => {
		let a = fixtureArrangement();
		a = applyCameraArrangementCommand(
			a,
			command(a, {
				kind: "override",
				cameraId: "camera-5",
				overrides: { fieldOfViewDegrees: 55 }
			})
		);
		const cameras = a.cameras.slice(0, 5);
		expect(previewArrangementRegeneration(a, cameras).customized).toEqual(["camera-5"]);
		expect(() =>
			applyCameraArrangementCommand(
				a,
				command(a, { kind: "regenerate", cameras, discardCustomizedIds: [] })
			)
		).toThrow("customized");
		a = applyCameraArrangementCommand(
			a,
			command(a, { kind: "regenerate", cameras, discardCustomizedIds: ["camera-5"] })
		);
		expect(() =>
			applyCameraArrangementCommand(
				a,
				command(a, {
					kind: "regenerate",
					cameras: fixtureArrangement().cameras,
					discardCustomizedIds: []
				})
			)
		).toThrow("Retired");
	});
	it("lens-only edits do not pin placement, and fit accounts for vertical FOV", () => {
		const a = fixtureArrangement();
		const next = applyCameraArrangementCommand(
			a,
			command(a, {
				kind: "pose",
				cameraId: "camera-0",
				pose: { ...resolveArrangementCamera(a, "camera-0"), fieldOfViewDegrees: 40 },
				poseChanged: false,
				lensChanged: true
			})
		);
		expect(next.cameras[0]?.manualPose).toBeUndefined();
		expect(arrangementFitDistance(a.bounds, 60, 16 / 9, 0.1)).toBeGreaterThan(
			arrangementFitDistance(a.bounds, 60, 1, 0.1)
		);
	});
});

describe("durable camera coordination", () => {
	it("repairs an approval interrupted after the durable commit and before its export", async () => {
		const p = await paths(),
			store = makeCameraAuthoringStore(p.draft),
			a = fixtureArrangement();
		await Effect.runPromise(store.create(a, fixtureSet()));
		const approval = {
			operationId: CameraOperationId.make("save"),
			expectedRevision: 0,
			cameraId: ArrangementCameraId.make("camera-0"),
			destination: p.destination
		};
		const committed = await Effect.runPromise(store.approve(approval));
		// This is the on-disk boundary left by a crash between the two atomic writes.
		await rm(p.destination);
		await writeFile(
			p.draft,
			JSON.stringify({
				...committed,
				projection: { path: p.destination, previousDigest: null }
			})
		);
		const recovered = await Effect.runPromise(
			makeCameraAuthoringStore(p.draft).approve(approval)
		);
		expect(recovered.projection).toBeUndefined();
		expect(JSON.parse(await readFile(p.destination, "utf8"))).toEqual(committed.reviewSet);
		expect(recovered.reviewSet.views[0]?.revision.number).toBe(1);
	});
	it("serializes independent store instances and leaves a loser able to inspect and retry", async () => {
		const p = await paths(),
			store = makeCameraAuthoringStore(p.draft),
			a = fixtureArrangement();
		await Effect.runPromise(store.create(a, fixtureSet()));
		const results = await Promise.allSettled(
			[store, makeCameraAuthoringStore(p.draft)].map((writer, index) =>
				Effect.runPromise(
					writer.mutate(
						command(a, {
							kind: "tune",
							operationId: `writer-${index}`,
							settings: { heightOffset: index + 1 }
						})
					)
				)
			)
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect((await Effect.runPromise(store.load())).arrangement.revision).toBe(1);
	});
	it("restarts with exact state, rejects stale writers, and deduplicates committed operations", async () => {
		const p = await paths(),
			store = makeCameraAuthoringStore(p.draft),
			a = fixtureArrangement();
		await Effect.runPromise(store.create(a, fixtureSet()));
		const tune = command(a, { kind: "tune", settings: { fieldOfViewDegrees: 40 } });
		await Effect.runPromise(store.mutate(tune));
		expect(
			(await Effect.runPromise(makeCameraAuthoringStore(p.draft).mutate(tune))).arrangement
				.revision
		).toBe(1);
		await expect(
			Effect.runPromise(
				store.mutate(command(a, { kind: "tune", settings: { fieldOfViewDegrees: 55 } }))
			)
		).rejects.toThrow("different input");
		await expect(
			Effect.runPromise(
				store.mutate(command(a, { kind: "tune", operationId: "other", settings: {} }))
			)
		).rejects.toThrow("changed");
	});
	it("approval exports the approved camera exactly and a retry does not create a second View revision", async () => {
		const p = await paths(),
			store = makeCameraAuthoringStore(p.draft),
			a = fixtureArrangement();
		await Effect.runPromise(store.create(a, fixtureSet()));
		const approval = {
			operationId: decodeCommand({
				arrangementId: a.id,
				expectedRevision: 0,
				operationId: "save",
				kind: "tune",
				settings: {}
			}).operationId,
			expectedRevision: 0,
			cameraId: ArrangementCameraId.make("camera-0"),
			destination: p.destination
		};
		await Effect.runPromise(store.approve(approval));
		await Effect.runPromise(makeCameraAuthoringStore(p.draft).approve(approval));
		const saved = await Effect.runPromise(
			decodeReviewSet(JSON.parse(await readFile(p.destination, "utf8")))
		);
		expect(saved.views[0]?.viewpoint).toEqual({
			kind: "world_fixed",
			approvedPose: resolveArrangementCamera(a, "camera-0")
		});
		expect(saved.views[0]?.revision.number).toBe(1);
		await writeFile(p.destination, "{}");
		await expect(
			Effect.runPromise(
				store.approve({ ...approval, operationId: CameraOperationId.make("save-again") })
			)
		).rejects.toThrow("destination differs");
	});
	it("approval preserves other actors' saved views", () => {
		const a = fixtureArrangement();
		const set = approveArrangementCamera(a, "camera-0", fixtureSet());
		const second = CameraArrangement.make({
			...a,
			subject: {
				kind: "actor_path",
				actorPath: ReviewSubjectActorPath.make(
					"/Game/Fixture.Fixture:PersistentLevel.Other"
				)
			},
			cameras: a.cameras.slice(1)
		});
		const next = approveArrangementCamera(second, "camera-1", set);
		expect(next.views[0]).toEqual(set.views[0]);
	});
	it("prevents another arrangement on the same actor from replacing an owned View", () => {
		const a = fixtureArrangement();
		const set = approveArrangementCamera(a, "camera-0", fixtureSet());
		const other = Schema.decodeUnknownSync(CameraArrangement)({
			...a,
			id: "another-arrangement"
		});
		expect(() => approveArrangementCamera(other, "camera-0", set)).toThrow(
			"another camera arrangement"
		);
		expect(() =>
			Schema.decodeUnknownSync(ReviewSet)({
				...set,
				contract: { name: "ue-shed-review-set", version: { major: 1, minor: 3 } }
			})
		).toThrow("1.4");
	});
});
