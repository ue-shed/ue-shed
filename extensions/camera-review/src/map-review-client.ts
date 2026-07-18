import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringResult,
	MapReviewCandidatePreviewResult,
	MapReviewResult
} from "@ue-shed/cameras/review-contracts";
import type {
	ActorId,
	WorldScoutFocusResult,
	WorldScoutRefreshRate,
	WorldScoutResult
} from "@ue-shed/observatory";
import { Context, type Effect, Schema, type Stream } from "effect";

export type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringCandidate,
	MapReviewAuthoringResult,
	MapReviewCandidatePreviewResult,
	MapReviewPose,
	MapReviewResult,
	MapReviewRunView
} from "@ue-shed/cameras/review-contracts";

export class MapReviewClientError extends Schema.TaggedErrorClass<MapReviewClientError>()(
	"MapReviewClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface MapReviewClientShape {
	readonly connectWorld: () => Effect.Effect<WorldScoutResult, MapReviewClientError>;
	readonly focusActor: (
		actorId: ActorId,
		bringToFront: boolean
	) => Effect.Effect<WorldScoutFocusResult, MapReviewClientError>;
	readonly worldSnapshots: (
		refreshRate: WorldScoutRefreshRate
	) => Stream.Stream<WorldScoutResult>;
	readonly approveCandidate: (
		intent: MapReviewApproveCandidateIntent
	) => Effect.Effect<MapReviewApprovalResult, MapReviewClientError>;
	readonly authorFromSelection: () => Effect.Effect<
		MapReviewAuthoringResult,
		MapReviewClientError
	>;
	readonly capture: () => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly load: () => Effect.Effect<MapReviewResult, MapReviewClientError>;
	readonly previewCandidate: (
		candidateId: string
	) => Effect.Effect<MapReviewCandidatePreviewResult, MapReviewClientError>;
}

export class MapReviewClient extends Context.Service<MapReviewClient, MapReviewClientShape>()(
	"@ue-shed/extension-camera-review/MapReviewClient"
) {}
