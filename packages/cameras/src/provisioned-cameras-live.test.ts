import { describe, expect, it } from "@effect/vitest";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
	awaitProvisionedCameraFrame,
	decodeProvisionedCameraRequest,
	ensureProvisionedCameras,
	ProvisionedCameraError,
	ProvisionedCameraRequest,
	provisionedCameraRequest,
	ProvisionedCameraSpec
} from "./provisioned-cameras-live.js";

const camera = Schema.decodeUnknownSync(ProvisionedCameraSpec)({
	correlation: { reviewViewId: "overview", type: "review_view" },
	height: 180,
	location: { x: 0, y: 0, z: 500 },
	projection: { fieldOfViewDegrees: 60, type: "perspective" },
	rotation: { pitch: -30, roll: 0, yaw: 0 },
	width: 320
});
const visibleCamera = Schema.decodeUnknownSync(ProvisionedCameraSpec)({
	...camera,
	visibility: { hide: [], protect: [] }
});
const expectedMapPath = "/Game/Fixture/Cameras/L_CameraLoad";
const decodeWireRequest = Schema.decodeUnknownSync(ProvisionedCameraRequest);

/** Provisions one camera against a fake plugin, recording each request as decoded wire input. */
function provisionWith(respond: () => Schema.Json) {
	const requests: Array<ProvisionedCameraRequest> = [];
	return {
		requests,
		run: (options: { readonly editorPreviews?: boolean }) =>
			ensureProvisionedCameras("http://localhost:30010", [camera], {
				expectedMapPath,
				...options
			}).pipe(
				Effect.provideService(RemoteControlClient, {
					request: (request) => {
						requests.push(
							decodeWireRequest(JSON.parse(String(request.parameters.RequestJson)))
						);
						return Effect.succeed(respond());
					}
				})
			)
	};
}

function status(schemaVersion: number, editorPreviews?: { readonly revealedChildActors: number }) {
	const response = {
		cameras: [
			{
				cameraId: "camera-0",
				correlation: { reviewViewId: "overview", type: "review_view" },
				displayName: "overview",
				height: 180,
				index: 0,
				width: 320
			}
		],
		schemaVersion,
		worldContext: "editor"
	};
	return editorPreviews === undefined ? response : { ...response, editorPreviews };
}

