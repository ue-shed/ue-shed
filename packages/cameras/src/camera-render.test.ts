import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteControlClientError, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import {
	CameraRenderer,
	makeCameraRenderer,
	renderCamera,
	cameraRenderReuseIdentity
} from "./camera-render.js";
import {
	AbsoluteCamera,
	CameraFrameOperationId,
	CameraRenderCapabilities,
	CameraRenderSessionId,
	cameraRenderContract,
	legacyReviewRenderPolicy,
	type CameraFrameResult,
	type CameraRenderSessionRequest
} from "./camera-render-schema.js";

const request: CameraRenderSessionRequest = {
	contract: cameraRenderContract,
	sessionId: CameraRenderSessionId.make("session"),
	expectedMapPath: "/Game/Fixture",
	expectedProjectName: "Fixture",
	leaseMs: 120000,
	maximumFrames: 3,
	policy: legacyReviewRenderPolicy
};
const frame = {
	contract: cameraRenderContract,
	sessionId: request.sessionId,
	operationId: CameraFrameOperationId.make("frame"),
	size: { width: 320, height: 180 },
	camera: AbsoluteCamera.make({
		location: { x: 1, y: 2, z: 3 },
		rotation: { pitch: 0, yaw: 0, roll: 0 },
		projection: { kind: "perspective", horizontalFieldOfView: 60 }
	})
};
const captured: CameraFrameResult = {
	status: "captured",
	sessionId: request.sessionId,
	operationId: frame.operationId,
	artifact: { relativePath: "session/frame.png", bytes: 100, width: 320, height: 180 },
	evidence: {
		camera: frame.camera,
		size: frame.size,
		policy: request.policy,
		editorState: { mapPackageDirtyBefore: false, mapPackageDirtyAfter: false },
		exposureEV100: null,
		preparation: { status: "preserved", regionsHeld: 0, dataLayersApplied: 0, limitations: [] },
		settling: { renderedFrames: 1, elapsedMs: 2, convergence: "not_assessed" },
		engineVersion: "fixture-engine",
		pluginVersion: "fixture-plugin"
	}
};
const capabilities = CameraRenderCapabilities.make({
	contract: cameraRenderContract,
	projectName: "Fixture",
	engineVersion: "fixture-engine",
	pluginVersion: "fixture-plugin",
	renderers: [],
	preparation: [],
	freeze: [],
	maximumRetainedOperations: 64,
	maximumRetainedSessions: 9,
	retentionMs: 120000
});
const failed = (code: "editor_busy" | "capture_failed" | "restoration_failed") => ({
	status: "failed",
	code,
	message: code,
	recovery: "inspect",
	sessionId: request.sessionId,
	issues: [],
	restoration:
		code === "editor_busy"
			? "not_acquired"
			: code === "restoration_failed"
				? "failed"
				: "restored"
});
function harness(
	override: (name: string) => Effect.Effect<unknown, RemoteControlClientError> | undefined = () =>
		undefined
) {
	const calls: string[] = [];
	const client: RemoteControlClientApi = {
		request: (call) =>
			Effect.gen(function* () {
				calls.push(call.functionName);
				const custom = override(call.functionName);
				const value = custom
					? yield* custom
					: call.functionName === "GetCapabilityManifest"
						? {
								schemaVersion: 1,
								producerKind: "unreal_editor",
								capabilities: ["cameras.render-session.v1"]
							}
						: call.functionName === "GetCameraRenderCapabilities"
							? capabilities
							: call.functionName === "BeginCameraRender"
								? {
										status: "opened",
										sessionId: request.sessionId,
										resolvedPolicy: request.policy
									}
								: call.functionName === "EndCameraRender"
									? {
											status: "closed",
											sessionId: request.sessionId,
											restoration: "restored"
										}
									: captured;
				return Schema.decodeUnknownSync(Schema.Json)(value);
			})
	};
	const renderer = makeCameraRenderer(client, "http://fixture");
	return {
		calls,
		renderer,
		run: () =>
			renderCamera({ session: request, frame }).pipe(
				Effect.provideService(CameraRenderer, renderer)
			)
	};
}

