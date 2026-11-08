import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cameras from "@ue-shed/cameras";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import {
	fixtureArrangement,
	fixtureSet
} from "../../../../../packages/cameras/src/camera-arrangement.test-support.js";
import { makeWorkbenchEditorHandoffTestLayer } from "./editor-handoff.js";
import { WorkbenchCameraWorkspace, WorkbenchCameraWorkspaceLive } from "./camera-workspace.js";
it.effect("L4.1 retires local ticking and retains failed detach diagnostics", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "camera-retirement-")));
		const arrangement = fixtureArrangement();
		const set = fixtureSet();
		const store = cameras.makeCameraAuthoringStore(join(root, "draft.json"));
		yield* store.create(arrangement, set);
		let ticks = 0;
		let detaches = 0;
		let snapshot = cameras.CameraBridgeSnapshot.make({
			version: 1,
			status: "ready",
			message: "",
			sessionId: arrangement.id,
			cameraId: cameras.ArrangementCameraId.make("camera-0"),
			producerId: "fixture",
			revision: 0,
			sequence: 0,
			pending: false,
			piloting: false,
			saveRequested: false,
			pose: cameras.resolveArrangementCamera(arrangement, "camera-0")
		});
		vi.spyOn(cameras, "makeCameraAuthoringStore").mockReturnValue(store);
		vi.spyOn(cameras, "attachArrangementCamera").mockReturnValue(Effect.sync(() => snapshot));
		vi.spyOn(cameras, "makeCameraAuthoringBridge").mockReturnValue({
			call: (request) => {
				if (request.operation === "detach") {
					if (++detaches > 1)
						return Effect.succeed({
							version: 1 as const,
							status: "detached" as const,
							message: "Done"
						});
					return Effect.fail(
						new cameras.CameraBridgeError({
							code: "disconnected",
							message: "Detach failed",
							recovery: "Reconnect",
							retrySafe: false,
							nextStep: "reconcile"
						})
					);
				}
				ticks++;
				if (request.operation === "panel") snapshot = { ...snapshot, panel: request.state };
				return Effect.succeed(snapshot);
			}
		});
		yield* Effect.gen(function* () {
			const workspace = yield* WorkbenchCameraWorkspace;
			const context = {
				projectRoot: root,
				reviewSetPath: join(root, "review.json"),
				endpoint: "http://127.0.0.1:30001"
			};
			const opened = yield* workspace.request(context, {
				kind: "open",
				id: arrangement.id,
				livePreview: false
			});
			expect(opened.error).toBeNull();
			yield* workspace.close.pipe(Effect.result);
			const before = ticks;
			yield* TestClock.adjust("1 second");
			expect(ticks).toBe(before);
			const state = yield* workspace.request(context, { kind: "state" });
			expect(state.panel).toBeNull();
			expect(state.error).toContain("Detach failed");
			yield* workspace.close;
			expect(detaches).toBe(2);
			yield* TestClock.adjust("1 second");
			expect(ticks).toBe(before);
		}).pipe(
			Effect.provide(
				WorkbenchCameraWorkspaceLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeRemoteControlClientTestLayer(() => Effect.die("unused")),
							makeWorkbenchEditorHandoffTestLayer(),
							Layer.mock(cameras.ReviewRepository, {
								loadSet: () => Effect.succeed(set)
							}),
							Layer.mock(cameras.ReviewAuthoring, {})
						)
					)
				)
			),
			Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true }))),
			Effect.ensuring(Effect.sync(() => vi.restoreAllMocks()))
		);
	})
);
