import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Clock, Duration, Effect, Schema } from "effect";
import type { ApprovedPose } from "./review-schema.js";

const cameraLibraryPath = "/Script/UEShedCameras.Default__UEShedCameraLibrary";

export class ProvisionedCameraError extends Schema.TaggedErrorClass<ProvisionedCameraError>()(
	"ProvisionedCameraError",
	{
		message: Schema.String,
		operation: Schema.Literals(["ensure_cameras", "clear_cameras", "await_frame", "configure"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ProvisionedCameraSpec {
	readonly candidateId: string;
	readonly fieldOfViewDegrees: number;
	readonly height: number;
	readonly location: ApprovedPose["location"];
	readonly rotation: ApprovedPose["rotation"];
	readonly width: number;
}

export interface ProvisionedCameraBinding {
	readonly cameraId: string;
	readonly candidateId: string;
	readonly height: number;
	readonly index: number;
	readonly width: number;
}

export interface ProvisionedCameraFrame {
	readonly cameraIndex: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly width: number;
}

const ProvisionedCameraStatus = Schema.Struct({
	cameras: Schema.Array(
		Schema.Struct({
			cameraId: Schema.String,
			candidateId: Schema.optional(Schema.String),
			displayName: Schema.String,
			height: Schema.Number,
			index: Schema.Number,
			width: Schema.Number
		})
	),
	error: Schema.optional(Schema.String),
	schemaVersion: Schema.optional(Schema.Number),
	status: Schema.optional(Schema.String)
});

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
		const client = yield* RemoteControlClient;
		const previewFps = Math.min(10, Math.max(1, Math.round(options.previewFps ?? 5)));
		const value = yield* client
			.request({
				endpoint,
				functionName: "EnsureProvisionedCameras",
				objectPath: cameraLibraryPath,
				operation: "camera.provisioned.ensure",
				parameters: {
					RequestJson: JSON.stringify({
						previewFps,
						cameras: cameras.map((camera) => ({
							candidateId: camera.candidateId,
							fieldOfViewDegrees: camera.fieldOfViewDegrees,
							height: camera.height,
							location: camera.location,
							rotation: camera.rotation,
							width: camera.width
						}))
					})
				},
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
		return status.cameras.map((camera) => ({
			cameraId: camera.cameraId,
			candidateId: camera.candidateId ?? camera.displayName,
			height: camera.height,
			index: camera.index,
			width: camera.width
		}));
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
