import type {
	GameTextInvestigationQuery,
	GameTextInvestigationPresetResult,
	InvestigationFileResult,
	InvestigationFormat
} from "@ue-shed/game-text/browser";
import type {
	WorkspaceQualityRequest,
	WorkspaceQualityResult,
	WorkspaceQualityFocusRequest,
	WorkspaceQualityFocusResult,
	WorkspaceChangesResult,
	LocalizationEditRequest,
	LocalizationEditResult,
	WorkspaceReportRequest,
	WorkspaceReportResult,
	WorkspaceReportFileRequest,
	WorkspaceReportFileResult,
	LocalizationTargetsResult,
	LocalizationTargetResult,
	LocalizationFocusRequest,
	LocalizationFocusResult,
	LocalizationSelection,
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusQueryRunResult,
	TextCorpusSearchRequest,
	TextCorpusSearchResult,
	TextQualityFocusRequest,
	TextQualityFocusResult,
	TextQualityQueryRunResult,
	GameTextRuleDocument,
	TextQualityRuleUpdateResult,
	TextQualitySearchRequest,
	TextQualitySearchResult
} from "@ue-shed/game-text/browser";
import type { EditorAssetLocateResult } from "@ue-shed/protocol";
import type { TaskProgress } from "@ue-shed/ui/task-progress";
import { Context, type Effect, Schema, type Stream } from "effect";
import type {
	WorkbenchOperationRequest,
	WorkbenchOperationPlanResult,
	WorkbenchOperationResult,
	WorkbenchOperationState,
	WorkbenchOperationProgress,
	WorkbenchOperationFilesRequest,
	WorkbenchOperationFilesResult
} from "@ue-shed/game-text/browser";

export class GameTextClientError extends Schema.TaggedErrorClass<GameTextClientError>()(
	"GameTextClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface GameTextClientApi {
	readonly operations?: {
		readonly state: (
			target: LocalizationSelection["target"]
		) => Effect.Effect<WorkbenchOperationState, GameTextClientError>;
		readonly plan: (
			request: WorkbenchOperationRequest
		) => Effect.Effect<WorkbenchOperationPlanResult, GameTextClientError>;
		readonly run: (id: string) => Effect.Effect<WorkbenchOperationResult, GameTextClientError>;
		readonly cancel: (
			id: string
		) => Effect.Effect<WorkbenchOperationResult, GameTextClientError>;
		readonly files: (
			request: WorkbenchOperationFilesRequest
		) => Effect.Effect<WorkbenchOperationFilesResult, GameTextClientError>;
		readonly progress: Stream.Stream<WorkbenchOperationProgress, GameTextClientError>;
	};
	readonly localizationQualitySearch?: (
		request: WorkspaceQualityRequest
	) => Effect.Effect<WorkspaceQualityResult, GameTextClientError>;
	readonly localizationQualityFocus?: (
		request: WorkspaceQualityFocusRequest
	) => Effect.Effect<WorkspaceQualityFocusResult, GameTextClientError>;
	readonly localizationChanges?: (
		request: WorkspaceQualityRequest
	) => Effect.Effect<WorkspaceChangesResult, GameTextClientError>;
	readonly localizationEdits?: (
		request: LocalizationEditRequest
	) => Effect.Effect<LocalizationEditResult, GameTextClientError>;
	readonly localizationReport?: (
		request: WorkspaceReportRequest
	) => Effect.Effect<WorkspaceReportResult, GameTextClientError>;
	readonly localizationReportFile?: (
		request: WorkspaceReportFileRequest
	) => Effect.Effect<WorkspaceReportFileResult, GameTextClientError>;
	readonly localizationTargets?: () => Effect.Effect<
		LocalizationTargetsResult,
		GameTextClientError
	>;
	readonly localizationTarget?: (
		target: LocalizationSelection["target"]
	) => Effect.Effect<LocalizationTargetResult, GameTextClientError>;
	readonly localizationFocus?: (
		request: LocalizationFocusRequest
	) => Effect.Effect<LocalizationFocusResult, GameTextClientError>;
	readonly projectKey?: () => Effect.Effect<string | undefined, GameTextClientError>;
	readonly reloadQualityRules?: () => Effect.Effect<
		TextQualityQueryRunResult,
		GameTextClientError
	>;
	readonly createStarterRules?: (
		loadExisting: boolean
	) => Effect.Effect<TextQualityQueryRunResult, GameTextClientError>;
	readonly investigations?: {
		readonly export: (
			query: GameTextInvestigationQuery,
			format: InvestigationFormat
		) => Effect.Effect<InvestigationFileResult, GameTextClientError>;
		readonly save: (
			query: GameTextInvestigationQuery
		) => Effect.Effect<InvestigationFileResult, GameTextClientError>;
		readonly open: () => Effect.Effect<GameTextInvestigationPresetResult, GameTextClientError>;
	};
	readonly chooseProjectAndScan: () => Effect.Effect<
		TextCorpusQueryRunResult,
		GameTextClientError
	>;
	readonly focus: (
		request: TextCorpusFocusRequest
	) => Effect.Effect<TextCorpusFocusResult, GameTextClientError>;
	readonly loadConfiguredProject: (
		refresh?: boolean
	) => Effect.Effect<TextCorpusQueryRunResult, GameTextClientError>;
	readonly locateAsset: (
		objectPath: string
	) => Effect.Effect<EditorAssetLocateResult, GameTextClientError>;
	readonly progress: () => Effect.Effect<TaskProgress, GameTextClientError>;
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchResult, GameTextClientError>;
	readonly chooseQualityRules: () => Effect.Effect<
		TextQualityQueryRunResult,
		GameTextClientError
	>;
	readonly qualityFocus: (
		request: TextQualityFocusRequest
	) => Effect.Effect<TextQualityFocusResult, GameTextClientError>;
	readonly qualitySearch: (
		request: TextQualitySearchRequest
	) => Effect.Effect<TextQualitySearchResult, GameTextClientError>;
	readonly previewQualityRules: (
		document: GameTextRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError>;
	readonly saveQualityRules: (
		document: GameTextRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError>;
}

export class GameTextClient extends Context.Service<GameTextClient, GameTextClientApi>()(
	"@ue-shed/extension-game-text/GameTextClient"
) {}
