import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCameraAuthoringStore } from "./camera-authoring-store.js";
import { makeCameraAuthoringPanelSession } from "./camera-authoring-panel.js";
import { CameraPanelEvent, type CameraPanelAction } from "./camera-authoring-panel-schema.js";
import {
	CameraBridgeSnapshot,
	CameraBridgeError,
	type CameraAuthoringBridge
} from "./camera-authoring-bridge.js";
import { ArrangementCameraId, resolveArrangementCamera } from "./camera-arrangement.js";
import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";

describe("replaceable native menu coordinator", () => {
	it("reviews regeneration, recovers lost activation replies, and resumes the durable arrangement", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-panel-"));
		try {
			const store = makeCameraAuthoringStore(join(root, "draft.json"));
			const arrangement = fixtureArrangement();
			await Effect.runPromise(store.create(arrangement, fixtureSet()));
			let native = CameraBridgeSnapshot.make({
				version: 1,
				status: "ready",
				message: "",
				sessionId: arrangement.id,
				cameraId: ArrangementCameraId.make("camera-0"),
				producerId: "fixture",
				revision: 0,
				sequence: 0,
				pending: false,
				piloting: false,
				saveRequested: false,
				pose: resolveArrangementCamera(arrangement, "camera-0")
			});
			let loseActivation = false;
			const bridge: CameraAuthoringBridge = {
				call: (request) =>
					Effect.gen(function* () {
						if (request.operation === "apply")
							native = {
								...native,
								revision: request.revision,
								pose: request.pose,
								pending: false
							};
						if (request.operation === "activate") {
							native = { ...native, cameraId: request.cameraId, pose: request.pose };
							if (loseActivation) {
								loseActivation = false;
								return yield* Effect.fail(
									new CameraBridgeError({
										code: "disconnected",
										message: "Lost activation reply",
										recovery: "Retry"
									})
								);
							}
						}
						if (request.operation === "panel") {
							const { panelEvent: event, ...rest } = native;
							native = {
								...rest,
								panel: request.state,
								...(event && event.id !== request.acknowledgeEvent
									? { panelEvent: event }
									: undefined)
							};
						}
						return native;
					})
			};
			const session = await Effect.runPromise(
				makeCameraAuthoringPanelSession({
					store,
					bridge,
					attachment: native,
					draftPath: join(root, "draft.json"),
					approvalPath: join(root, "views.json")
				})
			);
			let serial = 0;
			const enqueue = (action: CameraPanelAction) => {
				native = {
					...native,
					panelEvent: Schema.decodeUnknownSync(CameraPanelEvent)({
						id: `menu-${serial++}`,
						expectedRevision: native.revision,
						action
					})
				};
			};
			await Effect.runPromise(session.tick());
			enqueue({
				kind: "layout",
				layout: {
					kind: "single",
					count: 1,
					startDegrees: 30,
					spanDegrees: 0,
					orientation: "world"
				},
				retainExisting: false
			});
			await Effect.runPromise(session.tick());
			expect(native.panel?.proposal?.removed).toHaveLength(arrangement.cameras.length);
			expect((await Effect.runPromise(store.load())).arrangement.revision).toBe(0);
			enqueue({ kind: "accept_proposal" });
			loseActivation = true;
			await expect(Effect.runPromise(session.tick())).rejects.toThrow(
				"Lost activation reply"
			);
			expect((await Effect.runPromise(store.load())).arrangement.cameras).toHaveLength(1);
			await Effect.runPromise(session.tick());
			expect(native.panelEvent).toBeUndefined();
			expect(native.panel?.proposal).toBeUndefined();
			const saved = await Effect.runPromise(store.load());
			expect(saved.arrangement.revision).toBe(1);
			expect(native.cameraId).toBe(saved.arrangement.cameras[0]!.id);
			enqueue({ kind: "approve", cameraIds: [native.cameraId], removeRetiredViewIds: [] });
			await Effect.runPromise(session.tick());
			const reopened = makeCameraAuthoringStore(join(root, "draft.json"));
			expect((await Effect.runPromise(reopened.load())).reviewSet.views).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
