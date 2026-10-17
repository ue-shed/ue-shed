import {
	decodeCameraScheduleConfig,
	CameraControlFailure,
	CameraStatus,
	ErrorCauseFields,
	ErrorGuidanceFields,
	type CameraScheduleConfig
} from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect";
import { createServer, type Server, type Socket } from "node:net";

export {
	captureReviewSet,
	type CaptureReviewSetOptions,
	defaultReviewCaptureConcurrency,
	makeReviewCaptureTestLayer,
	manualCaptureInvocation,
	ReviewCapture,
	type ReviewCaptureApi,
	ReviewCaptureConcurrency,
	ReviewCaptureLive,
	ReviewCapturePort,
	type ReviewCapturePortApi,
	reviewCapturePortLayer,
	reviewCaptureRemotePortLayer,
	ReviewCaptureRunError,
	ReviewIdGenerator,
	type ReviewIdGeneratorApi,
	reviewIdGeneratorLayer,
	ReviewIdGeneratorLive
} from "./review-capture.js";
export {
	AbsoluteCamera,
	CameraExposurePolicy,
	CameraFrameEvidence,
	CameraFrameOperationId,
	CameraFrameRequest,
	CameraFrameResult,
	CameraFrameStatus,
	CameraOutputSize,
	CameraPreparationPolicy,
	CameraRenderBeginResult,
	CameraRenderCapabilities,
	CameraRenderCapabilitiesV1,
	cameraRenderContract,
	CameraRenderContract,
	CameraRenderEndResult,
	CameraRendererPolicy,
	CameraRenderFailure,
	CameraRenderFailureCode,
	CameraRenderIssue,
	CameraRenderPolicy,
	CameraRenderPreflight,
	CameraRenderProgress,
	CameraRenderRegion,
	CameraRenderSessionId,
	CameraRenderSessionRequest,
	CameraWorldRotation,
	CameraWorldVector,
	highResolutionReviewRenderer,
	legacyReviewRenderPolicy,
	reviewCaptureRenderPolicy
} from "./camera-render-schema.js";
export {
	CameraRenderer,
	type CameraRendererApi,
	cameraRendererLayer,
	CameraRenderError,
	cameraRendererTestLayer,
	cameraRenderReuseIdentity,
	type CameraRenderSession,
	isEditorOwnershipRejection,
	makeCameraRenderer,
	readCameraFrameArtifact,
	renderCamera
} from "./camera-render.js";
export {
	assertMapTileKey,
	chooseMapTileLevel,
	createMapTileGrid,
	type CreateMapTileGridOptions,
	mapTileAncestorChain,
	mapTileChildren,
	type MapTileGrid,
	type MapTileKey,
	mapTileKeyId,
	type MapTileLevel,
	mapTileParent,
	mapTileRelativePath,
	type MapTileSelection,
	type MapTileSelectionOptions,
	mapTileWorldBounds,
	type MapWorldBounds,
	resolveAvailableMapTiles,
	selectMapTiles,
	visibleMapTiles,
	worldToMapTile
} from "./map-tile-pyramid.js";
export {
	createMapTileSource,
	MapTilePixelRect,
	MapTileSource,
	MapTileSourceBlock,
	MapTileSourceCrop,
	MapTileSourceError,
	type MapTileSourceLayout,
	MapTileSourceLayoutOptions,
	MapTileSourceLimits,
	MapTileSourceSettings,
	planMapTileSources
} from "./map-tile-source.js";
export {
	cropMapTileImage,
	deriveMapTileParent,
	MapTileImage,
	MapTileImageError,
	MapTileParentImages
} from "./map-tile-image.js";
export {
	fitMapCapturePlanToSelection,
	makeDefaultMapCapturePlan,
	mapCaptureBackendIssue,
	mapCaptureSafeIdentifier,
	savedMapPathToGameMapPath
} from "./map-tile-authoring.js";
export {
	decodeMapCapturePlan,
	decodeMapTileCaptureRequest,
	decodeMapTileCaptureResponse,
	decodeMapTilePyramidManifest,
	MapCaptureBackend,
	MapCaptureContractVersion,
	MapCaptureDataLayerPolicy,
	MapCaptureOperationId,
	MapCapturePlan,
	MapCapturePlanId,
	MapCaptureProject,
	MapCaptureRenderPolicy,
	MapCaptureRunId,
	MapCaptureWorldBounds,
	MapTileArtifact,
	MapTileCaptureOperation,
	MapTileCaptureProgress,
	MapTileCaptureRequest,
	MapTileCaptureResponse,
	MapTileCaptureTileRequest,
	MapTileKeySchema,
	type MapTileKeyValue,
	MapTilePyramidFailure,
	MapTilePyramidLevel,
	MapTilePyramidManifest,
	MapTileReleaseResult
} from "./map-tile-schema.js";
export {
	callerOwnedMapCaptureDestination,
	DEFAULT_MAP_CAPTURE_ROOT,
	makeMapCaptureRepositoryTestLayer,
	MapCaptureArtifactSourceRejected,
	type MapCaptureAttempt,
	mapCaptureAttemptsRoot,
	type MapCaptureDestination,
	mapCapturePlansRoot,
	MapCaptureRepository,
	type MapCaptureRepositoryApi,
	MapCaptureRepositoryLive,
	mapCaptureRoot,
	mapCaptureRunsRoot,
	type MapCaptureRunSummary,
	MapCaptureStorageError,
	projectLocalMapCaptureDestination,
	validateMapCaptureProjectRoot
} from "./map-tile-repository.js";
export {
	inspectMapCapturePlan,
	type InspectMapCapturePlanResult,
	makeMapTileCaptureRemotePort,
	MapCapture,
	type MapCaptureApi,
	MapCaptureLive,
	MapCaptureRunError,
	type MapCaptureRunOutcome,
	type MapCaptureRunProgress,
	MapTileCapturePort,
	type MapTileCapturePortApi,
	mapTileCapturePortLayer,
	mapTileCaptureRemotePortLayer,
	runMapCapture,
	type RunMapCaptureOptions,
	runMapCapturePlan,
	type RunMapCapturePlanOptions
} from "./map-tile-capture.js";
export {
	inspectReviewSelection,
	makeReviewAuthoringTestLayer,
	previewReviewCandidate,
	type PreviewReviewCandidateArgs,
	ReviewAuthoring,
	type ReviewAuthoringApi,
	ReviewAuthoringConnectionError,
	ReviewAuthoringLive,
	type ReviewCandidatePreview
} from "./review-authoring-live.js";
export {
	makeReviewAuthoringSessionsTestLayer,
	nextReviewViewId,
	REVIEW_AUTHORING_SESSIONS_DIRECTORY,
	ReviewAuthoringSessionError,
	reviewAuthoringSessionPath,
	ReviewAuthoringSessions,
	type ReviewAuthoringSessionsApi,
	ReviewAuthoringSessionsLive
} from "./review-authoring-session.js";
export {
	bootstrapMapReviewSet,
	createMapReviewSet,
	type MapReviewBootstrap
} from "./review-bootstrap.js";
export {
	applyCandidateOverrides,
	approveFramingCandidate,
	type ApproveFramingCandidateResult,
	type ArcFramingPresetOptions,
	cardinalOrbitGroup,
	cardinalOrbitGroupId,
	contextThreeQuarterGroup,
	contextThreeQuarterGroupId,
	createAreaReviewView,
	createReviewViewFromCandidate,
	defaultFramingParameters,
	facadeFrontGroup,
	facadeFrontGroupId,
	framingDriftDiagnostics,
	generateFramingCandidateId,
	generateFramingCandidates,
	realizationFramingDiagnostics,
	realizeTargetRelativePose,
	type ReviewSelection,
	revisedReviewViewRevision,
	reviseReviewView,
	type ReviseReviewViewResult,
	targetRelativePoseFromWorldPose,
	targetRelativeViewpointFromWorldPose
} from "./review-framing.js";
export {
	projectReviewViewHistory,
	type ReviewViewHistory,
	type ReviewViewHistoryEntry
} from "./review-history.js";
export {
	captureReviewView,
	getReviewAssessmentCapabilities,
	ReviewCaptureConnectionError
} from "./review-live.js";
export {
	awaitProvisionedCameraFrame,
	clearProvisionedCameras,
	decodeProvisionedCameraRequest,
	ensureProvisionedCameras,
	ProvisionedCameraBinding,
	ProvisionedCameraCorrelation,
	ProvisionedCameraError,
	ProvisionedCameraFrame,
	type ProvisionedCameraOptions,
	provisionedCameraRequest,
	ProvisionedCameraRequest,
	ProvisionedCameraSpec
} from "./provisioned-cameras-live.js";
export {
	callerOwnedReviewCaptureDestination,
	captureRunPath,
	captureRunsRoot,
	type CaptureRunSummary,
	createReviewSetFromTemplate,
	DEFAULT_REVIEW_ROOT,
	findReviewSet,
	isPathWithin,
	listCaptureRuns,
	listReviewSets,
	loadCaptureRun,
	loadReviewSet,
	makeReviewRepositoryTestLayer,
	projectLocalReviewCaptureDestination,
	ReviewArtifactSourceRejected,
	type ReviewCaptureAttempt,
	type ReviewCaptureDestination,
	ReviewRepository,
	type ReviewRepositoryApi,
	ReviewRepositoryLive,
	reviewSetsRoot,
	type ReviewSetSummary,
	ReviewStorageError,
	runIdFromPath,
	saveReviewSet
} from "./review-repository.js";
export {
	ActorGuidSubjectLocator,
	ActorPathSubjectLocator,
	ActorTarget,
	ActorTransformSnapshot,
	ApprovedPose,
	ApproveReviewCandidateIntent,
	ArcFramingPattern,
	AreaTarget,
	ArtifactId,
	BoundedJsonObject,
	CaptureArtifact,
	CapturedReviewViewRevision,
	CaptureInvocation,
	CaptureInvocationCause,
	CaptureInvocationId,
	CaptureProfile,
	CaptureProfileId,
	CaptureRealization,
	CaptureRun,
	CaptureRunId,
	classifyVisibilityMeasurement,
	ClearCompanionResult,
	decodeApproveReviewCandidateIntent,
	decodeCaptureInvocation,
	decodeCaptureRun,
	decodeCaptureRunWithMigration,
	decodeReviewAssessmentCapabilities,
	decodeReviewAuthoringSession,
	decodeReviewCaptureRequest,
	decodeReviewCaptureResponse,
	decodeReviewSelectionResponse,
	decodeReviewSet,
	decodeReviewSetWithMigration,
	decodeReviewSubjectInspectionResponse,
	defaultNaturalOnlyVisibilityPolicy,
	EffectiveVisibilityMethod,
	FramingCandidate,
	FramingCandidateId,
	FramingCandidateOverride,
	FramingCandidateOverrides,
	FramingDiagnostic,
	FramingGroup,
	FramingGroupId,
	FramingParameters,
	FramingPattern,
	FramingPreset,
	FramingRecipe,
	initialReviewViewRevision,
	nextReviewViewRevision,
	NumberedReviewViewRevision,
	ObjectLocator,
	OccluderEvidence,
	OrientedBoundsSubject,
	PresetFramingRecipe,
	PresetFramingRecipeV1,
	PresetFramingRecipeV2,
	ProvisionedCameraId,
	ResolvedActorGuidSubject,
	ResolvedActorSubject,
	ResolvedReviewSubject,
	ReviewAssessmentCapabilities,
	ReviewAssessmentMethodName,
	ReviewAuthoringDestination,
	ReviewAuthoringSession,
	ReviewAuthoringSessionId,
	ReviewAuthoringSessionPatch,
	ReviewAuthoringSessionRecovery,
	ReviewCandidateRealization,
	ReviewCaptureOperationId,
	ReviewCaptureRequest,
	ReviewCaptureRequestCurrent,
	ReviewCaptureResponse,
	ReviewCaptureSubject,
	ReviewClearCompanionRequest,
	type ReviewProjectedBounds,
	type ReviewProjectionMargins,
	ReviewRotation,
	ReviewSelectionResponse,
	ReviewSet,
	ReviewSetId,
	ReviewSubjectActorGuid,
	ReviewSubjectActorPath,
	ReviewSubjectInspectionResponse,
	ReviewSubjectProjection,
	ReviewTarget,
	ReviewVector,
	ReviewView,
	reviewViewActorSubject,
	reviewViewApprovedPose,
	ReviewViewDefinition,
	ReviewViewId,
	ReviewViewRevisionId,
	RingFramingPattern,
	SubjectBounds,
	SubjectLocator,
	subjectLocatorFromSelection,
	TargetRelativeViewpoint,
	ViewResult,
	VisibilityAssessment,
	VisibilityClassification,
	VisibilityClassificationThresholds,
	VisibilityLowThresholdAction,
	VisibilityMeasurement,
	VisibilityOutput,
	VisibilityOverrides,
	VisibilityPolicy,
	VisibilityPolicyId,
	VisibilityResult,
	VisibilitySamplePreset,
	WorldFixedViewpoint
} from "./review-schema.js";
export {
	evaluateReviewCapturePolicy,
	ReviewCaptureBlock,
	type ReviewCapturePolicyDecision
} from "./review-session-policy.js";
export {
	applyVisibilityPolicyToViews,
	applyVisibilityPolicyToViewsAtPath,
	inspectReviewVisibilityPolicies,
	inspectReviewVisibilityPoliciesAtPath,
	makeReviewViewId,
	makeVisibilityPolicyId,
	replaceViewVisibilityPolicy,
	replaceViewVisibilityPolicyAtPath,
	ReviewVisibilityPolicyError,
	type ReviewVisibilityPolicyInspection
} from "./review-visibility-policy.js";
export {
	putReviewView,
	putReviewViewAtPath,
	type PutReviewViewResult,
	ReviewViewDefinitionError
} from "./review-view.js";

