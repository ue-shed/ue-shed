import { Schema } from "effect";

export const CameraId = Schema.String.pipe(Schema.brand("CameraId"));
export type CameraId = Schema.Schema.Type<typeof CameraId>;

export const CameraScheduleConfig = Schema.Struct({
	editorBackgroundTicking: Schema.optional(Schema.Literals(["inherit", "while_streaming"])),
	activeCameraCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
	backgroundFps: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 30 })),
	captureBudgetPerTick: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
	focusedCameraIndex: Schema.NullOr(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 }))
	),
	focusedFps: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 60 })),
	paused: Schema.Boolean,
	pipelineMode: Schema.Literals(["full_pipeline", "render_only", "schedule_only"]),
	renderProfile: Schema.Literals(["full_fidelity", "observation"]),
	resolution: Schema.Literals([
		"160x90",
		"320x180",
		"640x360",
		"960x540",
		"1280x720",
		"1920x1080",
		"2560x1440"
	]),
	viewMode: Schema.Literals(["overview", "actor_pov", "posed"])
}).annotate({ identifier: "CameraScheduleConfig" });
export type CameraScheduleConfig = Schema.Schema.Type<typeof CameraScheduleConfig>;

export const CameraStreamStats = Schema.Struct({
	bytesSent: Schema.Number,
	captureBatchesSubmitted: Schema.Number,
	cadenceIntervalsSkipped: Schema.Number,
	camerasDue: Schema.Number,
	capturesRequested: Schema.Number,
	experimentBytesSent: Schema.Number,
	experimentCadenceIntervalsSkipped: Schema.Number,
	experimentElapsedMs: Schema.Number,
	experimentFramesDelivered: Schema.Number,
	experimentReadbackDrops: Schema.Number,
	experimentReadbackResourcesCreated: Schema.Number,
	experimentReadbacksEnqueued: Schema.Number,
	experimentRenderedCaptures: Schema.Number,
	experimentRevision: Schema.Number,
	experimentSchedulerTicks: Schema.Number,
	experimentScheduledCaptures: Schema.Number,
	experimentTransportReplacements: Schema.Number,
	framesDelivered: Schema.Number,
	lastCaptureBatchSize: Schema.Number,
	lastCaptureBatchSubmissionMs: Schema.Number,
	maxCaptureBatchSize: Schema.Number,
	maxCaptureBatchSubmissionMs: Schema.Number,
	maxCaptureLatenessMs: Schema.Number,
	pipeConnected: Schema.Boolean,
	readbackDrops: Schema.Number,
	readbackResourcesCreated: Schema.Number,
	schedulerTicks: Schema.Number,
	totalCaptureBatchSubmissionMs: Schema.Number,
	totalCaptureLatenessMs: Schema.Number,
	transportReplacements: Schema.Number
}).annotate({ identifier: "CameraStreamStats" });
export type CameraStreamStats = Schema.Schema.Type<typeof CameraStreamStats>;

export const CameraDescriptor = Schema.Struct({
	cameraId: CameraId,
	displayName: Schema.String,
	index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 })),
	height: Schema.Int.check(Schema.isGreaterThan(0)),
	width: Schema.Int.check(Schema.isGreaterThan(0)),
	candidateId: Schema.optional(Schema.String)
}).annotate({ identifier: "CameraDescriptor" });
export type CameraDescriptor = Schema.Schema.Type<typeof CameraDescriptor>;

export const CameraStatus = Schema.Struct({
	cameras: Schema.Array(CameraDescriptor),
	config: CameraScheduleConfig,
	pipeName: Schema.String,
	schemaVersion: Schema.Literal(1),
	stats: CameraStreamStats
}).annotate({ identifier: "CameraStatus" });
export type CameraStatus = Schema.Schema.Type<typeof CameraStatus>;

export const decodeCameraScheduleConfig = Schema.decodeUnknownEffect(CameraScheduleConfig);
export const decodeCameraStatus = Schema.decodeUnknownEffect(CameraStatus);
