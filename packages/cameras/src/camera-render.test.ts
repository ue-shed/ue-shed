import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema, Stream } from "effect";
import {
	WorldPreparation,
	WorldId,
	WorldLeaseId,
	type WorldRequirements,
	type WorldSnapshot
} from "@ue-shed/world";
import { renderPreparedCamera } from "./prepared-camera.js";
import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import {
	RemoteControlClient,
	RemoteControlClientError,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import {
	CameraRenderer,
	isEditorOwnershipRejection,
	makeCameraRenderer,
	renderCamera,
	type CameraRendererOptions,
	cameraRenderReuseIdentity
} from "./camera-render.js";
import { captureReviewView } from "./review-live.js";
import { ReviewCaptureRequestCurrent } from "./review-schema.js";
import {
	AbsoluteCamera,
	CameraFrameOperationId,
	CameraRenderCapabilities,
	CameraRenderCapabilitiesV1,
	CameraRenderCapabilitiesV2,
	CameraRendererPolicy,
	CameraRenderSessionId,
	cameraRenderContract,
	highResolutionReviewRenderer,
	legacyReviewRenderPolicy,
	reviewCaptureRenderPolicy,
	type CameraFrameResult,
	type CameraRenderSessionRequest
} from "./camera-render-schema.js";
const decodeJsonEffect = Schema.decodeUnknownEffect(Schema.Json);
const decodeCameraRenderCapabilitiesV = Schema.decodeUnknownResult(CameraRenderCapabilitiesV1);
const decodeReviewCaptureRequestCurrent = Schema.decodeSync(ReviewCaptureRequestCurrent);

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
		undefined,
	extendedCapabilities: boolean | "v3" = false,
	options?: CameraRendererOptions
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
								capabilities:
									extendedCapabilities === "v3"
										? [
												"cameras.render-session.v1",
												"cameras.render-session.capabilities.v2",
												"cameras.render-session.capabilities.v3"
											]
										: extendedCapabilities
											? [
													"cameras.render-session.v1",
													"cameras.render-session.capabilities.v2"
												]
											: ["cameras.render-session.v1"]
							}
						: call.functionName === "GetCameraRenderCapabilities" ||
							  call.functionName === "GetCameraRenderCapabilitiesV2" ||
							  call.functionName === "GetCameraRenderCapabilitiesV3"
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
				return yield* decodeJsonEffect(value).pipe(Effect.orDie);
			})
	};
	const renderer = makeCameraRenderer(client, "http://fixture", options);
	return {
		calls,
		client,
		renderer,
		run: () =>
			renderCamera({ session: request, frame }).pipe(
				Effect.provideService(CameraRenderer, renderer)
			)
	};
}

