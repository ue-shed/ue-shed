import { describe, expect, it } from "vitest";
import {
	CaptureProfileId,
	ReviewSetId,
	ReviewViewId,
	ReviewViewRevisionId
} from "./review-schema.js";
import { projectReviewViewHistory } from "./review-history.js";

describe("projectReviewViewHistory", () => {
	it("keeps captured, failed, missing, and older-revision states per View", () => {
		const reviewSet = {
			captureProfiles: [],
			contract: { name: "ue-shed-review-set", version: { major: 1, minor: 1 } },
			displayName: "History",
			id: ReviewSetId.make("history"),
			project: { id: "fixture", mapPath: "/Game/Fixture" },
			views: [
				{
					captureProfileId: CaptureProfileId.make("profile"),
					displayName: "Subject",
					id: ReviewViewId.make("subject"),
					revision: {
						id: ReviewViewRevisionId.make("subject-r2"),
						number: 2,
						status: "numbered"
					}
				}
			],
			visibilityPolicies: []
		};
		const result = (args: {
			readonly revision: number;
			readonly status: "captured" | "failed";
		}) => {
			const view = {
				viewId: ReviewViewId.make("subject"),
				viewRevision: {
					id: ReviewViewRevisionId.make(`subject-r${args.revision}`),
					number: args.revision,
					status: "numbered" as const
				}
			};
			return args.status === "captured"
				? {
						...view,
						artifacts: [],
						captureDurationMs: 1,
						clearCompanion: { status: "not_requested" as const },
						realization: {},
						status: "captured" as const,
						visibility: { reason: "fixture", status: "not_assessed" as const }
					}
				: {
						...view,
						code: "subject_missing",
						message: "Missing",
						recovery: "Restore",
						retrySafe: true,
						status: "failed" as const
					};
		};
		const run = (id: string, results: ReadonlyArray<ReturnType<typeof result>>) => ({
			completedAt: id,
			id,
			results
		});
		const [history] = projectReviewViewHistory({
			reviewSet,
			runs: [
				run("new", [result({ revision: 2, status: "captured" })]),
				run("failed", [result({ revision: 1, status: "failed" })]),
				run("old", [result({ revision: 1, status: "captured" })]),
				run("predates", [])
			]
		});

		expect(history?.currentRevisionId).toBe("subject-r2");
		expect(history?.entries.map((entry) => entry.status)).toEqual([
			"captured",
			"failed",
			"captured",
			"missing"
		]);
		expect(history?.entries[2]).toMatchObject({
			viewRevision: { id: "subject-r1", number: 1 }
		});
	});
});
