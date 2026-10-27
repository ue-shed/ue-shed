// Named exports only. Modules not listed in an entry point are private to the package.

export {
	STRING_TABLE_CLASS,
	type ScanTextCorpusOptions,
	TEXT_PROPERTY_NAME,
	TextCorpusScanError,
	TextCorpusScanLimit,
	TextCorpusScanOptions,
	TextCorpusService,
	type TextCorpusServiceApi,
	TextCorpusServiceLive,
	type TextCorpusServiceTestApi,
	type TextPackageCounts,
	type TextPackageOutcome,
	buildTextCorpus,
	makeTextCorpusServiceTestLayer,
	parseTextCorpusScanOptions,
	scanTextCorpus,
	textCorpusFromExtractionEvents,
	textOccurrenceFromExtraction,
	textOccurrenceId,
	textOccurrencesFromInspection,
	textPackagePathsFromProjectIndex
} from "./corpus.js";

export { type GameTextIndexBuildSessionRequest, GameTextIndexBuilder } from "./index-builder.js";

export {
	indexedLocalizationLinesRequest,
	indexedLocalizationStatusReport,
	readIndexedLocalizationEvidence
} from "./index-context.js";

export {
	GameTextIndexError,
	GameTextIndexRefresh,
	GameTextIndexRefreshRequest,
	type GameTextIndexRefreshResult,
	GameTextIndexSource,
	type GameTextIndexSourceRequest,
	type IndexedLocalizationQualityOptions,
	type IndexFailure
} from "./index-contract.js";

export {
	GameTextIndexPhase,
	GameTextIndexProgress,
	GameTextIndexProgressReporter
} from "./index-progress.js";

export type { PreparedLocalizationCheck } from "./localization-check-report.js";

export { gameTextIndexRefreshLayer } from "./index-refresh.js";

export {
	type RetainedGameTextIndexResult,
	makeRetainedGameTextIndex,
	makeRetainedGameTextIndexWith
} from "./index-retained.js";

export { gameTextIndexSourceNodeLayer } from "./index-source-node.js";

export {
	type GameTextIndexModel,
	GameTextIndexSteps,
	type GameTextIndexStepsOptions,
	type GameTextProject,
	type GameTextProjectIndex,
	GameTextProjectRefreshRequest,
	GameTextTargetBuildRequest,
	type GameTextTargetImport,
	GameTextTargetImportRequest,
	type GameTextTargetIndex,
	gameTextIndexStepsLayer,
	makeGameTextIndexSteps
} from "./index-steps.js";

export {
	LOCALIZATION_IMPORT_VERSION,
	type LocalizationFileImportRequest,
	type LocalizationFileSnapshotKey,
	LocalizationImportSource,
	type LocalizationImportSourceFile,
	type LocalizationTargetImportRequest,
	importLocalizationFile,
	importLocalizationTarget,
	localizationImportMetrics,
	prepareLocalizationFile
} from "./localization-import.js";

export { type GameTextProjectView } from "./project-index-view.js";

export { TextRulesFileError, createStarterTextRules } from "./rules-file.js";

export { SnapshotFormatError } from "./snapshot-format.js";

export { SnapshotStoreError } from "./snapshot-store.js";

export { GameTextIndexBuilderLive, nativeIndexBuilderLayer } from "./native-index-builder.js";

export {
	GAME_TEXT_ACTIONS_CAPABILITY,
	type GameTextActionMismatch,
	GameTextActionsError,
	type GameTextActionsOptions,
	type GameTextActionsVerification,
	gameTextActionForOccurrence,
	gameTextActionsRequest,
	runGameTextActions,
	verifyGameTextActions
} from "./text-actions.js";

export { nativeIndexQueryLayer, GameTextIndexQuery } from "./index-query-native.js";
export type { NativeTextQuery } from "./native-query.js";
