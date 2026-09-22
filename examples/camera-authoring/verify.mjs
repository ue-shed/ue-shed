import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import * as Cameras from "@ue-shed/cameras";

// Copied into a clean packed consumer. No workspace imports, editor, or Workbench.
const arrangement = Schema.decodeUnknownSync(Cameras.CameraArrangement)({
	version: 1,
	id: "adopted-set",
	revision: 0,
	projectName: "Fixture",
	mapPath: "/Game/Fixture",
	subject: { kind: "actor_path", actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject" },
	bounds: {
		center: { x: 0, y: 0, z: 100 },
		extent: { x: 100, y: 100, z: 100 },
		rotation: { pitch: 0, yaw: 0, roll: 0 }
	},
	settings: { fieldOfViewDegrees: 60, distanceScale: 1, heightOffset: 0, margin: 0.1 },
	cameras: Array.from({ length: 6 }, (_, i) => ({
		id: `camera-${i}`,
		viewId: `view-${i}`,
		displayName: `Camera ${i}`,
		yawDegrees: i * 60,
		overrides: {}
	})),
	retiredCameraIds: [],
	captureProfileId: "hd",
	visibilityPolicyId: "pure"
});
const set = await Effect.runPromise(
	Cameras.decodeReviewSet({
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 2 } },
		id: "fixture",
		displayName: "Fixture",
		project: { id: "fixture", mapPath: "/Game/Fixture" },
		captureProfiles: [
			{
				id: "hd",
				imageFormat: "png",
				renderProfile: "full_fidelity",
				resolution: { width: 1280, height: 720 },
				variantPolicy: "pure_only"
			}
		],
		visibilityPolicies: [{ ...Cameras.defaultNaturalOnlyVisibilityPolicy(), id: "pure" }],
		views: []
	})
);
const draft = resolve("camera-adoption-draft.json"),
	destination = resolve("camera-adoption-approved.json");
const store = Cameras.makeCameraAuthoringStore(draft);
await Effect.runPromise(store.create(arrangement, set));
const command = Schema.decodeUnknownSync(Cameras.CameraArrangementCommand)({
	kind: "tune",
	arrangementId: arrangement.id,
	expectedRevision: 0,
	operationId: "tune",
	settings: { fieldOfViewDegrees: 40, distanceScale: 1.25, heightOffset: 100 }
});
await Effect.runPromise(store.mutate(command));
await Effect.runPromise(Cameras.makeCameraAuthoringStore(draft).mutate(command));
const doc = await Effect.runPromise(store.load());
assert.equal(doc.arrangement.revision, 1);
const approval = Schema.decodeUnknownSync(Cameras.CameraApproval)({
	operationId: "approve",
	expectedRevision: 1,
	cameraIds: arrangement.cameras.map((camera) => camera.id),
	removeRetiredViewIds: [],
	destination
});
await Effect.runPromise(store.approve(approval));
await Effect.runPromise(Cameras.makeCameraAuthoringStore(draft).approve(approval));
const approved = await Effect.runPromise(
	Cameras.decodeReviewSet(JSON.parse(await readFile(destination, "utf8")))
);
assert.equal(approved.views.length, 6);
assert.ok(
	approved.views.every(
		(view) =>
			view.revision.number === 1 &&
			view.viewpoint.kind === "world_fixed" &&
			view.viewpoint.approvedPose.fieldOfViewDegrees === 40
	)
);
const snapshot = Cameras.CameraBridgeSnapshot.make({
	version: 1,
	status: "ready",
	message: "",
	sessionId: arrangement.id,
	cameraId: arrangement.cameras[0].id,
	producerId: "offline",
	revision: 1,
	sequence: 1,
	pending: true,
	piloting: false,
	saveRequested: false,
	pose: {
		...Cameras.resolveArrangementCamera(doc.arrangement, arrangement.cameras[0].id),
		fieldOfViewDegrees: 55
	}
});
const proposal = await Effect.runPromise(Cameras.prepareCameraRecovery(store, snapshot));
await Effect.runPromise(Cameras.restoreCameraRecovery(store, proposal, "native"));
const restored = await Effect.runPromise(Cameras.restoreCameraRecovery(store, proposal, "native"));
assert.equal(restored.arrangement.revision, 2);
assert.equal(
	Cameras.resolveArrangementCamera(restored.arrangement, snapshot.cameraId).fieldOfViewDegrees,
	55
);
assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), approved);
console.log("camera-adoption-ok");