describe("shared renderer lifecycle", () => {
	it("rejects invalid policy before contacting Unreal", async () => {
		const h = harness();
		const result = await Effect.runPromise(
			Effect.scoped(h.renderer.open({ ...request, leaseMs: 0 })).pipe(Effect.flip)
		);
		expect(result.code).toBe("invalid_policy");
		expect(h.calls).toEqual([]);
	});
	it("rejects a response correlated to another failed operation", async () => {
		const h = harness((name) =>
			name === "StartCameraFrame"
				? Effect.succeed({ ...failed("capture_failed"), operationId: "someone-else" })
				: undefined
		);
		const result = await Effect.runPromise(h.run().pipe(Effect.flip));
		expect(result.code).toBe("correlation_mismatch");
		expect(h.calls.at(-1)).toBe("EndCameraRender");
	});
	it("uses one lifecycle for one-shot and batched rendering, restoring before return", async () => {
		const h = harness();
		expect(await Effect.runPromise(h.run())).toEqual(captured);
		expect(h.calls.at(-1)).toBe("EndCameraRender");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* h.renderer.open(request);
					yield* session.capture(frame);
					yield* session.capture(frame);
				})
			)
		);
		expect(h.calls.filter((name) => name === "BeginCameraRender")).toHaveLength(2);
		expect(h.calls.filter((name) => name === "EndCameraRender")).toHaveLength(2);
	});
	it("reconciles an uncertain Start by polling its identity without starting twice", async () => {
		const h = harness((name) =>
			name === "StartCameraFrame"
				? Effect.fail(
						new RemoteControlClientError({
							endpoint: "http://fixture",
							functionName: name,
							operation: "capture",
							message: "lost response",
							retrySafe: true
						})
					)
				: undefined
		);
		await Effect.runPromise(h.run());
		expect(h.calls.filter((name) => name === "StartCameraFrame")).toHaveLength(1);
		expect(h.calls).toContain("PollCameraFrame");
	});
	it("does not release someone else's session after an explicit ownership rejection", async () => {
		const h = harness((name) =>
			name === "BeginCameraRender" ? Effect.succeed(failed("editor_busy")) : undefined
		);
		await expect(Effect.runPromise(h.run())).rejects.toMatchObject({ code: "editor_busy" });
		expect(h.calls).not.toContain("EndCameraRender");
	});
	it("retains capture and cleanup errors together", async () => {
		const h = harness((name) =>
			name === "StartCameraFrame"
				? Effect.succeed(failed("capture_failed"))
				: name === "EndCameraRender"
					? Effect.succeed(failed("restoration_failed"))
					: undefined
		);
		const exit = await Effect.runPromise(Effect.exit(h.run()));
		if (Exit.isSuccess(exit)) throw new Error("Expected both failures");
		const failure = Cause.squash(exit.cause);
		expect(String(failure)).toContain("capture_failed");
		expect(String(failure)).toContain("restoration_failed");
	});
	it("preserves interruption and waits for native release", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const h = harness((name) =>
					name === "StartCameraFrame"
						? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
						: undefined
				);
				const fiber = yield* h.run().pipe(Effect.forkChild);
				yield* Deferred.await(started);
				yield* Fiber.interrupt(fiber);
				const exit = yield* Fiber.await(fiber);
				expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
				expect(h.calls.at(-1)).toBe("EndCameraRender");
			})
		);
	});
	it("includes resolution, policy, producer and scene changes in reuse identity", () => {
		const base = {
			frame,
			policy: request.policy,
			engineVersion: "engine",
			pluginVersion: "plugin",
			sceneRevision: "scene-1",
			workflow: "review-natural"
		};
		const key = cameraRenderReuseIdentity(base);
		const anotherFrame = {
			...frame,
			sessionId: CameraRenderSessionId.make("another-session"),
			operationId: CameraFrameOperationId.make("another-operation")
		};
		expect(
			cameraRenderReuseIdentity({
				...base,
				frame: anotherFrame
			})
		).toBe(key);
		for (const changed of [
			{ ...base, sceneRevision: "scene-2" },
			{ ...base, pluginVersion: "plugin-2" },
			{ ...base, frame: { ...frame, size: { width: 640, height: 360 } } },
			{
				...base,
				policy: {
					...base.policy,
					exposure: {
						mode: "fixed_ev100" as const,
						ev100: 8,
						compensation: "project" as const
					}
				}
			}
		])
			expect(cameraRenderReuseIdentity(changed)).not.toBe(key);
	});
});