/**
 * Default local Windows named pipe for version-1 preview frames. Hosts can override pipeName;
 * this is preview transport rather than a persistent capture artifact destination.
 */
export const CAMERA_PIPE_NAME = "\\\\.\\pipe\\ue-shed-cameras-v1";
/**
 * Fixed 128-byte preview frame header length. The frame decoder validates header/payload
 * bounds before exposing BGRA pixels.
 */
export const CAMERA_FRAME_HEADER_BYTES = 128;
const frameMagic = Buffer.from("USCF");
const maximumPayloadBytes = 16 * 1024 * 1024;

/**
 * Received BGRA8 preview with pixel dimensions, camera/session/producer identities, sequence
 * and timing/drop evidence. Preview frames are transient; use capture artifacts for immutable
 * review history.
 */
export interface CameraFrame {
	readonly cameraId: string;
	readonly cameraIndex: number;
	readonly captureMonotonicMs: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly producerId: string;
	readonly readbackDrops: number;
	readonly readbackLatencyMs: number;
	readonly receivedMonotonicMs: number;
	readonly sequence: bigint;
	readonly sessionId: string;
	readonly transportReplacements: number;
	readonly width: number;
	readonly worldSeconds: number;
}

/**
 * Cumulative received bytes/frames, malformed/transport errors and replacements at
 * transport/receiver/delivery boundaries. Started time uses a monotonic clock rather than
 * wall-clock UTC.
 */
