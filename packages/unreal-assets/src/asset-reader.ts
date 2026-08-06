import {
	isHeaderScanEntry,
	SavedAssetCatalogInspection,
	SavedAssetInspection,
	SavedAssetScan,
	SavedAssetScanEntry,
	SavedAssetScanProgress,
	SavedAssetTextExtractionEvent,
	SavedAssetTextureExtractionEvent,
	SavedTableCatalog,
	SavedTableCatalogProgress,
	SavedTableDescriptor,
	SavedWorld,
	SavedWorldProgress,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import { Config, Context, Duration, Effect, Layer, Metric, Option, Schema, Stream } from "effect";

export const MAX_PROTOCOL_OUTPUT_BYTES = 1024 * 1024 * 1024;
export const MAX_CAPTURED_STDERR_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CATALOG_TIMEOUT_MS = 5 * 60_000;

export const assetReaderQueueDuration = Metric.histogram("ue_shed_asset_reader_queue_duration_ms", {
	boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 1_000, 5_000],
	description: "Time an AssetReader operation waits before its native worker starts"
});
export const assetReaderStartupDuration = Metric.histogram(
	"ue_shed_asset_reader_startup_duration_ms",
	{
		boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 1_000, 5_000],
		description: "Time for a native AssetReader worker to accept a request"
	}
);
export const assetReaderDiscoveryDuration = Metric.histogram(
	"ue_shed_asset_reader_discovery_duration_ms",
	{
		boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 1_000, 5_000, 30_000],
		description: "Time an AssetReader worker spends discovering package inputs"
	}
);
export const assetReaderReadBytes = Metric.counter("ue_shed_asset_reader_read_bytes_total", {
	description:
		"Package and sidecar bytes explicitly reported in AssetReader result frames; operations without byte fields contribute zero",
	incremental: true
});
export const assetReaderInspectedFiles = Metric.counter(
	"ue_shed_asset_reader_inspected_files_total",
	{
		description:
			"Asset/package/item counts explicitly reported in AssetReader result frames; this is not an estimate of unreported file reads",
		incremental: true
	}
);
export const assetReaderPartialFailures = Metric.counter(
	"ue_shed_asset_reader_partial_failure_total",
	{
		description: "Partial package results and per-file AssetReader failures",
		incremental: true
	}
);
export const assetReaderCancellations = Metric.counter("ue_shed_asset_reader_cancellation_total", {
	description: "AssetReader operations cancelled before their terminal event",
	incremental: true
});
export const assetReaderCacheOutcome = Metric.frequency(
	"ue_shed_asset_reader_cache_outcome_total",
	{
		description: "AssetReader cache outcomes"
	}
);
export const assetReaderTerminalState = Metric.frequency("ue_shed_asset_reader_terminal_total", {
	description: "AssetReader protocol terminal states"
});

/** Metrics are exported for hosts that install an Effect metrics exporter. */
export const assetReaderMetrics = {
	cacheOutcome: assetReaderCacheOutcome,
	cancellations: assetReaderCancellations,
	discoveryDuration: assetReaderDiscoveryDuration,
	inspectedFiles: assetReaderInspectedFiles,
	partialFailures: assetReaderPartialFailures,
	queueDuration: assetReaderQueueDuration,
	readBytes: assetReaderReadBytes,
	startupDuration: assetReaderStartupDuration,
	terminalState: assetReaderTerminalState
};

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

export class AssetReaderError extends Schema.TaggedErrorClass<AssetReaderError>()(
	"AssetReaderError",
	{
		kind: Schema.Literals(["timeout", "process", "contract", "discovery", "resource_limit"]),
		operation: Schema.Literals([
			"authoring",
			"catalog",
			"extract_text",
			"extract_texture",
			"inspect",
			"discovery",
			"scan",
			"saved_world"
		]),
		message: Schema.String,
		retrySafe: Schema.Boolean,
		path: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number)
	}
) {}

export interface AssetReaderOptions {
	readonly assetPath: string;
}

export interface SavedTableCatalogOptions {
	readonly cachePath?: string;
	readonly projectRoot: string;
	readonly concurrency?: number;
}

/**
 * One batched project scan. The class and name filters are header-only selection rules evaluated
 * inside the reader, so unselected packages are never fully read or decoded. A package is selected
 * when it matches any rule; with no rules every package is selected.
 */
