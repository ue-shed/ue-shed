export {
	ArchiveEntry,
	ArchiveFileEvidence,
	CompileSettings,
	CultureCode,
	DashboardSettings,
	defaultLocalizationLimits,
	DuplicateIdentityDiagnostic,
	ExportSettings,
	FileProvenance,
	GatherFromMetaData,
	GatherFromPackages,
	GatherFromTextFiles,
	isLocalizationError,
	LocalizationArchive,
	LocalizationCollapseMode,
	LocalizationError,
	LocalizationErrorCode,
	localizationErrorGuidance,
	LocalizationErrorGuidanceFields,
	LocalizationErrorNextStep,
	LocalizationEvidenceRequest,
	LocalizationIdentity,
	LocalizationLimits,
	LocalizationManifest,
	LocalizationMeta,
	LocalizationOutputPaths,
	LocalizationProjectRequest,
	LocalizationRecipe,
	LocalizationTarget,
	LocalizationTargetDiscovery,
	LocalizationTargetEvidence,
	LocalizationTargetName,
	LocalizationTargetSettings,
	LocalizationTargetsReport,
	LocalizationText,
	ManifestEntry,
	ManifestFileEvidence,
	OpaqueRecord,
	POBlock,
	PODocument,
	POEntry,
	POEvidence,
	POFileEvidence,
	POFormat,
	POLine,
	POParseOptions,
	POStringField,
	RecipeFields,
	TargetDiagnostic,
	TextKey,
	TextNamespace,
	WordCountReport
} from "./schema.js";
export { type LocalizationGatherPath, resolveLocalizationGatherPath } from "./gather-path.js";
export { stripPackageNamespace } from "./text-namespace.js";
export {
	discoverLocalizationTargets,
	LocalizationConfigInput,
	parseDashboardTargets,
	parseLocalizationRecipe,
	parseStructText
} from "./targets.js";
export { localizationIdentityDiagnostics, parseArchive, parseManifest } from "./json-formats.js";
export {
	decodePOEscapes,
	parsePO,
	parsePOBlock,
	parsePOIdentity,
	projectPOEvidence,
	serializePO
} from "./po.js";
export { parseLocmeta, parseWordCountCSV } from "./reports.js";
export {
	decodeLocalizationChangeSet,
	LocalizationChange,
	LocalizationChangeSet,
	LocalizationChangeSetError
} from "./change-sets.js";
export {
	currentLocalizationTranslation,
	LocalizationChangeOutcome,
	LocalizationChangeReview,
	localizationChangeSetIsCurrent,
	LocalizationChangeSetReview,
	reviewLocalizationChangeSet
} from "./change-set-review.js";
export {
	escapePOString,
	POEditError,
	POEditFailureCode,
	POTranslationEdit,
	replacePOTranslations
} from "./po-writer.js";
export {
	decodeLocalizationReviewFile,
	defaultLocalizationReviewPath,
	emptyLocalizationReviewFile,
	encodeLocalizationReviewFile,
	LocalizationAcceptedFinding,
	localizationEvidenceFingerprint,
	LocalizationReviewFile,
	LocalizationReviewFileError,
	localizationReviewFingerprint,
	LocalizationReviewFlag,
	LocalizationReviewRecord,
	LocalizationReviewUpdate,
	updateLocalizationReviewFile
} from "./review-file.js";
export { sha256Hex } from "./sha256.js";
export {
	isLocalizationOperationError,
	LocalizationEngine,
	LocalizationFileChange,
	LocalizationOperation,
	LocalizationOperationError,
	LocalizationOperationPlan,
	LocalizationOperationReceipt,
	LocalizationPlannedFile,
	LocalizationPlannedStep,
	LocalizationPlanningRequest,
	LocalizationProcessStarted,
	LocalizationProgress,
	LocalizationRunEvent,
	LocalizationRunRequest,
	LocalizationStepKind
} from "./operation-schema.js";
export {
	availableLocalizationOperations,
	localizationOperationError,
	localizationOperationNextStep,
	localizationRelativePath,
	planLocalizationOperation
} from "./operation-plan.js";
export { localizationExitFailure, parseLocalizationProgress } from "./operation-progress.js";
export { validateUnrealJsonEscapes } from "./unreal-json.js";
export { localizationError } from "./decode.js";
