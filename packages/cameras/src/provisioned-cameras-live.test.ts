import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
	awaitProvisionedCameraFrame,
	decodeProvisionedCameraRequest,
	ProvisionedCameraError
} from "./provisioned-cameras-live.js";

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
});