export interface SavedAssetScanOptions {
	/** Select packages exporting a class under this path prefix, e.g. `/Script/EnhancedInput.`. */
	readonly classPrefixes?: readonly string[];
	/**
	 * Select packages whose serialized class object's name ends with this suffix. This finds
	 * conventionally named native subclasses, not a resolved Unreal inheritance hierarchy.
	 */
	readonly classNameSuffixes?: readonly string[];
	/** Select packages exporting this class, as a full path or a bare class name. */
	readonly classes?: readonly string[];
	readonly concurrency?: number;
	/**
	 * Reuse header results for packages whose size and mtime are unchanged. Requires
	 * `depth: "header"`. The cache is scoped to the class filters it was written with, so a caller
	 * with different filters must name a different path.
	 */
	readonly cachePath?: string;
	/**
	 * `"header"` stops at the package summary and export table, answering "what classes are in this
	 * project" from the one header read the filters already need. `"full"` decodes every property
	 * stream and re-reads the whole file. Defaults to `"full"`.
	 */
	readonly depth?: "header" | "full";
	/** Stream a complete package-and-sidecar signature inventory alongside selected assets. */
	readonly inventory?: boolean;
	/** Refuse the scan when enumeration finds more packages than this, before any decode. */
	readonly maximumAssets?: number;
	/**
	 * Select packages whose name table contains this entry, e.g. the `TextProperty` type name.
	 * Header scans retain only matching requested names, so this can reuse the header cache.
	 */
	readonly names?: readonly string[];
	/** Roots to enumerate, relative to the project root or absolute. Defaults to `Content`. */
	readonly paths?: readonly string[];
	readonly projectRoot: string;
}

/**
 * Runs one compact domain projection. When `paths` is omitted the reader selects its own
 * candidates from package headers; an explicit empty list is intentionally a no-op and never
 * falls back to `Content`.
 */
export interface SavedAssetExtractionOptions {
	readonly concurrency?: number;
	readonly maximumAssets?: number;
	readonly paths?: readonly string[];
	readonly projectRoot: string;
}

/** Reads saved actors belonging to exactly one conventional or World Partition map. */
export interface SavedWorldReadOptions {
	readonly concurrency?: number;
	/** Refuse the map before decode when it has more selected packages than this. */
	readonly maximumAssets?: number;
	/** A `.umap` path inside `projectRoot`, relative to it or absolute. */
	readonly mapPath: string;
	readonly projectRoot: string;
}

export interface AssetReaderConfiguration {
	readonly catalogTimeoutMs: number;
	readonly executable: string;
	/** Aggregate process evidence for benchmarks and host telemetry; never includes asset paths. */
	readonly protocolObserver?: (event: AssetReaderProtocolObservation) => void;
	readonly timeoutMs: number;
}

export type ProtocolTerminalState = "complete" | "partial" | "failed" | "rejected" | "cancelled";

export type AssetReaderProtocolObservation =
	| {
			readonly kind: "worker_started";
			readonly pid: number;
	  }
	| {
			readonly kind: "worker_completed";
			readonly largestFrameBytes: number;
			readonly outputBytes: number;
			readonly pid?: number;
			readonly terminalState: ProtocolTerminalState;
	  };

export interface AssetReaderShape {
	readonly catalogProgress?: () => Effect.Effect<SavedTableCatalogProgress>;
	/** Returns the native worker settings needed by sibling headless adapters. */
	readonly configuration: () => Effect.Effect<AssetReaderConfiguration>;
	readonly discoverAssets: (
		projectRoot: string
	) => Effect.Effect<readonly string[], AssetReaderError>;
	readonly discoverTables: (
		options: SavedTableCatalogOptions
	) => Effect.Effect<SavedTableCatalog, AssetReaderError>;
	/** Streams compact FText and StringTable evidence without generic inspection payloads. */
	readonly extractProjectText: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetTextExtractionEvent, AssetReaderError>;
	/** Streams compact Texture2D facts without generic inspection payloads. */
	readonly extractProjectTextures: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetTextureExtractionEvent, AssetReaderError>;
	readonly readAsset: (
		assetPath: string
	) => Effect.Effect<SavedAssetInspection, AssetReaderError>;
	readonly readTable: (
		assetPath: string
	) => Effect.Effect<AuthoringTableSnapshot, AssetReaderError>;
	/** Reads one saved map's actors without requiring a live Unreal connection. */
	readonly readSavedWorld: (
		options: SavedWorldReadOptions
	) => Effect.Effect<SavedWorld, AssetReaderError>;
	/**
	 * Inspects every selected package under one project in a single reader process. Prefer this
	 * over `discoverAssets` plus `readAsset` per path for any project-wide scan.
	 */
	readonly scanProject: (
		options: SavedAssetScanOptions
	) => Effect.Effect<SavedAssetScan, AssetReaderError>;
	readonly scanProgress: () => Effect.Effect<SavedAssetScanProgress>;
	readonly savedWorldProgress: () => Effect.Effect<SavedWorldProgress>;
	readonly source: () => Effect.Effect<"configured" | "path">;
}

