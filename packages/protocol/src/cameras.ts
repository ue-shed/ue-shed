import { Schema } from "effect";

export const CameraId = Schema.String.pipe(Schema.brand("CameraId"));
export type CameraId = Schema.Schema.Type<typeof CameraId>;

export const CameraScheduleConfig = Schema.Struct({
	activeCameraCount: Schema.Number.pipe(Schema.int(), Schema.between(1, 32)),
	backgroundFps: Schema.Number.pipe(Schema.between(0.1, 30)),
	captureBudgetPerTick: Schema.Number.pipe(Schema.int(), Schema.between(1, 32)),
	focusedCameraIndex: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(0, 31))),
	focusedFps: Schema.Number.pipe(Schema.between(0.1, 60)),
	paused: Schema.Boolean,
	resolution: Schema.Literal(
		"160x90",
		"320x180",
		"640x360",
		"960x540",
		"1280x720",
		"1920x1080",
		"2560x1440"
	),
	viewMode: Schema.Literal("overview", "actor_pov")
}).annotations({ identifier: "CameraScheduleConfig" });
export type CameraScheduleConfig = Schema.Schema.Type<typeof CameraScheduleConfig>;

export const CameraStreamStats = Schema.Struct({
	bytesSent: Schema.Number,
	capturesRequested: Schema.Number,
	framesDelivered: Schema.Number,
	pipeConnected: Schema.Boolean,
	readbackDrops: Schema.Number,
	transportReplacements: Schema.Number
}).annotations({ identifier: "CameraStreamStats" });
export type CameraStreamStats = Schema.Schema.Type<typeof CameraStreamStats>;

export const CameraDescriptor = Schema.Struct({
	cameraId: CameraId,
	displayName: Schema.String,
	index: Schema.Number.pipe(Schema.int(), Schema.between(0, 31)),
	height: Schema.Number.pipe(Schema.int(), Schema.positive()),
	width: Schema.Number.pipe(Schema.int(), Schema.positive())
}).annotations({ identifier: "CameraDescriptor" });
export type CameraDescriptor = Schema.Schema.Type<typeof CameraDescriptor>;

export const CameraStatus = Schema.Struct({
	cameras: Schema.Array(CameraDescriptor),
	config: CameraScheduleConfig,
	pipeName: Schema.String,
	schemaVersion: Schema.Literal(1),
	stats: CameraStreamStats
}).annotations({ identifier: "CameraStatus" });
export type CameraStatus = Schema.Schema.Type<typeof CameraStatus>;

export const decodeCameraScheduleConfig = Schema.decodeUnknownSync(CameraScheduleConfig);
export const decodeCameraStatus = Schema.decodeUnknownSync(CameraStatus);