export interface CameraFeedMetrics {
	readonly bytesReceived: number;
	readonly deliveryReplacements: number;
	readonly framesReceived: number;
	readonly malformedFrames: number;
	readonly receiverReplacements: number;
	readonly startedMonotonicMs: number;
	readonly transportErrors: number;
}

/**
 * Local preview listener acquisition failure with pipe identity, guidance and original cause.
 * Correct pipe ownership/platform prerequisites before retrying.
 */
export class CameraFeedError extends Schema.TaggedError<CameraFeedError>()("CameraFeedError", {
	...ErrorGuidanceFields,
	...ErrorCauseFields,
	operation: Schema.Literal("listen"),
	pipeName: Schema.String
}) {}

function unrealGuidToDigits(buffer: Buffer, offset: number): string {
	return [0, 4, 8, 12]
		.map((wordOffset) =>
			buffer
				.readUInt32LE(offset + wordOffset)
				.toString(16)
				.padStart(8, "0")
		)
		.join("");
}

/**
 * Incremental bounded binary preview decoder accepting fragmented or combined pipe chunks.
 * Validates header/dimensions/payload before emitting a frame; malformed input is tracked
 * rather than trusted as pixels.
 */
export class CameraFrameDecoder {
	private readonly chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private headOffset = 0;