/** Optional members a test layer may omit; `makeAssetReaderTestLayer` supplies the defaults. */
type AssetReaderTestDefaults =
	| "catalogProgress"
	| "configuration"
	| "extractProjectText"
	| "extractProjectTextures"
	| "readSavedWorld"
	| "savedWorldProgress"
	| "scanProgress"
	| "scanProject";

export type AssetReaderTestShape = Omit<AssetReaderShape, AssetReaderTestDefaults> &
	Partial<Pick<AssetReaderShape, AssetReaderTestDefaults>>;

export class AssetReader extends Context.Service<AssetReader, AssetReaderShape>()(
	"@ue-shed/unreal-assets/AssetReader"
) {}

export interface CatalogProgressStore {
	current: SavedTableCatalogProgress;
}

export interface ScanProgressStore {
	current: SavedAssetScanProgress;
}

export interface SavedWorldProgressStore {
	current: SavedWorldProgress;
}

const idleScanProgress = (): SavedAssetScanProgress => ({
	cacheHits: 0,
	emittedAssets: 0,
	phase: "idle",
	processedAssets: 0,
	totalAssets: 0
});

const idleCatalogProgress = (): SavedTableCatalogProgress => ({
	cacheHits: 0,
	phase: "idle",
	processedAssets: 0,
	tablesFound: 0,
	totalAssets: 0
});

const idleSavedWorldProgress = (): SavedWorldProgress => ({
	actorsFound: 0,
	phase: "idle",
	processedPackages: 0,
	totalPackages: 0
});

export function savedTableDescriptorsFromInspection(
	inspection: SavedAssetCatalogInspection
): readonly SavedTableDescriptor[] {
	return inspection.assets.flatMap((asset): SavedTableDescriptor[] => {
		if (asset.kind !== "DataTable" && asset.kind !== "CompositeDataTable") return [];
		return [
			{
				assetPath: inspection.path,
				authority: { kind: "project_files", packageName: inspection.package.name },
				completeness: inspection.status === "partial" ? "partial" : "complete",
				kind: asset.kind === "DataTable" ? "data_table" : "composite_data_table",
				objectPath: asset.object_path,
				parentTables: asset.parent_tables,
				rowStruct: asset.row_struct ?? "",
				schema: {
					reason: "Saved row-structure schema has not been resolved for this table.",
					status: "unavailable"
				}
			}
		];
	});
}

const DATA_TABLE_CLASS = "/Script/Engine.DataTable";
const COMPOSITE_DATA_TABLE_CLASS = "/Script/Engine.CompositeDataTable";

const HEADER_SCHEMA_UNAVAILABLE = {
	reason: "Catalog metadata is header-only; open the table to decode its saved schema.",
	status: "unavailable"
} as const;

/**
 * Republishes scan progress as catalog progress, so a caller polling `catalogProgress` keeps
 * working now that the catalog is a projection of the generic scan.
 *
 * `tablesFound` counts emitted *packages*, not tables. A package exporting two DataTables advances
 * it by one. It drives a progress indicator, not a result count.
 */
function catalogProgressBridge(catalog: CatalogProgressStore): ScanProgressStore {
	let latest = idleScanProgress();
	return {
		get current(): SavedAssetScanProgress {
			return latest;
		},
		set current(next: SavedAssetScanProgress) {
			latest = next;
			catalog.current = {
				cacheHits: next.cacheHits,
				phase: next.phase,
				processedAssets: next.processedAssets,
				tablesFound: next.emittedAssets,
				totalAssets: next.totalAssets
			};
		}
	};
}

export const SAVED_TABLE_SCAN_CLASSES = [DATA_TABLE_CLASS, COMPOSITE_DATA_TABLE_CLASS] as const;

