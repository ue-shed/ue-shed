import { contractParseError, ContractParseError } from "@ue-shed/protocol";
import { CameraVisibilityList } from "./camera-visibility.js";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { Clock, Duration, Effect, Schema } from "effect";
import {
	FramingCandidateId,
	ProvisionedCameraId,
	ReviewViewId,
	ReviewVector,
	ReviewRotation
} from "./review-schema.js";
import { MapCapturePlanId } from "./map-tile-schema.js";

const isRemoteControlClientError = Schema.is(RemoteControlClientError);
const cameraLibraryPath = "/Script/UEShedCameras.Default__UEShedCameraLibrary";
const positiveWidth = Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 2560 }));
const positiveHeight = Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 1440 }));

/**
 * Temporary preview provisioning/configuration/frame-wait failure with original cause.
 * Unsupported requested options fail explicitly rather than silently changing preview policy.
 */
export class ProvisionedCameraError extends Schema.TaggedError<ProvisionedCameraError>()(
	"ProvisionedCameraError",
	{
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		operation: Schema.Literals(["ensure_cameras", "clear_cameras", "await_frame", "configure"]),
		/** Set when the connected plugin cannot honour a requested option. */
		code: Schema.optionalKey(Schema.Literal("unsupported_capability"))
	}
) {}

/**
 * Links a temporary editor camera to a framing candidate, approved review view or map plan.
 * Correlation survives camera index changes and is separate from the producer's camera
 * identity.
 */
export const ProvisionedCameraCorrelation = Schema.Union([
	Schema.Struct({ candidateId: FramingCandidateId, type: Schema.Literal("framing_candidate") }),
	Schema.Struct({ reviewViewId: ReviewViewId, type: Schema.Literal("review_view") }),
	Schema.Struct({
		mapCapturePlanId: MapCapturePlanId,
		type: Schema.Literal("map_capture_plan")
	})
]);
export type ProvisionedCameraCorrelation = Schema.Schema.Type<typeof ProvisionedCameraCorrelation>;

const ProvisionedCameraFields = {
	visibility: Schema.optionalKey(CameraVisibilityList),
	correlation: ProvisionedCameraCorrelation,
	height: positiveHeight,
	location: ReviewVector,
	rotation: ReviewRotation,
	width: positiveWidth
};

/**
 * Perspective or orthographic temporary camera definition with explicit correlation and pose.
 * Optional visibility depends on negotiated request version; no saved map actor is implicitly
 * required.
 */
export const ProvisionedCameraSpec = Schema.Union([
	Schema.Struct({
		...ProvisionedCameraFields,
		projection: Schema.Struct({
			fieldOfViewDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
			type: Schema.Literal("perspective")
		})
	}),
	Schema.Struct({
		...ProvisionedCameraFields,
		projection: Schema.Struct({
			orthoWidth: Schema.Finite.check(Schema.isGreaterThan(0)),
			type: Schema.Literal("orthographic")
		})
	})
]);
export type ProvisionedCameraSpec = Schema.Schema.Type<typeof ProvisionedCameraSpec>;

/**
 * Bounded one-through-32 temporary cameras, expected map and preview FPS from one through
 * ten. Visibility requires version 4+, editor-preview reveal requires version 5; incompatible
 * fields are rejected.
 */
export const ProvisionedCameraRequest = Schema.Struct({
	cameras: Schema.Array(ProvisionedCameraSpec).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(32)
	),
	expectedMapPath: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(1_024),
		Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/u)
	),
	previewFps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
	/** Reveal child actors of editor-only owners in the previews, as renderer.editorPreviews does. */
	editorPreviews: Schema.optionalKey(Schema.Boolean),
	schemaVersion: Schema.Literals([3, 4, 5])
}).check(
	Schema.makeFilter((request) =>
		request.schemaVersion >= 4 ||
		request.cameras.every((camera) => camera.visibility === undefined)
			? undefined
			: "Visibility requires provisioning version 4."
	),
	Schema.makeFilter((request) =>
		request.schemaVersion === 5 || request.editorPreviews === undefined
			? undefined
			: "Editor previews require provisioning version 5."
	)
);
export type ProvisionedCameraRequest = Schema.Schema.Type<typeof ProvisionedCameraRequest>;

const PreviousProvisionedCameraRequest = Schema.Struct({
	cameras: Schema.Array(
		Schema.Struct({
			correlation: Schema.Union([
				Schema.Struct({
					candidateId: FramingCandidateId,
					type: Schema.Literal("framing_candidate")
				}),
				Schema.Struct({ reviewViewId: ReviewViewId, type: Schema.Literal("review_view") })
			]),
			fieldOfViewDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
			height: positiveHeight,
			location: ReviewVector,
			rotation: ReviewRotation,
			width: positiveWidth
		})
	).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
	previewFps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
	schemaVersion: Schema.Literal(2)
});

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

