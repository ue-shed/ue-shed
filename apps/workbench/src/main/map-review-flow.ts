import { Clock, Effect, Schema } from "effect";
import type {
	MapReviewFlowAttachment,
	MapReviewFlowCheckpoint,
	MapReviewFlowCleanup,
	MapReviewFlowIdentity
} from "./map-review-flow-contract.js";

/**
 * Test/recording orchestration shared by Playwright adapters. It deliberately contains no
 * Workbench implementation authority and is not imported by the production composition root.
 */

export class MapReviewFlowExecutionError extends Schema.TaggedErrorClass<MapReviewFlowExecutionError>()(
	"MapReviewFlowExecutionError",
	{
		message: Schema.NonEmptyString,
		operation: Schema.NonEmptyString
	}
) {}

export interface MapReviewFlowStepEvidence {
	readonly attachments?: ReadonlyArray<MapReviewFlowAttachment>;
	readonly identity?: MapReviewFlowIdentity;
}

type FlowStep = () => Effect.Effect<MapReviewFlowStepEvidence, MapReviewFlowExecutionError>;

export interface MapReviewAuthoringRoundtripDriver {
	readonly approveView: FlowStep;
	readonly captureView: FlowStep;
	readonly cleanup: () => Effect.Effect<MapReviewFlowCleanup>;
	readonly generateRig: FlowStep;
	readonly inspectEvidence: FlowStep;
	readonly loadView: FlowStep;
	readonly prepareFixture: FlowStep;
	readonly previewCandidate: FlowStep;
	readonly relaunchWorkbench: FlowStep;
	readonly selectSubject: FlowStep;
	readonly tuneRig: FlowStep;
	readonly verifyPersistence: FlowStep;
}

export interface MapReviewFlowCheckpointSink {
	readonly checkpoint: (
		checkpoint: MapReviewFlowCheckpoint
	) => Effect.Effect<void, MapReviewFlowExecutionError>;
}

const checkpointDescriptions = {
	"candidate-previewed": {
		description: "The tuned candidate is visible through a real Unreal preview.",
		title: "Preview the tuned candidate"
	},
	"capture-completed": {
		description: "The loaded Review View produced immutable Unreal capture evidence.",
		title: "Capture the persisted view"
	},
	"cleanup-verified": {
		description: "Transient cameras are cleared and the fixture map remains clean.",
		title: "Verify cleanup"
	},
	"evidence-inspected": {
		description: "The captured image and its identity-linked evidence are inspectable.",
		title: "Inspect capture evidence"
	},
	"fixture-ready": {
		description: "The deterministic Map Review fixture is loaded and ready.",
		title: "Prepare the fixture"
	},
	"persistence-verified": {
		description: "The approved recipe and View exist on disk before restart.",
		title: "Verify durable state"
	},
	"rig-generated": {
		description: "The selected subject produced the requested modular framing rig.",
		title: "Generate the camera rig"
	},
	"rig-tuned": {
		description: "Rig parameters and one candidate-specific override are applied.",
		title: "Tune the framing"
	},
	"subject-selected": {
		description: "A contract-named fixture subject is selected in the live editor.",
		title: "Select the review subject"
	},
	"view-approved": {
		description: "The chosen candidate is approved as a durable Review View.",
		title: "Keep the selected view"
	},
	"view-loaded": {
		description: "Workbench loads the same persisted View and revision after restart.",
		title: "Load the persisted view"
	},
	"workbench-restarted": {
		description: "Workbench is closed and relaunched against the same durable roots.",
		title: "Restart Workbench"
	}
} as const;

function mergeIdentity(
	current: MapReviewFlowIdentity,
	next: MapReviewFlowIdentity | undefined
): MapReviewFlowIdentity {
	return next === undefined ? current : { ...current, ...next };
}

export const runMapReviewAuthoringRoundtrip = Effect.fn("MapReviewFlow.runAuthoringRoundtrip")(
	function* (args: {
		readonly driver: MapReviewAuthoringRoundtripDriver;
		readonly sink: MapReviewFlowCheckpointSink;
	}) {
		let identity: MapReviewFlowIdentity = {};

		const runStep = Effect.fn("MapReviewFlow.runStep")(function* (
			id: Exclude<keyof typeof checkpointDescriptions, "cleanup-verified">,
			action: FlowStep
		) {
			const evidence = yield* action();
			identity = mergeIdentity(identity, evidence.identity);
			const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
			const copy = checkpointDescriptions[id];
			yield* args.sink.checkpoint({
				attachments: evidence.attachments ?? [],
				completedAt,
				description: copy.description,
				id,
				identity,
				title: copy.title
			});
		});

		const flow = Effect.gen(function* () {
			yield* runStep("fixture-ready", args.driver.prepareFixture);
			yield* runStep("subject-selected", args.driver.selectSubject);
			yield* runStep("rig-generated", args.driver.generateRig);
			yield* runStep("rig-tuned", args.driver.tuneRig);
			yield* runStep("candidate-previewed", args.driver.previewCandidate);
			yield* runStep("view-approved", args.driver.approveView);
			yield* runStep("persistence-verified", args.driver.verifyPersistence);
			yield* runStep("workbench-restarted", args.driver.relaunchWorkbench);
			yield* runStep("view-loaded", args.driver.loadView);
			yield* runStep("capture-completed", args.driver.captureView);
			yield* runStep("evidence-inspected", args.driver.inspectEvidence);
		});

		return yield* flow.pipe(
			Effect.onExit(() =>
				Effect.gen(function* () {
					const cleanup = yield* args.driver.cleanup();
					const copy = checkpointDescriptions["cleanup-verified"];
					yield* args.sink.checkpoint({
						attachments: [],
						completedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
						description: copy.description,
						id: "cleanup-verified",
						identity,
						title: copy.title
					});
					if (cleanup.status === "failed") {
						yield* new MapReviewFlowExecutionError({
							message: cleanup.message,
							operation: "cleanup"
						});
					}
				})
			)
		);
	}
);
