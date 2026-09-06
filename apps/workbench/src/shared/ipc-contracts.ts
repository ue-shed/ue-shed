import {
	TextureInvestigationQuery,
	TextureInvestigationPresetResult
} from "@ue-shed/asset-audits/browser";

import {
	GameTextInvestigationQuery,
	GameTextInvestigationPresetResult
} from "@ue-shed/game-text/browser";
import { InvestigationFileResult, InvestigationFormat } from "@ue-shed/unreal-assets/investigation";
import {
	AuthoringAuthority,
	AuthoringCatalogResult,
	AuthoringLoadResult,
	AuthoringSessionIntent,
	AuthoringSessionListResult,
	AuthoringSessionReviewResult,
	AuthoringSessionResult
} from "@ue-shed/authoring-sdk";
import {
	TextureAuditQueryRunResult,
	TextureAuditRecordResult,
	TextureAuditRunResult,
	TextureAuditSearchRequest,
	TextureAuditSearchResult,
	TexturePreviewBatchRequest,
	TexturePreviewBatchResult,
	TexturePreviewResult
} from "@ue-shed/asset-audits/browser";
import {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewApplyVisibilityPolicyIntent,
	MapReviewReplaceVisibilityPolicyIntent,
	MapReviewCandidatePreviewResult,
	MapReviewResult,
	MapReviewSetCreateIntent,
	MapReviewSetLibraryResult,
	MapReviewSetSelectIntent
} from "@ue-shed/cameras/review-contracts";
import {
	MapCaptureExecuteIntent,
	MapCaptureExecuteResult,
	MapCaptureActorCatalogResult,
	MapCaptureLivePreviewResult,
	MapCaptureOpenResult,
	MapCaptureProgressEvent,
	MapCaptureSaveIntent,
	MapCaptureSaveResult,
	MapCaptureSelectionResult,
	MapCaptureTileIntent,
	MapCaptureTileResult
} from "@ue-shed/extension-camera-review/map-capture-client";
import { MapCapturePlan } from "@ue-shed/cameras/browser";
import {
	ConfigComparison,
	ConfigExplanation,
	ConfigExplorerPublicError
} from "@ue-shed/config-explorer/browser";
import { EnhancedInputRunResult } from "@ue-shed/enhanced-input/browser";
import {
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusQueryRunResult,
	TextCorpusRunResult,
	TextCorpusSearchRequest,
	TextCorpusSearchResult,
	TextQualityFocusRequest,
	TextQualityFocusResult,
	TextQualityQueryRunResult,
	TextQualityRuleDocument,
	TextQualityRuleUpdateResult,
	TextQualitySearchRequest,
	TextQualitySearchResult
} from "@ue-shed/game-text/browser";
import { RuntimeHealth } from "@ue-shed/observability/health";
import {
	ScenarioDocument,
	ScenarioDocumentFileResult,
	ScenarioRun,
	ScenarioRunHandle,
	ScenarioStatusResponse
} from "@ue-shed/scenarios/browser";
import {
	ActorId,
	WorldActorCatalog,
	WorldActorSnapshot,
	WorldIndexedTransform,
	WorldObservationHealth,
	WorldScoutFocusResult,
	WorldScoutResult,
	WorldScoutRefreshRate
} from "@ue-shed/observatory/browser";
import {
	BlueprintGraphRead,
	CameraScheduleConfig,
	CameraStatus,
	EditorPlaySessionCommand,
	EditorPlaySessionCommandResponse,
	EditorPlaySessionStateResponse,
	EditorAssetLocateResult,
	SavedWorld,
	SavedWorldChoice,
	SavedWorldMap,
	SavedWorldProgress
} from "@ue-shed/protocol";
import {
	ContentObservatoryHistoryRequest,
	ContentObservatoryTargetCatalog,
	ContentObservatoryState
} from "@ue-shed/extension-content-observatory/client";
import { ProjectRelativeMapPath } from "@ue-shed/map-history/contract";
import {
	CustodianCancelRunResult,
	CustodianExecuteIntent,
	CustodianExecutionRunResult,
	CustodianPrepareIntent,
	CustodianPrepareRunResult,
	CustodianRunResult
} from "@ue-shed/extension-project-custodian/client";
import { CustodianProposalId } from "@ue-shed/project-custodian/browser";
import {
	NiagaraCatalogueResult,
	NiagaraPreviewFrameIntent,
	NiagaraPreviewFrameResult,
	NiagaraPreviewIntent,
	NiagaraPreviewRunResult
} from "@ue-shed/extension-niagara-preview/client";
import { Schema, SchemaGetter } from "effect";
import {
	ProjectLaunchMode,
	ProjectLaunchResult,
	WorkbenchRecentProject,
	WorkbenchRecentProjects,
	WorkbenchProjectState,
	WorkbenchTaskProgress
} from "./project-workspace-contract.js";

