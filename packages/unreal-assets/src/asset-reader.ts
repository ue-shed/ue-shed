import {
	ErrorCauseFields,
	ErrorGuidanceFields,
	BlueprintGraphRead,
	LevelSequenceRead,
	isHeaderScanEntry,
	SavedAssetCatalogInspection,
	SavedAssetInspection,
	SavedAssetScan,
	SavedAssetScanEntry,
	SavedAssetScanProgress,
	SavedAssetTextExtractionEvent,
	SavedAssetPackageTextEvent,
	SavedAssetTextureExtractionEvent,
	SavedTableCatalog,
	SavedTableCatalogProgress,
	SavedTableDescriptor,
	SavedWorld,
	SavedWorldProgress,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import {
	Config,
	Context,
	Duration,
	Effect,
	Layer,
	Metric,
	Option,
	Schema,
	Semaphore,
	Stream
} from "effect";

export const MAX_PROTOCOL_OUTPUT_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_CAPTURED_STDERR_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CATALOG_TIMEOUT_MS = 50 * 60_000;

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

/**
 * Native reader discovery, process, timeout, contract or resource-limit failure. Carries
 * operation/path context and original cause; honor nextStep before replaying a mutating index
 * command.
 */
export class AssetReaderError extends Schema.TaggedError<AssetReaderError>()("AssetReaderError", {
	code: Schema.optional(Schema.String),
	kind: Schema.Literals(["timeout", "process", "contract", "discovery", "resource_limit"]),
	operation: Schema.Literals([
		"game_text_index",
		"authoring",
		"blueprint",
		"level_sequence",
		"catalog",
		"extract_text",
		"extract_text_packages",
		"extract_texture",
		"inspect",
		"discovery",
		"scan",
		"saved_world"
	]),
	path: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	...ErrorGuidanceFields,
	...ErrorCauseFields
}) {}

/**
 * @internal Recovery and next step for a reader failure of one kind. Only `retrySafe` failures
 * suggest `retry`.
 */
export function assetReaderGuidance(
	kind: AssetReaderError["kind"],
	retrySafe: boolean
): Pick<AssetReaderError, "nextStep" | "recovery"> {
	switch (kind) {
		case "timeout":
			return {
				recovery:
					"The saved-asset reader timed out. Retry, or raise the reader timeout for large packages.",
				nextStep: retrySafe ? "retry" : "escalate"
			};
		case "process":
			return {
				recovery:
					"The saved-asset reader process failed. Check that the configured uasset executable starts, then retry.",
				nextStep: retrySafe ? "retry" : "escalate"
			};
		case "contract":
			return {
				recovery:
					"The saved-asset reader answered outside its protocol. Install the reader version paired with this host.",
				nextStep: "escalate"
			};
		case "discovery":
			return {
				recovery:
					"Check that the project root or asset path exists, is readable and is inside an Unreal project.",
				nextStep: retrySafe ? "retry" : "fix_input"
			};
		case "resource_limit":
			return {
				recovery:
					"Narrow the request to fewer packages, or raise the configured reader limit.",
				nextStep: "fix_input"
			};
	}
}

/**
 * Explicit saved asset path for a single native-reader operation. The path is a filesystem
 * input rather than an Unreal object-path locator.
 */
export interface AssetReaderOptions {
	readonly assetPath: string;
}

/**
 * Explicit project root with optional header cache and worker concurrency for DataTable
 * discovery. Catalog results describe saved packages; open a table to resolve its row schema.
 */
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
	/** Request uasset-io v1.9 saved package flags and gatherable-text summary evidence. */
	readonly headerData?: boolean;
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

/**
 * Native reader executable and ordinary/catalog timeouts in milliseconds, with optional
 * aggregate protocol observation. Sibling adapters reuse these settings instead of choosing a
 * separate executable.
 */
export interface AssetReaderConfiguration {
	readonly catalogTimeoutMs: number;
	readonly executable: string;
	/** Aggregate process evidence for benchmarks and host telemetry; never includes asset paths. */
	readonly protocolObserver?: (event: AssetReaderProtocolObservation) => void;
	readonly timeoutMs: number;
}

/**
 * Worker outcome observed at the protocol boundary: complete, partial, failed, rejected or
 * cancelled. Partial evidence must remain distinguishable from a complete successful result.
 */
export type ProtocolTerminalState = "complete" | "partial" | "failed" | "rejected" | "cancelled";

/**
 * Path-free native worker start/completion evidence with PID, output/frame byte counts and
 * terminal state. Intended for host telemetry and benchmark attribution, not asset-level
 * diagnostics.
 */
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

/**
 * Saved-package discovery, header/full scans, projections and asset reads. Production
 * operations use the native reader; progress and configuration are available without
 * requiring an editor connection.
 */
export interface AssetReaderApi {
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
	/** Requires the opt-in uasset-io v1.8 package-text capability; requests v1.10 gather coverage. */
	readonly extractProjectTextPackages?: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetPackageTextEvent, AssetReaderError>;
	/** Streams compact Texture2D facts without generic inspection payloads. */
	readonly extractProjectTextures: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetTextureExtractionEvent, AssetReaderError>;
	readonly readAsset: (
		assetPath: string
	) => Effect.Effect<SavedAssetInspection, AssetReaderError>;
	/** Reads the saved editor graph without requiring Unreal Engine or loading the Blueprint. */
	readonly readBlueprint: (
		assetPath: string
	) => Effect.Effect<BlueprintGraphRead, AssetReaderError>;
	readonly readLevelSequence: (
		assetPath: string
	) => Effect.Effect<LevelSequenceRead, AssetReaderError>;
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

/** Complete reader port supplied to a test layer; omitted operations are type errors. */
export type AssetReaderTestApi = AssetReaderApi;

/**
 * Headless saved-package reader service. It reads project files through a paired native
 * worker and does not use or require an active Unreal editor.
 */
export class AssetReader extends Context.Service<AssetReader, AssetReaderApi>()(
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

/**
 * Pure DataTable/CompositeDataTable projection from inspected saved exports. Retains
 * project-file authority and partial completeness; unresolved row schemas remain explicitly
 * unavailable.
 */
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

/**
 * Exact saved DataTable and CompositeDataTable class paths used by header discovery. Header
 * matching does not resolve arbitrary project-specific inheritance.
 */
export const SAVED_TABLE_SCAN_CLASSES = [DATA_TABLE_CLASS, COMPOSITE_DATA_TABLE_CLASS] as const;

/**
 * Unreal Blueprint asset classes, including editor-defined specializations such as
 * WidgetBlueprint, share this class-name suffix. Generated classes intentionally do not match.
 */
export const BLUEPRINT_ASSET_CLASS_NAME_SUFFIXES = ["Blueprint"] as const;

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
	UassetProtocolSession,
	invokeProtocolScan,
	invokeProtocolSessionSingle,
	invokeProtocolSessionSingleWithEvidence,
	invokeProtocolSingle,
	invokeProtocolSingleWithEvidence,
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
	savedWorldStore: SavedWorldProgressStore,
	invokeSingle: typeof invokeProtocolSingle = invokeProtocolSingle,
	invokeSingleWithEvidence: typeof invokeProtocolSingleWithEvidence = invokeProtocolSingleWithEvidence
): AssetReaderApi {
	const catalogProgress = Effect.fn("AssetReader.catalogProgress")(() =>
		Effect.sync(() => progress.current)
	);
	const getConfiguration = Effect.fn("AssetReader.configuration")(() =>
		Effect.succeed({
			catalogTimeoutMs: configuration.catalogTimeoutMs,
			executable: configuration.executable,
			...(configuration.protocolObserver === undefined
				? undefined
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
	const scanProject = Effect.fn("AssetReader.scanProject")(
		function* (options: SavedAssetScanOptions) {
			return yield* invokeProtocolScan(configuration, options, scanStore);
		},
		(effect, options) =>
			effect.pipe(
				Effect.withSpan("unreal_assets.scan_project", {
					attributes: { "unreal.project_root": options.projectRoot }
				})
			)
	);
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
	const extractProjectTextPackages = (options: SavedAssetExtractionOptions) =>
		options.paths?.length === 0
			? Stream.empty
			: protocolProjectionStream({
					configuration,
					extraction: options,
					projection: "text_packages",
					scanStore,
					decode: (result) =>
						result.kind === "extract_text_packages" ? result.event : undefined
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
		return yield* invokeSingle({
			configuration,
			operation: "inspect",
			path: assetPath,
			request: makeProtocolRequest(
				{ kind: "inspect", assetPath },
				{
					maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
					timeoutMs: configuration.timeoutMs
				},
				{ contractMinor: 14 }
			),
			expected: "inspect",
			select: (result) => (result.kind === "inspect" ? result.inspection : undefined)
		});
	});
	const readBlueprint = Effect.fn("AssetReader.readBlueprint")(function* (assetPath: string) {
		const evidence = yield* invokeSingleWithEvidence({
			configuration,
			operation: "blueprint",
			path: assetPath,
			request: makeProtocolRequest(
				{ kind: "blueprint", assetPath },
				{
					maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
					timeoutMs: configuration.timeoutMs
				},
				{ contractMinor: 7 }
			),
			expected: "blueprint",
			select: (result) => (result.kind === "blueprint" ? result.blueprint : undefined)
		});
		return {
			blueprint: evidence.value,
			diagnostics: evidence.diagnostics,
			outcome: evidence.outcome
		};
	});
	const readLevelSequence = Effect.fn("AssetReader.readLevelSequence")(function* (
		assetPath: string
	) {
		const evidence = yield* invokeSingleWithEvidence({
			configuration,
			operation: "level_sequence",
			path: assetPath,
			request: makeProtocolRequest(
				{ kind: "level_sequence", assetPath },
				{
					maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
					timeoutMs: configuration.timeoutMs
				},
				{ contractMinor: 7 }
			),
			expected: "level_sequence",
			select: (result) => (result.kind === "level_sequence" ? result.sequence : undefined)
		});
		return {
			sequence: evidence.value,
			diagnostics: evidence.diagnostics,
			outcome: evidence.outcome
		};
	});
	const readTable = Effect.fn("AssetReader.readTable")(function* (assetPath: string) {
		return yield* invokeSingle({
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
						? undefined
						: { concurrency: options.concurrency }),
					...(options.maximumAssets === undefined
						? undefined
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
		const scan = yield* invokeProtocolScan(
			configuration,
			{
				...(options.cachePath === undefined ? undefined : { cachePath: options.cachePath }),
				classes: SAVED_TABLE_SCAN_CLASSES,
				...(options.concurrency === undefined
					? undefined
					: { concurrency: options.concurrency }),
				depth: "header",
				projectRoot: options.projectRoot
			},
			catalogProgressBridge(progress)
		);
		return savedTableCatalogFromScan(scan);
	});
	const source = Effect.fn("AssetReader.source")(() => Effect.succeed(configuration.source));
	return AssetReader.of({
		catalogProgress,
		configuration: getConfiguration,
		discoverAssets,
		discoverTables,
		extractProjectText,
		extractProjectTextPackages,
		extractProjectTextures,
		readAsset,
		readBlueprint,
		readLevelSequence,
		readSavedWorld,
		readTable,
		scanProgress,
		scanProject,
		savedWorldProgress,
		source
	});
}

function makeScopedAssetReader(
	configuration: AssetReaderConfiguration & { readonly source: "configured" | "path" }
) {
	return Effect.gen(function* () {
		const mutex = yield* Semaphore.make(1);
		const session = yield* Effect.acquireRelease(
			Effect.sync(() => new UassetProtocolSession(configuration)),
			(session) => Effect.promise(() => session.close())
		);
		const invokeSingle: typeof invokeProtocolSingle = (options) =>
			mutex.withPermits(1)(
				invokeProtocolSessionSingle({
					...options,
					session
				})
			);
		const invokeSingleWithEvidence: typeof invokeProtocolSingleWithEvidence = (options) =>
			mutex.withPermits(1)(
				invokeProtocolSessionSingleWithEvidence({
					...options,
					session
				})
			);
		return makeAssetReader(
			configuration,
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() },
			invokeSingle,
			invokeSingleWithEvidence
		);
	});
}

/**
 * Creates a scoped native reader with explicit executable/timeouts and optional observation.
 * Defaults resolve uasset on PATH; the layer closes its owned session when released.
 */
export function assetReaderLayer(
	configuration: Partial<AssetReaderConfiguration> = {}
): Layer.Layer<AssetReader> {
	return Layer.effect(
		AssetReader,
		makeScopedAssetReader({
			catalogTimeoutMs: configuration.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
			executable: configuration.executable ?? "uasset",
			...(configuration.protocolObserver === undefined
				? undefined
				: { protocolObserver: configuration.protocolObserver }),
			source: configuration.executable === undefined ? "path" : "configured",
			timeoutMs: configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS
		})
	);
}

const readerExecutable = Config.option(Config.String("UE_SHED_UASSET_EXECUTABLE"));
const readerTimeout = Config.Duration("UE_SHED_UASSET_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_TIMEOUT_MS))
);
const readerCatalogTimeout = Config.Duration("UE_SHED_UASSET_CATALOG_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_CATALOG_TIMEOUT_MS))
);

/**
 * Effect Config-backed scoped reader. Reads UE_SHED_UASSET_EXECUTABLE and ordinary/catalog
 * timeout settings; defaults to uasset on PATH and owns its protocol session lifecycle.
 */
export const AssetReaderLive = Layer.effect(
	AssetReader,
	Effect.gen(function* () {
		const executable = yield* readerExecutable;
		return yield* makeScopedAssetReader({
			catalogTimeoutMs: Duration.toMillis(yield* readerCatalogTimeout),
			executable: Option.getOrElse(executable, () => "uasset"),
			source: Option.isSome(executable) ? "configured" : "path",
			timeoutMs: Duration.toMillis(yield* readerTimeout)
		});
	})
);

/** Provides a complete explicit test reader. No operation or configuration is filled implicitly. */
export function makeAssetReaderTestLayer(service: AssetReaderTestApi): Layer.Layer<AssetReader> {
	return Layer.succeed(AssetReader, AssetReader.of(service));
}

/**
 * Reads a saved table snapshot through AssetReader using its explicit authority. It does not
 * apply edits or save an Unreal package.
 */
export function readSavedTable(
	options: AssetReaderOptions
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readTable(options.assetPath));
}

/**
 * Inspects one saved package through AssetReader. The result can be partial; consumers must
 * preserve diagnostics and completeness rather than assuming every property decoded.
 */
export function readSavedAsset(
	options: AssetReaderOptions
): Effect.Effect<SavedAssetInspection, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readAsset(options.assetPath));
}

/**
 * Reads saved Blueprint graph evidence through AssetReader. This does not compile or load the
 * Blueprint in Unreal; unsupported saved evidence remains explicit.
 */
export function readSavedBlueprint(
	options: AssetReaderOptions
): Effect.Effect<BlueprintGraphRead, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readBlueprint(options.assetPath));
}
/**
 * Reads saved LevelSequence evidence through AssetReader without an editor. Returned
 * bindings/tracks describe disk state rather than a live sequencer evaluation.
 */
export function readSavedLevelSequence(
	options: AssetReaderOptions
): Effect.Effect<LevelSequenceRead, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readLevelSequence(options.assetPath));
}