function tableDescriptorsFrom(entry: SavedAssetScanEntry): SavedTableDescriptor[] {
	if (!isHeaderScanEntry(entry)) return [];
	return entry.header.exports.flatMap((exported) => {
		const kind =
			exported.class_path === COMPOSITE_DATA_TABLE_CLASS
				? ("composite_data_table" as const)
				: exported.class_path === DATA_TABLE_CLASS
					? ("data_table" as const)
					: undefined;
		if (kind === undefined) return [];
		return [
			{
				assetPath: entry.header.path,
				authority: {
					kind: "project_files" as const,
					packageName: entry.header.package.name
				},
				// Header depth reads no property stream, so the row struct and parent tables stay
				// unknown until a table is opened. The dedicated catalog reader was no different.
				completeness: "partial" as const,
				kind,
				objectPath: exported.object_path,
				parentTables: [],
				rowStruct: "",
				schema: HEADER_SCHEMA_UNAVAILABLE
			}
		];
	});
}

/** A pure DataTable projection of a header scan. No filesystem or process operation occurs here. */
export function savedTableCatalogFromScan(scan: SavedAssetScan): SavedTableCatalog {
	return {
		diagnostics: [
			...scan.summary.diagnostics,
			...scan.failures.map(({ code, message, path, retrySafe }) => ({
				code,
				message,
				path,
				retrySafe
			}))
		],
		projectRoot: scan.summary.projectRoot,
		scannedAssets: scan.summary.scannedAssets,
		tables: scan.assets
			.flatMap(tableDescriptorsFrom)
			.sort((left, right) => left.objectPath.localeCompare(right.objectPath))
	};
}

// Import after shared AssetReader constants/types so the protocol transport can load them without a
// circular initialization failure. Call-time use of these helpers is intentional.
import {
	invokeProtocolScan,
	invokeProtocolSingle,
	makeProtocolRequest,
	protocolProjectionStream,
	updateSavedWorldProgress
} from "./protocol-transport.js";

/**
 * Discovers saved packages through the native header scan. Filesystem traversal is an IO concern,
 * so the TypeScript reader only projects the paths returned by the protocol.
 */
function discoverSavedAssetsWith(
	configuration: AssetReaderConfiguration,
	projectRoot: string
): Effect.Effect<readonly string[], AssetReaderError> {
	const progress: ScanProgressStore = { current: idleScanProgress() };
	return invokeProtocolScan(configuration, { depth: "header", projectRoot }, progress).pipe(
		Effect.map((scan) =>
			scan.assets
				.flatMap((entry) => (isHeaderScanEntry(entry) ? [entry.header.path] : []))
				.sort((left, right) => left.localeCompare(right))
		),
		Effect.withSpan("unreal_assets.discover_saved_assets", {
			attributes: { "unreal.project_root": projectRoot }
		})
	);
}

/**
 * Discovers saved DataTables as a projection of the generic header-depth scan.
 *
 * This used to be a dedicated `catalog` subcommand that enumerated the project a second time with
 * its own cache. Selecting the DataTable classes at header depth answers the same question from the
 * shared scan, measurably faster, and leaves one project enumeration instead of two.
 */