	private discard(byteCount: number): void {
		let remaining = byteCount;
		while (remaining > 0 && this.chunks.length > 0) {
			const head = this.chunks[0];
			if (!head) return;
			const available = head.length - this.headOffset;
			const consumed = Math.min(available, remaining);
			this.headOffset += consumed;
			this.bufferedBytes -= consumed;
			remaining -= consumed;
			if (this.headOffset === head.length) {
				this.chunks.shift();
				this.headOffset = 0;
			}
		}
	}

	private read(byteCount: number): Buffer | undefined {
		if (this.bufferedBytes < byteCount) return undefined;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= byteCount) {
			const result = head.subarray(this.headOffset, this.headOffset + byteCount);
			this.discard(byteCount);
			return result;
		}
		const result = Buffer.allocUnsafe(byteCount);
		let written = 0;
		while (written < byteCount) {
			const chunk = this.chunks[0];
			if (!chunk) return undefined;
			const copied = Math.min(chunk.length - this.headOffset, byteCount - written);
			chunk.copy(result, written, this.headOffset, this.headOffset + copied);
			this.discard(copied);
			written += copied;
		}
		return result;
	}

	private peek(byteCount: number): Buffer | undefined {
		if (this.bufferedBytes < byteCount) return undefined;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= byteCount) {
			return head.subarray(this.headOffset, this.headOffset + byteCount);
		}
		const result = Buffer.allocUnsafe(byteCount);
		let written = 0;
		for (const chunk of this.chunks) {
			const start = chunk === head ? this.headOffset : 0;
			const copied = Math.min(chunk.length - start, byteCount - written);
			chunk.copy(result, written, start, start + copied);
			written += copied;
			if (written === byteCount) return result;
		}
		return undefined;
	}

	private startsWithMagic(): boolean {
		if (this.bufferedBytes < frameMagic.length) return false;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= frameMagic.length) {
			return head
				.subarray(this.headOffset, this.headOffset + frameMagic.length)
				.equals(frameMagic);
		}
		let offset = 0;
		for (const chunk of this.chunks) {
			const start = chunk === head ? this.headOffset : 0;
			for (
				let index = start;
				index < chunk.length && offset < frameMagic.length;
				index += 1
			) {
				if (chunk[index] !== frameMagic[offset]) return false;
				offset += 1;
			}
			if (offset === frameMagic.length) return true;
		}
		return false;
	}

	push(chunk: Uint8Array) {
		if (chunk.byteLength > 0) {
			this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			this.bufferedBytes += chunk.byteLength;
		}
		const frames: Array<CameraFrame> = [];
		let malformed = 0;
		while (this.bufferedBytes >= CAMERA_FRAME_HEADER_BYTES) {
			if (!this.startsWithMagic()) {
				do {
					this.discard(1);
				} while (this.bufferedBytes >= frameMagic.length && !this.startsWithMagic());
				malformed += 1;
				continue;
			}
			const header = this.peek(CAMERA_FRAME_HEADER_BYTES);
			if (!header) break;
			const version = header.readUInt16LE(4);
			const headerBytes = header.readUInt16LE(6);
			const width = header.readUInt32LE(12);
			const height = header.readUInt32LE(16);
			const rowPitch = header.readUInt32LE(20);
			const payloadBytes = header.readUInt32LE(24);
			const valid =
				version === 1 &&
				headerBytes === CAMERA_FRAME_HEADER_BYTES &&
				width > 0 &&
				height > 0 &&
				rowPitch === width * 4 &&
				payloadBytes === rowPitch * height &&
				payloadBytes <= maximumPayloadBytes;
			if (!valid) {
				this.discard(4);
				malformed += 1;
				continue;
			}
			if (this.bufferedBytes < headerBytes + payloadBytes) break;
			this.discard(headerBytes);
			const pixels = this.read(payloadBytes);
			if (!pixels) break;
			frames.push({
				cameraId: unrealGuidToDigits(header, 96),
				cameraIndex: header.readUInt32LE(28),
				captureMonotonicMs: header.readDoubleLE(48),
				height,
				pixels: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
				producerId: unrealGuidToDigits(header, 64),
				readbackDrops: header.readUInt32LE(112),
				readbackLatencyMs: header.readDoubleLE(56),
				receivedMonotonicMs: performance.now(),
				sequence: header.readBigUInt64LE(32),
				sessionId: unrealGuidToDigits(header, 80),
				transportReplacements: header.readUInt32LE(116),
				width,
				worldSeconds: header.readDoubleLE(40)
			});
		}
		return { frames, malformed };
	}
}

