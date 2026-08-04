export * from "./project-index.js";
export * from "./project-index-memory.js";
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
	assetReaderLayer,
	assetReaderMetrics,
	discoverSavedAssets,
	discoverSavedTables,
	extractProjectText,
	extractProjectTextures,
	getAssetReaderSource,
	makeAssetReaderTestLayer,
	readSavedAsset,
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
	AssetReaderShape,
	AssetReaderTestShape,
	ProtocolTerminalState,
	SavedAssetExtractionOptions,
	SavedAssetScanOptions,
	SavedTableCatalogOptions,
	SavedWorldReadOptions
} from "./asset-reader.js";
export {
	ProtocolOutputBudget,
	ProtocolStreamValidator,
	protocolCacheOutcome
} from "./protocol-transport.js";
export { resolveScanTarget, type ResolvedScanTarget } from "./scan-target.js";
export {
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