function makeAssetReader(
	configuration: AssetReaderConfiguration & { readonly source: "configured" | "path" },
	progress: CatalogProgressStore,
	scanStore: ScanProgressStore,
	savedWorldStore: SavedWorldProgressStore
): AssetReaderShape {
	const catalogProgress = Effect.fn("AssetReader.catalogProgress")(() =>
		Effect.sync(() => progress.current)
	);
	const getConfiguration = Effect.fn("AssetReader.configuration")(() =>
		Effect.succeed({
			catalogTimeoutMs: configuration.catalogTimeoutMs,
			executable: configuration.executable,
			...(configuration.protocolObserver === undefined
				? {}
				: { protocolObserver: configuration.protocolObserver }),
			timeoutMs: configuration.timeoutMs
		})
	);
	const scanProgress = Effect.fn("AssetReader.scanProgress")(() =>
		Effect.sync(() => scanStore.current)
	);
	const savedWorldProgress = Effect.fn("AssetReader.savedWorldProgress")(() =>
		Effect.sync(() => savedWorldStore.current)
	);
	const scanProject = Effect.fn("AssetReader.scanProject")(function* (
		options: SavedAssetScanOptions
	) {
		return yield* invokeProtocolScan(configuration, options, scanStore).pipe(
			Effect.withSpan("unreal_assets.scan_project", {
				attributes: { "unreal.project_root": options.projectRoot }
			})
		);
	});
	const extractProjectText = (options: SavedAssetExtractionOptions) =>
		options.paths?.length === 0
			? Stream.empty
			: protocolProjectionStream({
					configuration,
					extraction: options,
					projection: "text",
					scanStore,
					decode: (result) => (result.kind === "extract_text" ? result.event : undefined)
				});
	const extractProjectTextures = (options: SavedAssetExtractionOptions) =>
		options.paths?.length === 0
			? Stream.empty
			: protocolProjectionStream({
					configuration,
					extraction: options,
					projection: "texture",
					scanStore,
					decode: (result) =>
						result.kind === "extract_texture" ? result.event : undefined
				});
	const discoverAssets = Effect.fn("AssetReader.discoverAssets")(function* (projectRoot: string) {
		return yield* discoverSavedAssetsWith(configuration, projectRoot);
	});
	const readAsset = Effect.fn("AssetReader.readAsset")(function* (assetPath: string) {
		return yield* invokeProtocolSingle({
			configuration,
			operation: "inspect",
			path: assetPath,
			request: makeProtocolRequest(
				{ kind: "inspect", assetPath },
				{
					maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
					timeoutMs: configuration.timeoutMs
				}
			),
			expected: "inspect",
			select: (result) => (result.kind === "inspect" ? result.inspection : undefined)
		});
	});
	const readTable = Effect.fn("AssetReader.readTable")(function* (assetPath: string) {
		return yield* invokeProtocolSingle({
			configuration,
			operation: "authoring",
			path: assetPath,
			request: makeProtocolRequest(
				{ kind: "authoring", assetPath },
				{
					maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
					timeoutMs: configuration.timeoutMs
				}
			),
			expected: "authoring",
			select: (result) => (result.kind === "authoring" ? result.snapshot : undefined)
		});
	});
	const readSavedWorld = Effect.fn("AssetReader.readSavedWorld")(function* (
		options: SavedWorldReadOptions
	) {
		savedWorldStore.current = { ...idleSavedWorldProgress(), phase: "enumerating" };
		return yield* invokeProtocolSingle({
			configuration: { ...configuration, timeoutMs: configuration.catalogTimeoutMs },
			operation: "saved_world",
			path: options.mapPath,
			request: makeProtocolRequest(
				{
					kind: "saved_world",
					mapPath: options.mapPath,
					projectRoot: options.projectRoot
				},
				{
					...(options.concurrency === undefined
						? {}
						: { concurrency: options.concurrency }),
					...(options.maximumAssets === undefined
						? {}
						: { maximumAssets: options.maximumAssets }),
					maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
					timeoutMs: configuration.catalogTimeoutMs
				}
			),
			expected: "saved_world",
			onEvent: (event) => updateSavedWorldProgress(savedWorldStore, event),
			select: (result) => (result.kind === "saved_world" ? result.world : undefined)
		}).pipe(
			Effect.tap((world) =>
				Effect.sync(() => {
					savedWorldStore.current = {
						actorsFound: world.actors.length,
						phase: "ready",
						processedPackages: world.summary.scannedPackages,
						totalPackages: world.summary.scannedPackages
					};
				})
			),
			Effect.tapError(() =>
				Effect.sync(() => {
					savedWorldStore.current = { ...savedWorldStore.current, phase: "failed" };
				})
			)
		);
	});
	const discoverTables = Effect.fn("AssetReader.discoverTables")(function* (
		options: SavedTableCatalogOptions
	) {
		return yield* invokeProtocolScan(
			configuration,
			{
				...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
				classes: SAVED_TABLE_SCAN_CLASSES,
				...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
				depth: "header",
				projectRoot: options.projectRoot
			},
			catalogProgressBridge(progress)
		).pipe(Effect.map(savedTableCatalogFromScan));
	});
	const source = Effect.fn("AssetReader.source")(() => Effect.succeed(configuration.source));
	return AssetReader.of({
		catalogProgress,
		configuration: getConfiguration,
		discoverAssets,
		discoverTables,
		extractProjectText,
		extractProjectTextures,
		readAsset,
		readSavedWorld,
		readTable,
		scanProgress,
		scanProject,
		savedWorldProgress,
		source
	});
}

export function assetReaderLayer(
	configuration: Partial<AssetReaderConfiguration> = {}
): Layer.Layer<AssetReader> {
	return Layer.sync(AssetReader, () =>
		makeAssetReader(
			{
				catalogTimeoutMs: configuration.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
				executable: configuration.executable ?? "uasset",
				...(configuration.protocolObserver === undefined
					? {}
					: { protocolObserver: configuration.protocolObserver }),
				source: configuration.executable === undefined ? "path" : "configured",
				timeoutMs: configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS
			},
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() }
		)
	);
}

