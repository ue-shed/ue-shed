import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import { it } from "@effect/vitest";
import { ContractParseError } from "@ue-shed/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { describe, expect, expectTypeOf } from "vitest";
import {
	ReviewCapturePort,
	reviewCapturePortLayer,
	reviewCaptureRemotePortLayer,
	type ReviewCaptureError,
	type ReviewCaptureConnectionError,
	type ReviewCapturePortApi,
	ReviewCaptureRequestCurrent,
	ReviewViewId
} from "./index.js";
const isContractParseError = Schema.is(ContractParseError);

const request = ReviewCaptureRequestCurrent.make({
	contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 5 } },
	operationId: "00000000-0000-4000-8000-000000000001",
	viewId: ReviewViewId.make("front"),
	expectedMapPath: "/Game/Fixture",
	resolution: { width: 320, height: 180 },
	assessment: { method: "automatic" },
	clearCompanion: { status: "not_requested" },
	subject: { kind: "actor_path", actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject" },
	viewpoint: {
		kind: "world_fixed",
		approvedPose: {
			projection: "perspective",
			aspectRatio: "16:9",
			location: { x: 0, y: 0, z: 0 },
			rotation: { pitch: 0, yaw: 0, roll: 0 },
			fieldOfViewDegrees: 60
		}
	}
});

describe("review capture port failures", () => {
	it.effect("retains classified transport failures and resolves the endpoint per capture", () =>
		Effect.gen(function* () {
			expectTypeOf<
				Effect.Error<ReturnType<ReviewCapturePortApi["capture"]>>
			>().toEqualTypeOf<ReviewCaptureError>();
			expectTypeOf<ReviewCaptureError>().toEqualTypeOf<
				ReviewCaptureConnectionError | Cause.UnknownError
			>();
			const original = new Error("connection reset");
			const transport = new RemoteControlClientError({
				code: "connection_failed",
				endpoint: "http://fixture",
				functionName: "CaptureReviewView",
				operation: "camera.review.capture.remote",
				message: "Editor connection failed.",
				recovery: "Inspect the editor before retrying.",
				retrySafe: false,
				nextStep: "reconcile",
				cause: original
			});
			let selected = "http://first";
			const endpoints: string[] = [];
			const layer = reviewCaptureRemotePortLayer(Effect.sync(() => selected)).pipe(
				Layer.provide(
					makeRemoteControlClientTestLayer((call) => {
						endpoints.push(call.endpoint);
						return Effect.fail(transport);
					})
				)
			);
			yield* Effect.gen(function* () {
				const port = yield* ReviewCapturePort;
				for (const endpoint of ["http://first", "http://second"]) {
					selected = endpoint;
					const failure = yield* Effect.flip(port.capture(request));
					expect(failure._tag).toBe("ReviewCaptureConnectionError");
					expect(failure.cause).toBe(transport);
					expect(transport.cause).toBe(original);
					expect(failure).toMatchObject({
						message: transport.message,
						recovery: transport.recovery,
						retrySafe: false,
						nextStep: "reconcile"
					});
				}
			}).pipe(Effect.provide(layer));
			expect(endpoints).toEqual(["http://first", "http://second"]);
		})
	);

	it.effect("retains an untyped foreign rejection by identity", () =>
		Effect.gen(function* () {
			const original = { reason: "foreign rejection", nested: new Error("offline") };
			const port = yield* ReviewCapturePort.pipe(
				Effect.provide(
					reviewCapturePortLayer({
						capture: () => Effect.tryPromise(() => Promise.reject(original))
					})
				)
			);
			const failure = yield* Effect.flip(port.capture(request));
			expect(Cause.isUnknownError(failure)).toBe(true);
			expect(failure.cause).toBe(original);
		})
	);

	it.effect("retains malformed response contract and schema causes", () =>
		Effect.gen(function* () {
			const layer = reviewCaptureRemotePortLayer("http://fixture").pipe(
				Layer.provide(
					makeRemoteControlClientTestLayer(() => Effect.succeed({ status: "invalid" }))
				)
			);
			const port = yield* ReviewCapturePort.pipe(Effect.provide(layer));
			const failure = yield* Effect.flip(port.capture(request));
			expect(failure).toMatchObject({
				_tag: "ReviewCaptureConnectionError",
				retrySafe: false,
				nextStep: "escalate",
				cause: { _tag: "ContractParseError", contract: "ReviewCaptureResponse" }
			});
			if (!isContractParseError(failure.cause))
				throw new Error("Review capture lost its contract parse failure");
			expect(Schema.isSchemaError(failure.cause.cause)).toBe(true);
		})
	);

	it.effect("preserves interruption and releases the host operation", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			let released = false;
			const layer = reviewCapturePortLayer({
				capture: () =>
					Effect.acquireUseRelease(
						Deferred.succeed(started, undefined),
						() => Effect.never,
						() =>
							Effect.sync(() => {
								released = true;
							})
					)
			});
			const port = yield* ReviewCapturePort.pipe(Effect.provide(layer));
			const fiber = yield* Effect.forkScoped(port.capture(request));
			yield* Deferred.await(started);
			yield* Fiber.interrupt(fiber);
			const exit = yield* Fiber.await(fiber);
			expect(Exit.hasInterrupts(exit)).toBe(true);
			expect(released).toBe(true);
		})
	);
});