/**
 * Live preview stream, latest frame per camera index and aggregate metrics. Latest frames
 * replace older previews; consumers requiring immutable history must capture explicitly.
 */
export interface CameraFeedApi {
	readonly frames: Stream.Stream<CameraFrame>;
	readonly latestFrames: Effect.Effect<ReadonlyMap<number, CameraFrame>>;
	readonly metrics: Effect.Effect<CameraFeedMetrics>;
}

/**
 * Scope-owned local preview reception service independent of editor control. Opening the
 * listener does not configure cameras or select a project.
 */
export class CameraFeed extends Context.Service<CameraFeed, CameraFeedApi>()(
	"@ue-shed/cameras/CameraFeed"
) {}

/**
 * Optional listener pipe name and delivery capacity. Capacity bounds preview buffering;
 * replacement metrics reveal frames skipped under backpressure.
 */
export interface CameraFeedOptions {
	readonly capacity?: number;
	readonly pipeName?: string;
}

interface AcquiredCameraFeed {
	readonly feed: CameraFeedApi;
	readonly pubsub: PubSub.PubSub<CameraFrame>;
	readonly server: Server;
	readonly sockets: Set<Socket>;
}

function listen(server: Server, pipeName: string): Effect.Effect<void, CameraFeedError> {
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					server.off("error", onError);
					server.off("listening", onListening);
					signal.removeEventListener("abort", onAbort);
				};
				const onAbort = () => {
					cleanup();
					try {
						server.close();
					} catch {
						// The server may not have started listening yet.
					}
					reject(signal.reason);
				};
				const onError = (cause: Error) => {
					cleanup();
					reject(cause);
				};
				const onListening = () => {
					cleanup();
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				signal.addEventListener("abort", onAbort, { once: true });
				server.listen(pipeName);
			}),
		catch: (cause) =>
			new CameraFeedError({
				message: `Could not listen on camera feed pipe ${pipeName}${
					cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE"
						? " because another process is already listening on it"
						: ""
				}.`,
				cause,
				nextStep: "retry",
				operation: "listen",
				pipeName,
				recovery:
					"Stop any other process listening on this camera feed pipe, then open the feed again.",
				retrySafe: true
			})
	});
}