/**
 * Enumerates saved asset paths through AssetReader for an explicit project root. Uses native
 * discovery rather than TypeScript filesystem recursion.
 */
export function discoverSavedAssets(
	projectRoot: string
): Effect.Effect<readonly string[], AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverAssets(projectRoot));
}

/**
 * Discovers saved DataTable descriptors through AssetReader with optional cache/concurrency.
 * Header-only metadata does not establish a resolved editable row schema.
 */
export function discoverSavedTables(
	options: SavedTableCatalogOptions
): Effect.Effect<SavedTableCatalog, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverTables(options));
}

/**
 * Runs one batched project scan through AssetReader. Prefer it to discovering then spawning
 * one read per path; depth and filters determine how much package evidence is decoded.
 */
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

/**
 * Streams compact per-package FText/StringTable evidence through AssetReader. This is the
 * saved-evidence input to indexing, separate from localization target joining.
 */
export function extractProjectTextPackages(
	options: SavedAssetExtractionOptions
): Stream.Stream<SavedAssetPackageTextEvent, AssetReaderError, AssetReader> {
	return Stream.unwrap(
		Effect.map(
			AssetReader,
			(reader) =>
				reader.extractProjectTextPackages?.(options) ??
				Stream.fail(
					new AssetReaderError({
						kind: "contract",
						code: "unsupported_capability",
						operation: "extract_text_packages",
						message: "This AssetReader does not provide the package-text capability.",
						path: options.projectRoot,
						retrySafe: false,
						recovery:
							"Use an asset reader with the uasset-io package-text capability (v1.8 or later).",
						nextStep: "fix_input"
					})
				)
		)
	);
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

/**
 * Reports whether the configured reader executable was explicit or resolved from PATH. It
 * does not launch the worker or prove its protocol compatibility.
 */
export function getAssetReaderSource(): Effect.Effect<"configured" | "path", never, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.source());
}
