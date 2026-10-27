import { ErrorNextStep } from "@ue-shed/protocol/errors";
import type {
	GameTextInvestigationQuery,
	GameTextInvestigationPresetResult,
	LocalizationLinesFileResult
} from "@ue-shed/game-text/corpus";
import type {
	InvestigationFileResult,
	InvestigationFormat
} from "@ue-shed/unreal-assets/investigation";
import type {
	WorkspaceQualityRequest,
	WorkspaceQualityResult,
	WorkspaceQualityFocusRequest,
	WorkspaceQualityFocusResult,
	WorkspaceChangesResult,
	LocalizationEditRequest,
	LocalizationEditResult,
	LocalizationReviewRequest,
	LocalizationReviewResult,
	WorkspaceReportRequest,
	WorkspaceReportResult,
	WorkspaceReportFileRequest,
	WorkspaceReportFileResult,
	LocalizationTargetsResult,
	LocalizationTargetResult,
	LocalizationFocusRequest,
	LocalizationFocusResult,
	RelatedLinesRequest,
	RelatedLinesResult,
	TextQualityFocusRequest,
	TextQualityFocusResult,
	TextQualityQueryRunResult,
	TextQualityRuleUpdateResult,
	TextQualitySearchRequest,
	TextQualitySearchResult
} from "@ue-shed/game-text/corpus";
import type { GameTextRuleDocument } from "@ue-shed/game-text/rules";
import type {
	TextIdRepairRequest,
	TextIdRepairId,
	TextIdRepairResult,
	LocalizationSelection,
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusQueryRunResult,
	TextCorpusRowsResult,
	TextCorpusSearchRequest,
	TextCorpusSearchResult
} from "@ue-shed/game-text/schema";
import type { EditorAssetLocateResult } from "@ue-shed/protocol";
import { Context, type Effect, Schema, type Stream } from "effect";
import type {
	WorkbenchOperationRequest,
	WorkbenchOperationPlanResult,
	WorkbenchOperationResult,
	WorkbenchOperationState,
	WorkbenchOperationProgress,
	WorkbenchOperationFilesRequest,
	WorkbenchOperationFilesResult,
	GameTextWorkspaceProgress
} from "@ue-shed/game-text/schema";

export class GameTextClientError extends Schema.TaggedError<GameTextClientError>()(
	"GameTextClientError",
	{
		message: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: ErrorNextStep,
		code: Schema.Literal("game_text_client_failed"),
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface GameTextClientApi {
	readonly idRepairs?: {
		readonly prepare: (
			request: TextIdRepairRequest
		) => Effect.Effect<TextIdRepairResult, GameTextClientError>;
		readonly apply: (
			id: TextIdRepairId
		) => Effect.Effect<TextIdRepairResult, GameTextClientError>;
	};
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
	readonly localizationReview?: (
		request: LocalizationReviewRequest
	) => Effect.Effect<LocalizationReviewResult, GameTextClientError>;
	readonly localizationReport?: (
		request: WorkspaceReportRequest
	) => Effect.Effect<WorkspaceReportResult, GameTextClientError>;
	readonly localizationReportFile?: (
		request: WorkspaceReportFileRequest
	) => Effect.Effect<WorkspaceReportFileResult, GameTextClientError>;
	/** Every matching line, a column per culture, written to a CSV the person chooses. */
	readonly localizationLinesFile?: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<LocalizationLinesFileResult, GameTextClientError>;
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
	/** A selection's related units and lines, with their places and translations. */
	readonly related?: (
		request: RelatedLinesRequest
	) => Effect.Effect<RelatedLinesResult, GameTextClientError>;
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
	readonly focus: (
		request: TextCorpusFocusRequest
	) => Effect.Effect<TextCorpusFocusResult, GameTextClientError>;
	readonly loadConfiguredProject: (
		refresh?: boolean
	) => Effect.Effect<TextCorpusQueryRunResult, GameTextClientError>;
	readonly locateAsset: (
		objectPath: string
	) => Effect.Effect<EditorAssetLocateResult, GameTextClientError>;
	/** Game Text's progress, then each change to it, pushed by the host. */
	readonly progress: Stream.Stream<GameTextWorkspaceProgress, GameTextClientError>;
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchResult, GameTextClientError>;
	/**
	 * The request's rows, or its open groups' first rows, without the aggregates `search` adds:
	 * every read with a cursor, and the open groups after a grouped search.
	 */
	readonly searchRows: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusRowsResult, GameTextClientError>;
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