/**
 * Validates current and supported legacy preview requests, normalizing legacy correlation.
 * Invalid input fails with ContractParseError; retained legacy versions do not invent newer
 * visibility capabilities.
 */
export function decodeProvisionedCameraRequest<Input>(input: Input) {
	return Schema.decodeUnknownEffect(
		Schema.Union([
			ProvisionedCameraRequest,
			PreviousProvisionedCameraRequest,
			LegacyProvisionedCameraRequest
		])
	)(input).pipe(
		Effect.map((request) =>
			"schemaVersion" in request
				? request
				: PreviousProvisionedCameraRequest.make({
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
		),
		Effect.mapError((cause) => contractParseError("ProvisionedCameraRequest", cause))
	);
}

const ProvisionedCameraStatus = Schema.Struct({
	cameras: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				cameraId: ProvisionedCameraId,
				candidateId: Schema.optional(FramingCandidateId),
				correlation: Schema.optional(ProvisionedCameraCorrelation),
				displayName: Schema.String,
				height: positiveHeight,
				index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
				width: positiveWidth
			})
		)
	),
	editorPreviews: Schema.optional(
		Schema.Struct({
			revealedChildActors: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	error: Schema.optional(Schema.String),
	/** Prose beside the `error` code, for people; plugins before 0.17 put prose in `error`. */
	message: Schema.optional(Schema.String),
	schemaVersion: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
	status: Schema.optional(Schema.String),
	worldContext: Schema.optional(Schema.Literals(["editor", "play"]))
});

/**
 * Producer-assigned temporary camera ID/index, dimensions and editor-live/play-live preview
 * context. Use its ID as well as index when waiting so an old frame cannot satisfy a new
 * binding.
 */
export const ProvisionedCameraBinding = Schema.Struct({
	cameraId: ProvisionedCameraId,
	correlation: ProvisionedCameraCorrelation,
	height: positiveHeight,
	index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	previewContext: Schema.Literals(["editor_live", "play_live"]),
	width: positiveWidth
});
export type ProvisionedCameraBinding = Schema.Schema.Type<typeof ProvisionedCameraBinding>;

/**
 * Latest preview BGRA bytes and dimensions indexed by camera, optionally carrying producer
 * camera identity. Transient previews are not immutable PNG review artifacts.
 */
export const ProvisionedCameraFrame = Schema.Struct({
	cameraId: Schema.optional(Schema.String),
	cameraIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	height: positiveHeight,
	pixels: Schema.Uint8Array,
	width: positiveWidth
});
export type ProvisionedCameraFrame = Schema.Schema.Type<typeof ProvisionedCameraFrame>;

function provisionedCameraError(
	operation: ProvisionedCameraError["operation"],
	cause: RemoteControlClientError | unknown,
	recovery: string,
	/** Which side of the exchange failed to decode: the caller's request or the editor's response. */
	subject: "request" | "response" = "response"
): ProvisionedCameraError {
	if (isRemoteControlClientError(cause)) {
		return new ProvisionedCameraError({
			message: cause.message,
			nextStep: cause.nextStep,
			operation,
			recovery,
			retrySafe: cause.retrySafe,
			cause
		});
	}
	if (Schema.isSchemaError(cause) || Schema.is(ContractParseError)(cause))
		return subject === "request"
			? new ProvisionedCameraError({
					message: `The provisioned camera request for ${operation} does not match the provisioning contract.`,
					nextStep: "fix_input",
					operation,
					recovery,
					retrySafe: true,
					cause
				})
			: new ProvisionedCameraError({
					message: `The editor response to ${operation} does not match the provisioning contract.`,
					nextStep: "escalate",
					operation,
					recovery,
					retrySafe: false,
					cause
				});
	return new ProvisionedCameraError({
		message: `Provisioned camera operation ${operation} failed unexpectedly.`,
		nextStep: "escalate",
		operation,
		recovery,
		retrySafe: false,
		cause
	});
}

/** Picks the oldest provisioning version that carries the request, so older plugins keep working. */
export function provisionedCameraRequest(
	cameras: ReadonlyArray<ProvisionedCameraSpec>,
	options: ProvisionedCameraOptions
): ProvisionedCameraRequest {
	const previewFps = Math.min(10, Math.max(1, Math.round(options.previewFps ?? 5)));
	const { expectedMapPath } = options;
	if (options.editorPreviews === true)
		return { cameras, editorPreviews: true, expectedMapPath, previewFps, schemaVersion: 5 };
	const schemaVersion = cameras.some((camera) => camera.visibility !== undefined) ? 4 : 3;
	return { cameras, expectedMapPath, previewFps, schemaVersion };
}

/**
 * Expected map, optional preview FPS and explicit editor-preview reveal policy. Unsupported
 * reveal fails with unsupported_capability; a host may explicitly request a supported
 * alternative.
 */
export interface ProvisionedCameraOptions {
	readonly expectedMapPath: string;
	readonly previewFps?: number;
	/**
	 * Show child actors that ChildActorComponents spawn for editor-only owners (for example
	 * spawn-volume previews), like renderer.editorPreviews on renders. Defaults to false. Plugins
	 * without support fail with code "unsupported_capability"; retry without the option to fall back.
	 */
	readonly editorPreviews?: boolean;
}

/**
 * Validates/provisions temporary cameras at an explicit endpoint and verifies returned
 * bindings. Requested options are honored or refused explicitly; requires
 * RemoteControlClient.
 */
export function ensureProvisionedCameras(
	endpoint: string,
	cameras: ReadonlyArray<ProvisionedCameraSpec>,
	options: ProvisionedCameraOptions
): Effect.Effect<
	ReadonlyArray<ProvisionedCameraBinding>,
	ProvisionedCameraError,
	RemoteControlClient
> {
	return Effect.gen(function* () {
		const request = yield* Schema.decodeUnknownEffect(ProvisionedCameraRequest)(
			provisionedCameraRequest(cameras, options)
		).pipe(
			Effect.mapError((cause) =>
				provisionedCameraError(
					"ensure_cameras",
					cause,
					"Provide one through 32 valid temporary camera requests.",
					"request"
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
						"Open the expected map in Unreal Editor, then retry live previews."
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
		// Plugins that support version 5 echo it in every response, failures included.
		if (request.schemaVersion === 5 && status.schemaVersion !== 5)
			return yield* Effect.fail(
				new ProvisionedCameraError({
					code: "unsupported_capability",
					operation: "ensure_cameras",
					message: "The connected plugin cannot show editor previews in live previews.",
					recovery:
						"Omit editorPreviews or install a matching UE Shed Cameras plugin that supports provisioning version 5.",
					retrySafe: false,
					nextStep: "fix_input"
				})
			);
		if (request.schemaVersion === 4 && status.schemaVersion !== 4)
			return yield* Effect.fail(
				new ProvisionedCameraError({
					code: "unsupported_capability",
					operation: "ensure_cameras",
					message: "The connected plugin cannot confirm authored preview visibility.",
					recovery:
						"Install a matching Cameras plugin before previewing authored output.",
					retrySafe: false,
					nextStep: "fix_input"
				})
			);
		if (status.editorPreviews !== undefined)
			yield* Effect.annotateCurrentSpan(
				"camera.provisioned.editor_previews.revealed",
				status.editorPreviews.revealedChildActors
			);
		const statusCameras = status.cameras ?? [];
		if (status.error !== undefined || statusCameras.length === 0) {
			return yield* Effect.fail(
				new ProvisionedCameraError({
					message:
						status.message !== undefined && status.error !== undefined
							? `${status.message} (${status.error})`
							: (status.error ?? "No provisioned cameras were registered."),
					operation: "ensure_cameras",
					recovery: "Open the expected map with UEShedCameras enabled, then retry.",
					retrySafe: true,
					nextStep: "fix_input"
				})
			);
		}
		return yield* Effect.forEach(statusCameras, (camera) => {
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
						retrySafe: false,
						nextStep: "escalate"
					})
				);
			}
			return Effect.succeed(
				ProvisionedCameraBinding.make({
					cameraId: camera.cameraId,
					correlation,
					height: camera.height,
					index: camera.index,
					previewContext: status.worldContext === "editor" ? "editor_live" : "play_live",
					width: camera.width
				})
			);
		});
	}).pipe(Effect.withSpan("camera.provisioned.ensure"));
}