const EmptyArgs = Schema.Tuple([]);

export const BlueprintAssetPath = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.isMaxLength(32_768)
);
export type BlueprintAssetPath = Schema.Schema.Type<typeof BlueprintAssetPath>;

export const BLUEPRINT_ASSET_SEARCH_LIMIT = 80;

export const BlueprintAssetSearchRequest = Schema.Struct({
	query: Schema.Trim.check(Schema.isMaxLength(256))
});
export interface BlueprintAssetSearchRequest extends Schema.Schema.Type<
	typeof BlueprintAssetSearchRequest
> {}

export const BlueprintAssetCandidate = Schema.Struct({
	assetName: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
	assetPath: BlueprintAssetPath,
	className: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
	packageName: Schema.NonEmptyString.check(Schema.isMaxLength(32_768)),
	relativePath: Schema.NonEmptyString.check(Schema.isMaxLength(32_768))
});
export interface BlueprintAssetCandidate extends Schema.Schema.Type<
	typeof BlueprintAssetCandidate
> {}

export const BlueprintAssetSearchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({
		assets: Schema.Array(BlueprintAssetCandidate).check(
			Schema.isMaxLength(BLUEPRINT_ASSET_SEARCH_LIMIT)
		),
		matchCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		projectName: Schema.NonEmptyString,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({
		message: Schema.NonEmptyString,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	})
]);
export type BlueprintAssetSearchResult = Schema.Schema.Type<typeof BlueprintAssetSearchResult>;

export const BlueprintGraphFailureReason = Schema.Literals([
	"control_rig",
	"malformed_package",
	"missing_reader",
	"reader_failure",
	"unsupported_asset",
	"unsupported_version"
]);
export type BlueprintGraphFailureReason = Schema.Schema.Type<typeof BlueprintGraphFailureReason>;

