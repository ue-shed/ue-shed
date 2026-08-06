import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import {
	ArtifactId,
	CaptureRunId,
	FramingCandidateId,
	ReviewAuthoringSessionId,
	ReviewViewId,
	ReviewViewRevisionId
} from "@ue-shed/cameras";
import type {
	MapReviewAuthoringRoundtripDriver,
	MapReviewFlowCheckpointSink,
	MapReviewFlowStepEvidence
} from "./map-review-flow.js";
import { MapReviewFlowExecutionError, runMapReviewAuthoringRoundtrip } from "./map-review-flow.js";

const noEvidence = (): Effect.Effect<MapReviewFlowStepEvidence, MapReviewFlowExecutionError> =>
	Effect.succeed({});

function makeDriver(
	overrides: Partial<MapReviewAuthoringRoundtripDriver> = {}
): MapReviewAuthoringRoundtripDriver {
	return {
		approveView: () =>
			Effect.succeed({ identity: { viewId: ReviewViewId.make("fixture-view") } }),
		captureView: () =>
			Effect.succeed({
				identity: {
					artifactId: ArtifactId.make("artifact-1"),
					runId: CaptureRunId.make("run-1")
				}
			}),
		cleanup: () =>
			Effect.succeed({
				mapDirtyAfter: false,
				provisionedCameraCountAfter: 0,
				status: "verified" as const
			}),
		generateRig: () =>
			Effect.succeed({
				identity: {
					candidateId: FramingCandidateId.make("preset/context-three-quarter/0")
				}
			}),
		inspectEvidence: noEvidence,
		loadView: () =>
			Effect.succeed({
				identity: { viewRevisionId: ReviewViewRevisionId.make("fixture-view-r1") }
			}),
		prepareFixture: noEvidence,
		previewCandidate: noEvidence,
		relaunchWorkbench: noEvidence,
		selectSubject: noEvidence,
		tuneRig: noEvidence,
		verifyPersistence: () =>
			Effect.succeed({
				identity: { sessionId: ReviewAuthoringSessionId.make("fixture-session") }
			}),
		...overrides
	};
}

describe("Map Review authoring round-trip flow", () => {
	it.effect("sends test and recording sinks the same ordered identity-linked checkpoints", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(1_786_010_400_000);
			const first = yield* Ref.make<ReadonlyArray<string>>([]);
			const second = yield* Ref.make<ReadonlyArray<string>>([]);
			const makeSink = (
				target: Ref.Ref<ReadonlyArray<string>>
			): MapReviewFlowCheckpointSink => ({
				checkpoint: (checkpoint) =>
					Ref.update(target, (ids) => [
						...ids,
						`${checkpoint.id}:${checkpoint.identity.sessionId ?? "pending"}`
					])
			});

			for (const sink of [makeSink(first), makeSink(second)]) {
				yield* runMapReviewAuthoringRoundtrip({ driver: makeDriver(), sink });
			}

			const expected = [
				"fixture-ready:pending",
				"subject-selected:pending",
				"rig-generated:pending",
				"rig-tuned:pending",
				"candidate-previewed:pending",
				"view-approved:pending",
				"persistence-verified:fixture-session",
				"workbench-restarted:fixture-session",
				"view-loaded:fixture-session",
				"capture-completed:fixture-session",
				"evidence-inspected:fixture-session",
				"cleanup-verified:fixture-session"
			];
			expect(yield* Ref.get(first)).toEqual(expected);
			expect(yield* Ref.get(second)).toEqual(expected);
		})
	);

	it.effect("runs cleanup after a typed mid-flow failure and omits later checkpoints", () =>
		Effect.gen(function* () {
			const observed = yield* Ref.make<ReadonlyArray<string>>([]);
			const result = yield* Effect.exit(
				runMapReviewAuthoringRoundtrip({
					driver: makeDriver({
						previewCandidate: () =>
							Effect.fail(
								new MapReviewFlowExecutionError({
									message: "Preview failed",
									operation: "previewCandidate"
								})
							)
					}),
					sink: {
						checkpoint: (checkpoint) =>
							Ref.update(observed, (ids) => [...ids, checkpoint.id])
					}
				})
			);

			expect(result._tag).toBe("Failure");
			expect(yield* Ref.get(observed)).toEqual([
				"fixture-ready",
				"subject-selected",
				"rig-generated",
				"rig-tuned",
				"cleanup-verified"
			]);
		})
	);
});
