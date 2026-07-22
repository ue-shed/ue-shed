import {
	AuthoringAuthority,
	AuthoringCatalogResult,
	AuthoringLoadResult,
	AuthoringSessionIntent,
	AuthoringSessionListResult,
	AuthoringSessionReviewResult,
	AuthoringSessionResult
} from "@ue-shed/authoring-sdk";
import { TextureAuditRunResult, TexturePreviewResult } from "@ue-shed/asset-audits";
import {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewCandidatePreviewResult,
	MapReviewResult
} from "@ue-shed/cameras/review-contracts";
import { TextCorpusRunResult } from "@ue-shed/game-text";
import { RuntimeHealth } from "@ue-shed/observability";
import {
	ActorId,
	WorldActorCatalog,
	WorldActorSnapshot,
	WorldIndexedTransform,
	WorldObservationHealth,
	WorldScoutFocusResult,
	WorldScoutResult,
	WorldScoutRefreshRate
} from "@ue-shed/observatory";
import {
	CameraScheduleConfig,
	CameraStatus,
	EditorPlaySessionCommand,
	EditorPlaySessionCommandResponse,
	EditorPlaySessionStateResponse
} from "@ue-shed/protocol";
import { Schema, SchemaGetter } from "effect";

const EmptyArgs = Schema.Tuple([]);

/** `/Game/` object paths accepted by preview and catalog-table IPC. */
export const GameObjectPath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(1_024),
	Schema.isStartsWith("/Game/")
).pipe(Schema.brand("GameObjectPath"));
export type GameObjectPath = Schema.Schema.Type<typeof GameObjectPath>;

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = Schema.Schema.Type<typeof SessionId>;

export const CandidateId = Schema.NonEmptyString.pipe(Schema.brand("CandidateId"));
export type CandidateId = Schema.Schema.Type<typeof CandidateId>;

/**
 * Presentation budget input. Finite values outside 25–500 MB/s clamp to that range
 * (current main-process behavior); non-finite values fail decode.
 */
export const PresentationBudgetMbPerSecond = Schema.Finite.pipe(
	Schema.decode({
		decode: SchemaGetter.transform((value) => Math.min(500, Math.max(25, value))),
		encode: SchemaGetter.transform((value) => value)
	})
);
export type PresentationBudgetMbPerSecond = Schema.Schema.Type<
	typeof PresentationBudgetMbPerSecond
>;

export const ShowcaseContext = Schema.Struct({
	fixtureConfigured: Schema.Boolean,
	health: RuntimeHealth,
	projectRoot: Schema.optionalKey(Schema.String),
	reader: Schema.Literals(["configured", "path"]),
	ruleFile: Schema.optionalKey(Schema.String)
});
export interface ShowcaseContext extends Schema.Schema.Type<typeof ShowcaseContext> {}

export const FixtureLaunchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type FixtureLaunchResult = Schema.Schema.Type<typeof FixtureLaunchResult>;

export const WorkbenchCameraMetrics = Schema.Struct({
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
export interface WorkbenchCameraMetrics extends Schema.Schema.Type<typeof WorkbenchCameraMetrics> {}

export const RendererCameraFrame = Schema.Struct({
	cameraId: Schema.String,
	cameraIndex: Schema.Int,
	captureMonotonicMs: Schema.Number,
	height: Schema.Int.check(Schema.isGreaterThan(0)),
	pixels: Schema.Uint8Array,
	producerId: Schema.String,
	readbackDrops: Schema.Number,
	readbackLatencyMs: Schema.Number,
	receivedMonotonicMs: Schema.Number,
	sequence: Schema.String,
	sessionId: Schema.String,
	transportReplacements: Schema.Number,
	width: Schema.Int.check(Schema.isGreaterThan(0)),
	worldSeconds: Schema.Number
});
export interface RendererCameraFrame extends Schema.Schema.Type<typeof RendererCameraFrame> {}

/**
 * Retained observation sample crossing Electron IPC. Transforms stay as a dense array so the
 * renderer can rebuild a Map without receiving catalog actor metadata on every transform tick.
 */
export const RendererWorldObservationSample = Schema.Struct({
	catalog: WorldActorCatalog,
	health: WorldObservationHealth,
	lastSequence: Schema.String,
	sampleWorldSeconds: Schema.Finite,
	transforms: Schema.Array(WorldIndexedTransform)
});
export interface RendererWorldObservationSample extends Schema.Schema.Type<
	typeof RendererWorldObservationSample
> {}

/**
 * Main→renderer observation events. Catalog/status payloads carry metadata once; transform
 * batches carry only coalesced changed indices. Bigints travel as decimal strings (camera pattern).
 */
export const RendererWorldObservationEvent = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("connecting")
	}),
	Schema.Struct({
		kind: Schema.Literal("catalog"),
		sample: RendererWorldObservationSample,
		status: Schema.Literals(["live", "stale"]),
		message: Schema.optionalKey(Schema.String),
		recovery: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		kind: Schema.Literal("transforms"),
		actorsChanged: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		actorsSampled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		health: WorldObservationHealth,
		producerMonotonicMs: Schema.Finite,
		producerReplacements: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		revision: Schema.String,
		sequence: Schema.String,
		sessionId: Schema.String,
		status: Schema.Literals(["live", "stale"]),
		transforms: Schema.Array(WorldIndexedTransform),
		worldSeconds: Schema.Finite,
		message: Schema.optionalKey(Schema.String),
		recovery: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		kind: Schema.Literal("polling_fallback"),
		cadenceHz: Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(10)
		),
		message: Schema.String,
		snapshot: WorldActorSnapshot
	}),
	Schema.Struct({
		kind: Schema.Literal("unavailable"),
		message: Schema.String,
		recovery: Schema.String,
		sample: Schema.optionalKey(RendererWorldObservationSample)
	})
]);
export type RendererWorldObservationEvent = Schema.Schema.Type<
	typeof RendererWorldObservationEvent
