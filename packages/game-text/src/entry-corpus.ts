// Named exports only. Modules not listed in an entry point are private to the package.

export {
	MAX_CORPUS_REPORT_ITEMS,
	TextCorpusDiagnosticSummary,
	TextCorpusReport,
	TextPackageCoverageSummary,
	textCorpusDiagnosticSummary,
	textCorpusReport,
	textPackageCoverageSummary
} from "./corpus-summary.js";

export {
	gameTextCsv,
	gameTextQualityCsv,
	spreadsheetCsv,
	textAssetName,
	textQualityProblem
} from "./csv.js";

export {
	GameTextInvestigationExport,
	GameTextInvestigationPreset,
	GameTextInvestigationPresetResult,
	GameTextInvestigationQuery,
	exportGameTextInvestigation,
	gameTextInvestigationCsv
} from "./investigation.js";

export {
	LocalizationEdit,
	LocalizationEditOutcome,
	LocalizationEditRequest,
	LocalizationEditResult,
	MAX_LOCALIZATION_EDITS,
	localizationEditChangeSet,
	localizationEditOutcomes
} from "./localization-edits.js";

export {
	LocalizationLinesFileResult,
	localizationLinesCsv,
	pickedLocalizationCultures
} from "./localization-export.js";

export {
	LocalizationKeyChangePair,
	type LocalizationKeyChanges,
	applyLocalizationKeyChanges,
	localizationKeyChanges,
	localizationKeyChangesAcross,
	manifestPlace,
	mergeLocalizationKeyChanges
} from "./localization-key-changes.js";

export {
	localizationCounts,
	localizationLinePreview,
	localizationQueryPage,
	matchesLocalizationLine,
	scopedLocalizationMarks,
	validateLocalizationSelection
} from "./localization-query.js";

export {
	LocalizationBaseline,
	LocalizationBaselineDelta,
	LocalizationBaselineEntry,
	LocalizationBaselineKeyChange,
	LocalizationProgressCulture,
	LocalizationProgressReport,
	LocalizationReportError,
	createLocalizationBaseline,
	decodeLocalizationBaselineJson,
	diffLocalizationBaselines,
	localizationProgressReport
} from "./localization-reports.js";

export {
	LocalizationReviewChange,
	LocalizationReviewRequest,
	LocalizationReviewResult,
	acceptedFindingFilter,
	applyLocalizationReview,
	localizationLineFingerprint,
	matchesLocalizationReview,
	withoutAcceptedFindings
} from "./localization-review.js";

export {
	type LocalizationFileExplanation,
	LocalizationFileProblem,
	LocalizationFileStatus,
	LocalizationStatusReport,
	type LocalizationTargetFiles,
	explainLocalizationFile,
	localizationEvidenceFileStatuses,
	localizationEvidenceFolder,
	localizationFileProblems,
	localizationStatusReport,
	localizationTargetFiles
} from "./localization-status.js";

export {
	LocalizationFocus,
	LocalizationFocusRequest,
	LocalizationFocusResult,
	LocalizationTargetPreview,
	LocalizationTargetResult,
	LocalizationTargetsResult,
	LocalizationTranslation,
	localizationFocusPage
} from "./localization-view.js";

export {
	BuiltInQualityFilter,
	CustomQualityFilter,
	type LocalizationFindingGroup,
	type LocalizationFindingList,
	type LocalizationQuality,
	type LocalizationQualityMetadata,
	WorkspaceChangesResult,
	WorkspaceFinding,
	WorkspaceLocalizationFindingFocus,
	WorkspaceQualityFilter,
	WorkspaceQualityFocusRequest,
	WorkspaceQualityFocusResult,
	type WorkspaceQualityItem,
	WorkspaceQualityPage,
	WorkspaceQualityReport,
	WorkspaceQualityRequest,
	WorkspaceQualityResult,
	WorkspaceReportFileRequest,
	WorkspaceReportFileResult,
	WorkspaceReportPage,
	WorkspaceReportRequest,
	WorkspaceReportResult,
	WorkspaceReportRow,
	customQualityFilter,
	eligibleLocalizationChange,
	localizationFindingHash,
	localizationFindingId,
	localizationQuality,
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf,
	localizationReportCsv,
	localizationReportPage,
	workspaceQualityCsv,
	workspaceQualityFilterOf,
	workspaceQualityItem,
	workspaceQualityLabel,
	workspaceQualitySeverity
} from "./localization-workspace.js";

export {
	LocalizationGatherCoverage,
	gatheredTextIdentity,
	joinLocalizationTarget,
	localizationGatherCoverage,
	localizationGathersEditorOnlyData,
	localizationManifestNotes,
	localizationTextMatches,
	manifestPackageFile,
	matchesUnrealWildcard,
	textGatherScope
} from "./localization.js";

export {
	TextQualityFilter,
	TextQualityFindingId,
	TextQualityFindingKind,
	type TextQualityFindingList,
	TextQualityFindingSummary,
	TextQualityFocus,
	TextQualityFocusRequest,
	TextQualityFocusResult,
	type TextQualityQuery,
	TextQualityQueryRunResult,
	TextQualityQuerySummary,
	TextQualityRuleFile,
	TextQualityRuleUpdateResult,
	TextQualitySearchPage,
	TextQualitySearchRequest,
	TextQualitySearchResult,
	makeTextQualityFindingId,
	parseTextQualityFocusResult,
	parseTextQualityQueryRunResult,
	parseTextQualityRuleUpdateResult,
	parseTextQualitySearchResult,
	textQualityEvidenceHash,
	textQualityFindingHash,
	textQualityFindingId,
	textQualityFindingIdHash,
	textQualityFindingIdOf,
	textQualityQuery,
	textQualityQueryOf
} from "./quality-query.js";

export { hasSearchableSource } from "./search.js";

export { RUNTIME_COPY_KINDS, hasDifferingCopy, staleRuntimeCopy } from "./text-copies.js";

export {
	textAssetFacet,
	textAudienceFacet,
	textCultureFacet,
	textFolderFacet,
	textGroupOf,
	textGroups,
	textOriginFacet
} from "./text-groups.js";

export {
	PackageTextChange,
	PackageTextDiff,
	PackageTextPlace,
	diffPackageText,
	packageTextPlace
} from "./package-text-diff.js";