describe("shared renderer lifecycle", () => {
	for (const terminal of ["captured", "failed"] as const) {
		effectIt.effect(`polls running frames until ${terminal} and restores the session`, () =>
			Effect.gen(function* () {
				const polled = yield* Deferred.make<void>();
				let polls = 0;
				const running = {
					status: "running",
					sessionId: request.sessionId,
					operationId: frame.operationId,
					phase: "capturing",
					renderedFrames: 0,
					elapsedMs: 0
				};
				const h = harness((name) => {
					if (name === "StartCameraFrame") return Effect.succeed(running);
					if (name !== "PollCameraFrame") return undefined;
					return Effect.gen(function* () {
						if (++polls === 1) {
							yield* Deferred.succeed(polled, undefined);
							return running;
						}
						return terminal === "captured" ? captured : failed("capture_failed");
					});
				});
				const fiber = yield* h.run().pipe(Effect.result, Effect.forkScoped);
				yield* Deferred.await(polled);
				yield* TestClock.adjust("100 millis");
				const result = yield* Fiber.join(fiber);
				if (terminal === "captured") {
					expect(result).toEqual(Result.succeed(captured));
				} else {
					expect(result).toMatchObject({
						_tag: "Failure",
						failure: { code: "capture_failed" }
					});
				}
				expect(polls).toBe(2);
				expect(h.calls.filter((name) => name === "StartCameraFrame")).toHaveLength(1);
				expect(h.calls.at(-1)).toBe("EndCameraRender");
			})
		);
	}
	it("keeps actor context through capture and restores camera before world ownership", async () => {
		const events: string[] = [];
		const h = harness((name) => {
			if (name === "StartCameraFrame") events.push("capture");
			if (name === "EndCameraRender") events.push("camera.release");
			return undefined;
		});
		const preparation: WorldRequirements = {
			world: {
				worldId: WorldId.make("world"),
				mapPath: request.expectedMapPath,
				projectName: request.expectedProjectName,
				partitioned: true,
				streamingEnabled: true
			},
			targets: [
				{
					kind: "actor",
					actor: {
						actorGuid: "00000000-0000-0000-0000-000000000001",
						containerId: "container"
					},
					contextExtent: { x: 5000, y: 5000, z: 2000 }
				}
			],
			dataLayers: [],
			maximumActors: 500
		};
		const snapshot: WorldSnapshot = {
			status: "ready",
			world: preparation.world,
			leaseId: WorldLeaseId.make("lease"),
			revision: 0,
			regions: [],
			actors: [],
			issues: [],
			renderReadiness: "not_assessed"
		};
		const service = WorldPreparation.of({
			describe: Effect.sync(() => preparation.world),
			plan: () => Effect.succeed(snapshot),
			execute: () => Effect.succeed(snapshot),
			acquire: (requirements) =>
				Effect.gen(function* () {
					expect(requirements.targets).toEqual(preparation.targets);
					events.push("world.acquire");
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							events.push("world.release");
						})
					);
					return {
						id: snapshot.leaseId,
						progress: Stream.empty,
						inspect: Effect.succeed(snapshot),
						checkReady: Effect.succeed(snapshot),
						replace: () => Effect.succeed(snapshot),
						guard: (work) => work
					};
				})
		});
		const result = await Effect.runPromise(
			renderPreparedCamera({ preparation, session: request, frame }).pipe(
				Effect.provideService(CameraRenderer, h.renderer),
				Effect.provideService(WorldPreparation, service)
			)
		);
		expect(result.preparation).toEqual(snapshot);
		expect(result.frame).toEqual(captured);
		expect(events).toEqual(["world.acquire", "capture", "camera.release", "world.release"]);
		const rejected = await Effect.runPromise(
			renderPreparedCamera({
				preparation,
				session: { ...request, expectedMapPath: "/Game/Other" },
				frame
			}).pipe(
				Effect.provideService(CameraRenderer, h.renderer),
				Effect.provideService(WorldPreparation, service),
				Effect.result
			)
		);
		expect(rejected._tag).toBe("Failure");
		expect(events).toHaveLength(4);
	});
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
							code: "transport_failed",
							endpoint: "http://fixture",
							functionName: name,
							operation: "capture",
							message: "lost response",
							retrySafe: true,
							recovery: "Test double: retry the Remote Control call.",
							nextStep: "retry"
						})
					)
				: undefined
		);
		await Effect.runPromise(h.run());
		expect(h.calls.filter((name) => name === "StartCameraFrame")).toHaveLength(1);
		expect(h.calls).toContain("PollCameraFrame");
	});
	const runningFrame = {
		status: "running",
		sessionId: request.sessionId,
		operationId: frame.operationId,
		phase: "capturing",
		renderedFrames: 0,
		elapsedMs: 0
	};
	const noAnswer = (functionName: string) =>
		new RemoteControlClientError({
			code: "request_timeout",
			endpoint: "http://fixture",
			functionName,
			operation: "capture",
			message: "no answer in time",
			retrySafe: false,
			recovery: "Test double: the editor was busy.",
			nextStep: "reconcile"
		});
	it("keeps checking a frame whose status check times out while the editor renders", async () => {
		let polls = 0;
		const h = harness((name) => {
			if (name === "StartCameraFrame") return Effect.succeed(runningFrame);
			if (name !== "PollCameraFrame") return undefined;
			// Unreal renders the screenshot in one call and answers nothing until it is done.
			return ++polls === 1 ? Effect.fail(noAnswer(name)) : Effect.succeed(captured);
		});
		expect(await Effect.runPromise(h.run())).toEqual(captured);
		expect(polls).toBe(2);
		expect(h.calls.filter((name) => name === "StartCameraFrame")).toHaveLength(1);
		expect(h.calls.at(-1)).toBe("EndCameraRender");
	});
	it("passes the host's request timeout to every editor call", async () => {
		const timeouts: unknown[] = [];
		const h = harness(undefined, false, { requestTimeout: "3 minutes" });
		const client: RemoteControlClientApi = {
			request: (call) => {
				if (call.objectPath !== "/Script/UEShedCore.Default__UEShedCoreLibrary")
					timeouts.push(call.timeout);
				return h.client.request(call);
			}
		};
		await Effect.runPromise(
			renderCamera({ session: request, frame }).pipe(
				Effect.provideService(
					CameraRenderer,
					makeCameraRenderer(client, "http://fixture", { requestTimeout: "3 minutes" })
				)
			)
		);
		expect(timeouts.length).toBeGreaterThan(0);
		expect(new Set(timeouts)).toEqual(new Set(["3 minutes"]));
	});
	effectIt.effect("fails a frame that outlasts its deadline as a settling timeout", () =>
		Effect.gen(function* () {
			const polled = yield* Deferred.make<void>();
			const h = harness(
				(name) => {
					if (name === "StartCameraFrame") return Effect.succeed(runningFrame);
					if (name !== "PollCameraFrame") return undefined;
					return Deferred.succeed(polled, undefined).pipe(
						Effect.andThen(Effect.fail(noAnswer(name)))
					);
				},
				false,
				{ frameDeadlineMargin: "1 second" }
			);
			const fiber = yield* h.run().pipe(Effect.result, Effect.forkScoped);
			yield* Deferred.await(polled);
			yield* TestClock.adjust(request.policy.settling.timeoutMs + 1000);
			expect(yield* Fiber.join(fiber)).toMatchObject({
				_tag: "Failure",
				failure: { code: "settling_timeout", operation: "capture", nextStep: "reconcile" }
			});
			expect(h.calls.at(-1)).toBe("EndCameraRender");
		})
	);
	for (const recovers of [true, false])
		effectIt.effect(
			recovers
				? "keeps the lease when a renewal times out while the editor renders"
				: "fails the next frame once renewals time out past the lease",
			() =>
				Effect.gen(function* () {
					let begins = 0;
					const h = harness((name) => {
						if (name !== "BeginCameraRender") return undefined;
						begins++;
						// The first Begin opens the session; renewals follow.
						if (begins === 1) return undefined;
						return recovers && begins > 2 ? undefined : Effect.fail(noAnswer(name));
					});
					yield* Effect.scoped(
						Effect.gen(function* () {
							const session = yield* h.renderer.open(request);
							yield* TestClock.adjust(request.leaseMs / 3);
							yield* TestClock.adjust("200 millis");
							if (!recovers) yield* TestClock.adjust(request.leaseMs);
							const result = yield* session.capture(frame).pipe(Effect.result);
							if (recovers) expect(result).toEqual(Result.succeed(captured));
							else
								expect(result).toMatchObject({
									_tag: "Failure",
									failure: { code: "lease_expired", nextStep: "reconcile" }
								});
						})
					);
					expect(begins).toBeGreaterThan(2);
				})
		);
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
		const exit = await Effect.runPromiseExit(h.run());
		if (Exit.isSuccess(exit)) throw new Error("Expected both failures");
		const failure = Cause.squash(exit.cause);
		expect(failure).toMatchObject({
			code: "render_or_restoration_failed",
			message:
				"Camera render session session failed during capture or restoration; editor state is unknown."
		});
		// The classified message omits the native failures; the kept cause chain retains both.
		const kept = JSON.stringify(failure);
		expect(kept).toContain("capture_failed");
		expect(kept).toContain("restoration_failed");
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