describe("provisioned camera helpers", () => {
	it.effect(
		"migrates the candidate-only provisioning request during the compatibility window",
		() =>
			Effect.gen(function* () {
				const request = yield* decodeProvisionedCameraRequest({
					cameras: [
						{
							candidateId: "context_three_quarter",
							fieldOfViewDegrees: 60,
							height: 180,
							location: { x: 1200, y: -1400, z: 700 },
							rotation: { pitch: -12, roll: 0, yaw: 135 },
							width: 320
						}
					],
					previewFps: 5
				});
				expect(request).toMatchObject({
					cameras: [
						{
							correlation: {
								candidateId: "context_three_quarter",
								type: "framing_candidate"
							}
						}
					],
					schemaVersion: 2
				});
			})
	);

	it.effect("rejects a temporary camera request with no durable correlation", () =>
		decodeProvisionedCameraRequest({
			cameras: [
				{
					fieldOfViewDegrees: 60,
					height: 180,
					location: { x: 1200, y: -1400, z: 700 },
					rotation: { pitch: -12, roll: 0, yaw: 135 },
					width: 320
				}
			],
			previewFps: 5,
			schemaVersion: 2
		}).pipe(
			Effect.exit,
			Effect.tap((exit) => Effect.sync(() => expect(exit._tag).toBe("Failure"))),
			Effect.asVoid
		)
	);

	it.effect("decodes a map-correlated orthographic v3 request", () =>
		Effect.gen(function* () {
			const request = yield* decodeProvisionedCameraRequest({
				cameras: [
					{
						correlation: {
							mapCapturePlanId: "fixture-overview",
							type: "map_capture_plan"
						},
						height: 360,
						location: { x: 0, y: 0, z: 5000 },
						projection: { orthoWidth: 4096, type: "orthographic" },
						rotation: { pitch: -90, roll: 0, yaw: 0 },
						width: 640
					}
				],
				expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
				previewFps: 5,
				schemaVersion: 3
			});
			expect(request).toEqual({
				cameras: [
					{
						correlation: {
							mapCapturePlanId: "fixture-overview",
							type: "map_capture_plan"
						},
						height: 360,
						location: { x: 0, y: 0, z: 5000 },
						projection: { orthoWidth: 4096, type: "orthographic" },
						rotation: { pitch: -90, roll: 0, yaw: 0 },
						width: 640
					}
				],
				expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
				previewFps: 5,
				schemaVersion: 3
			});
		})
	);

	it.effect("awaits the latest BGRA frame for a posed camera index", () =>
		Effect.gen(function* () {
			const frame = yield* awaitProvisionedCameraFrame({
				cameraIndex: 2,
				latestFrames: Effect.succeed(
					new Map([
						[
							2,
							{
								cameraIndex: 2,
								height: 180,
								pixels: new Uint8Array([1, 2, 3, 4]),
								width: 320
							}
						]
					])
				),
				timeout: "1 second"
			});
			expect(frame).toEqual({
				cameraIndex: 2,
				height: 180,
				pixels: new Uint8Array([1, 2, 3, 4]),
				width: 320
			});
		})
	);

	it.effect("rejects a stale frame identity and fails with typed recovery", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				awaitProvisionedCameraFrame({
					cameraIndex: 0,
					expectedCameraId: "current-camera",
					latestFrames: Effect.succeed(
						new Map([
							[
								0,
								{
									cameraId: "stale-camera",
									cameraIndex: 0,
									height: 180,
									pixels: new Uint8Array([1, 2, 3, 4]),
									width: 320
								}
							]
						])
					),
					timeout: "100 millis"
				}).pipe(Effect.flip)
			);
			yield* TestClock.adjust("150 millis");
			const error = yield* Fiber.join(fiber);
			expect(error).toBeInstanceOf(ProvisionedCameraError);
			expect(error.operation).toBe("await_frame");
			expect(error.recovery).toMatch(/camera pipe/i);
		})
	);

	it("requests editor previews through provisioning version 5 only when enabled", () => {
		const options = { expectedMapPath, previewFps: 0.5 };
		expect(provisionedCameraRequest([camera], options)).toEqual({
			cameras: [camera],
			expectedMapPath,
			previewFps: 1,
			schemaVersion: 3
		});
		expect(
			provisionedCameraRequest([camera], { ...options, editorPreviews: false })
		).not.toHaveProperty("editorPreviews");
		expect(
			provisionedCameraRequest([camera], { ...options, editorPreviews: false }).schemaVersion
		).toBe(3);
		expect(provisionedCameraRequest([visibleCamera], options).schemaVersion).toBe(4);
		expect(
			provisionedCameraRequest([camera], { ...options, editorPreviews: true })
		).toMatchObject({ editorPreviews: true, schemaVersion: 5 });
		expect(
			provisionedCameraRequest([visibleCamera], { ...options, editorPreviews: true })
				.schemaVersion
		).toBe(5);
	});

	it.effect("accepts editorPreviews only in provisioning version 5", () =>
		Effect.gen(function* () {
			const base = { cameras: [camera], expectedMapPath, previewFps: 1 };
			const decode = Schema.decodeUnknownEffect(ProvisionedCameraRequest);
			expect(
				yield* decode({ ...base, editorPreviews: true, schemaVersion: 5 })
			).toMatchObject({ editorPreviews: true, schemaVersion: 5 });
			expect(
				yield* decode({ ...base, cameras: [visibleCamera], schemaVersion: 5 })
			).toMatchObject({ schemaVersion: 5 });
			for (const schemaVersion of [3, 4])
				expect(
					(yield* Effect.exit(decode({ ...base, editorPreviews: true, schemaVersion })))
						._tag
				).toBe("Failure");
			expect(
				(yield* Effect.exit(decode({ ...base, editorPreviews: "yes", schemaVersion: 5 })))
					._tag
			).toBe("Failure");
		})
	);

	it.effect("sends editorPreviews and accepts a plugin that confirms version 5", () =>
		Effect.gen(function* () {
			const provision = provisionWith(() => status(5, { revealedChildActors: 2 }));
			const bindings = yield* provision.run({ editorPreviews: true });
			expect(provision.requests[0]).toMatchObject({ editorPreviews: true, schemaVersion: 5 });
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.previewContext).toBe("editor_live");
		})
	);

	it.effect("leaves the request unchanged when editor previews are off", () =>
		Effect.gen(function* () {
			const provision = provisionWith(() => status(1));
			yield* provision.run({ editorPreviews: false });
			expect(provision.requests[0]).not.toHaveProperty("editorPreviews");
			expect(provision.requests[0]?.schemaVersion).toBe(3);
		})
	);

	it.effect("reports an older plugin as an unsupported capability", () =>
		Effect.gen(function* () {
			const error = yield* provisionWith(() => status(1))
				.run({ editorPreviews: true })
				.pipe(Effect.flip);
			expect(error).toBeInstanceOf(ProvisionedCameraError);
			expect(error.code).toBe("unsupported_capability");
			expect(error.retrySafe).toBe(false);
			expect(error.recovery).toMatch(/Omit editorPreviews/);
		})
	);

	it.effect("keeps a version 5 native failure distinct from missing support", () =>
		Effect.gen(function* () {
			const error = yield* provisionWith(() => ({
				error: "expected-map-mismatch",
				schemaVersion: 5,
				status: "failed"
			}))
				.run({ editorPreviews: true })
				.pipe(Effect.flip);
			expect(error.code).toBeUndefined();
			expect(error.message).toBe("expected-map-mismatch");
			expect(error.retrySafe).toBe(true);
		})
	);
});
