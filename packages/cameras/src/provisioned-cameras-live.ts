import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Clock, Duration, Effect, Schema } from "effect";
import {
	FramingCandidateId,
	ProvisionedCameraId,
	ReviewViewId,
	ReviewVector,
	ReviewRotation
} from "./review-schema.js";

const cameraLibraryPath = "/Script/UEShedCameras.Default__UEShedCameraLibrary";
const positiveWidth = Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 2560 }));
const positiveHeight = Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 1440 }));

export class ProvisionedCameraError extends Schema.TaggedErrorClass<ProvisionedCameraError>()(
	"ProvisionedCameraError",
	{
		message: Schema.String,
		operation: Schema.Literals(["ensure_cameras", "clear_cameras", "await_frame", "configure"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export const ProvisionedCameraCorrelation = Schema.Union([
	Schema.Struct({ candidateId: FramingCandidateId, type: Schema.Literal("framing_candidate") }),
	Schema.Struct({ reviewViewId: ReviewViewId, type: Schema.Literal("review_view") })
]);
export type ProvisionedCameraCorrelation = Schema.Schema.Type<typeof ProvisionedCameraCorrelation>;

export const ProvisionedCameraSpec = Schema.Struct({
	correlation: ProvisionedCameraCorrelation,
	fieldOfViewDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
	height: positiveHeight,
	location: ReviewVector,
	rotation: ReviewRotation,
	width: positiveWidth
});
export type ProvisionedCameraSpec = Schema.Schema.Type<typeof ProvisionedCameraSpec>;

export const ProvisionedCameraRequest = Schema.Struct({
	cameras: Schema.Array(ProvisionedCameraSpec).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(32)
	),
	previewFps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
	schemaVersion: Schema.Literal(2)
});
export type ProvisionedCameraRequest = Schema.Schema.Type<typeof ProvisionedCameraRequest>;

const LegacyProvisionedCameraRequest = Schema.Struct({
	cameras: Schema.Array(
		Schema.Struct({
			candidateId: FramingCandidateId,
			fieldOfViewDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
			height: positiveHeight,
			location: ReviewVector,
			rotation: ReviewRotation,
			width: positiveWidth
		})
	).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
	previewFps: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })))
});

export function decodeProvisionedCameraRequest(input: unknown) {
	return Schema.decodeUnknownEffect(
		Schema.Union([ProvisionedCameraRequest, LegacyProvisionedCameraRequest])
	)(input).pipe(
		Effect.map((request) =>
			"schemaVersion" in request
				? request
				: ProvisionedCameraRequest.make({
						cameras: request.cameras.map((camera) => ({
							correlation: {
								candidateId: camera.candidateId,
								type: "framing_candidate" as const
							},
							fieldOfViewDegrees: camera.fieldOfViewDegrees,
							height: camera.height,
							location: camera.location,
							rotation: camera.rotation,
							width: camera.width
						})),
						previewFps: request.previewFps ?? 5,
						schemaVersion: 2
					})
		)
	);
}

const ProvisionedCameraStatus = Schema.Struct({
	cameras: Schema.Array(
		Schema.Struct({
			cameraId: ProvisionedCameraId,
			candidateId: Schema.optional(FramingCandidateId),
			correlation: Schema.optional(ProvisionedCameraCorrelation),
			displayName: Schema.String,
			height: positiveHeight,
			index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			width: positiveWidth
		})
	),
	error: Schema.optional(Schema.String),
	schemaVersion: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
	status: Schema.optional(Schema.String)
});

export const ProvisionedCameraBinding = Schema.Struct({
	cameraId: ProvisionedCameraId,
	correlation: ProvisionedCameraCorrelation,
	height: positiveHeight,
	index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	width: positiveWidth
});
export type ProvisionedCameraBinding = Schema.Schema.Type<typeof ProvisionedCameraBinding>;

export const ProvisionedCameraFrame = Schema.Struct({
	cameraIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	height: positiveHeight,
	pixels: Schema.Uint8Array,
	width: positiveWidth
});
export type ProvisionedCameraFrame = Schema.Schema.Type<typeof ProvisionedCameraFrame>;

function provisionedCameraError(
	operation: ProvisionedCameraError["operation"],
	cause: RemoteControlClientError | unknown,
	recovery: string
): ProvisionedCameraError {
	return new ProvisionedCameraError({
		message: cause instanceof RemoteControlClientError ? cause.message : String(cause),
		operation,
		recovery,
		retrySafe: cause instanceof RemoteControlClientError ? cause.retrySafe : false
	});
}