describe("native screenshot warmup", () => {
	const session: CameraRenderSessionRequest = {
		...request,
		policy: {
			...request.policy,
			renderer: { ...highResolutionReviewRenderer, screenshotWarmupFrames: 128 }
		}
	};
	it("accepts bounded integers only for the viewport renderer and preserves absence", () => {
		const decode = Schema.decodeUnknownResult(CameraRendererPolicy);
		const strict = { onExcessProperty: "error" } as const;
		const absent = decode(highResolutionReviewRenderer, strict);
		expect(absent._tag === "Success" && "screenshotWarmupFrames" in absent.success).toBe(false);
		for (const screenshotWarmupFrames of [1, 32, 128, 256])
			expect(
				decode({ ...highResolutionReviewRenderer, screenshotWarmupFrames }, strict)._tag
			).toBe("Success");
		for (const screenshotWarmupFrames of [0, 257, 1.5, null, "128"])
			expect(
				decode({ ...highResolutionReviewRenderer, screenshotWarmupFrames }, strict)._tag
			).toBe("Failure");
		expect(
			decode({ ...legacyReviewRenderPolicy.renderer, screenshotWarmupFrames: 32 }, strict)
				._tag
		).toBe("Failure");
	});
	it("rejects missing or insufficient support before native preflight or acquisition", async () => {
		for (const support of [undefined, { version: 1, maximumWarmupFrames: 32 }]) {
			const h = harness(
				(name) =>
					name === "GetCameraRenderCapabilitiesV2"
						? Effect.succeed(
								support === undefined
									? capabilities
									: { ...capabilities, highResolutionScreenshot: support }
							)
						: undefined,
				support !== undefined
			);
			const opened = await Effect.runPromise(
				Effect.scoped(h.renderer.open(session)).pipe(Effect.flip)
			);
			expect(opened).toMatchObject({ code: "unsupported_capability", operation: "open" });
			const checked = await Effect.runPromise(
				h.renderer.preflight(session).pipe(Effect.flip)
			);
			expect(checked).toMatchObject({
				code: "unsupported_capability",
				operation: "preflight"
			});
			expect(h.calls).not.toContain("BeginCameraRender");
			expect(h.calls).not.toContain("PreflightCameraRender");
		}
	});
	it("round-trips the requested warmup in frame evidence and capture reuse identity", async () => {
		const h = harness(
			(name) =>
				name === "GetCameraRenderCapabilitiesV2"
					? Effect.succeed({
							...capabilities,
							highResolutionScreenshot: { version: 1, maximumWarmupFrames: 256 }
						})
					: name === "BeginCameraRender"
						? Effect.succeed({
								status: "opened",
								sessionId: session.sessionId,
								resolvedPolicy: session.policy
							})
						: name === "StartCameraFrame"
							? Effect.succeed({
									...captured,
									evidence: { ...captured.evidence, policy: session.policy }
								})
							: undefined,
			true
		);
		const result = await Effect.runPromise(
			renderCamera({ session, frame }).pipe(Effect.provideService(CameraRenderer, h.renderer))
		);
		expect(result.evidence.policy).toEqual(session.policy);
		expect(h.calls.at(-1)).toBe("EndCameraRender");
		const identity = {
			frame,
			policy: session.policy,
			engineVersion: "engine",
			pluginVersion: "plugin",
			sceneRevision: "scene-1",
			workflow: "map-source"
		};
		expect(cameraRenderReuseIdentity(identity)).not.toBe(
			cameraRenderReuseIdentity({
				...identity,
				policy: { ...session.policy, renderer: highResolutionReviewRenderer }
			})
		);
	});
	it("uses unchanged v1 discovery and rendering when extended discovery is absent", async () => {
		const h = harness();
		const response = await Effect.runPromise(h.renderer.capabilities);
		expect(
			decodeCameraRenderCapabilitiesV(response, {
				onExcessProperty: "error"
			})._tag
		).toBe("Success");
		expect(response).not.toHaveProperty("highResolutionScreenshot");
		expect(await Effect.runPromise(h.run())).toEqual(captured);
		expect(h.calls).toContain("GetCameraRenderCapabilities");
		expect(h.calls).not.toContain("GetCameraRenderCapabilitiesV2");
	});
	it("negotiates extended discovery before receiving new capability fields", async () => {
		const h = harness(
			(name) =>
				name === "GetCameraRenderCapabilitiesV2"
					? Effect.succeed({
							...capabilities,
							highResolutionScreenshot: { version: 1, maximumWarmupFrames: 256 }
						})
					: undefined,
			true
		);
		const response = await Effect.runPromise(h.renderer.capabilities);
		expect(response.highResolutionScreenshot?.maximumWarmupFrames).toBe(256);
		expect(h.calls).toContain("GetCameraRenderCapabilitiesV2");
		expect(h.calls).not.toContain("GetCameraRenderCapabilities");
	});
});

