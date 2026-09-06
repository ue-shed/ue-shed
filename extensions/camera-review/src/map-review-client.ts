import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewApplyVisibilityPolicyIntent,
	MapReviewReplaceVisibilityPolicyIntent,
	MapReviewCandidatePreviewResult,
	MapReviewResult,
	MapReviewSetCreateIntent,
	MapReviewSetLibraryResult,
	MapReviewSetSelectIntent
} from "@ue-shed/cameras/review-contracts";
import type {
	ActorId,
	WorldIndexedTransform,
	WorldObservationState,
	WorldScoutFocusResult,
	WorldScoutRefreshRate,
	WorldScoutResult
} from "@ue-shed/observatory/browser";
import type {
	SavedWorld,
	SavedWorldChoice,
	SavedWorldMap,
	SavedWorldProgress
} from "@ue-shed/protocol";
import { Context, type Effect, Schema, type Stream } from "effect";

/** Renderer presentation state plus the sparse IPC batch that produced its latest transform tick. */
export type MapReviewWorldObservation = WorldObservationState & {
	readonly changedTransforms?: ReadonlyArray<WorldIndexedTransform>;
};

export type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringCandidate,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureCompletedJob,
	MapReviewCaptureJobState,
	MapReviewCapturePlanView,
	MapReviewCaptureResult,
	MapReviewApplyVisibilityPolicyIntent,
	MapReviewReplaceVisibilityPolicyIntent,
	MapReviewCandidatePreviewResult,
	MapReviewPose,
	MapReviewResult,
	MapReviewRunView,
	MapReviewSetCreateIntent,
	MapReviewSetLibraryResult,
	MapReviewSetSelectIntent,
	MapReviewSetSummary
} from "@ue-shed/cameras/review-contracts";

export class MapReviewClientError extends Schema.TaggedErrorClass<MapReviewClientError>()(
	"MapReviewClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface MapReviewClientApi {
	/** Optional while older hosts adopt saved-map support. This source is never an editor session. */
	readonly readSavedWorld?: (mapPath: string) => Effect.Effect<SavedWorld, MapReviewClientError>;
	readonly savedWorldMaps?: () => Effect.Effect<readonly SavedWorldMap[], MapReviewClientError>;
	readonly savedWorldProgress?: () => Effect.Effect<SavedWorldProgress, MapReviewClientError>;
	/** Chooses the app-wide project, then returns its cached saved-map inventory. */
	readonly chooseProjectAndMaps?: () => Effect.Effect<SavedWorldChoice, MapReviewClientError>;
	readonly connectWorld: () => Effect.Effect<WorldScoutResult, MapReviewClientError>;
	readonly focusActor: (
		actorId: ActorId,
		bringToFront: boolean
	) => Effect.Effect<WorldScoutFocusResult, MapReviewClientError>;
	readonly worldObservations: (
		refreshRate: WorldScoutRefreshRate
	) => Stream.Stream<MapReviewWorldObservation>;
	readonly setWorldObservationRate?: (
		refreshRate: WorldScoutRefreshRate
	) => Effect.Effect<WorldScoutRefreshRate, MapReviewClientError>;
	readonly approveCandidate: (
		intent: MapReviewApproveCandidateIntent
	) => Effect.Effect<MapReviewApprovalResult, MapReviewClientError>;
	readonly authorFromSelection: (
		intent: MapReviewAuthorFromSelectionIntent
	) => Effect.Effect<MapReviewAuthoringResult, MapReviewClientError>;
	readonly authoringResume: () => Effect.Effect<MapReviewAuthoringResult, MapReviewClientError>;
	readonly authoringPatch: (
		intent: MapReviewAuthoringPatchIntent
	) => Effect.Effect<MapReviewAuthoringResult, MapReviewClientError>;
	readonly authoringReframe: (
		intent: MapReviewAuthoringSessionIntent
	) => Effect.Effect<MapReviewAuthoringResult, MapReviewClientError>;
	readonly discardAuthoring: (
		intent: MapReviewAuthoringSessionIntent
	) => Effect.Effect<MapReviewAuthoringResult, MapReviewClientError>;
	readonly previewAuthoringCandidate: (
		intent: MapReviewAuthoringPreviewIntent
	) => Effect.Effect<MapReviewCandidatePreviewResult, MapReviewClientError>;
	readonly approveAuthoring: (
		intent: MapReviewAuthoringSessionIntent
	) => Effect.Effect<MapReviewApprovalResult, MapReviewClientError>;
	readonly capture: (
		intent: MapReviewCaptureIntent
	) => Effect.Effect<MapReviewCaptureResult, MapReviewClientError>;
	readonly applyVisibilityPolicy?: (
		intent: MapReviewApplyVisibilityPolicyIntent
	) => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly replaceVisibilityPolicy?: (
		intent: MapReviewReplaceVisibilityPolicyIntent
	) => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly reviewSetLibrary: () => Effect.Effect<MapReviewSetLibraryResult, MapReviewClientError>;
	readonly createReviewSet: (
		intent: MapReviewSetCreateIntent
	) => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly selectReviewSet: (
		intent: MapReviewSetSelectIntent
	) => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly load: () => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly previewCandidate: (
		candidateId: string
	) => Effect.Effect<MapReviewCandidatePreviewResult, MapReviewClientError>;
	readonly liveFrames: Stream.Stream<MapReviewLiveFrame>;
	/** Cheap capability probe used to promote cached PNG previews after Unreal reconnects. */
	readonly livePreviewAvailable?: () => Effect.Effect<boolean, MapReviewClientError>;
	readonly setLivePreviewFps: (fps: number) => Effect.Effect<number, MapReviewClientError>;
}

export interface MapReviewLiveFrame {
	readonly cameraIndex: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly width: number;
}

export class MapReviewClient extends Context.Service<MapReviewClient, MapReviewClientApi>()(
	"@ue-shed/extension-camera-review/MapReviewClient"
) {}
