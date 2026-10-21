export {
	countProjectIndex,
	countProjectIndexPages,
	decodeProjectIndexCount,
	decodeProjectIndexPage,
	decodeProjectIndexQuery,
	decodeProjectIndexTarget,
	foldProjectIndexRefresh,
	getProjectIndexCacheRoot,
	getProjectIndexStatus,
	isProjectIndexError,
	makeProjectIndexTestLayer,
	PROJECT_INDEX_CACHE_ROOT_ENV,
	PROJECT_INDEX_MAX_DIAGNOSTICS,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIdentity,
	ProjectIndex,
	type ProjectIndexApi,
	ProjectIndexCacheRoot,
	projectIndexCacheRootConfig,
	ProjectIndexConfig,
	projectIndexConfigLayer,
	ProjectIndexConfigLive,
	type ProjectIndexConfiguration,
	ProjectIndexCorruptCatalog,
	ProjectIndexCount,
	ProjectIndexCountResult,
	ProjectIndexCursor,
	ProjectIndexDiagnostic,
	type ProjectIndexError,
	ProjectIndexFilter,
	ProjectIndexGeneration,
	ProjectIndexHeader,
	ProjectIndexIncompatibleWorker,
	ProjectIndexInvalidRequest,
	ProjectIndexInventory,
	ProjectIndexItem,
	ProjectIndexMap,
	ProjectIndexPage,
	ProjectIndexQuery,
	ProjectIndexRefreshEvent,
	ProjectIndexRefreshFailed,
	ProjectIndexStaleGeneration,
	ProjectIndexStatus,
	ProjectIndexSummary,
	ProjectIndexTarget,
	ProjectIndexUnavailable,
	queryProjectIndex,
	rebuildProjectIndex,
	refreshProjectIndex,
	requireProjectIndexCacheRoot
} from "./project-index.js";
export {
	projectIndexMemoryLayer,
	projectIndexMemoryLayerWithConfig,
	type ProjectIndexMemoryOptions,
	type ProjectIndexMemorySeed
} from "./project-index-memory.js";
export {
	projectIndexCacheBytes,
	projectIndexChangedPackages,
	projectIndexEvidenceWrites,
	projectIndexGeneration,
	projectIndexMetrics,
	type ProjectIndexProcessConfiguration,
	projectIndexProcessLayer,
	projectIndexProcessLayerFromConfig,
	projectIndexProcessLayerFromReader,
	projectIndexProcessLayerWithConfig,
	projectIndexQuarantines,
	projectIndexQueryDuration,
	projectIndexRefreshDuration,
	projectIndexRemovedPackages,
	projectIndexTerminalState
} from "./project-index-process.js";
export {
	decodeProjectIndexWirePage,
	decodeProjectIndexWireSummary,
	mapProjectIndexProgress,
	mapProjectIndexProtocolFailure
} from "./project-index-protocol.js";
export {
	AssetReader,
	AssetReaderError,
	AssetReaderLive,
	BLUEPRINT_ASSET_CLASS_NAME_SUFFIXES,
	DEFAULT_CATALOG_TIMEOUT_MS,
	DEFAULT_TIMEOUT_MS,
	assetReaderLayer,
	assetReaderMetrics,
	discoverSavedAssets,
	discoverSavedTables,
	extractProjectText,
	extractProjectTextPackages,
	extractProjectTextures,
	getAssetReaderSource,
	makeAssetReaderTestLayer,
	readSavedAsset,
	readSavedBlueprint,
	readSavedLevelSequence,
	readSavedTable,
	readSavedWorld,
	SAVED_TABLE_SCAN_CLASSES,
	savedTableCatalogFromScan,
	savedTableDescriptorsFromInspection,
	scanSavedProject
} from "./asset-reader.js";
export type {
	AssetReaderConfiguration,
	AssetReaderOptions,
	AssetReaderProtocolObservation,
	AssetReaderApi,
	AssetReaderTestApi,
	ProtocolTerminalState,
	SavedAssetExtractionOptions,
	SavedAssetScanOptions,
	SavedAssetStagedPackageTextEvent,
	SavedAssetStagedTextExtractionOptions,
	SavedTableCatalogOptions,
	SavedWorldReadOptions
} from "./asset-reader.js";
export {
	batchProtocolPaths,
	MAX_PROTOCOL_PATH_BYTES,
	MAX_PROTOCOL_REQUEST_BYTES
} from "./protocol-request-limit.js";
export { resolveScanTarget, type ResolvedScanTarget } from "./scan-target.js";
export {
	BlueprintGraphDiagnostic,
	BlueprintGraphProjection,
	BlueprintGraphRead,
	decodeSavedAssetCatalogInspection,
	decodeSavedAssetInspection,
	decodeSavedWorld,
	isFullScanEntry,
	isHeaderScanEntry,
	SavedAssetCatalogInspection,
	SavedAssetDecodeError,
	SavedAssetHeader,
	SavedAssetHeaderExport,
	SavedAssetInspection,
	SavedAssetManifestEntry,
	SavedAssetScan,
	SavedAssetScanEntry,
	SavedAssetScanFailure,
	SavedAssetScanProgress,
	SavedAssetScanSummary,
	SavedAssetTextCoverageGap,
	SavedAssetBlueprintClasses,
	SavedAssetGatherCoverage,
	SavedAssetMissingGatherableText,
	SavedAssetPackageTextEvent,
	SavedAssetPackageTextRecord,
	SavedAssetTextExtractionEvent,
	SavedAssetTextOccurrence,
	SavedAssetTextureExtractionEvent,
	SavedAssetTextureRecord,
	SavedTableCatalog,
	SavedTableCatalogProgress,
	SavedTableDescriptor,
	SavedWorld,
	SavedWorldProgress
} from "@ue-shed/protocol";
export type { SavedProperty, SavedPropertyValue } from "@ue-shed/protocol";

export {
	blueprintReferences,
	compareSavedBlueprints,
	compareSavedSequences,
	resolveSavedReference,
	SavedReferenceResolution,
	SavedReviewAsset,
	SavedReviewChange,
	SavedReviewComparison,
	SavedReviewOutput,
	SavedReviewReference,
	SAVED_REVIEW_MAX_CHANGES,
	sequenceReferences
} from "./saved-review.js";

export {
	NativeGameTextIndexClient,
	type NativeGameTextIndexOutcome,
	nativeGameTextIndexClientLayer
} from "./game-text-index-client.js";
export { encodeGameTextJoinInput } from "@ue-shed/protocol";
export type { GameTextIndexBuildRequest, GameTextIndexBuildOutcome } from "@ue-shed/protocol";

export {
	NativeGameTextEngineClient,
	nativeGameTextEngineClientLayer
} from "./game-text-engine-client.js";