describe("offscreen viewport strategy", () => {
	const offscreen = {
		kind: "editor_viewport",
		strategy: "offscreen_viewport",
		profile: "lit",
		vignette: "disabled",
		fog: true,
		volumetricFog: true,
		resolution: "native",
		lod: "highest"
	} as const satisfies CameraRendererPolicy;
	const session: CameraRenderSessionRequest = {
		...request,
		policy: { ...request.policy, renderer: offscreen }
	};
	const viewportRenderer = {
		kind: "editor_viewport",
		profiles: ["lit", "observation"],
		reviewAssessment: [],
		reviewClear: [],
		projections: ["perspective", "orthographic"],
		exposure: ["project_auto", "fixed_ev100", "meter_once"],
		maximumDimension: 16384
	} as const;
	const v3 = (lods: ReadonlyArray<"highest" | "natural"> = ["highest", "natural"]) =>
		CameraRenderCapabilities.make({
			...capabilities,
			renderers: [
				{
					...viewportRenderer,
					strategies: ["high_resolution_screenshot", "offscreen_viewport"]
				}
			],
			offscreenViewport: { version: 1, resolutions: ["native"], lods }
		});
	const v2 = CameraRenderCapabilitiesV2.make({
		...capabilities,
		renderers: [{ ...viewportRenderer, strategies: ["high_resolution_screenshot"] }]
	});
	it("accepts native resolution and highest or natural LOD, and no screenshot fields", () => {
		const decode = Schema.decodeUnknownResult(CameraRendererPolicy);
		const strict = { onExcessProperty: "error" } as const;
		for (const lod of ["highest", "natural"])
			expect(decode({ ...offscreen, lod }, strict)._tag).toBe("Success");
		expect(decode({ ...offscreen, clouds: false, editorPreviews: true }, strict)._tag).toBe(
			"Success"
		);
		for (const renderer of [
			{ ...offscreen, screenshotWarmupFrames: 8 },
			{ ...offscreen, resolution: "half" },
			{ ...offscreen, lod: "lowest" },
			{ ...offscreen, lod: undefined },
			{ ...offscreen, resolution: undefined },
			{ ...offscreen, clouds: "off" },
			{ ...highResolutionReviewRenderer, lod: "highest" },
			{ ...highResolutionReviewRenderer, resolution: "native" }
		])
			expect(decode(renderer, strict)._tag).toBe("Failure");
	});
	it("keeps v2 discovery strict: no offscreen strategy or options", () => {
		const decode = Schema.decodeUnknownResult(CameraRenderCapabilitiesV2);
		const strict = { onExcessProperty: "error" } as const;
		expect(decode(v2, strict)._tag).toBe("Success");
		expect(decode(v3(), strict)._tag).toBe("Failure");
		const options = { version: 1, resolutions: ["native"], lods: [] };
		expect(decode({ ...v2, offscreenViewport: options }, strict)._tag).toBe("Failure");
	});
	it("prefers v3 discovery when the plugin advertises it", async () => {
		const h = harness(
			(name) => (name === "GetCameraRenderCapabilitiesV3" ? Effect.succeed(v3()) : undefined),
			"v3"
		);
		const response = await Effect.runPromise(h.renderer.capabilities);
		expect(response.offscreenViewport).toEqual({
			version: 1,
			resolutions: ["native"],
			lods: ["highest", "natural"]
		});
		expect(h.calls).toContain("GetCameraRenderCapabilitiesV3");
		expect(h.calls).not.toContain("GetCameraRenderCapabilitiesV2");
		expect(h.calls).not.toContain("GetCameraRenderCapabilities");
	});
	it("falls back to v2 and then v1 discovery", async () => {
		const second = harness(
			(name) => (name === "GetCameraRenderCapabilitiesV2" ? Effect.succeed(v2) : undefined),
			true
		);
		await Effect.runPromise(second.renderer.capabilities);
		expect(second.calls).toContain("GetCameraRenderCapabilitiesV2");
		expect(second.calls).not.toContain("GetCameraRenderCapabilitiesV3");
		const first = harness();
		await Effect.runPromise(first.renderer.capabilities);
		expect(first.calls).toContain("GetCameraRenderCapabilities");
		expect(first.calls).not.toContain("GetCameraRenderCapabilitiesV3");
	});
	it("refuses the strategy before preflight or acquisition on older plugins", async () => {
		for (const [extended, response] of [
			[false, capabilities],
			[true, v2]
		] as const) {
			const h = harness(
				(name) =>
					name === "GetCameraRenderCapabilitiesV2" ||
					name === "GetCameraRenderCapabilities"
						? Effect.succeed(response)
						: undefined,
				extended
			);
			const opened = await Effect.runPromise(
				Effect.scoped(h.renderer.open(session)).pipe(Effect.flip)
			);
			expect(opened).toMatchObject({ code: "unsupported_capability", operation: "open" });
			const checked = await Effect.runPromise(
				h.renderer.preflight(session).pipe(Effect.flip)
			);
			expect(checked).toMatchObject({
				code: "unsupported_capability",
				operation: "preflight"
			});
			expect(h.calls).not.toContain("BeginCameraRender");
			expect(h.calls).not.toContain("PreflightCameraRender");
		}
	});
	it("refuses a LOD the plugin does not list", async () => {
		const h = harness(
			(name) =>
				name === "GetCameraRenderCapabilitiesV3"
					? Effect.succeed(v3(["natural"]))
					: undefined,
			"v3"
		);
		const refused = await Effect.runPromise(
			Effect.scoped(h.renderer.open(session)).pipe(Effect.flip)
		);
		expect(refused.code).toBe("unsupported_capability");
		expect(h.calls).not.toContain("BeginCameraRender");
	});
	it("renders with the exact policy on a v3 plugin", async () => {
		const h = harness(
			(name) =>
				name === "GetCameraRenderCapabilitiesV3"
					? Effect.succeed(v3())
					: name === "BeginCameraRender"
						? Effect.succeed({
								status: "opened",
								sessionId: session.sessionId,
								resolvedPolicy: session.policy
							})
						: name === "StartCameraFrame"
							? Effect.succeed({
									...captured,
									evidence: { ...captured.evidence, policy: session.policy }
								})
							: undefined,
			"v3"
		);
		const result = await Effect.runPromise(
			renderCamera({ session, frame }).pipe(Effect.provideService(CameraRenderer, h.renderer))
		);
		expect(result.evidence.policy.renderer).toEqual(offscreen);
		expect(h.calls.at(-1)).toBe("EndCameraRender");
	});
});