function closeCameraFeed(resource: AcquiredCameraFeed): Effect.Effect<void> {
	return Effect.gen(function* () {
		for (const socket of resource.sockets) socket.destroy();
		yield* Effect.callback<void>((resume) => {
			if (!resource.server.listening) {
				resume(Effect.void);
				return;
			}
			resource.server.close(() => resume(Effect.void));
		});
		yield* PubSub.shutdown(resource.pubsub);
	});
}

function acquireCameraFeed(
	options: CameraFeedOptions
): Effect.Effect<AcquiredCameraFeed, CameraFeedError, Scope.Scope> {
	const pipeName = options.pipeName ?? CAMERA_PIPE_NAME;
	const capacity = options.capacity ?? 8;
	if (!Number.isInteger(capacity) || capacity <= 0) {
		return Effect.fail(
			new CameraFeedError({
				message: `Camera feed capacity must be a positive integer, received ${capacity}.`,
				nextStep: "fix_input",
				operation: "listen",
				pipeName,
				recovery:
					"Pass a positive integer camera feed capacity, or omit it to use the default.",
				retrySafe: false
			})
		);
	}
	return Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const pubsub = yield* PubSub.sliding<CameraFrame>(capacity);
		const latest = new Map<number, CameraFrame>();
		const sockets = new Set<Socket>();
		const startedMonotonicMs = performance.now();
		let bytesReceived = 0;
		let deliveryReplacements = 0;
		let framesReceived = 0;
		let malformedFrames = 0;
		let receiverReplacements = 0;
		let transportErrors = 0;
		const server = createServer((socket) => {
			sockets.add(socket);
			const decoder = new CameraFrameDecoder();
			socket.on("error", () => {
				transportErrors += 1;
			});
			socket.on("data", (chunk) => {
				bytesReceived += chunk.byteLength;
				const decoded = decoder.push(chunk);
				malformedFrames += decoded.malformed;
				for (const frame of decoded.frames) {
					if (latest.has(frame.cameraIndex)) receiverReplacements += 1;
					latest.set(frame.cameraIndex, frame);
					framesReceived += 1;
					Effect.runFork(
						Effect.forkIn(
							Effect.gen(function* () {
								if ((yield* PubSub.size(pubsub)) >= capacity) {
									deliveryReplacements += 1;
								}
								yield* PubSub.publish(pubsub, frame);
							}),
							scope
						)
					);
				}
			});
			socket.once("close", () => sockets.delete(socket));
		});
		yield* listen(server, pipeName);
		server.on("error", () => {
			transportErrors += 1;
		});
		return {
			feed: {
				frames: Stream.fromPubSub(pubsub),
				latestFrames: Effect.sync(() => new Map(latest)),
				metrics: Effect.sync(() => ({
					bytesReceived,
					deliveryReplacements,
					framesReceived,
					malformedFrames,
					receiverReplacements,
					startedMonotonicMs,
					transportErrors
				}))
			},
			pubsub,
			server,
			sockets
		} satisfies AcquiredCameraFeed;
	});
}

/**
 * Acquires a preview listener and attaches socket/server cleanup to layer scope release.
 * Fails with CameraFeedError on acquisition rather than returning an apparently connected
 * empty feed.
 */
export function cameraFeedLayer(
	options: CameraFeedOptions = {}
): Layer.Layer<CameraFeed, CameraFeedError> {
	return Layer.effect(
		CameraFeed,
		Effect.acquireRelease(acquireCameraFeed(options), closeCameraFeed).pipe(
			Effect.map((resource) => resource.feed)
		)
	);
}

/**
 * Default scoped named-pipe preview listener using CAMERA_PIPE_NAME. Host composition
 * controls its lifetime; it does not start camera streaming in Unreal.
 */
export const CameraFeedLive = cameraFeedLayer();

/**
 * Provides explicit preview effects with empty stream/map and zero metrics for omitted
 * observational fields. Does not open sockets or invoke an unstubbed editor operation.
 */