export const BlueprintGraphReadResult = Schema.Union([
	Schema.Struct({
		assetPath: BlueprintAssetPath,
		...BlueprintGraphRead.fields,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({
		assetPath: Schema.optionalKey(BlueprintAssetPath),
		message: Schema.NonEmptyString,
		reason: BlueprintGraphFailureReason,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	})
]);
export type BlueprintGraphReadResult = Schema.Schema.Type<typeof BlueprintGraphReadResult>;

export const RemoteControlPort = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(65_535)
);
export type RemoteControlPort = Schema.Schema.Type<typeof RemoteControlPort>;

export const CameraStatusResult = Schema.Union([
	Schema.Struct({ camera: CameraStatus, status: Schema.Literal("ready") }),
	Schema.Struct({
		message: Schema.NonEmptyString,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("unavailable")
	})
]);
export type CameraStatusResult = Schema.Schema.Type<typeof CameraStatusResult>;

export const EditorSessionStatusResult = Schema.Union([
	Schema.Struct({ session: EditorPlaySessionStateResponse, status: Schema.Literal("ready") }),
	Schema.Struct({
		error: Schema.Struct({
			code: Schema.Literals([
				"capability_unavailable",
				"contract_failure",
				"transport_failure"
			]),
			endpoint: Schema.String,
			message: Schema.String,
			operation: Schema.String,
			recovery: Schema.String,
			retrySafe: Schema.Boolean
		}),
		status: Schema.Literal("unavailable")
	})
]);
export type EditorSessionStatusResult = Schema.Schema.Type<typeof EditorSessionStatusResult>;

export const UnrealConnectionSettings = Schema.Struct({
	endpoint: Schema.optionalKey(Schema.NonEmptyString),
	port: RemoteControlPort
});
export interface UnrealConnectionSettings extends Schema.Schema.Type<
	typeof UnrealConnectionSettings
> {}

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

export const ShowcaseCandidateEvidence = Schema.Union([
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
]);
export type ShowcaseCandidateEvidence = Schema.Schema.Type<typeof ShowcaseCandidateEvidence>;

export const ShowcaseProjectEvidence = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({
		message: Schema.NonEmptyString,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	}),
	Schema.Struct({
		candidates: ShowcaseCandidateEvidence,
		mapCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		packageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		projectName: Schema.NonEmptyString,
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("ready")
	})
]);
export type ShowcaseProjectEvidence = Schema.Schema.Type<typeof ShowcaseProjectEvidence>;

export const ShowcaseContext = Schema.Struct({
	configSampleAvailable: Schema.optionalKey(Schema.Boolean),
	fixtureConfigured: Schema.Boolean,
	health: RuntimeHealth,
	project: ShowcaseProjectEvidence,
	projectRoot: Schema.optionalKey(Schema.String),
	reader: Schema.Literals(["configured", "path"]),
	ruleFile: Schema.optionalKey(Schema.String)
});
export interface ShowcaseContext extends Schema.Schema.Type<typeof ShowcaseContext> {}

const ConfigExplorerQueryFields = {
	family: Schema.optionalKey(Schema.NonEmptyString),
	key: Schema.NonEmptyString,
	section: Schema.NonEmptyString,
	source: Schema.Literals(["selected_project", "sample_fixture"])
};

export const ConfigExplorerQuery = Schema.Union([
	Schema.Struct({
		...ConfigExplorerQueryFields,
		mode: Schema.Literal("explain"),
		platform: Schema.NonEmptyString
	}),
	Schema.Struct({
		...ConfigExplorerQueryFields,
		leftPlatform: Schema.NonEmptyString,
		mode: Schema.Literal("compare"),
		rightPlatform: Schema.NonEmptyString
	})
]);
export type ConfigExplorerQuery = typeof ConfigExplorerQuery.Type;