describe("cloud control", () => {
	const withClouds = (renderer: CameraRendererPolicy): CameraRenderSessionRequest => ({
		...request,
		policy: { ...request.policy, renderer: { ...renderer, clouds: false } }
	});
	const supported = (sceneCapture: boolean) =>
		CameraRenderCapabilities.make({
			...capabilities,
			clouds: { version: 1, viewport: true, sceneCapture }
		});
	it("is optional on both renderers and accepts only booleans", () => {
		const decode = Schema.decodeUnknownResult(CameraRendererPolicy);
		const strict = { onExcessProperty: "error" } as const;
		for (const renderer of [highResolutionReviewRenderer, legacyReviewRenderPolicy.renderer]) {
			const absent = decode(renderer, strict);
			expect(absent._tag === "Success" && "clouds" in absent.success).toBe(false);
			for (const clouds of [true, false])
				expect(decode({ ...renderer, clouds }, strict)._tag).toBe("Success");
			for (const clouds of ["off", 0, null])
				expect(decode({ ...renderer, clouds }, strict)._tag).toBe("Failure");
		}
	});
	it("refuses clouds before acquiring an editor whose plugin can't apply them", async () => {
		const h = harness();
		const opened = await Effect.runPromise(
			Effect.scoped(h.renderer.open(withClouds(highResolutionReviewRenderer))).pipe(
				Effect.flip
			)
		);
		expect(opened).toMatchObject({ code: "unsupported_capability", operation: "open" });
		expect(h.calls).not.toContain("BeginCameraRender");
	});
	it("checks support for the requested backend", async () => {
		const h = harness(
			(name) =>
				name === "GetCameraRenderCapabilitiesV2"
					? Effect.succeed(supported(false))
					: undefined,
			true
		);
		const refused = await Effect.runPromise(
			Effect.scoped(h.renderer.open(withClouds(legacyReviewRenderPolicy.renderer))).pipe(
				Effect.flip
			)
		);
		expect(refused.code).toBe("unsupported_capability");
		expect(h.calls).not.toContain("BeginCameraRender");
		const allowed = harness(
			(name) =>
				name === "GetCameraRenderCapabilitiesV2"
					? Effect.succeed(supported(false))
					: undefined,
			true
		);
		// The viewport supports clouds, so the request reaches the editor.
		await Effect.runPromiseExit(
			Effect.scoped(allowed.renderer.open(withClouds(highResolutionReviewRenderer)))
		);
		expect(allowed.calls).toContain("BeginCameraRender");
	});
});

