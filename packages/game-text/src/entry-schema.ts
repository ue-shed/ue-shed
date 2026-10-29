// Named exports only. Modules not listed in an entry point are private to the package.

export {
	TextOccurrenceId,
	TextUnitId,
	makeTextOccurrenceId,
	makeTextUnitId
} from "./identifiers.js";

export {
	BuiltInCheckId,
	CheckSeverity,
	LocalizationCheckId,
	SourceCheckId
} from "./localization-check-ids.js";

export {
	LocalizationCheckDiagnostic,
	LocalizationCheckOptions,
	LocalizationCustomFinding,
	LocalizationPolicyFinding,
	LocalizationQualityFinding,
	LocalizationQualityReport,
	LocalizationRuleDiagnostic
} from "./localization-quality-schema.js";

export {
	GameTextLocalizationError,
	LocalizationCarriedTranslation,
	LocalizationCultureCounts,
	LocalizationCultureMark,
	LocalizationCultureState,
	LocalizationEvidenceLineId,
	LocalizationJoin,
	LocalizationKeyChange,
	LocalizationKeyChangeMatch,
	LocalizationLine,
	LocalizationLineId,
	LocalizationLinePreview,
	LocalizationQueryPage,
	LocalizationReviewLens,
	LocalizationReviewState,
	LocalizationSelection,
	LocalizationState,
	LocalizationStateCounts,
	LocalizationUnknownReason,
	MAX_LOCALIZATION_CULTURES,
	localizationManifestFailure,
	localizationStates
} from "./localization-schema.js";

export {
	OperationRelativePath,
	GameTextOperationFailure,
	GameTextOperationFilesRequest,
	GameTextOperationFilesResult,
	GameTextOperationId,
	GameTextOperationPlan,
	GameTextOperationPlanResult,
	GameTextOperationProgress,
	GameTextOperationReceipt,
	GameTextOperationRequest,
	GameTextOperationResult,
	GameTextOperationState,
	GameTextOperationTarget
} from "./operation-query.js";

export {
	CharacterBudgetActual,
	CharacterBudgetExpectation,
	TerminologyActual,
	TerminologyExpectation,
	TextQualityAffectedOccurrence,
	TextQualityFinding,
	TextQualityReport,
	TextQualityRoleSummary,
	TextQualityRuleId,
	TextQualityRuleSummary,
	TextRole,
	TextRoleId,
	TextRoleMatcher,
	TextRoleScope,
	TextTerminologyEntry,
	parseTextQualityReport
} from "./quality-schema.js";
export { TextQualityRule } from "./game-text-rules.js";

export {
	MAX_TEXT_GROUPS,
	MAX_TEXT_OPEN_GROUPS,
	MAX_TEXT_SOURCE_LENGTH,
	MAX_TEXT_SOURCE_VALUES,
	MAX_TEXT_PICKED_LINES,
	MAX_TEXT_QUERY_PAGE_SIZE,
	MAX_TEXT_SECTION_ROWS,
	TextSectionRows,
	MAX_TEXT_SCOPE_FILES,
	StringTableTextIdentity,
	TEXT_AUDIENCE_LABELS,
	TextAssetType,
	TextAudience,
	TextAudienceReason,
	TextCapabilityFilter,
	TextCopyKind,
	TextCorpus,
	TextCorpusDiagnostic,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusPublicError,
	TextCorpusQueryRunResult,
	TextCorpusQuerySummary,
	TextCorpusRunResult,
	TextCorpusSearchCounts,
	TextCorpusSearchPage,
	TextCorpusSearchRequest,
	TextCorpusSearchResult,
	TextCorpusRows,
	TextCorpusRowsPage,
	TextCorpusRowsResult,
	TextOpenGroupRows,
	TextCoverageGapCounts,
	TextCultureFacet,
	TextEditing,
	TextFacetRequest,
	TextFactCounts,
	TextFacets,
	TextFileScopeSummary,
	TextFilter,
	TextFilterClause,
	type TextFilterField,
	TextGroup,
	TextGroupBy,
	TextGroupList,
	TextIdentity,
	TextLocation,
	TextNotes,
	TextOccurrence,
	TextOriginKind,
	TextOutOfScopeReason,
	TextPackageCoverage,
	TextProblem,
	TextProblemCounts,
	TextRepresentationCopy,
	TextReviewSignal,
	TextTranslationKey,
	TextSourceText,
	TextTranslationState,
	TextUnit,
	TextUnitContext,
	TextUnitSearchResult,
	TextWhere,
	UnrealTextIdentity,
	UnresolvedTextIdentity,
	parseTextCorpusFocusResult,
	parseTextCorpusQueryRunResult,
	parseTextCorpusRunResult,
	parseTextCorpusSearchResult,
	parseTextCorpusRowsResult
} from "./schema.js";

export { GameTextResponseError, gameTextResponseParser } from "./response-parser.js";

export {
	TextIdRepairChange,
	TextIdRepairRequest,
	TextIdRepairId,
	TextIdRepairPlan,
	TextIdRepairResult
} from "./id-repair-schema.js";

export {
	LocalizationLineField,
	LocalizationLineMark,
	LocalizationLinePlace,
	TextAggregate,
	TextAggregateDimension,
	TextAggregateGroup,
	TextAggregateMeasure,
	TextAggregateRequest,
	TextCorpusHeader,
	type LocalizationLineView
} from "./index-reads.js";

export { GameTextIndexPhase, GameTextIndexProgress } from "./index-progress.js";

export { GameTextWorkspacePhase, GameTextWorkspaceProgress } from "./workspace-progress.js";

export {
	GameTextInvestigationExportRequest,
	GameTextStarterRulesRequest,
	GameTextWorkspaceContract,
	type GameTextWorkspaceContractApi,
	type GameTextWorkspaceContractEntry,
	type GameTextWorkspaceContractMethod,
	type GameTextWorkspaceContractMismatch,
	type GameTextWorkspaceContractName,
	type GameTextWorkspaceHostOnlyMethod,
	GameTextWorkspaceNoParams,
	GameTextWorkspaceRefreshRequest
} from "./workspace-contract.js";

export {
	ChangeComparisonRequest,
	ChangeComparisonResult,
	ChangeComparisonTarget,
	ChangeFinding,
	ChangePlace,
	ChangeRow,
	ChangeText,
	GameTextChange,
	MAX_CHANGE_PAGE,
	gameTextChangeLabel,
	gameTextChangePoints
} from "./change-comparison.js";

export {
	LocalizationFileChange,
	LocalizationFileComparisonRequest,
	LocalizationFileComparisonResult,
	LocalizationFileField,
	LocalizationFileFormat,
	LocalizationFilePair,
	localizationFileFormat
} from "./file-comparison.js";