export function makeCameraFeedTestLayer(
	feed: Partial<CameraFeedApi> = {}
): Layer.Layer<CameraFeed> {
	return Layer.succeed(CameraFeed, {
		frames: feed.frames ?? Stream.empty,
		latestFrames: feed.latestFrames ?? Effect.succeed(new Map()),
		metrics:
			feed.metrics ??
			Effect.succeed({
				bytesReceived: 0,
				deliveryReplacements: 0,
				framesReceived: 0,
				malformedFrames: 0,
				receiverReplacements: 0,
				startedMonotonicMs: 0,
				transportErrors: 0
			})
	});
}

/**
 * Camera configure/status failure with endpoint/operation, optional producer code and
 * original cause. Unsupported options require a corrected request rather than an implicit
 * fallback.
 */
export class CameraControlError extends Schema.TaggedError<CameraControlError>()(
	"CameraControlError",
	{
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		endpoint: Schema.String,
		operation: Schema.Literals(["configure", "status"]),
		/** Stable failure category reported by the optional native camera plugin. */
		code: Schema.optionalKey(Schema.String),
		status: Schema.optional(Schema.Number)
	}
) {}

const isRemoteControlClientError = Schema.is(RemoteControlClientError);
const isCameraControlError = Schema.is(CameraControlError);
const decodeCameraControlResponse = Schema.decodeUnknownEffect(
	Schema.Union([CameraStatus, CameraControlFailure])
);

function cameraStatusOrFailure(endpoint: string, operation: "configure" | "status") {
	return (value: Schema.Json) =>
		decodeCameraControlResponse(value).pipe(
			Effect.flatMap((response) => {
				if (!("error" in response)) return Effect.succeed(response);
				const retrySafe = response.error === "no-renderable-world";
				const invalidInput = response.error.startsWith("invalid-");
				return Effect.fail(
					new CameraControlError({
						endpoint,
						operation,
						code: response.error,
						message:
							response.message ?? `The camera plugin reported ${response.error}.`,
						retrySafe,
						nextStep: retrySafe ? "retry" : invalidInput ? "fix_input" : "escalate",
						recovery: retrySafe
							? "Open an editor world, then retry the camera request."
							: invalidInput
								? "Check the camera configuration before retrying."
								: "Inspect the plugin failure and capability support before retrying."
					})
				);
			})
		);
}

function cameraControlError(
	endpoint: string,
	operation: "configure" | "status",
	cause: RemoteControlClientError | unknown
): CameraControlError {
	if (isCameraControlError(cause)) return cause;
	if (isRemoteControlClientError(cause)) {
		return new CameraControlError({
			endpoint: cause.endpoint,
			message: cause.message,
			nextStep: cause.nextStep,
			operation,
			recovery: cause.recovery,
			retrySafe: cause.retrySafe,
			cause,
			...(cause.status === undefined ? undefined : { status: cause.status })
		});
	}
	return new CameraControlError({
		endpoint,
		message: `The editor at ${endpoint} returned a camera ${operation} response that does not match this UE Shed version.`,
		nextStep: "escalate",
		operation,
		recovery:
			"Update the Core and Cameras plugins together so their response matches this UE Shed version.",
		retrySafe: false,
		cause
	});
}

const cameraRemoteCall = Effect.fn("CameraControl.remoteCall")(function* (
	endpoint: string,
	functionName: string,
	operation: "configure" | "status",
	parameters: Schema.JsonObject
) {
	const client = yield* RemoteControlClient;
	return yield* client
		.request({
			endpoint,
			functionName,
			objectPath: "/Script/UEShedCameras.Default__UEShedCameraLibrary",
			operation: `camera.control.${operation}`,
			idempotent: operation === "status",
			parameters
		})
		.pipe(Effect.mapError((error) => cameraControlError(endpoint, operation, error)));
});

/**
 * Reads the optional camera plugin's status at an explicit endpoint through
 * RemoteControlClient. Validates response/failure envelopes and does not enable streaming.
 */
export function getCameraStatus(
	endpoint: string
): Effect.Effect<CameraStatus, CameraControlError, RemoteControlClient> {
	return cameraRemoteCall(endpoint, "GetStatus", "status", {}).pipe(
		Effect.flatMap(cameraStatusOrFailure(endpoint, "status")),
		Effect.mapError((error) => cameraControlError(endpoint, "status", error))
	);
}

/**
 * Validates and explicitly applies camera scheduling policy through RemoteControlClient.
 * Rejects unsupported requested background-ticking behavior instead of claiming the
 * configuration was honored.
 */
