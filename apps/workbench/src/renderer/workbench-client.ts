import {
	CameraStatus,
	decodeCameraStatus,
	decodeEditorPlaySessionCommandResponse,
	type CameraScheduleConfig,
	type EditorPlaySessionCommand,
	type EditorPlaySessionCommandResponse,
	type EditorPlaySessionStateResponse
} from "@ue-shed/protocol";
import { RuntimeHealth } from "@ue-shed/observability/health";
import { Effect, Exit, Queue, Schedule, Schema, Stream } from "effect";
import type {
	ConfigExplorerQuery,
	ConfigExplorerQueryResult,
	EditorSessionStatusResult,
	FixtureLaunchResult,
	RendererCameraFrame,
	ShowcaseContext,
	UnrealConnectionSettings,
	WorkbenchCameraMetrics
} from "../main/preload.js";
import {
	ConfigExplorerQueryResult as ConfigExplorerQueryResultSchema,
	EditorSessionStatusResult as EditorSessionStatusResultSchema
} from "../main/ipc-contracts.js";
import {
	ProjectLaunchResult,
	type ProjectLaunchMode,
	type ProjectLaunchResult as ProjectLaunchResultValue,
	WorkbenchProjectState,
	type WorkbenchProjectState as WorkbenchProjectStateValue,
	WorkbenchTaskProgress,
	type WorkbenchTaskProgress as WorkbenchTaskProgressValue
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
	project: Schema.Union([
		Schema.Struct({ status: Schema.Literal("not_configured") }),
		Schema.Struct({
			message: Schema.NonEmptyString,
			recovery: Schema.NonEmptyString,
			status: Schema.Literal("failed")
		}),
		Schema.Struct({
			candidates: Schema.Union([
				Schema.Struct({
					dataTablePackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
					enhancedInputPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
					gameTextPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
					status: Schema.Literal("ready"),
					texturePackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
				}),
				Schema.Struct({
					message: Schema.NonEmptyString,
					recovery: Schema.NonEmptyString,
					status: Schema.Literal("failed")
				})
			]),
			mapCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			packageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			projectName: Schema.NonEmptyString,
			projectRoot: Schema.NonEmptyString,
			status: Schema.Literal("ready")
		})
	]),
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
const decodeConfigExplorerQueryResult = Schema.decodeUnknownEffect(ConfigExplorerQueryResultSchema);
const decodeEditorSessionStatusResult = Schema.decodeUnknownEffect(EditorSessionStatusResultSchema);
const decodeFixtureLaunchResult = Schema.decodeUnknownEffect(FixtureLaunchResultSchema);
const decodeWorkbenchCameraMetrics = Schema.decodeUnknownEffect(WorkbenchCameraMetricsSchema);
const decodePresentationBudget = Schema.decodeUnknownEffect(Schema.Number);
const decodeWorkbenchProjectState = Schema.decodeUnknownEffect(WorkbenchProjectState);
const decodeProjectLaunchResult = Schema.decodeUnknownEffect(ProjectLaunchResult);
const decodeWorkbenchTaskProgress = Schema.decodeUnknownEffect(WorkbenchTaskProgress);
const decodeUnrealConnectionSettings = Schema.decodeUnknownEffect(
	Schema.Struct({
		port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535))
	})
);
const decodeCameraStatusResult = Schema.decodeUnknownEffect(
	Schema.Union([
		Schema.Struct({ camera: CameraStatus, status: Schema.Literal("ready") }),
		Schema.Struct({
			message: Schema.NonEmptyString,
			recovery: Schema.NonEmptyString,
			status: Schema.Literal("unavailable")
		})
	])
);

export function editorSessionStateFromResult(
	result: EditorSessionStatusResult
): Effect.Effect<EditorPlaySessionStateResponse, WorkbenchRendererError> {
	return result.status === "ready"
		? Effect.succeed(result.session)
		: Effect.fail(
				new WorkbenchRendererError({
					cause: result.error,
					operation: result.error.operation,
					recovery: result.error.recovery
				})
			);
}

const getEditorSessionStatus = Effect.fn("WorkbenchRenderer.editorSessionStatus")(
	(): Effect.Effect<EditorPlaySessionStateResponse, WorkbenchRendererError> =>
		request({
			decode: decodeEditorSessionStatusResult,
			invoke: () => window.ueShed.editorSession.status(),
			operation: "editorSession.status"
		}).pipe(Effect.flatMap(editorSessionStateFromResult))
);

