import type {
	CapturedReviewViewRevision,
	CaptureRun,
	ReviewSet,
	ReviewViewRevisionId
} from "./review-schema.js";

export type ReviewViewHistoryEntry =
	| {
			readonly completedAt: string;
			readonly runId: string;
			readonly status: "missing";
	  }
	| {
			readonly completedAt: string;
			readonly runId: string;
			readonly status: "captured";
			readonly viewRevision: CapturedReviewViewRevision;
	  }
	| {
			readonly completedAt: string;
			readonly message: string;
			readonly runId: string;
			readonly status: "failed";
			readonly viewRevision: CapturedReviewViewRevision;
	  };

export interface ReviewViewHistory {
	readonly currentRevisionId: ReviewViewRevisionId;
	readonly entries: ReadonlyArray<ReviewViewHistoryEntry>;
	readonly viewId: string;
}

/**
 * Projects immutable runs around their durable View anchors. A run that predates or omits a View
 * remains visible as missing; no evidence is rewritten or inferred as a capture.
 */
export function projectReviewViewHistory(args: {
	readonly reviewSet: ReviewSet;
	readonly runs: ReadonlyArray<CaptureRun>;
}): ReadonlyArray<ReviewViewHistory> {
	return args.reviewSet.views.map((view) => ({
		currentRevisionId: view.revision.id,
		entries: args.runs.map((run): ReviewViewHistoryEntry => {
			const result = run.results.find((candidate) => candidate.viewId === view.id);
			if (result === undefined) {
				return { completedAt: run.completedAt, runId: run.id, status: "missing" };
			}
			return result.status === "captured"
				? {
						completedAt: run.completedAt,
						runId: run.id,
						status: "captured",
						viewRevision: result.viewRevision
					}
				: {
						completedAt: run.completedAt,
						message: result.message,
						runId: run.id,
						status: "failed",
						viewRevision: result.viewRevision
					};
		}),
		viewId: view.id
	}));
}