describe("editor preview renderer policy", () => {
	const viewportPreviews: CameraRenderSessionRequest = {
		...request,
		policy: {
			...request.policy,
			renderer: { ...highResolutionReviewRenderer, editorPreviews: true }
		}
	};
	const supported = (sceneCapture: boolean) =>
		CameraRenderCapabilities.make({
			...capabilities,
			editorPreviews: {
				version: 1,
				subjects: "child_actors_of_editor_only_owners",
				viewport: true,
				sceneCapture
			}
		});
	it("keeps a saved editorPreviews when a capture run picks another renderer", () => {
		const saved = {
			...legacyReviewRenderPolicy,
			renderer: { ...legacyReviewRenderPolicy.renderer, editorPreviews: true }
		};
		expect(reviewCaptureRenderPolicy(saved, highResolutionReviewRenderer).renderer).toEqual({
			...highResolutionReviewRenderer,
			editorPreviews: true
		});
		const explicit = { ...highResolutionReviewRenderer, editorPreviews: false };
		expect(reviewCaptureRenderPolicy(saved, explicit).renderer).toEqual(explicit);
		expect(
			"editorPreviews" in
				reviewCaptureRenderPolicy(legacyReviewRenderPolicy, highResolutionReviewRenderer)
					.renderer
		).toBe(false);
		expect(reviewCaptureRenderPolicy(saved)).toBe(saved);
	});
	it("is optional on both renderers, round-trips absence and accepts only booleans", () => {
		const decode = Schema.decodeUnknownResult(CameraRendererPolicy);
		const strict = { onExcessProperty: "error" } as const;
		for (const renderer of [highResolutionReviewRenderer, legacyReviewRenderPolicy.renderer]) {
			const absent = decode(renderer, strict);
			expect(absent._tag === "Success" && "editorPreviews" in absent.success).toBe(false);
			for (const editorPreviews of [true, false])
				expect(decode({ ...renderer, editorPreviews }, strict)._tag).toBe("Success");
			for (const editorPreviews of ["yes", 1, null])
				expect(decode({ ...renderer, editorPreviews }, strict)._tag).toBe("Failure");
		}
	});
	it("reports a missing plugin capability before acquiring the editor", async () => {
		for (const session of [
			viewportPreviews,
			{
				...request,
				policy: {
					...request.policy,
					renderer: { ...highResolutionReviewRenderer, editorPreviews: false }
				}
			}
		]) {
			const h = harness();
			const opened = await Effect.runPromise(
				Effect.scoped(h.renderer.open(session)).pipe(Effect.flip)
			);
			expect(opened).toMatchObject({ code: "unsupported_capability", operation: "open" });
			const checked = await Effect.runPromise(
				h.renderer.preflight(session).pipe(Effect.flip)
			);
			expect(checked).toMatchObject({
				code: "unsupported_capability",
				operation: "preflight"
			});
			expect(h.calls).not.toContain("BeginCameraRender");
			expect(h.calls).not.toContain("PreflightCameraRender");
		}
	});
	it("checks support for the requested backend", async () => {
		const h = harness((name) =>
			name === "GetCameraRenderCapabilities" ? Effect.succeed(supported(false)) : undefined
		);
		const sceneCapture: CameraRenderSessionRequest = {
			...request,
			policy: {
				...request.policy,
				renderer: { ...legacyReviewRenderPolicy.renderer, editorPreviews: true }
			}
		};
		const result = await Effect.runPromise(
			Effect.scoped(h.renderer.open(sceneCapture)).pipe(Effect.flip)
		);
		expect(result.code).toBe("unsupported_capability");
		expect(h.calls).not.toContain("BeginCameraRender");
	});
	it("renders with the exact policy and returns revealed-preview evidence", async () => {
		const evidence = {
			...captured.evidence,
			policy: viewportPreviews.policy,
			editorPreviews: { revealedChildActors: 2 }
		};
		const h = harness((name) =>
			name === "GetCameraRenderCapabilities"
				? Effect.succeed(supported(true))
				: name === "BeginCameraRender"
					? Effect.succeed({
							status: "opened",
							sessionId: request.sessionId,
							resolvedPolicy: viewportPreviews.policy
						})
					: name === "StartCameraFrame"
						? Effect.succeed({ ...captured, evidence })
						: undefined
		);
		const result = await Effect.runPromise(
			renderCamera({ session: viewportPreviews, frame }).pipe(
				Effect.provideService(CameraRenderer, h.renderer)
			)
		);
		expect(result.evidence.editorPreviews).toEqual({ revealedChildActors: 2 });
		expect(h.calls.at(-1)).toBe("EndCameraRender");
		expect(
			cameraRenderReuseIdentity({
				frame,
				policy: viewportPreviews.policy,
				engineVersion: "engine",
				pluginVersion: "plugin",
				sceneRevision: "scene",
				workflow: "standalone"
			})
		).not.toBe(
			cameraRenderReuseIdentity({
				frame,
				policy: request.policy,
				engineVersion: "engine",
				pluginVersion: "plugin",
				sceneRevision: "scene",
				workflow: "standalone"
			})
		);
	});
});