export function configureCameras(
	endpoint: string,
	config: CameraScheduleConfig
): Effect.Effect<CameraStatus, CameraControlError, RemoteControlClient> {
	return Effect.gen(function* () {
		const validConfig = yield* decodeCameraScheduleConfig(config).pipe(
			Effect.mapError((error) => cameraControlError(endpoint, "configure", error))
		);
		const response = yield* cameraRemoteCall(endpoint, "Configure", "configure", {
			ConfigJson: JSON.stringify(validConfig)
		});
		const status = yield* cameraStatusOrFailure(endpoint, "configure")(response);
		if (
			config.editorBackgroundTicking === "while_streaming" &&
			status.config.editorBackgroundTicking !== "while_streaming"
		)
			return yield* Effect.fail(
				new CameraControlError({
					endpoint,
					operation: "configure",
					retrySafe: false,
					nextStep: "fix_input",
					recovery: "Update UEShedCameras or configure without interactive previews.",
					message:
						"This UEShedCameras plugin does not support scoped editor background ticking. Update the plugin before enabling interactive previews."
				})
			);
		return status;
	}).pipe(Effect.mapError((error) => cameraControlError(endpoint, "configure", error)));
}

export {
	inspectMapCaptureReadiness,
	inspectMapCaptureSelection,
	MapCaptureInspectionError,
	MapCaptureReadiness,
	MapCaptureSelection
} from "./map-capture-tools.js";
export {
	applyCameraArrangementCommand,
	approveArrangementCamera,
	ArrangementCamera,
	ArrangementCameraId,
	arrangementFailure,
	arrangementFitDistance,
	CameraArrangement,
	CameraArrangementCommand,
	CameraArrangementError,
	CameraArrangementGroup,
	CameraArrangementId,
	CameraArrangementOverrides,
	CameraArrangementRecipe,
	CameraArrangementSettings,
	CameraEditScope,
	cameraIdsInScope,
	CameraLayout,
	CameraOperationId,
	createCameraArrangementFromSelection,
	effectiveCameraArrangementSettings,
	effectiveCameraArrangementVisibility,
	exportCameraArrangementRecipe,
	importCameraArrangementRecipe,
	migrateLegacyCameraArrangement,
	previewArrangementRegeneration,
	proposeCameraLayout,
	resolveArrangementCamera
} from "./camera-arrangement.js";
export {
	CameraApproval,
	cameraApprovalBase,
	CameraAuthoringDocument,
	type CameraAuthoringStore,
	makeCameraAuthoringStore,
	readCameraArrangementRecipe,
	readCameraVisibilityPreset,
	writeCameraArrangementRecipe,
	writeCameraVisibilityPreset
} from "./camera-authoring-store.js";
export {
	CameraRecoveryChoice,
	CameraRecoveryProposal,
	inspectCameraRecovery,
	prepareCameraRecovery,
	resolveCameraRecovery,
	restoreCameraRecovery
} from "./camera-authoring-recovery.js";
export {
	arrangementBridgeCameras,
	attachArrangementCamera,
	type CameraAuthoringBridge,
	CameraBridgeCamera,
	CameraBridgeError,
	CameraBridgeFailureCode,
	CameraBridgeRequest,
	CameraBridgeResponse,
	CameraBridgeSnapshot,
	makeCameraAuthoringBridge,
	readyCameraBridge,
	synchronizeArrangementCamera
} from "./camera-authoring-bridge.js";
export {
	CameraSetupIntent,
	CameraSetupOpenIntent,
	CameraSetupOutcome,
	CameraSetupRequest,
	cameraSetupSavedSet,
	CameraSetupSavedSet,
	CameraSetupState
} from "./camera-setup-schema.js";
export { makeCameraSetupHost } from "./camera-setup-host.js";
export {
	cameraAuthoringPanelState,
	makeCameraAuthoringPanelSession
} from "./camera-authoring-panel.js";
export {
	CameraActorSelectionResult,
	CameraPanelAction,
	CameraPanelEvent,
	CameraPanelProposal,
	CameraPanelSelectionScope,
	CameraPanelState,
	CameraVisibilityResolutionResult
} from "./camera-authoring-panel-schema.js";
export {
	CameraActorEntry,
	cameraActorIdentity,
	CameraActorReference,
	CameraAuthoredVisibility,
	CameraVisibilityDiagnostic,
	CameraVisibilityList,
	CameraVisibilityOutput,
	CameraVisibilityPreset,
	mergeCameraVisibility
} from "./camera-visibility.js";

export { mapCaptureVisibilityVariants } from "./map-capture-visibility.js";
export { renderPreparedCamera } from "./prepared-camera.js";
