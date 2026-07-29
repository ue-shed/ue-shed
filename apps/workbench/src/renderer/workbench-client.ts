import {
	CameraStatus,
	decodeCameraStatus,
	decodeEditorPlaySessionCommandResponse,
	decodeEditorPlaySessionStateResponse,
	type CameraScheduleConfig,
	type EditorPlaySessionCommand,
	type EditorPlaySessionCommandResponse,
	type EditorPlaySessionStateResponse
} from "@ue-shed/protocol";
import { RuntimeHealth } from "@ue-shed/observability/health";
import { Effect, Exit, Queue, Schedule, Schema, Stream } from "effect";
import type {
	FixtureLaunchResult,
	RendererCameraFrame,
	ShowcaseContext,
	WorkbenchCameraMetrics
} from "../main/preload.js";
import {
	WorkbenchProjectState,
	type WorkbenchProjectState as WorkbenchProjectStateValue
} from "../main/project-workspace-contract.js";

export class WorkbenchRendererError extends Schema.TaggedErrorClass<WorkbenchRendererError>()(
	"WorkbenchRendererError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

const ShowcaseContextSchema = Schema.Struct({
	fixtureConfigured: Schema.Boolean,
	health: RuntimeHealth,
	projectRoot: Schema.optionalKey(Schema.String),
	reader: Schema.Literals(["configured", "path"]),
	ruleFile: Schema.optionalKey(Schema.String)
});
const FixtureLaunchResultSchema = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready") }),
	Schema.Struct({
		message: Schema.String,
		recovery: Schema.String,
		status: Schema.Literal("failed")
	})
]);
const WorkbenchCameraMetricsSchema = Schema.Struct({
	bytesReceived: Schema.Number,
	deliveryReplacements: Schema.Number,
	electronPrivateMemoryMb: Schema.Number,
	framesReceived: Schema.Number,
	gpuProcessPrivateMemoryMb: Schema.Number,
	malformedFrames: Schema.Number,
	presentationBudgetMbPerSecond: Schema.Number,
	presentationFramesSent: Schema.Number,
	presentationReplacements: Schema.Number,
	receiverReplacements: Schema.Number,
	startedMonotonicMs: Schema.Number,
	transportErrors: Schema.Number
});

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function request<A>(args: {
	readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
	readonly invoke: () => Promise<unknown>;
	readonly operation: string;
}): Effect.Effect<A, WorkbenchRendererError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) => new WorkbenchRendererError({ cause, operation: args.operation, recovery })
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) => new WorkbenchRendererError({ cause, operation: args.operation, recovery })
		)
	);
}

const decodeShowcaseContext = Schema.decodeUnknownEffect(ShowcaseContextSchema);
const decodeFixtureLaunchResult = Schema.decodeUnknownEffect(FixtureLaunchResultSchema);
const decodeWorkbenchCameraMetrics = Schema.decodeUnknownEffect(WorkbenchCameraMetricsSchema);
const decodePresentationBudget = Schema.decodeUnknownEffect(Schema.Number);
const decodeWorkbenchProjectState = Schema.decodeUnknownEffect(WorkbenchProjectState);

const getStatus = Effect.fn("WorkbenchRenderer.getStatus")(
	(): Effect.Effect<CameraStatus, WorkbenchRendererError> =>
		request({
			decode: decodeCameraStatus,
			invoke: () => window.ueShed.getStatus(),
			operation: "camera.getStatus"
		})
);

const getMetrics = Effect.fn("WorkbenchRenderer.getMetrics")(
	(): Effect.Effect<WorkbenchCameraMetrics, WorkbenchRendererError> =>
		request({
			decode: decodeWorkbenchCameraMetrics,
			invoke: () => window.ueShed.getMetrics(),
			operation: "camera.getMetrics"
		})
);