>;

export const CameraMetricsResult = Schema.UndefinedOr(WorkbenchCameraMetrics);
export type CameraMetricsResult = Schema.Schema.Type<typeof CameraMetricsResult>;

export interface InvokeContract<
	Args extends Schema.Top = Schema.Top,
	Result extends Schema.Top = Schema.Top
> {
	readonly kind: "invoke";
	readonly channel: string;
	readonly args: Args;
	readonly result: Result;
}

const invoke = <
	const Channel extends string,
	Args extends Schema.Top,
	Result extends Schema.Top
>(contract: {
	readonly channel: Channel;
	readonly args: Args;
	readonly result: Result;
}): InvokeContract<Args, Result> & { readonly channel: Channel } => ({
	kind: "invoke",
	...contract
});

export const invokeContracts = {
	"editor-session:status": invoke({
		channel: "editor-session:status",
		args: EmptyArgs,
		result: EditorPlaySessionStateResponse
	}),
	"editor-session:execute": invoke({
		channel: "editor-session:execute",
		args: Schema.Tuple([EditorPlaySessionCommand]),
		result: EditorPlaySessionCommandResponse
	}),
	"fixture:launch": invoke({
		channel: "fixture:launch",
		args: EmptyArgs,
		result: FixtureLaunchResult
	}),
	"fixture:launch-review": invoke({
		channel: "fixture:launch-review",
		args: EmptyArgs,
		result: FixtureLaunchResult
	}),
	"showcase:context": invoke({
		channel: "showcase:context",
		args: EmptyArgs,
		result: ShowcaseContext
	}),
	"asset-audits:textures:configured-scan": invoke({
		channel: "asset-audits:textures:configured-scan",
		args: EmptyArgs,
		result: TextureAuditRunResult
	}),
	"asset-audits:textures:choose-and-scan": invoke({
		channel: "asset-audits:textures:choose-and-scan",
		args: EmptyArgs,
		result: TextureAuditRunResult
	}),
	"asset-audits:textures:preview": invoke({
		channel: "asset-audits:textures:preview",
		args: Schema.Tuple([GameObjectPath]),
		result: TexturePreviewResult
	}),
	"game-text:configured-scan": invoke({
		channel: "game-text:configured-scan",
		args: EmptyArgs,
		result: TextCorpusRunResult
	}),
	"game-text:choose-and-scan": invoke({
		channel: "game-text:choose-and-scan",
		args: EmptyArgs,
		result: TextCorpusRunResult
	}),
	"authoring:configured-table": invoke({
		channel: "authoring:configured-table",
		args: EmptyArgs,
		result: AuthoringLoadResult
	}),
	"authoring:configured-catalog": invoke({
		channel: "authoring:configured-catalog",
		args: EmptyArgs,
		result: AuthoringCatalogResult
	}),
	"authoring:open-catalog-table": invoke({
		channel: "authoring:open-catalog-table",
		args: Schema.Tuple([GameObjectPath, AuthoringAuthority]),
		result: AuthoringLoadResult
	}),
	"authoring:choose-table": invoke({
		channel: "authoring:choose-table",
		args: EmptyArgs,
		result: AuthoringLoadResult
	}),
	"authoring:session:begin": invoke({
		channel: "authoring:session:begin",
		args: Schema.Tuple([GameObjectPath]),
		result: AuthoringSessionResult
	}),
	"authoring:session:list": invoke({
		channel: "authoring:session:list",
		args: EmptyArgs,
		result: AuthoringSessionListResult
	}),
	"authoring:session:open": invoke({
		channel: "authoring:session:open",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionResult
	}),
	"authoring:session:discard": invoke({
		channel: "authoring:session:discard",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionListResult
	}),
	"authoring:session:edit": invoke({
		channel: "authoring:session:edit",
		args: Schema.Tuple([AuthoringSessionIntent]),
		result: AuthoringSessionResult
	}),
	"authoring:session:review": invoke({
		channel: "authoring:session:review",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionReviewResult
	}),
	"authoring:session:undo": invoke({
		channel: "authoring:session:undo",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionResult
	}),
	"authoring:session:redo": invoke({
		channel: "authoring:session:redo",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionResult
	}),
	"authoring:session:apply": invoke({
		channel: "authoring:session:apply",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionResult
	}),
	"authoring:session:reconcile": invoke({
		channel: "authoring:session:reconcile",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionResult
	}),
	"authoring:session:save": invoke({
		channel: "authoring:session:save",
		args: Schema.Tuple([SessionId]),
		result: AuthoringSessionResult
	}),
	"camera:metrics": invoke({
		channel: "camera:metrics",
		args: EmptyArgs,
		result: CameraMetricsResult
	}),
	"camera:presentation-budget": invoke({
		channel: "camera:presentation-budget",
		args: Schema.Tuple([PresentationBudgetMbPerSecond]),
		result: PresentationBudgetMbPerSecond
	}),
	"camera:status": invoke({
		channel: "camera:status",
		args: EmptyArgs,
		result: CameraStatus
	}),
	"camera:configure": invoke({
		channel: "camera:configure",
		args: Schema.Tuple([CameraScheduleConfig]),
		result: CameraStatus
	}),
	"map-review:load": invoke({
		channel: "map-review:load",
		args: EmptyArgs,
		result: MapReviewResult
	}),
	"map-review:world-snapshot": invoke({
		channel: "map-review:world-snapshot",
		args: EmptyArgs,
		result: WorldScoutResult
	}),
	"map-review:focus-actor": invoke({
		channel: "map-review:focus-actor",
		args: Schema.Tuple([ActorId, Schema.Boolean]),
		result: WorldScoutFocusResult
	}),
	"map-review:capture": invoke({
		channel: "map-review:capture",
		args: Schema.Tuple([MapReviewCaptureIntent]),
		result: MapReviewCaptureResult
	}),
	"map-review:author-from-selection": invoke({
		channel: "map-review:author-from-selection",
		args: EmptyArgs,
		result: MapReviewAuthoringResult
	}),
	"map-review:authoring-resume": invoke({
		channel: "map-review:authoring-resume",
		args: EmptyArgs,
		result: MapReviewAuthoringResult
	}),
	"map-review:authoring-patch": invoke({
		channel: "map-review:authoring-patch",
		args: Schema.Tuple([MapReviewAuthoringPatchIntent]),
		result: MapReviewAuthoringResult
	}),
	"map-review:authoring-reframe": invoke({
		channel: "map-review:authoring-reframe",
		args: Schema.Tuple([MapReviewAuthoringSessionIntent]),
		result: MapReviewAuthoringResult
	}),
	"map-review:authoring-discard": invoke({
		channel: "map-review:authoring-discard",
		args: Schema.Tuple([MapReviewAuthoringSessionIntent]),
		result: MapReviewAuthoringResult
	}),
	"map-review:preview-authoring-candidate": invoke({
		channel: "map-review:preview-authoring-candidate",
		args: Schema.Tuple([MapReviewAuthoringPreviewIntent]),
		result: MapReviewCandidatePreviewResult
	}),
	"map-review:approve-authoring": invoke({
		channel: "map-review:approve-authoring",
		args: Schema.Tuple([MapReviewAuthoringSessionIntent]),
		result: MapReviewApprovalResult
	}),
	"map-review:preview-candidate": invoke({
		channel: "map-review:preview-candidate",
		args: Schema.Tuple([CandidateId]),
		result: MapReviewCandidatePreviewResult
	}),
	"map-review:approve-candidate": invoke({
		channel: "map-review:approve-candidate",
		args: Schema.Tuple([MapReviewApproveCandidateIntent]),
		result: MapReviewApprovalResult
	}),
	"map-review:set-live-preview-fps": invoke({
		channel: "map-review:set-live-preview-fps",
		args: Schema.Tuple([Schema.Number]),
		result: Schema.Number
	}),
	"map-review:subscribe-world-observations": invoke({
		channel: "map-review:subscribe-world-observations",
		args: Schema.Tuple([WorldScoutRefreshRate]),
		result: Schema.Undefined
	}),
	"map-review:set-world-observation-rate": invoke({
		channel: "map-review:set-world-observation-rate",
		args: Schema.Tuple([WorldScoutRefreshRate]),
		result: WorldScoutRefreshRate
	}),
	"map-review:unsubscribe-world-observations": invoke({
		channel: "map-review:unsubscribe-world-observations",
		args: EmptyArgs,
		result: Schema.Undefined
	})
} as const;

export type InvokeChannel = keyof typeof invokeContracts;

export const cameraFrameEvent = {
	kind: "event",
	channel: "camera:frame",
	payload: RendererCameraFrame
} as const;

export const worldObservationEvent = {
	kind: "event",
	channel: "map-review:world-observation",
	payload: RendererWorldObservationEvent
} as const;

export const invokeChannelNames = Object.keys(invokeContracts) as Array<InvokeChannel>;

export const decodeInvokeArgs = <C extends InvokeContract>(contract: C) =>
	Schema.decodeUnknownEffect(contract.args);

export const decodeInvokeResult = <C extends InvokeContract>(contract: C) =>
	Schema.decodeUnknownEffect(contract.result);

export const decodeCameraFrameEvent = Schema.decodeUnknownEffect(cameraFrameEvent.payload);
export const decodeWorldObservationEvent = Schema.decodeUnknownEffect(
	worldObservationEvent.payload
);
