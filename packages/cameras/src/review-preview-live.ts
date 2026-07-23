import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Clock, Duration, Effect, Schema } from "effect";
import type { ApprovedPose } from "./review-schema.js";

const cameraLibraryPath = "/Script/UEShedCameras.Default__UEShedCameraLibrary";

export class ReviewLivePreviewError extends Schema.TaggedErrorClass<ReviewLivePreviewError>()(
	"ReviewLivePreviewError",
	{
		message: Schema.String,
		operation: Schema.Literals(["ensure_sources", "clear_sources", "await_frame", "configure"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ReviewPreviewSourceSpec {
	readonly candidateId: string;
	readonly fieldOfViewDegrees: number;
	readonly height: number;
	readonly location: ApprovedPose["location"];
	readonly rotation: ApprovedPose["rotation"];
	readonly width: number;
}

export interface ReviewPreviewCameraBinding {
	readonly cameraId: string;
	readonly candidateId: string;
	readonly height: number;
	readonly index: number;
	readonly width: number;
}

export interface ReviewPreviewFrame {
	readonly cameraIndex: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly width: number;
}

const ReviewPreviewStatus = Schema.Struct({
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

function livePreviewError(
	operation: ReviewLivePreviewError["operation"],
	cause: RemoteControlClientError | unknown,
	recovery: string
): ReviewLivePreviewError {
	return new ReviewLivePreviewError({
		message: cause instanceof RemoteControlClientError ? cause.message : String(cause),
		operation,
		recovery,
		retrySafe: cause instanceof RemoteControlClientError ? cause.retrySafe : false
	});
}

export function ensureReviewPreviewSources(
	endpoint: string,
	sources: ReadonlyArray<ReviewPreviewSourceSpec>,
	options: { readonly previewFps?: number } = {}
): Effect.Effect<
	ReadonlyArray<ReviewPreviewCameraBinding>,
	ReviewLivePreviewError,
	RemoteControlClient
> {
	return Effect.gen(function* () {
		const client = yield* RemoteControlClient;
		const previewFps = Math.min(10, Math.max(1, Math.round(options.previewFps ?? 5)));
		const value = yield* client
			.request({
				endpoint,
				functionName: "EnsureReviewPreviewSources",
				objectPath: cameraLibraryPath,
				operation: "camera.review.preview.ensure_sources",
				parameters: {
					RequestJson: JSON.stringify({
						previewFps,
						sources: sources.map((source) => ({
							candidateId: source.candidateId,
							fieldOfViewDegrees: source.fieldOfViewDegrees,
							height: source.height,
							location: source.location,
							rotation: source.rotation,
							width: source.width
						}))
					})
				},
				timeout: "10 seconds"
			})
			.pipe(
				Effect.mapError((cause) =>
					livePreviewError(
						"ensure_sources",
						cause,
						"Start PIE in the fixture map, then retry live previews."
					)
				)
			);
		const status = yield* Schema.decodeUnknownEffect(ReviewPreviewStatus)(value).pipe(
			Effect.mapError((cause) =>
				livePreviewError(
					"ensure_sources",
					cause,
					"Update UEShedCameras and retry live review previews."
				)
			)
		);
		if (status.error !== undefined || status.cameras.length === 0) {
			return yield* Effect.fail(
				new ReviewLivePreviewError({
					message: status.error ?? "No review preview cameras were registered.",
					operation: "ensure_sources",
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
	}).pipe(Effect.withSpan("camera.review.preview.ensure_sources"));
}

export function clearReviewPreviewSources(
	endpoint: string
): Effect.Effect<void, ReviewLivePreviewError, RemoteControlClient> {
	return Effect.gen(function* () {
		const client = yield* RemoteControlClient;
		yield* client
			.request({
				endpoint,
				functionName: "ClearReviewPreviewSources",
				objectPath: cameraLibraryPath,
				operation: "camera.review.preview.clear_sources",
				parameters: {},
				timeout: "5 seconds"
			})
			.pipe(
				Effect.mapError((cause) =>
					livePreviewError(
						"clear_sources",
						cause,
						"Stop PIE or clear review preview sources from the editor."
					)
				)
			);
	}).pipe(Effect.withSpan("camera.review.preview.clear_sources"));
}

export function awaitReviewPreviewFrame(args: {
	readonly cameraIndex: number;
	readonly latestFrames: Effect.Effect<ReadonlyMap<number, ReviewPreviewFrame>>;
	readonly timeout?: Duration.Input;
}): Effect.Effect<ReviewPreviewFrame, ReviewLivePreviewError> {
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
			new ReviewLivePreviewError({
				message: `Timed out waiting for live preview frame ${args.cameraIndex}.`,
				operation: "await_frame",
				recovery:
					"Confirm Workbench is listening on the camera pipe and PIE is still running.",
				retrySafe: true
			})
		);
	}).pipe(Effect.withSpan("camera.review.preview.await_frame"));
}
