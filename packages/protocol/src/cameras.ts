import { contractParser } from "./contract-parser.js";
import { Schema } from "effect";

/**
 * A UEShedCameras camera source: its Unreal GUID as 32 lowercase hex digits, assigned by the
 * plugin when the source is created. Decoding checks only that it is a string.
 */
export const CameraId = Schema.String.pipe(Schema.brand("CameraId"));
export type CameraId = Schema.Schema.Type<typeof CameraId>;

/**
 * The capture schedule sent to the UEShedCameras `Configure` call and echoed in its status. The
 * focused camera captures at `focusedFps` and the rest at `backgroundFps` (frames per second);
 * `focusedCameraIndex: null` focuses none. An omitted `editorBackgroundTicking` means `inherit`.
 * Decoding fails with a ContractParseError when a value leaves its bound or a literal is unknown.
 */
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

/**
 * Camera stream counters reported by the plugin. Plain counters run since the camera subsystem
 * started; `experiment*` counters restart on every successful configure, which increments
 * `experimentRevision`. `*Ms` fields are milliseconds and `*BytesSent` fields are bytes.
 */
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

/**
 * One live camera source. `index` (0-31) matches the camera index in streamed frame headers and
 * `width`/`height` are the capture size in pixels. `candidateId` is a compatibility copy, present
 * only for cameras provisioned for a framing candidate.
 */
export const CameraDescriptor = Schema.Struct({
	cameraId: CameraId,
	displayName: Schema.String,
	index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 })),
	height: Schema.Int.check(Schema.isGreaterThan(0)),
	width: Schema.Int.check(Schema.isGreaterThan(0)),
	candidateId: Schema.optional(Schema.String)
}).annotate({ identifier: "CameraDescriptor" });
export type CameraDescriptor = Schema.Schema.Type<typeof CameraDescriptor>;

/**
 * Schema-1 reply from the UEShedCameras `GetStatus` and `Configure` calls: the effective schedule
 * after the plugin clamps it, the live cameras, stream counters, and the named pipe frames go to.
 */
export const CameraStatus = Schema.Struct({
	cameras: Schema.Array(CameraDescriptor),
	config: CameraScheduleConfig,
	/** Present while a provisioned feed shows editor previews; counts the revealed child actors. */
	editorPreviews: Schema.optionalKey(
		Schema.Struct({
			revealedChildActors: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	pipeName: Schema.String,
	schemaVersion: Schema.Literal(1),
	stats: CameraStreamStats
}).annotate({ identifier: "CameraStatus" });
export type CameraStatus = Schema.Schema.Type<typeof CameraStatus>;

/** Validates a schedule before it is sent; fails with a ContractParseError for any out-of-bound value. */
export const decodeCameraScheduleConfig = contractParser(
	CameraScheduleConfig,
	"CameraScheduleConfig"
);
/** Decodes a plugin status reply; fails with a ContractParseError for another schema version or shape. */
export const decodeCameraStatus = contractParser(CameraStatus, "CameraStatus");

/**
 * A failed camera status or configure call: `error` is a stable code (for example
 * `no-renderable-world`, `invalid-json`) and `message`, when present, is prose for people. Plugins
 * before 0.17 omit `status` and `message`.
 */
export const CameraControlFailure = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.optionalKey(Schema.Literal("failed")),
	error: Schema.NonEmptyString,
	message: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "CameraControlFailure" });
export type CameraControlFailure = Schema.Schema.Type<typeof CameraControlFailure>;
