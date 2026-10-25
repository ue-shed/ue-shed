// Named exports only. Modules not listed in an entry point are private to the package.

export {
	MAX_CORPUS_REPORT_ITEMS,
	TextCorpusDiagnosticSummary,
	TextCorpusReport,
	TextCorpusReportHeader,
	TextPackageCoverageSummary,
	textCorpusDiagnosticSummary,
	textCorpusReport,
	textCorpusReportHeader,
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
	investigationRequest,
	readFindingUnits,
	type IndexedInvestigationSource,
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
	LOCALIZATION_LINES_CSV_FIELDS,
	type LocalizationCsvLine,
	localizationLinesCsv,
	pickedLocalizationCultures
} from "./localization-export.js";

export {
	LocalizationKeyChangePair,
	KEY_CHANGE_FIELDS,
	type KeyChangeLine,
	type LocalizationCarryChanges,
	type LocalizationKeyChanges,
	applyLocalizationKeyChanges,
	localizationCarryChanges,
	localizationKeyChanges,
	localizationKeyChangesAcross,
	manifestPlace,
	mergeLocalizationKeyChanges
} from "./localization-key-changes.js";

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
	indexedLocalizationBaseline,
	indexedLocalizationProgressReport,
	localizationProgressReport,
	type LocalizationReportIndex
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
	RelatedLine,
	RelatedLines,
	RelatedLinesRequest,
	RelatedLinesResult,
	RelatedMember,
	RelatedSection,
	RelatedUnit
} from "./related-lines.js";

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
	type LocalizationQualityWorkspace,
	type QueriedLocalizationQuality,
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

export { gatheredIdentityKey } from "./gathered-text.js";

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
	type AsyncTextQualityQuery,
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