/**
 * Explicitly removes provisioned preview cameras through RemoteControlClient. Does not delete
 * saved review definitions or immutable capture history.
 */
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
						"Reconnect Unreal, then clear the provisioned preview cameras."
					)
				)
			);
	}).pipe(Effect.withSpan("camera.provisioned.clear"));
}

/**
 * Polls latest frames every 50 milliseconds until the requested index and optional camera ID
 * match. Defaults to eight seconds; timeout is a typed provisioning failure rather than an
 * empty frame.
 */
export function awaitProvisionedCameraFrame(args: {
	readonly cameraIndex: number;
	readonly expectedCameraId?: string;
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
			if (
				frame !== undefined &&
				(args.expectedCameraId === undefined || frame.cameraId === args.expectedCameraId)
			) {
				return frame;
			}
			yield* Effect.sleep("50 millis");
		}
		return yield* Effect.fail(
			new ProvisionedCameraError({
				message: `Timed out waiting for provisioned camera frame ${args.cameraIndex}.`,
				operation: "await_frame",
				recovery:
					"Confirm Workbench is listening on the camera pipe and the Unreal world is available.",
				retrySafe: true,
				nextStep: "retry"
			})
		);
	}).pipe(Effect.withSpan("camera.provisioned.await_frame"));
}
