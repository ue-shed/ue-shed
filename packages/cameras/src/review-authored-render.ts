import { ReviewRenderInspectionResult } from "./review-render.js";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { makeCameraRenderer, CameraRenderError } from "./camera-render.js";
import {
	CameraRenderSessionId,
	CameraFrameOperationId,
	cameraRenderContract,
	legacyReviewRenderPolicy,
	type CameraFrameResult,
	type CameraRenderPolicy
} from "./camera-render-schema.js";
import {
	ApprovedPose,
	ResolvedReviewSubject,
	ReviewCaptureRequestCurrent,
	decodeReviewCaptureResponse
} from "./review-schema.js";

/** Independent named variants. Meter the natural scene once, then hold the same exposure for the pair. */
export const captureAuthoredReviewView = Effect.fn("ReviewRenderer.authored")(function* (args: {
	endpoint: string;
	request: typeof ReviewCaptureRequestCurrent.Type;
}) {
	const client = yield* RemoteControlClient,
		request = args.request;
	const authored = request.authoredVisibility;
	if (!authored)
		return yield* Effect.fail(
			new CameraRenderError({
				code: "invalid_policy",
				operation: "capture",
				sessionId: request.operationId,
				message: "Authored output requires an explicit policy.",
				recovery: "Provide the saved View visibility policy."
			})
		);
	const renderer = makeCameraRenderer(client, args.endpoint),
		capabilities = yield* renderer.capabilities();
	if (!capabilities.authoredVisibility)
		return yield* Effect.fail(
			new CameraRenderError({
				code: "unsupported_capability",
				operation: "capture",
				sessionId: request.operationId,
				message: "The connected renderer does not support authored visibility.",
				recovery:
					"Enable a matching Cameras plugin; no renderer substitution was performed."
			})
		);
	const realization =
		request.viewpoint.kind === "world_fixed"
			? { status: "resolved" as const, pose: request.viewpoint.approvedPose }
			: yield* client
					.request({
						endpoint: args.endpoint,
						objectPath:
							"/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
						functionName: "ResolveReviewViewpoint",
						parameters: {
							RequestJson: JSON.stringify({
								contract: {
									name: "ue-shed-review-render-stages",
									version: { major: 1, minor: 0 }
								},
								viewpoint: request.viewpoint,
								subject: request.subject,
								expectedMapPath: request.expectedMapPath
							})
						}
					})
					.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Union([
									Schema.Struct({
										status: Schema.Literal("resolved"),
										pose: ApprovedPose,
										resolvedSubject: Schema.optionalKey(ResolvedReviewSubject)
									}),
									Schema.Struct({
										status: Schema.Literal("failed"),
										code: Schema.String,
										message: Schema.String,
										recovery: Schema.String
									})
								])
							)
						)
					);
	if (realization.status === "failed")
		return yield* Effect.fail(
			new CameraRenderError({
				...realization,
				code: "capture_failed",
				operation: "capture",
				sessionId: request.operationId
			})
		);
	const pose = realization.pose;
	const camera = {
		location: pose.location,
		rotation: pose.rotation,
		projection: { kind: "perspective" as const, horizontalFieldOfView: pose.fieldOfViewDegrees }
	};
	let policy = request.renderPolicy ?? legacyReviewRenderPolicy;
	const paired = authored.output === "natural_and_authored";
	if (paired && policy.exposure.mode === "project_auto") {
		if (policy.renderer.kind !== "editor_viewport")
			return yield* Effect.fail(
				new CameraRenderError({
					code: "exposure_unavailable",
					operation: "capture",
					sessionId: request.operationId,
					message: "Paired SceneCapture output requires explicit fixed exposure.",
					recovery:
						"Set fixed_ev100, or explicitly choose the viewport renderer with meter_once."
				})
			);
		policy = {
			...policy,
			exposure: {
				mode: "meter_once",
				referenceCamera: camera,
				referenceSize: request.resolution,
				minimumFrames: policy.settling.minimumFrames
			}
		};
	}
	let inspection:
		| Extract<Schema.Schema.Type<typeof ReviewRenderInspectionResult>, { status: "inspected" }>
		| undefined;
	const frames: { variant: "pure" | "authored"; frame: CameraFrameResult }[] = [];
	const variants: readonly ("pure" | "authored")[] =
		authored.output === "natural_only"
			? ["pure"]
			: authored.output === "authored_only"
				? ["authored"]
				: ["pure", "authored"];
	for (const variant of variants) {
		const selectedPolicy: CameraRenderPolicy = {
			...policy,
			...(variant === "authored" ? { visibility: authored.actors } : undefined)
		};
		const frame = yield* Effect.scoped(
			Effect.gen(function* () {
				const sessionId = CameraRenderSessionId.make(randomUUID());
				const session = yield* renderer.open({
					contract: cameraRenderContract,
					sessionId,
					expectedProjectName: capabilities.projectName,
					expectedMapPath: request.expectedMapPath,
					leaseMs: 120000,
					maximumFrames: 1,
					policy: selectedPolicy
				});
				const captured = yield* session.capture({
					contract: cameraRenderContract,
					sessionId,
					operationId: CameraFrameOperationId.make(variant),
					camera,
					size: request.resolution
				});
				if (variant === "pure") {
					const assessed = yield* client
						.request({
							endpoint: args.endpoint,
							objectPath:
								"/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
							functionName: "InspectRenderedReview",
							parameters: {
								SessionId: sessionId,
								RequestJson: JSON.stringify({
									contract: {
										name: "ue-shed-review-render-stages",
										version: { major: 1, minor: 0 }
									},
									subject: request.subject,
									assessment: request.assessment,
									clearCompanion: { status: "not_requested" }
								})
							}
						})
						.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(ReviewRenderInspectionResult))
						);
					if (assessed.status === "failed")
						return yield* Effect.fail(
							new CameraRenderError({
								code: "capture_failed",
								operation: "capture",
								sessionId,
								message: assessed.message,
								recovery: assessed.recovery
							})
						);
					inspection = assessed;
				}
				return captured;
			})
		);
		frames.push({ variant, frame });
		if (paired && variant === "pure" && policy.exposure.mode === "meter_once") {
			if (frame.evidence.exposureEV100 === null)
				return yield* Effect.fail(
					new CameraRenderError({
						code: "exposure_unavailable",
						operation: "capture",
						sessionId: request.operationId,
						message: "Natural exposure was not recorded.",
						recovery: "Inspect renderer metering before producing the pair."
					})
				);
			policy = {
				...policy,
				exposure: {
					mode: "fixed_ev100",
					ev100: frame.evidence.exposureEV100,
					compensation: "project"
				}
			};
		}
	}
	const first = frames[0]!.frame,
		altered = frames.find((entry) => entry.variant === "authored")?.frame;
	return yield* decodeReviewCaptureResponse({
		contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 7 } },
		status: "captured",
		operationId: request.operationId,
		viewId: request.viewId,
		effectiveWorldPose: pose,
		resolvedSubject:
			"resolvedSubject" in realization
				? realization.resolvedSubject
				: request.subject.kind === "oriented_bounds"
					? request.subject
					: {
							kind: "unresolved_actor",
							subject: request.subject,
							reason: "World-fixed capture does not require subject realization."
						},
		clearCompanion: { status: "not_requested" },
		stagedArtifacts: frames.map(({ variant, frame }) => ({
			variant,
			stagingPath: `Saved/UEShed/CameraRenderStaging/${frame.artifact.relativePath}`
		})),
		visibility: inspection?.visibility ?? {
			status: "not_assessed",
			reason: "Authored-only output has no natural-scene visibility score."
		},
		...(inspection?.subjectProjection
			? { subjectProjection: inspection.subjectProjection }
			: undefined),
		authoredVisibility: authored,
		...(altered ? { authoredEvidence: altered.evidence } : undefined),
		mapPath: request.expectedMapPath,
		...first.evidence.editorState,
		width: first.artifact.width,
		height: first.artifact.height,
		captureDurationMs: frames.reduce(
			(sum, entry) => sum + entry.frame.evidence.settling.elapsedMs,
			0
		),
		renderEvidence: first.evidence
	});
});
