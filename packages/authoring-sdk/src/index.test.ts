import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeAuthoringSessionIntent,
	decodeAuthoringSessionListResult,
	decodeAuthoringSessionReviewResult
} from "./index.js";

describe("authoring SDK contracts", () => {
	it("decodes host-neutral row intents", async () => {
		expect(
			await Effect.runPromise(
				decodeAuthoringSessionIntent({
					kind: "duplicate_row",
					rowName: "Beta",
					sessionId: "session-1",
					sourceRowId: "row:Alpha",
					tableObjectPath: "/Game/Data/DT_Test.DT_Test"
				})
			)
		).toMatchObject({ kind: "duplicate_row", sourceRowId: "row:Alpha" });
	});

	it("decodes complete session review results and rejects malformed projections", async () => {
		const result = {
			review: {
				activeCommandCount: 0,
				canRedo: false,
				canUndo: false,
				commandGroups: [],
				createdAt: "2026-07-16T00:00:00.000Z",
				lifecycle: "open",
				pipeline: { canApply: false, kind: "draft" },
				project: { id: "fixture", root: "C:/Fixture" },
				sessionId: "session-1",
				tables: [],
				updatedAt: "2026-07-16T00:00:00.000Z",
				validation: {
					diagnostics: [],
					errorCount: 0,
					valid: true,
					warningCount: 0
				}
			},
			status: "ready"
		};
		expect(await Effect.runPromise(decodeAuthoringSessionReviewResult(result))).toEqual(result);
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					decodeAuthoringSessionReviewResult({
						review: { tables: "bad" },
						status: "ready"
					})
				)
			)
		).toBe(true);
	});

	it("decodes recent persisted session summaries", async () => {
		const result = {
			diagnostics: [],
			sessions: [
				{
					commandCount: 3,
					createdAt: "2026-07-16T00:00:00.000Z",
					id: "session-1",
					lifecycle: "open",
					tableObjectPaths: ["/Game/Data/DT_Test.DT_Test"],
					undoPointer: 2,
					updatedAt: "2026-07-16T00:00:01.000Z"
				}
			],
			status: "ready"
		};
		expect(await Effect.runPromise(decodeAuthoringSessionListResult(result))).toEqual(result);
	});
});