describe("editor ownership rejections", () => {
	const message = "A camera set is open in the editor.";
	const recovery = "Close the camera set, then retry.";
	const rejected = (code: "authoring_open" | "editor_busy") => ({
		status: "failed",
		code,
		message,
		recovery,
		sessionId: request.sessionId,
		issues: [{ code, path: "sessionId", message, recovery }],
		restoration: "not_acquired"
	});
	const reviewRequest = (minor: 6 | 7) =>
		decodeReviewCaptureRequestCurrent({
			contract: { name: "ue-shed-review-capture", version: { major: 1, minor } },
			operationId: "0b6f1c1e-3c3a-4d7e-9a43-6f3f0e8d2a11",
			viewId: "front",
			expectedMapPath: request.expectedMapPath,
			subject: {
				kind: "actor_path",
				actorPath: "/Game/Fixture.Fixture:PersistentLevel.Floor"
			},
			viewpoint: {
				kind: "world_fixed",
				approvedPose: {
					aspectRatio: "16:9",
					projection: "perspective",
					location: { x: 1, y: 2, z: 3 },
					rotation: { pitch: 0, yaw: 0, roll: 0 },
					fieldOfViewDegrees: 60
				}
			},
			resolution: { width: 320, height: 180 },
			assessment: { method: "automatic" },
			clearCompanion: { status: "not_requested" },
			renderPolicy: legacyReviewRenderPolicy,
			...(minor === 7
				? {
						authoredVisibility: {
							version: 1,
							output: "authored_only",
							actors: {
								hide: [
									{
										label: "Column",
										locator: {
											kind: "actor_path",
											actorPath:
												"/Game/Fixture.Fixture:PersistentLevel.Column"
										}
									}
								],
								protect: []
							}
						}
					}
				: undefined)
		});
	const authoredCapabilities = {
		...capabilities,
		authoredVisibility: {
			version: 1,
			maximumActorsPerList: 256,
			geometry: "loaded_non_nanite_opaque_static_mesh_actors",
			viewport: true,
			sceneCapture: true
		}
	};

	it("keeps an open camera set distinct from another render session", async () => {
		const h = harness((name) =>
			name === "BeginCameraRender" ? Effect.succeed(rejected("authoring_open")) : undefined
		);
		const error = await Effect.runPromise(Effect.flip(h.run()));
		expect(error).toMatchObject({
			code: "authoring_open",
			operation: "open",
			message,
			recovery
		});
		expect(isEditorOwnershipRejection(error)).toBe(true);
		expect(h.calls).not.toContain("EndCameraRender");
	});
	it("does not treat failures after acquisition as ownership rejections", async () => {
		const h = harness((name) =>
			name === "StartCameraFrame" ? Effect.succeed(failed("capture_failed")) : undefined
		);
		const error = await Effect.runPromise(Effect.flip(h.run()));
		expect(isEditorOwnershipRejection(error)).toBe(false);
	});
	it.each([
		["authoring_open", 6],
		["authoring_open", 7],
		["editor_busy", 6]
	] as const)(
		"reports %s as a retryable Review failure for contract 1.%i",
		async (code, minor) => {
			const h = harness((name) =>
				name === "BeginCameraRender"
					? Effect.succeed(rejected(code))
					: name === "GetCameraRenderCapabilities"
						? Effect.succeed(authoredCapabilities)
						: undefined
			);
			const response = await Effect.runPromise(
				captureReviewView({
					endpoint: "http://fixture",
					request: reviewRequest(minor)
				}).pipe(Effect.provideService(RemoteControlClient, h.client))
			);
			expect(response).toMatchObject({
				status: "failed",
				code,
				message,
				recovery,
				retrySafe: true,
				contract: { name: "ue-shed-review-capture", version: { major: 1, minor } },
				viewId: "front"
			});
			expect(h.calls).not.toContain("StartCameraFrame");
			expect(h.calls).not.toContain("EndCameraRender");
		}
	);
});

