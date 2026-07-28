import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { awaitProvisionedCameraFrame, ProvisionedCameraError } from "./provisioned-cameras-live.js";

describe("provisioned camera helpers", () => {
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

	it.effect("fails with typed recovery when the feed host never delivers", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				awaitProvisionedCameraFrame({
					cameraIndex: 0,
					latestFrames: Effect.succeed(new Map()),
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
