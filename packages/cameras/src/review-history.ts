import type { CapturedReviewViewRevision, ReviewViewRevisionId } from "./review-schema.js";

interface ReviewHistorySet {
	readonly views: ReadonlyArray<{
		readonly id: string;
		readonly revision: { readonly id: ReviewViewRevisionId };
	}>;
}

type ReviewHistoryResult =
	| {
			readonly status: "captured";
			readonly viewId: string;
			readonly viewRevision: CapturedReviewViewRevision;
	  }
	| {
			readonly message: string;
			readonly status: "failed";
			readonly viewId: string;
			readonly viewRevision: CapturedReviewViewRevision;
	  };

interface ReviewHistoryRun {
	readonly completedAt: string;
	readonly id: string;
	readonly results: ReadonlyArray<ReviewHistoryResult>;
}

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
	readonly reviewSet: ReviewHistorySet;
	readonly runs: ReadonlyArray<ReviewHistoryRun>;
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
