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
	WorkbenchOperationFailure,
	GameTextOperationFilesRequest,
	WorkbenchOperationFilesRequest,
	GameTextOperationFilesResult,
	WorkbenchOperationFilesResult,
	GameTextOperationId,
	WorkbenchOperationId,
	GameTextOperationPlan,
	WorkbenchOperationPlan,
	GameTextOperationPlanResult,
	WorkbenchOperationPlanResult,
	GameTextOperationProgress,
	WorkbenchOperationProgress,
	GameTextOperationReceipt,
	WorkbenchOperationReceipt,
	GameTextOperationRequest,
	WorkbenchOperationRequest,
	GameTextOperationResult,
	WorkbenchOperationResult,
	GameTextOperationState,
	WorkbenchOperationState,
	GameTextOperationTarget,
	WorkbenchOperationTarget
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
	TextQualityRule,
	TextQualityRuleDocument,
	TextQualityRuleDocumentError,
	TextQualityRuleId,
	TextQualityRuleSummary,
	TextRole,
	TextRoleId,
	TextRoleMatcher,
	TextRoleScope,
	TextTerminologyEntry,
	decodeTextQualityRuleDocument,
	decodeTextQualityRuleDocumentJson,
	parseTextQualityReport
} from "./quality-schema.js";

export {
	MAX_TEXT_GROUPS,
	MAX_TEXT_SOURCE_LENGTH,
	MAX_TEXT_SOURCE_VALUES,
	MAX_TEXT_PICKED_LINES,
	MAX_TEXT_QUERY_PAGE_SIZE,
	MAX_TEXT_SCOPE_FILES,
	StringTableTextIdentity,
	TEXT_AUDIENCE_LABELS,
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
	TextCoverageGapCounts,
	TextCultureFacet,
	TextEditing,
	TextFacetRequest,
	TextFacets,
	TextFileScopeSummary,
	TextFilter,
	TextFilterClause,
	type TextFilterField,
	TextFinding,
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
	TextReviewLens,
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
	parseTextCorpusSearchResult
} from "./schema.js";

export { GameTextResponseError, gameTextResponseParser } from "./response-parser.js";

export {
	TextIdRepairChange,
	TextIdRepairRequest,
	TextIdRepairId,
	TextIdRepairPlan,
	TextIdRepairResult
} from "./id-repair-schema.js";