const readerExecutable = Config.option(Config.string("UE_SHED_UASSET_EXECUTABLE"));
const readerTimeout = Config.duration("UE_SHED_UASSET_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_TIMEOUT_MS))
);
const readerCatalogTimeout = Config.duration("UE_SHED_UASSET_CATALOG_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_CATALOG_TIMEOUT_MS))
);

export const AssetReaderLive = Layer.effect(
	AssetReader,
	Effect.gen(function* () {
		const executable = yield* readerExecutable;
		return makeAssetReader(
			{
				catalogTimeoutMs: Duration.toMillis(yield* readerCatalogTimeout),
				executable: Option.getOrElse(executable, () => "uasset"),
				source: Option.isSome(executable) ? "configured" : "path",
				timeoutMs: Duration.toMillis(yield* readerTimeout)
			},
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() }
		);
	})
);

export function makeAssetReaderTestLayer(service: AssetReaderTestShape): Layer.Layer<AssetReader> {
	return Layer.succeed(
		AssetReader,
		AssetReader.of({
			catalogProgress:
				service.catalogProgress ?? (() => Effect.succeed(idleCatalogProgress())),
			configuration:
				service.configuration ??
				(() =>
					Effect.succeed({
						catalogTimeoutMs: DEFAULT_CATALOG_TIMEOUT_MS,
						executable: "uasset",
						timeoutMs: DEFAULT_TIMEOUT_MS
					})),
			extractProjectText:
				service.extractProjectText ??
				((options) =>
					Stream.fail(
						new AssetReaderError({
							kind: "process",
							operation: "extract_text",
							message: "This test asset reader does not stub extractProjectText.",
							path: options.projectRoot,
							retrySafe: false
						})
					)),
			extractProjectTextures:
				service.extractProjectTextures ??
				((options) =>
					Stream.fail(
						new AssetReaderError({
							kind: "process",
							operation: "extract_texture",
							message: "This test asset reader does not stub extractProjectTextures.",
							path: options.projectRoot,
							retrySafe: false
						})
					)),
			savedWorldProgress:
				service.savedWorldProgress ?? (() => Effect.succeed(idleSavedWorldProgress())),
			scanProgress: service.scanProgress ?? (() => Effect.succeed(idleScanProgress())),
			readSavedWorld:
				service.readSavedWorld ??
				((options) =>
					new AssetReaderError({
						kind: "process",
						operation: "saved_world",
						message: "This test asset reader does not stub readSavedWorld.",
						path: options.mapPath,
						retrySafe: false
					})),
			scanProject:
				service.scanProject ??
				((options) =>
					new AssetReaderError({
						kind: "process",
						operation: "scan",
						message: "This test asset reader does not stub scanProject.",
						path: options.projectRoot,
						retrySafe: false
					})),
			...service
		})
	);
}

export function readSavedTable(
	options: AssetReaderOptions
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readTable(options.assetPath));
}

export function readSavedAsset(
	options: AssetReaderOptions
): Effect.Effect<SavedAssetInspection, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readAsset(options.assetPath));
}

export function discoverSavedAssets(
	projectRoot: string
): Effect.Effect<readonly string[], AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverAssets(projectRoot));
}

export function discoverSavedTables(
	options: SavedTableCatalogOptions
): Effect.Effect<SavedTableCatalog, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverTables(options));
}

export function scanSavedProject(
	options: SavedAssetScanOptions
): Effect.Effect<SavedAssetScan, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.scanProject(options));
}

/** Streams compact text evidence for an explicit candidate list or a header-filtered project. */
export function extractProjectText(
	options: SavedAssetExtractionOptions
): Stream.Stream<SavedAssetTextExtractionEvent, AssetReaderError, AssetReader> {
	return Stream.unwrap(Effect.map(AssetReader, (reader) => reader.extractProjectText(options)));
}

/** Streams compact Texture2D evidence for an explicit candidate list or a header-filtered project. */
export function extractProjectTextures(
	options: SavedAssetExtractionOptions
): Stream.Stream<SavedAssetTextureExtractionEvent, AssetReaderError, AssetReader> {
	return Stream.unwrap(
		Effect.map(AssetReader, (reader) => reader.extractProjectTextures(options))
	);
}

/** A user-supplied path resolved onto the project root plus the roots to enumerate beneath it. */
export function readSavedWorld(
	options: SavedWorldReadOptions
): Effect.Effect<SavedWorld, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readSavedWorld(options));
}

export function getAssetReaderSource(): Effect.Effect<"configured" | "path", never, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.source());
}