for (const functionName of [
	"GetCapabilityManifest",
	"GetCameraRenderCapabilities",
	"PreflightCameraRender"
]) {
	it(`escalates malformed ${functionName} without suggesting a native operation already exists`, async () => {
		const { renderer } = harness((name) =>
			name === functionName ? Effect.succeed({}) : undefined
		);
		const error = await Effect.runPromise(
			Effect.flip(
				functionName === "PreflightCameraRender"
					? renderer.preflight(request).pipe(Effect.as(undefined))
					: renderer.capabilities.pipe(Effect.as(undefined))
			)
		);
		expect(error.nextStep).toBe("escalate");
		expect(error.retrySafe).toBe(true);
		expect(error.recovery).toContain("matching host/plugin");
		expect(error.recovery).not.toContain("existing native operation");
	});
}
for (const nextStep of ["escalate", "fix_input", "retry"] as const) {
	it(`preserves ${nextStep} from typed renderer read failures`, async () => {
		const cause = new RemoteControlClientError({
			code: "transport_failed",
			endpoint: "http://fixture",
			functionName: "GetCapabilityManifest",
			operation: "read",
			message: "Read failed.",
			recovery: "Use the classified recovery.",
			retrySafe: true,
			nextStep
		});
		const { renderer } = harness((name) =>
			name === "GetCapabilityManifest" ? Effect.fail(cause) : undefined
		);
		const error = await Effect.runPromise(Effect.flip(renderer.capabilities));
		expect(error.nextStep).toBe(nextStep);
		expect(error.retrySafe).toBe(true);
		expect(error.recovery).toBe(cause.recovery);
	});
}
