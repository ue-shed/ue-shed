import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteControlClientError } from "@ue-shed/unreal-connection";
import {
	ArrangementCameraId,
	CameraArrangementCommand,
	resolveArrangementCamera
} from "./camera-arrangement.js";
import {
	CameraBridgeError,
	CameraBridgeSnapshot,
	attachArrangementCamera,
	makeCameraAuthoringBridge,
	synchronizeArrangementCamera,
	type CameraAuthoringBridge
} from "./camera-authoring-bridge.js";
import { makeCameraAuthoringStore } from "./camera-authoring-store.js";
import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-sync-"));
	const arrangement = fixtureArrangement(),
		store = makeCameraAuthoringStore(join(root, "draft.json"));
	await Effect.runPromise(store.create(arrangement, fixtureSet()));
	let state = CameraBridgeSnapshot.make({
		version: 1,
		status: "ready",
		message: "",
		sessionId: arrangement.id,
		cameraId: ArrangementCameraId.make("camera-0"),
		producerId: "producer",
		revision: 0,
		sequence: 0,
		pending: false,
		piloting: false,
		saveRequested: false,
		pose: resolveArrangementCamera(arrangement, "camera-0")
	});
	let failApplyResponse = false;
	let raceApply = false;
	const bridge: CameraAuthoringBridge = {
		call: (request) =>
			Effect.gen(function* () {
				if (request.operation === "apply") {
					if (raceApply) {
						raceApply = false;
						state = {
							...state,
							sequence: state.sequence + 1,
							pending: true,
							pose: { ...state.pose, fieldOfViewDegrees: 45 }
						};
					}
					if (
						request.sequence !== state.sequence ||
						request.expectedRevision !== state.revision
					)
						return {
							version: 1,
							status: "stale",
							message: "Native edit raced apply"
						} as const;
					state = {
						...state,
						revision: request.revision,
						pose: request.pose,
						pending: false,
						saveRequested: false
					};
					if (failApplyResponse) {
						failApplyResponse = false;
						return yield* Effect.fail(
							new CameraBridgeError({
								code: "disconnected",
								message: "Lost acknowledgement",
								recovery: "Reconnect"
							})
						);
					}
				}
				return state;
			})
	};
	const attachment = await Effect.runPromise(
		attachArrangementCamera(store, bridge, ArrangementCameraId.make("camera-0"))
	);
	return {
		root,
		store,
		bridge,
		attachment,
		inspect: () => state,
		edit: (patch: Partial<CameraBridgeSnapshot>) => {
			state = { ...state, ...patch, sequence: state.sequence + 1, pending: true };
		},
		loseAcknowledgement: () => {
			failApplyResponse = true;
		},
		raceAcknowledgement: () => {
			raceApply = true;
		},
		sync: () =>
			Effect.runPromise(
				synchronizeArrangementCamera({
					store,
					bridge,
					attachment,
					approvalDestination: join(root, "approved.json")
				})
			)
	};
}
describe("replaceable camera bridge coordinator", () => {
	it("reconciles continued native movement that races its previous acknowledgement", async () => {
		const f = await fixture();
		try {
			f.edit({ pose: { ...f.inspect().pose, fieldOfViewDegrees: 55 } });
			f.raceAcknowledgement();
			await expect(f.sync()).rejects.toThrow("Native edit raced apply");
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(1);
			await f.sync();
			expect(f.inspect()).toMatchObject({
				revision: 2,
				pending: false,
				pose: { fieldOfViewDegrees: 45 }
			});
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(2);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("round-trips native edits, saves, restarts, and tolerates a lost acknowledgement", async () => {
		const f = await fixture();
		try {
			f.edit({
				pose: {
					...f.inspect().pose,
					fieldOfViewDegrees: 40,
					location: { x: 15, y: 20, z: 25 }
				},
				saveRequested: true
			});
			f.loseAcknowledgement();
			await expect(f.sync()).rejects.toThrow("Lost acknowledgement");
			const saved = await Effect.runPromise(
				makeCameraAuthoringStore(join(f.root, "draft.json")).load()
			);
			expect(saved.arrangement.revision).toBe(1);
			expect(saved.reviewSet.views[0]?.viewpoint).toMatchObject({
				approvedPose: { fieldOfViewDegrees: 40, location: { x: 15, y: 20, z: 25 } }
			});
			await f.sync();
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(1);
			expect(f.inspect().pending).toBe(false);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("preserves both sides of overlapping edits instead of overwriting the native camera", async () => {
		const f = await fixture();
		try {
			f.edit({ pose: { ...f.inspect().pose, fieldOfViewDegrees: 55 } });
			await Effect.runPromise(
				f.store.mutate(
					Schema.decodeUnknownSync(CameraArrangementCommand)({
						kind: "tune",
						arrangementId: f.attachment.sessionId,
						expectedRevision: 0,
						operationId: "host",
						settings: { fieldOfViewDegrees: 40 }
					})
				)
			);
			await expect(f.sync()).rejects.toThrow("overlap");
			expect(f.inspect().pose.fieldOfViewDegrees).toBe(55);
			expect(f.inspect().pending).toBe(true);
			expect(
				(await Effect.runPromise(f.store.load())).arrangement.settings.fieldOfViewDegrees
			).toBe(40);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("sends committed host changes without producing another native edit", async () => {
		const f = await fixture();
		try {
			await Effect.runPromise(
				f.store.mutate(
					Schema.decodeUnknownSync(CameraArrangementCommand)({
						kind: "tune",
						arrangementId: f.attachment.sessionId,
						expectedRevision: 0,
						operationId: "host",
						settings: { fieldOfViewDegrees: 40 }
					})
				)
			);
			await f.sync();
			await f.sync();
			expect(f.inspect()).toMatchObject({
				revision: 1,
				pending: false,
				pose: { fieldOfViewDegrees: 40 }
			});
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(1);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("classifies a missing optional bridge and rejects malformed native snapshots", async () => {
		const missing = makeCameraAuthoringBridge(
			{
				request: () =>
					Effect.fail(
						new RemoteControlClientError({
							endpoint: "http://localhost:30010",
							functionName: "ExecuteCameraAuthoring",
							operation: "discover",
							retrySafe: true,
							status: 404,
							message: "Object not found"
						})
					)
			},
			"http://localhost:30010"
		);
		expect(
			await Effect.runPromise(
				missing.call({ version: 1, operation: "discover" }).pipe(Effect.flip)
			)
		).toMatchObject({ code: "missing_plugin" });
		const invalid = makeCameraAuthoringBridge(
			{ request: () => Effect.succeed({ version: 1, status: "ready" }) },
			"http://localhost:30010"
		);
		expect(
			await Effect.runPromise(
				invalid.call({ version: 1, operation: "discover" }).pipe(Effect.flip)
			)
		).toMatchObject({ code: "protocol" });
	});
});