const ConfigExplorerWorkbenchError = Schema.Union([
	ConfigExplorerPublicError,
	Schema.Struct({
		code: Schema.Literals(["project_unavailable", "sample_unavailable"]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	})
]);

export const ConfigExplorerQueryResult = Schema.Union([
	Schema.Struct({
		evidence: ConfigExplanation,
		mode: Schema.Literal("explain"),
		projectName: Schema.NonEmptyString,
		source: ConfigExplorerQueryFields.source,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({
		evidence: ConfigComparison,
		mode: Schema.Literal("compare"),
		projectName: Schema.NonEmptyString,
		source: ConfigExplorerQueryFields.source,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({
		error: ConfigExplorerWorkbenchError,
		status: Schema.Literal("failed")
	})
]);
export type ConfigExplorerQueryResult = typeof ConfigExplorerQueryResult.Type;

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
	"editor-session:settings": invoke({
		channel: "editor-session:settings",
		args: EmptyArgs,
		result: UnrealConnectionSettings
	}),
	"editor-session:set-port": invoke({
		channel: "editor-session:set-port",
		args: Schema.Tuple([RemoteControlPort]),
		result: UnrealConnectionSettings
	}),
	"editor-session:status": invoke({
		channel: "editor-session:status",
		args: EmptyArgs,
		result: EditorSessionStatusResult
	}),
	"editor-session:execute": invoke({
		channel: "editor-session:execute",
		args: Schema.Tuple([EditorPlaySessionCommand]),
		result: EditorPlaySessionCommandResponse
	}),
	"scenario:open-document": invoke({
		channel: "scenario:open-document",
		args: EmptyArgs,
		result: ScenarioDocumentFileResult
	}),
	"scenario:save-document": invoke({
		channel: "scenario:save-document",
		args: Schema.Tuple([ScenarioDocument]),
		result: ScenarioDocumentFileResult
	}),
	"scenario:start": invoke({
		channel: "scenario:start",
		args: Schema.Tuple([ScenarioDocument, Schema.NonEmptyString]),
		result: ScenarioRunHandle
	}),
	"scenario:status": invoke({
		channel: "scenario:status",
		args: Schema.Tuple([ScenarioRunHandle]),
		result: ScenarioStatusResponse
	}),
	"scenario:cancel": invoke({
		channel: "scenario:cancel",
		args: Schema.Tuple([ScenarioRunHandle]),
		result: ScenarioRun
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
	"config-explorer:query": invoke({
		channel: "config-explorer:query",
		args: Schema.Tuple([ConfigExplorerQuery]),
		result: ConfigExplorerQueryResult
	}),
	"project-custodian:configured-scan": invoke({
		channel: "project-custodian:configured-scan",
		args: EmptyArgs,
		result: CustodianRunResult
	}),
	"project-custodian:choose-and-scan": invoke({
		channel: "project-custodian:choose-and-scan",
		args: EmptyArgs,
		result: CustodianRunResult
	}),
	"project-custodian:prepare": invoke({
		channel: "project-custodian:prepare",
		args: Schema.Tuple([CustodianPrepareIntent]),
		result: CustodianPrepareRunResult
	}),
	"project-custodian:execute": invoke({
		channel: "project-custodian:execute",
		args: Schema.Tuple([CustodianExecuteIntent]),
		result: CustodianExecutionRunResult
	}),
	"project-custodian:cancel": invoke({
		channel: "project-custodian:cancel",
		args: Schema.Tuple([CustodianProposalId]),
		result: CustodianCancelRunResult
	}),
	"project:current": invoke({
		channel: "project:current",
		args: EmptyArgs,
		result: WorkbenchProjectState
	}),
	"project:refresh": invoke({
		channel: "project:refresh",
		args: Schema.Tuple([Schema.Literals(["refresh", "rebuild"])]),
		result: WorkbenchProjectState
	}),
	"project:choose": invoke({
		channel: "project:choose",
		args: EmptyArgs,
		result: WorkbenchProjectState
	}),
	"project:sample": invoke({
		channel: "project:sample",
		args: EmptyArgs,
		result: WorkbenchProjectState
	}),
	"project:recent": invoke({
		channel: "project:recent",
		args: EmptyArgs,
		result: WorkbenchRecentProjects
	}),
	"project:open-recent": invoke({
		channel: "project:open-recent",
		args: Schema.Tuple([WorkbenchRecentProject.fields.projectRoot]),
		result: WorkbenchProjectState
	}),
	"project:progress": invoke({
		channel: "project:progress",
		args: EmptyArgs,
		result: WorkbenchTaskProgress
	}),
	"project:launch": invoke({
		channel: "project:launch",
		args: Schema.Tuple([ProjectLaunchMode]),
		result: ProjectLaunchResult
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
	"asset-audits:textures:configured-refresh": invoke({
		channel: "asset-audits:textures:configured-refresh",
		args: Schema.Tuple([Schema.Boolean]),
		result: TextureAuditQueryRunResult
	}),
	"asset-audits:textures:choose-and-refresh": invoke({
		channel: "asset-audits:textures:choose-and-refresh",
		args: EmptyArgs,
		result: TextureAuditQueryRunResult
	}),
	"asset-audits:textures:progress": invoke({
		channel: "asset-audits:textures:progress",
		args: EmptyArgs,
		result: WorkbenchTaskProgress
	}),
	"asset-audits:textures:investigation-export": invoke({
		channel: "asset-audits:textures:investigation-export",
		args: Schema.Tuple([TextureInvestigationQuery, InvestigationFormat]),
		result: InvestigationFileResult
	}),
	"asset-audits:textures:investigation-save": invoke({
		channel: "asset-audits:textures:investigation-save",
		args: Schema.Tuple([TextureInvestigationQuery]),
		result: InvestigationFileResult
	}),
	"asset-audits:textures:investigation-open": invoke({
		channel: "asset-audits:textures:investigation-open",
		args: Schema.Tuple([]),
		result: TextureInvestigationPresetResult
	}),
	"asset-audits:textures:search": invoke({
		channel: "asset-audits:textures:search",
		args: Schema.Tuple([TextureAuditSearchRequest]),
		result: TextureAuditSearchResult
	}),
	"asset-audits:textures:record": invoke({
		channel: "asset-audits:textures:record",
		args: Schema.Tuple([GameObjectPath]),
		result: TextureAuditRecordResult
	}),
	"asset-audits:textures:preview": invoke({
		channel: "asset-audits:textures:preview",
		args: Schema.Tuple([GameObjectPath]),
		result: TexturePreviewResult
	}),
	"asset-audits:textures:preview-offline": invoke({
		channel: "asset-audits:textures:preview-offline",
		args: Schema.Tuple([GameObjectPath]),
		result: TexturePreviewResult
	}),
	"asset-audits:textures:preview-offline-batch": invoke({
		channel: "asset-audits:textures:preview-offline-batch",
		args: Schema.Tuple([TexturePreviewBatchRequest]),
		result: TexturePreviewBatchResult
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
	"game-text:configured-refresh": invoke({
		channel: "game-text:configured-refresh",
		args: Schema.Tuple([Schema.Boolean]),
		result: TextCorpusQueryRunResult
	}),
	"game-text:choose-and-refresh": invoke({
		channel: "game-text:choose-and-refresh",
		args: EmptyArgs,
		result: TextCorpusQueryRunResult
	}),
	"game-text:progress": invoke({
		channel: "game-text:progress",
		args: EmptyArgs,
		result: WorkbenchTaskProgress
	}),
	"game-text:investigation-export": invoke({
		channel: "game-text:investigation-export",
		args: Schema.Tuple([GameTextInvestigationQuery, InvestigationFormat]),
		result: InvestigationFileResult
	}),
	"game-text:investigation-save": invoke({
		channel: "game-text:investigation-save",
		args: Schema.Tuple([GameTextInvestigationQuery]),
		result: InvestigationFileResult
	}),
	"game-text:investigation-open": invoke({
		channel: "game-text:investigation-open",
		args: Schema.Tuple([]),
		result: GameTextInvestigationPresetResult
	}),
	"game-text:search": invoke({
		channel: "game-text:search",
		args: Schema.Tuple([TextCorpusSearchRequest]),
		result: TextCorpusSearchResult
	}),
	"game-text:focus": invoke({
		channel: "game-text:focus",
		args: Schema.Tuple([TextCorpusFocusRequest]),
		result: TextCorpusFocusResult
	}),
	"game-text:quality:choose-rules": invoke({
		channel: "game-text:quality:choose-rules",
		args: EmptyArgs,
		result: TextQualityQueryRunResult
	}),
	"game-text:quality:preview-rules": invoke({
		channel: "game-text:quality:preview-rules",
		args: Schema.Tuple([TextQualityRuleDocument]),
		result: TextQualityRuleUpdateResult
	}),
	"game-text:quality:save-rules": invoke({
		channel: "game-text:quality:save-rules",
		args: Schema.Tuple([TextQualityRuleDocument]),
		result: TextQualityRuleUpdateResult
	}),
	"game-text:quality:search": invoke({
		channel: "game-text:quality:search",
		args: Schema.Tuple([TextQualitySearchRequest]),
		result: TextQualitySearchResult
	}),
	"game-text:quality:focus": invoke({
		channel: "game-text:quality:focus",
		args: Schema.Tuple([TextQualityFocusRequest]),
		result: TextQualityFocusResult
	}),
	"asset-navigation:locate": invoke({
		channel: "asset-navigation:locate",
		args: Schema.Tuple([GameObjectPath]),
		result: EditorAssetLocateResult
	}),
	"blueprint-graphs:read": invoke({
		channel: "blueprint-graphs:read",
		args: Schema.Tuple([BlueprintAssetPath]),
		result: BlueprintGraphReadResult
	}),
	"blueprint-graphs:choose": invoke({
		channel: "blueprint-graphs:choose",
		args: EmptyArgs,
		result: BlueprintGraphReadResult
	}),
	"blueprint-graphs:search": invoke({
		channel: "blueprint-graphs:search",
		args: Schema.Tuple([BlueprintAssetSearchRequest]),
		result: BlueprintAssetSearchResult
	}),
	"input-atlas:configured-scan": invoke({
		channel: "input-atlas:configured-scan",
		args: EmptyArgs,
		result: EnhancedInputRunResult
	}),
	"input-atlas:choose-and-scan": invoke({
		channel: "input-atlas:choose-and-scan",
		args: EmptyArgs,
		result: EnhancedInputRunResult
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
		result: CameraStatusResult
	}),
	"camera:configure": invoke({
		channel: "camera:configure",
		args: Schema.Tuple([CameraScheduleConfig]),
		result: CameraStatus
	}),
	"content-observatory:status": invoke({
		channel: "content-observatory:status",
		args: EmptyArgs,
		result: ContentObservatoryState
	}),
	"content-observatory:targets": invoke({
		channel: "content-observatory:targets",
		args: Schema.Tuple([ProjectRelativeMapPath]),
		result: ContentObservatoryTargetCatalog
	}),
	"content-observatory:start": invoke({
		channel: "content-observatory:start",
		args: Schema.Tuple([ContentObservatoryHistoryRequest]),
		result: ContentObservatoryState
	}),
	"content-observatory:cancel": invoke({
		channel: "content-observatory:cancel",
		args: EmptyArgs,
		result: ContentObservatoryState
	}),
	"map-review:load": invoke({
		channel: "map-review:load",
		args: EmptyArgs,
		result: MapReviewResult
	}),
	"map-capture:choose-plan": invoke({
		channel: "map-capture:choose-plan",
		args: EmptyArgs,
		result: MapCaptureSelectionResult
	}),
	"map-capture:actors": invoke({
		channel: "map-capture:actors",
		args: Schema.Tuple([Schema.NonEmptyString]),
		result: MapCaptureActorCatalogResult
	}),
	"map-capture:new-plan": invoke({
		channel: "map-capture:new-plan",
		args: EmptyArgs,
		result: MapCaptureSelectionResult
	}),
	"map-capture:save-plan": invoke({
		channel: "map-capture:save-plan",
		args: Schema.Tuple([MapCaptureSaveIntent]),
		result: MapCaptureSaveResult
	}),
	"map-capture:open-map": invoke({
		channel: "map-capture:open-map",
		args: Schema.Tuple([MapCapturePlan]),
		result: MapCaptureOpenResult
	}),
	"map-capture:preview": invoke({
		channel: "map-capture:preview",
		args: Schema.Tuple([MapCapturePlan]),
		result: MapCaptureLivePreviewResult
	}),
	"map-capture:capture": invoke({
		channel: "map-capture:capture",
		args: Schema.Tuple([MapCaptureExecuteIntent]),
		result: MapCaptureExecuteResult
	}),
	"map-capture:tile": invoke({
		channel: "map-capture:tile",
		args: Schema.Tuple([MapCaptureTileIntent]),
		result: MapCaptureTileResult
	}),
	"niagara-preview:catalogue": invoke({
		channel: "niagara-preview:catalogue",
		args: EmptyArgs,
		result: NiagaraCatalogueResult
	}),
	"niagara-preview:run": invoke({
		channel: "niagara-preview:run",
		args: Schema.Tuple([NiagaraPreviewIntent]),
		result: NiagaraPreviewRunResult
	}),
	"niagara-preview:frame": invoke({
		channel: "niagara-preview:frame",
		args: Schema.Tuple([NiagaraPreviewFrameIntent]),
		result: NiagaraPreviewFrameResult
	}),
	"map-review:review-sets": invoke({
		channel: "map-review:review-sets",
		args: EmptyArgs,
		result: MapReviewSetLibraryResult
	}),
	"map-review:create-review-set": invoke({
		channel: "map-review:create-review-set",
		args: Schema.Tuple([MapReviewSetCreateIntent]),
		result: MapReviewResult
	}),
	"map-review:select-review-set": invoke({
		channel: "map-review:select-review-set",
		args: Schema.Tuple([MapReviewSetSelectIntent]),
		result: MapReviewResult
	}),
	"map-review:world-snapshot": invoke({
		channel: "map-review:world-snapshot",
		args: EmptyArgs,
		result: WorldScoutResult
	}),
	"map-review:saved-world": invoke({
		channel: "map-review:saved-world",
		args: Schema.Tuple([Schema.NonEmptyString]),
		result: SavedWorld
	}),
	"map-review:saved-world-maps": invoke({
		channel: "map-review:saved-world-maps",
		args: EmptyArgs,
		result: Schema.Array(SavedWorldMap)
	}),
	"map-review:saved-world-progress": invoke({
		channel: "map-review:saved-world-progress",
		args: EmptyArgs,
		result: SavedWorldProgress
	}),
	"map-review:choose-project-and-maps": invoke({
		channel: "map-review:choose-project-and-maps",
		args: EmptyArgs,
		result: SavedWorldChoice
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
	"map-review:apply-visibility-policy": invoke({
		channel: "map-review:apply-visibility-policy",
		args: Schema.Tuple([MapReviewApplyVisibilityPolicyIntent]),
		result: MapReviewResult
	}),
	"map-review:replace-visibility-policy": invoke({
		channel: "map-review:replace-visibility-policy",
		args: Schema.Tuple([MapReviewReplaceVisibilityPolicyIntent]),
		result: MapReviewResult
	}),
	"map-review:author-from-selection": invoke({
		channel: "map-review:author-from-selection",
		args: Schema.Tuple([MapReviewAuthorFromSelectionIntent]),
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
export type InvokeArguments<Channel extends InvokeChannel> = Schema.Codec.Encoded<
	(typeof invokeContracts)[Channel]["args"]
>;
export type InvokeResult<Channel extends InvokeChannel> = Schema.Codec.Encoded<
	(typeof invokeContracts)[Channel]["result"]
>;

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

export const mapCaptureProgressEvent = {
	kind: "event",
	channel: "map-capture:progress",
	payload: MapCaptureProgressEvent
} as const;

// SAFETY: invokeContracts is the sole source of keys, so Object.keys cannot produce another channel.
const invokeContractKeys = Object.keys(invokeContracts) as Array<InvokeChannel>;
export const invokeChannelNames = invokeContractKeys;

export const decodeInvokeArgs = <C extends InvokeContract>(contract: C) =>
	Schema.decodeUnknownEffect(contract.args);

export const encodeInvokeResult = <C extends InvokeContract>(contract: C) =>
	Schema.encodeUnknownEffect(contract.result);

export const decodeCameraFrameEvent = Schema.decodeUnknownEffect(cameraFrameEvent.payload);
export const decodeMapCaptureProgressEvent = Schema.decodeUnknownEffect(
	mapCaptureProgressEvent.payload
);
export const decodeWorldObservationEvent = Schema.decodeUnknownEffect(
	worldObservationEvent.payload
);