export function ensureProvisionedCameras(
	endpoint: string,
	cameras: ReadonlyArray<ProvisionedCameraSpec>,
	options: { readonly previewFps?: number } = {}
): Effect.Effect<
	ReadonlyArray<ProvisionedCameraBinding>,
	ProvisionedCameraError,
	RemoteControlClient
> {
	return Effect.gen(function* () {
		const request = yield* Schema.decodeUnknownEffect(ProvisionedCameraRequest)({
			cameras,
			previewFps: Math.min(10, Math.max(1, Math.round(options.previewFps ?? 5))),
			schemaVersion: 2
		}).pipe(
			Effect.mapError((cause) =>
				provisionedCameraError(
					"ensure_cameras",
					cause,
					"Provide one through 32 valid temporary camera requests."
				)
			)
		);
		const client = yield* RemoteControlClient;
		const value = yield* client
			.request({
				endpoint,
				functionName: "EnsureProvisionedCameras",
				objectPath: cameraLibraryPath,
				operation: "camera.provisioned.ensure",
				parameters: { RequestJson: JSON.stringify(request) },
				timeout: "10 seconds"
			})
			.pipe(
				Effect.mapError((cause) =>
					provisionedCameraError(
						"ensure_cameras",
						cause,
						"Start PIE in the fixture map, then retry live previews."
					)
				)
			);
		const status = yield* Schema.decodeUnknownEffect(ProvisionedCameraStatus)(value).pipe(
			Effect.mapError((cause) =>
				provisionedCameraError(
					"ensure_cameras",
					cause,
					"Update UEShedCameras and retry provisioning the cameras."
				)
			)
		);
		if (status.error !== undefined || status.cameras.length === 0) {
			return yield* Effect.fail(
				new ProvisionedCameraError({
					message: status.error ?? "No provisioned cameras were registered.",
					operation: "ensure_cameras",
					recovery: "Start PIE with UEShedCameras enabled, then retry.",
					retrySafe: true
				})
			);
		}
		return yield* Effect.forEach(status.cameras, (camera) => {
			const correlation =
				camera.correlation ??
				(camera.candidateId === undefined
					? undefined
					: { candidateId: camera.candidateId, type: "framing_candidate" as const });
			if (correlation === undefined) {
				return Effect.fail(
					new ProvisionedCameraError({
						message: "Provisioned camera status did not include a durable correlation.",
						operation: "ensure_cameras",
						recovery:
							"Update UEShedCameras before relying on provisioned camera status.",
						retrySafe: false
					})
				);
			}
			return Effect.succeed(
				ProvisionedCameraBinding.make({
					cameraId: camera.cameraId,
					correlation,
					height: camera.height,
					index: camera.index,
					width: camera.width
				})
			);
		});
	}).pipe(Effect.withSpan("camera.provisioned.ensure"));
}

export function clearProvisionedCameras(
	endpoint: string
): Effect.Effect<void, ProvisionedCameraError, RemoteControlClient> {
	return Effect.gen(function* () {
		const client = yield* RemoteControlClient;
		yield* client
			.request({
				endpoint,
				functionName: "ClearProvisionedCameras",
				objectPath: cameraLibraryPath,
				operation: "camera.provisioned.clear",
				parameters: {},
				timeout: "5 seconds"
			})
			.pipe(
				Effect.mapError((cause) =>
					provisionedCameraError(
						"clear_cameras",
						cause,
						"Stop PIE or clear the provisioned cameras from the editor."
					)
				)
			);
	}).pipe(Effect.withSpan("camera.provisioned.clear"));
}

export function awaitProvisionedCameraFrame(args: {
	readonly cameraIndex: number;
	readonly latestFrames: Effect.Effect<ReadonlyMap<number, ProvisionedCameraFrame>>;
	readonly timeout?: Duration.Input;
}): Effect.Effect<ProvisionedCameraFrame, ProvisionedCameraError> {
	const timeout = args.timeout ?? "8 seconds";
	return Effect.gen(function* () {
		const deadline =
			(yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.fromInputUnsafe(timeout));
		while ((yield* Clock.currentTimeMillis) < deadline) {
			const latest = yield* args.latestFrames;
			const frame = latest.get(args.cameraIndex);
			if (frame !== undefined) return frame;
			yield* Effect.sleep("50 millis");
		}
		return yield* Effect.fail(
			new ProvisionedCameraError({
				message: `Timed out waiting for provisioned camera frame ${args.cameraIndex}.`,
				operation: "await_frame",
				recovery:
					"Confirm Workbench is listening on the camera pipe and PIE is still running.",
				retrySafe: true
			})
		);
	}).pipe(Effect.withSpan("camera.provisioned.await_frame"));
}