const getStatus = Effect.fn("WorkbenchRenderer.getStatus")(
	(): Effect.Effect<CameraStatus, WorkbenchRendererError> =>
		request({
			decode: decodeCameraStatusResult,
			invoke: () => window.ueShed.getStatus(),
			operation: "camera.getStatus"
		}).pipe(
			Effect.flatMap((result) =>
				result.status === "ready"
					? Effect.succeed(result.camera)
					: Effect.fail(
							new WorkbenchRendererError({
								cause: result.message,
								operation: "camera.getStatus",
								recovery: result.recovery
							})
						)
			)
		)
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
	readonly configExplorerQuery: (
		request: ConfigExplorerQuery
	) => Effect.Effect<ConfigExplorerQueryResult, WorkbenchRendererError>;
	readonly unrealConnectionSettings: () => Effect.Effect<
		UnrealConnectionSettings,
		WorkbenchRendererError
	>;
	readonly setUnrealConnectionPort: (
		port: number
	) => Effect.Effect<UnrealConnectionSettings, WorkbenchRendererError>;
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
	readonly launchProject: (
		mode: ProjectLaunchMode
	) => Effect.Effect<ProjectLaunchResultValue, WorkbenchRendererError>;
	readonly chooseProject: () => Effect.Effect<WorkbenchProjectStateValue, WorkbenchRendererError>;
	readonly project: () => Effect.Effect<WorkbenchProjectStateValue, WorkbenchRendererError>;
	readonly projectProgress: () => Effect.Effect<
		WorkbenchTaskProgressValue,
		WorkbenchRendererError
	>;
	readonly metrics: Stream.Stream<Exit.Exit<WorkbenchCameraMetrics, WorkbenchRendererError>>;
	readonly setPresentationBudget: (
		megabytesPerSecond: number
	) => Effect.Effect<number, WorkbenchRendererError>;
	readonly statuses: Stream.Stream<Exit.Exit<CameraStatus, WorkbenchRendererError>>;
}

export const workbenchRendererClient: WorkbenchRendererClient = {
	configExplorerQuery: Effect.fn("WorkbenchRenderer.configExplorerQuery")((query) =>
		request({
			decode: decodeConfigExplorerQueryResult,
			invoke: () => window.ueShed.configExplorer.query(query),
			operation: "configExplorer.query"
		})
	),
	chooseProject: Effect.fn("WorkbenchRenderer.chooseProject")(() =>
		request({
			decode: decodeWorkbenchProjectState,
			invoke: () => window.ueShed.project.choose(),
			operation: "project.choose"
		})
	),
	editorSessionStatus: getEditorSessionStatus,
	executeEditorSessionCommand: Effect.fn("WorkbenchRenderer.executeEditorSessionCommand")(
		(command) =>
			request({
				decode: decodeEditorPlaySessionCommandResponse,
				invoke: () => window.ueShed.editorSession.execute(command),
				operation: `editorSession.${command}`
			})
	),
	editorSessionStatuses: Stream.fromEffectSchedule(
		Effect.exit(getEditorSessionStatus()),
		Schedule.spaced("750 millis")
	),
	unrealConnectionSettings: Effect.fn("WorkbenchRenderer.unrealConnectionSettings")(() =>
		request({
			decode: decodeUnrealConnectionSettings,
			invoke: () => window.ueShed.editorSession.settings(),
			operation: "editorSession.settings"
		})
	),
	setUnrealConnectionPort: Effect.fn("WorkbenchRenderer.setUnrealConnectionPort")((port) =>
		request({
			decode: decodeUnrealConnectionSettings,
			invoke: () => window.ueShed.editorSession.setPort(port),
			operation: "editorSession.setPort"
		})
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
	launchProject: Effect.fn("WorkbenchRenderer.launchProject")((mode) =>
		request({
			decode: decodeProjectLaunchResult,
			invoke: () => window.ueShed.project.launch(mode),
			operation: `project.launch.${mode}`
		})
	),
	project: Effect.fn("WorkbenchRenderer.project")(() =>
		request({
			decode: decodeWorkbenchProjectState,
			invoke: () => window.ueShed.project.current(),
			operation: "project.current"
		})
	),
	projectProgress: Effect.fn("WorkbenchRenderer.projectProgress")(() =>
		request({
			decode: decodeWorkbenchTaskProgress,
			invoke: () => window.ueShed.project.progress(),
			operation: "project.progress"
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
