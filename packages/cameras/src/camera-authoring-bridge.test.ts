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
	arrangementBridgeCameras,
	attachArrangementCamera,
	makeCameraAuthoringBridge,
	synchronizeArrangementCamera,
	type CameraAuthoringBridge
} from "./camera-authoring-bridge.js";
import { makeCameraAuthoringStore } from "./camera-authoring-store.js";
import {
	inspectCameraRecovery,
	resolveCameraRecovery,
	prepareCameraRecovery,
	restoreCameraRecovery
} from "./camera-authoring-recovery.js";
import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";

async function fixture(multiCamera = false) {
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
		pose: resolveArrangementCamera(arrangement, "camera-0"),
		...(multiCamera
			? { cameras: arrangementBridgeCameras(arrangement), edits: [], selectedCameraIds: [] }
			: undefined)
	});
	let failApplyResponse = false;
	let raceApply = false;
	let racePatch: Partial<CameraBridgeSnapshot> | undefined;
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
							pose: { ...state.pose, fieldOfViewDegrees: 45 },
							...racePatch
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
						...(request.cameras
							? {
									cameras: request.cameras,
									edits: [],
									added: [],
									removed: [],
									cameraId: request.cameraId ?? state.cameraId
								}
							: undefined),
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
		raceAcknowledgement: (patch?: Partial<CameraBridgeSnapshot>) => {
			raceApply = true;
			racePatch = patch;
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
	it("restores a preserved native snapshot once without a bridge or published-view changes", async () => {
		const f = await fixture();
		try {
			f.edit({ pose: { ...f.inspect().pose, fieldOfViewDegrees: 55 } });
			const proposal = await Effect.runPromise(prepareCameraRecovery(f.store, f.inspect()));
			await Effect.runPromise(restoreCameraRecovery(f.store, proposal, "native"));
			const document = await Effect.runPromise(
				restoreCameraRecovery(f.store, proposal, "native")
			);
			expect(document.arrangement.revision).toBe(1);
			expect(
				resolveArrangementCamera(document.arrangement, "camera-0").fieldOfViewDegrees
			).toBe(55);
			expect(document.reviewSet.views).toHaveLength(0);
			const repeated = await Effect.runPromise(prepareCameraRecovery(f.store, f.inspect()));
			expect(repeated.nativeCommitRevision).toBe(1);
			expect(
				(await Effect.runPromise(restoreCameraRecovery(f.store, repeated, "native")))
					.arrangement.revision
			).toBe(1);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("does not overwrite a host edit made after recovery inspection", async () => {
		const f = await fixture();
		try {
			f.edit({ pose: { ...f.inspect().pose, fieldOfViewDegrees: 55 } });
			const proposal = await Effect.runPromise(prepareCameraRecovery(f.store, f.inspect()));
			await Effect.runPromise(
				f.store.mutate(
					Schema.decodeUnknownSync(CameraArrangementCommand)({
						kind: "tune",
						arrangementId: f.attachment.sessionId,
						expectedRevision: 0,
						operationId: "newer-host",
						settings: { heightOffset: 200 }
					})
				)
			);
			await expect(
				Effect.runPromise(restoreCameraRecovery(f.store, proposal, "native"))
			).rejects.toThrow("changed");
			expect(
				(await Effect.runPromise(f.store.load())).arrangement.settings.heightOffset
			).toBe(200);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	for (const choice of ["saved", "native"] as const) {
		it(`resolves a reviewed conflict using ${choice} without publishing Views`, async () => {
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
				const proposal = await Effect.runPromise(
					inspectCameraRecovery(f.store, f.bridge, f.attachment)
				);
				expect(proposal.saved[0]?.pose.fieldOfViewDegrees).toBe(40);
				expect(proposal.native.pose.fieldOfViewDegrees).toBe(55);
				await Effect.runPromise(resolveCameraRecovery(f.store, f.bridge, proposal, choice));
				expect(f.inspect().pending).toBe(false);
				expect(f.inspect().pose.fieldOfViewDegrees).toBe(choice === "saved" ? 40 : 55);
				expect((await Effect.runPromise(f.store.load())).reviewSet.views).toHaveLength(0);
				await f.sync();
			} finally {
				await rm(f.root, { recursive: true, force: true });
			}
		});
	}
	it("rejects a recovery decision after another native gesture", async () => {
		const f = await fixture();
		try {
			f.edit({ pose: { ...f.inspect().pose, fieldOfViewDegrees: 55 } });
			const proposal = await Effect.runPromise(
				inspectCameraRecovery(f.store, f.bridge, f.attachment)
			);
			f.edit({ pose: { ...f.inspect().pose, fieldOfViewDegrees: 65 } });
			await expect(
				Effect.runPromise(resolveCameraRecovery(f.store, f.bridge, proposal, "saved"))
			).rejects.toThrow("changed");
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(0);
			expect(f.inspect().pose.fieldOfViewDegrees).toBe(65);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("persists native delete and undo without losing original View identity", async () => {
		const f = await fixture(true);
		try {
			const original = (await Effect.runPromise(f.store.load())).arrangement.cameras[1]!;
			f.edit({ edits: [], removed: [original.id] });
			await f.sync();
			let saved = await Effect.runPromise(f.store.load());
			expect(saved.arrangement.cameras).toHaveLength(5);
			expect(saved.arrangement.retiredCameraIds).toContain(original.id);
			f.edit({ edits: [], removed: [], added: [original] });
			await f.sync();
			saved = await Effect.runPromise(f.store.load());
			expect(
				saved.arrangement.cameras.find((camera) => camera.id === original.id)?.viewId
			).toBe(original.viewId);
			expect(saved.arrangement.retiredCameraIds).not.toContain(original.id);
			f.edit({ edits: [], removed: [original.id], added: [] });
			await f.sync();
			expect((await Effect.runPromise(f.store.load())).arrangement.cameras).toHaveLength(5);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("rebases native Undo and Redo that race membership acknowledgements", async () => {
		const f = await fixture(true);
		try {
			const originalSet = f.inspect().cameras!;
			const original = originalSet[1]!;
			const remaining = originalSet.filter((camera) => camera.id !== original.id);
			f.edit({ cameras: remaining, edits: [], removed: [original.id] });
			f.raceAcknowledgement({ cameras: originalSet, removed: [], added: [], edits: [] });
			await expect(f.sync()).rejects.toThrow("Native edit raced apply");
			expect((await Effect.runPromise(f.store.load())).arrangement.cameras).toHaveLength(5);
			// The deletion was committed, but Unreal undid it before seeing the host ack.
			f.raceAcknowledgement({
				cameras: remaining,
				removed: [original.id],
				added: [],
				edits: []
			});
			await expect(f.sync()).rejects.toThrow("Native edit raced apply");
			const restored = await Effect.runPromise(f.store.load());
			expect(
				restored.arrangement.cameras.find((camera) => camera.id === original.id)?.viewId
			).toBe(original.definition!.viewId);
			await f.sync();
			expect((await Effect.runPromise(f.store.load())).arrangement.cameras).toHaveLength(5);
			expect(f.inspect().pending).toBe(false);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("autosaves edits to several cameras atomically, even when neither is the active camera", async () => {
		const f = await fixture(true);
		try {
			const document = await Effect.runPromise(f.store.load());
			const first = resolveArrangementCamera(document.arrangement, "camera-1");
			const second = resolveArrangementCamera(document.arrangement, "camera-4");
			f.edit({
				edits: [
					{
						cameraId: ArrangementCameraId.make("camera-1"),
						pose: { ...first, location: { x: 100, y: 200, z: 300 } }
					},
					{
						cameraId: ArrangementCameraId.make("camera-4"),
						pose: { ...second, fieldOfViewDegrees: 35 }
					}
				]
			});
			f.loseAcknowledgement();
			await expect(f.sync()).rejects.toThrow("Lost acknowledgement");
			await f.sync();
			const saved = await Effect.runPromise(
				makeCameraAuthoringStore(join(f.root, "draft.json")).load()
			);
			expect(saved.arrangement.revision).toBe(1);
			expect(resolveArrangementCamera(saved.arrangement, "camera-1").location).toEqual({
				x: 100,
				y: 200,
				z: 300
			});
			expect(resolveArrangementCamera(saved.arrangement, "camera-4").fieldOfViewDegrees).toBe(
				35
			);
			expect(saved.arrangement.cameras[4]?.manualPose).toBeUndefined();
			expect(saved.arrangement.cameras[0]?.manualPose).toBeUndefined();
			expect(f.inspect().cameras).toHaveLength(6);
			expect(f.inspect().pending).toBe(false);
			expect(saved.reviewSet.views).toHaveLength(0);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("native selection switches do not pin a camera or mutate the draft", async () => {
		const f = await fixture(true);
		try {
			f.edit({ cameraId: ArrangementCameraId.make("camera-4"), edits: [] });
			await f.sync();
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(0);
			expect(f.inspect().cameraId).toBe("camera-4");
			expect(f.inspect().pending).toBe(false);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("rejects a multi-camera batch from a different scope without partially saving it", async () => {
		const f = await fixture(true);
		try {
			f.edit({
				edits: [
					{ cameraId: ArrangementCameraId.make("camera-1"), pose: f.inspect().pose },
					{ cameraId: ArrangementCameraId.make("missing"), pose: f.inspect().pose }
				]
			});
			await expect(f.sync()).rejects.toThrow();
			expect((await Effect.runPromise(f.store.load())).arrangement.revision).toBe(0);
			expect(f.inspect().pending).toBe(true);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
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