export interface WorkbenchRendererClient {
	readonly editorSessionStatus: () => Effect.Effect<
		EditorPlaySessionStateResponse,
		WorkbenchRendererError
	>;
	readonly executeEditorSessionCommand: (
		command: EditorPlaySessionCommand
	) => Effect.Effect<EditorPlaySessionCommandResponse, WorkbenchRendererError>;
	readonly editorSessionStatuses: Stream.Stream<
		Exit.Exit<EditorPlaySessionStateResponse, WorkbenchRendererError>
	>;
	readonly showcaseContext: () => Effect.Effect<ShowcaseContext, WorkbenchRendererError>;
	readonly configure: (
		config: CameraScheduleConfig
	) => Effect.Effect<CameraStatus, WorkbenchRendererError>;
	readonly frames: Stream.Stream<RendererCameraFrame>;
	readonly getMetrics: () => Effect.Effect<WorkbenchCameraMetrics, WorkbenchRendererError>;
	readonly getStatus: () => Effect.Effect<CameraStatus, WorkbenchRendererError>;
	readonly launchFixture: () => Effect.Effect<FixtureLaunchResult, WorkbenchRendererError>;
	readonly chooseProject: () => Effect.Effect<WorkbenchProjectStateValue, WorkbenchRendererError>;
	readonly project: () => Effect.Effect<WorkbenchProjectStateValue, WorkbenchRendererError>;
	readonly metrics: Stream.Stream<Exit.Exit<WorkbenchCameraMetrics, WorkbenchRendererError>>;
	readonly setPresentationBudget: (
		megabytesPerSecond: number
	) => Effect.Effect<number, WorkbenchRendererError>;
	readonly statuses: Stream.Stream<Exit.Exit<CameraStatus, WorkbenchRendererError>>;
}

export const workbenchRendererClient: WorkbenchRendererClient = {
	chooseProject: Effect.fn("WorkbenchRenderer.chooseProject")(() =>
		request({
			decode: decodeWorkbenchProjectState,
			invoke: () => window.ueShed.project.choose(),
			operation: "project.choose"
		})
	),
	editorSessionStatus: Effect.fn("WorkbenchRenderer.editorSessionStatus")(() =>
		request({
			decode: decodeEditorPlaySessionStateResponse,
			invoke: () => window.ueShed.editorSession.status(),
			operation: "editorSession.status"
		})
	),
	executeEditorSessionCommand: Effect.fn("WorkbenchRenderer.executeEditorSessionCommand")(
		(command) =>
			request({
				decode: decodeEditorPlaySessionCommandResponse,
				invoke: () => window.ueShed.editorSession.execute(command),
				operation: `editorSession.${command}`
			})
	),
	editorSessionStatuses: Stream.fromEffectSchedule(
		Effect.exit(
			request({
				decode: decodeEditorPlaySessionStateResponse,
				invoke: () => window.ueShed.editorSession.status(),
				operation: "editorSession.status"
			})
		),
		Schedule.spaced("750 millis")
	),
	showcaseContext: Effect.fn("WorkbenchRenderer.showcaseContext")(() =>
		request({
			decode: decodeShowcaseContext,
			invoke: () => window.ueShed.showcase.context(),
			operation: "showcase.context"
		})
	),
	configure: Effect.fn("WorkbenchRenderer.configure")((config) =>
		request({
			decode: decodeCameraStatus,
			invoke: () => window.ueShed.configure(config),
			operation: "camera.configure"
		})
	),
	frames: Stream.callback(
		(queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					window.ueShed.onFrame((frame) => Queue.offerUnsafe(queue, frame))
				),
				(unsubscribe) => Effect.sync(unsubscribe)
			),
		{ bufferSize: 32, strategy: "sliding" }
	),
	getMetrics,
	getStatus,
	launchFixture: Effect.fn("WorkbenchRenderer.launchFixture")(() =>
		request({
			decode: decodeFixtureLaunchResult,
			invoke: () => window.ueShed.fixture.launch(),
			operation: "fixture.launch"
		})
	),
	project: Effect.fn("WorkbenchRenderer.project")(() =>
		request({
			decode: decodeWorkbenchProjectState,
			invoke: () => window.ueShed.project.current(),
			operation: "project.current"
		})
	),
	metrics: Stream.fromEffectSchedule(Effect.exit(getMetrics()), Schedule.spaced("750 millis")),
	setPresentationBudget: Effect.fn("WorkbenchRenderer.setPresentationBudget")((value) =>
		request({
			decode: decodePresentationBudget,
			invoke: () => window.ueShed.setPresentationBudget(value),
			operation: "camera.setPresentationBudget"
		})
	),
	statuses: Stream.fromEffectSchedule(Effect.exit(getStatus()), Schedule.spaced("1 second"))
};
