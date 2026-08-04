import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import {
	isHeaderScanEntry,
	SavedAssetCatalogInspection,
	SavedAssetInspection,
	SavedAssetManifestEntry,
	SavedAssetScan,
	SavedAssetScanEntry,
	SavedAssetScanFailure,
	SavedAssetScanProgress,
	SavedAssetScanSummary,
	SavedAssetTextExtractionEvent,
	SavedAssetTextureExtractionEvent,
	SavedTableCatalog,
	SavedTableCatalogProgress,
	SavedTableDescriptor,
	SavedWorld,
	SavedWorldProgress,
	UAssetIoEvent,
	type UAssetIoResult,
	type UAssetIoOperation,
	type UAssetIoRequest,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import {
	Config,
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	Metric,
	Option,
	Schema,
	Stream
} from "effect";

export * from "./project-index.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 5 * 60_000;

const assetReaderQueueDuration = Metric.histogram("ue_shed_asset_reader_queue_duration_ms", {
	boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 1_000, 5_000],
	description: "Time an AssetReader operation waits before its native worker starts"
});
const assetReaderStartupDuration = Metric.histogram("ue_shed_asset_reader_startup_duration_ms", {
	boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 1_000, 5_000],
	description: "Time for a native AssetReader worker to accept a request"
});
const assetReaderDiscoveryDuration = Metric.histogram(
	"ue_shed_asset_reader_discovery_duration_ms",
	{
		boundaries: [0, 1, 5, 10, 25, 50, 100, 250, 1_000, 5_000, 30_000],
		description: "Time an AssetReader worker spends discovering package inputs"
	}
);
const assetReaderReadBytes = Metric.counter("ue_shed_asset_reader_read_bytes_total", {
	description:
		"Package and sidecar bytes explicitly reported in AssetReader result frames; operations without byte fields contribute zero",
	incremental: true
});
const assetReaderInspectedFiles = Metric.counter("ue_shed_asset_reader_inspected_files_total", {
	description:
		"Asset/package/item counts explicitly reported in AssetReader result frames; this is not an estimate of unreported file reads",
	incremental: true
});
const assetReaderPartialFailures = Metric.counter("ue_shed_asset_reader_partial_failure_total", {
	description: "Partial package results and per-file AssetReader failures",
	incremental: true
});
const assetReaderCancellations = Metric.counter("ue_shed_asset_reader_cancellation_total", {
	description: "AssetReader operations cancelled before their terminal event",
	incremental: true
});
const assetReaderCacheOutcome = Metric.frequency("ue_shed_asset_reader_cache_outcome_total", {
	description: "AssetReader cache outcomes"
});
const assetReaderTerminalState = Metric.frequency("ue_shed_asset_reader_terminal_total", {
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

interface CatalogProgressStore {
	current: SavedTableCatalogProgress;
}

interface ScanProgressStore {
	current: SavedAssetScanProgress;
}

interface SavedWorldProgressStore {
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

type ProtocolEvent = Schema.Schema.Type<typeof UAssetIoEvent>;

function sameProtocolContract(
	left: UAssetIoRequest["contract"],
	right: UAssetIoRequest["contract"]
): boolean {
	return (
		left.name === right.name &&
		left.version.major === right.version.major &&
		left.version.minor === right.version.minor
	);
}

function isProtocolTerminal(event: ProtocolEvent): boolean {
	return event.kind === "completed" || event.kind === "failed" || event.kind === "rejected";
}

/** @internal Shared byte accounting for the newline-delimited protocol reader. */
export class ProtocolOutputBudget {
	private totalBytes = 0;

	constructor(private readonly maximumBytes: number) {}

	get bytes(): number {
		return this.totalBytes;
	}

	observe(chunk: string): void {
		const nextBytes = this.totalBytes + Buffer.byteLength(chunk, "utf8");
		if (nextBytes > this.maximumBytes) {
			throw new ProtocolStreamFailure(
				"contract",
				`Protocol output exceeded ${this.maximumBytes} bytes`
			);
		}
		this.totalBytes = nextBytes;
	}
}

/** @internal Shared stream validation used by every AssetReader protocol operation. */
export class ProtocolStreamValidator {
	private expectedSequence = 0;
	private sawAccepted = false;
	private sawTerminal = false;
	private sawEvent = false;

	constructor(
		private readonly expectedContract: UAssetIoRequest["contract"],
		private readonly expectedRequestId: string
	) {}

	pushLine(line: string): ProtocolEvent {
		if (line.trim().length === 0) {
			throw new ProtocolStreamFailure("contract", "Protocol stream contains an empty frame");
		}
		let event: ProtocolEvent;
		try {
			event = Schema.decodeUnknownSync(UAssetIoEvent)(JSON.parse(line) as unknown);
		} catch (cause) {
			throw new ProtocolStreamFailure("contract", `Invalid protocol event: ${String(cause)}`);
		}
		this.push(event);
		return event;
	}

	push(event: ProtocolEvent): void {
		if (this.sawTerminal) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol emitted an event after its terminal event"
			);
		}
		if (event.requestId !== this.expectedRequestId) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol requestId changed during the stream"
			);
		}
		if (!sameProtocolContract(event.contract, this.expectedContract)) {
			throw new ProtocolStreamFailure(
				"contract",
				this.sawEvent
					? "Protocol stream changes contract between frames"
					: "Protocol event contract does not match the request contract"
			);
		}
		if (!this.sawEvent) {
			if (event.kind !== "accepted") {
				throw new ProtocolStreamFailure(
					"contract",
					"Protocol stream must begin with an accepted event"
				);
			}
			if (event.sequence !== 0) {
				throw new ProtocolStreamFailure(
					"contract",
					"Protocol stream sequence must begin at zero"
				);
			}
		} else {
			if (event.kind === "accepted") {
				throw new ProtocolStreamFailure(
					"contract",
					"Protocol stream contains more than one accepted event"
				);
			}
			if (event.sequence !== this.expectedSequence) {
				throw new ProtocolStreamFailure(
					"contract",
					`Protocol sequence expected ${this.expectedSequence} but received ${event.sequence}`
				);
			}
		}
		this.sawEvent = true;
		this.sawAccepted = true;
		this.expectedSequence += 1;
		this.sawTerminal = isProtocolTerminal(event);
	}

	finish(): void {
		if (!this.sawEvent) {
			throw new ProtocolStreamFailure("contract", "Protocol stream must not be empty");
		}
		if (!this.sawAccepted) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol stream must begin with an accepted event"
			);
		}
		if (!this.sawTerminal) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol stream ended without a terminal event"
			);
		}
	}
}

type ProtocolFailureKind = "contract" | "discovery" | "process" | "resource_limit" | "timeout";

class ProtocolStreamFailure extends Error {
	readonly _tag = "ProtocolStreamFailure";

	constructor(
		readonly kind: ProtocolFailureKind,
		message: string,
		readonly exitCode?: number
	) {
		super(message);
	}
}

export type ProtocolTerminalState = "complete" | "partial" | "failed" | "rejected" | "cancelled";

interface ProtocolTelemetry {
	readonly queuedAt: number;
	startedAt: number | undefined;
	acceptedAt: number | undefined;
	discoveryStartedAt: number | undefined;
	discoveryDurationMs: number | undefined;
	framePending: string;
	readBytes: number;
	inspectedFiles: number;
	cacheRequested: boolean;
	cacheHits: number;
	cacheMisses: number;
	partialFailures: number;
	cancelled: boolean;
	largestFrameBytes: number;
	observer: ((event: AssetReaderProtocolObservation) => void) | undefined;
	outputBytes: number;
	workerPid: number | undefined;
	terminalState: ProtocolTerminalState | undefined;
}

function nowMs(): number {
	return Date.now();
}

function notifyProtocolObserver(
	telemetry: ProtocolTelemetry,
	event: AssetReaderProtocolObservation
): void {
	try {
		telemetry.observer?.(event);
	} catch {
		// Optional measurement hooks must never change reader behavior.
	}
}

function makeProtocolTelemetry(
	cacheRequested = false,
	observer?: (event: AssetReaderProtocolObservation) => void
): ProtocolTelemetry {
	return {
		acceptedAt: undefined,
		cacheRequested,
		cacheHits: 0,
		cacheMisses: 0,
		cancelled: false,
		discoveryDurationMs: undefined,
		discoveryStartedAt: undefined,
		framePending: "",
		inspectedFiles: 0,
		largestFrameBytes: 0,
		observer,
		outputBytes: 0,
		partialFailures: 0,
		queuedAt: nowMs(),
		readBytes: 0,
		startedAt: undefined,
		terminalState: undefined,
		workerPid: undefined
	};
}

export function protocolCacheOutcome(
	cacheRequested: boolean,
	cacheHits: number,
	_cacheMisses: number
): "hit" | "miss" | "not_requested" {
	if (!cacheRequested) return "not_requested";
	return cacheHits > 0 ? "hit" : "miss";
}

function observeCacheSummary(
	telemetry: ProtocolTelemetry,
	scannedAssets: number,
	cacheHits: number
): void {
	if (!telemetry.cacheRequested) return;
	telemetry.cacheHits = Math.max(telemetry.cacheHits, cacheHits);
	telemetry.cacheMisses = Math.max(telemetry.cacheMisses, Math.max(0, scannedAssets - cacheHits));
}

function finishDiscovery(telemetry: ProtocolTelemetry, at: number): void {
	if (telemetry.discoveryStartedAt !== undefined && telemetry.discoveryDurationMs === undefined) {
		telemetry.discoveryDurationMs = Math.max(0, at - telemetry.discoveryStartedAt);
	}
}

function observeProtocolResult(result: UAssetIoResult, telemetry: ProtocolTelemetry): void {
	switch (result.kind) {
		case "inspect":
			telemetry.inspectedFiles += 1;
			if (result.inspection.status === "partial") telemetry.partialFailures += 1;
			return;
		case "authoring":
		case "saved_world":
			telemetry.inspectedFiles += 1;
			return;
		case "scan_asset":
			telemetry.inspectedFiles += 1;
			telemetry.readBytes += result.entry.fileBytes;
			if (result.entry.depth === "full" && result.entry.inspection.status === "partial") {
				telemetry.partialFailures += 1;
			}
			return;
		case "scan_inventory":
			telemetry.readBytes += result.entry.size;
			return;
		case "scan_summary":
			observeCacheSummary(telemetry, result.summary.scannedAssets, result.summary.cacheHits);
			telemetry.inspectedFiles = Math.max(
				telemetry.inspectedFiles,
				result.summary.scannedAssets
			);
			telemetry.partialFailures = Math.max(
				telemetry.partialFailures,
				result.summary.partialAssets + result.summary.failedAssets
			);
			return;
		case "extract_text":
			if (result.event.event === "text_package") {
				telemetry.inspectedFiles += 1;
				telemetry.readBytes += result.event.fileBytes;
				if (result.event.status === "partial") telemetry.partialFailures += 1;
			}
			if (result.event.event === "text_summary") {
				observeCacheSummary(telemetry, result.event.scannedAssets, result.event.cacheHits);
				telemetry.inspectedFiles = Math.max(
					telemetry.inspectedFiles,
					result.event.scannedAssets
				);
				telemetry.partialFailures = Math.max(
					telemetry.partialFailures,
					result.event.partialAssets + result.event.failedAssets
				);
			}
			return;
		case "extract_texture":
			if (result.event.event === "texture_package") {
				telemetry.inspectedFiles += 1;
				telemetry.readBytes += result.event.fileBytes;
				if (result.event.status === "partial") telemetry.partialFailures += 1;
			}
			if (result.event.event === "texture_summary") {
				observeCacheSummary(telemetry, result.event.scannedAssets, result.event.cacheHits);
				telemetry.inspectedFiles = Math.max(
					telemetry.inspectedFiles,
					result.event.scannedAssets
				);
				telemetry.partialFailures = Math.max(
					telemetry.partialFailures,
					result.event.partialAssets + result.event.failedAssets
				);
			}
			return;
	}
}

function observeProtocolEvent(event: ProtocolEvent, telemetry: ProtocolTelemetry): void {
	const at = nowMs();
	if (event.kind === "accepted") {
		telemetry.acceptedAt = at;
		if (telemetry.startedAt !== undefined) finishDiscovery(telemetry, at);
		return;
	}
	if (event.kind === "progress") {
		if (event.phase === "discovering" && telemetry.discoveryStartedAt === undefined) {
			telemetry.discoveryStartedAt = at;
		}
		if (
			(event.phase === "reading" || event.phase === "inspecting") &&
			telemetry.discoveryStartedAt !== undefined
		) {
			finishDiscovery(telemetry, at);
		}
		telemetry.inspectedFiles = Math.max(telemetry.inspectedFiles, event.completedItems);
		return;
	}
	if (event.kind === "diagnostic") {
		telemetry.partialFailures += 1;
		return;
	}
	if (event.kind === "result") {
		observeProtocolResult(event.result, telemetry);
		return;
	}
	if (event.kind === "completed") {
		finishDiscovery(telemetry, at);
		telemetry.terminalState = event.outcome;
		if (event.outcome === "partial" && telemetry.partialFailures === 0) {
			telemetry.partialFailures = 1;
		}
		return;
	}
	if (event.kind === "rejected") {
		telemetry.terminalState = "rejected";
		return;
	}
	telemetry.terminalState = "failed";
}

function observeProtocolChunk(chunk: string, telemetry: ProtocolTelemetry): void {
	telemetry.outputBytes += Buffer.byteLength(chunk, "utf8");
	telemetry.framePending += chunk;
	const lines = telemetry.framePending.split(/\r?\n/);
	telemetry.framePending = lines.pop() ?? "";
	for (const line of lines) {
		telemetry.largestFrameBytes = Math.max(
			telemetry.largestFrameBytes,
			Buffer.byteLength(line, "utf8") + 1
		);
	}
}

function recordProtocolTelemetry(
	operation: AssetReaderError["operation"],
	telemetry: ProtocolTelemetry
): Effect.Effect<void> {
	const at = nowMs();
	finishDiscovery(telemetry, at);
	const terminalState = telemetry.cancelled ? "cancelled" : (telemetry.terminalState ?? "failed");
	notifyProtocolObserver(telemetry, {
		kind: "worker_completed",
		largestFrameBytes: telemetry.largestFrameBytes,
		outputBytes: telemetry.outputBytes,
		...(telemetry.workerPid === undefined ? {} : { pid: telemetry.workerPid }),
		terminalState
	});
	const cacheOutcome = protocolCacheOutcome(
		telemetry.cacheRequested,
		telemetry.cacheHits,
		telemetry.cacheMisses
	);
	return Effect.all([
		Metric.update(
			assetReaderQueueDuration,
			Math.max(0, (telemetry.startedAt ?? at) - telemetry.queuedAt)
		),
		Metric.update(
			assetReaderStartupDuration,
			Math.max(
				0,
				(telemetry.acceptedAt ?? telemetry.startedAt ?? at) -
					(telemetry.startedAt ?? telemetry.queuedAt)
			)
		),
		Metric.update(
			assetReaderDiscoveryDuration,
			Math.max(0, telemetry.discoveryDurationMs ?? 0)
		),
		Metric.update(assetReaderReadBytes, Math.max(0, telemetry.readBytes)),
		Metric.update(assetReaderInspectedFiles, Math.max(0, telemetry.inspectedFiles)),
		Metric.update(assetReaderPartialFailures, Math.max(0, telemetry.partialFailures)),
		Metric.update(assetReaderCacheOutcome, `${operation}:${cacheOutcome}`),
		Metric.update(assetReaderTerminalState, `${operation}:${terminalState}`),
		...(telemetry.cancelled ? [Metric.update(assetReaderCancellations, 1)] : [])
	]).pipe(Effect.asVoid);
}

let protocolRequestCounter = 0;

function makeProtocolRequest(
	operation: UAssetIoOperation,
	limits: UAssetIoRequest["limits"]
): UAssetIoRequest {
	protocolRequestCounter += 1;
	return {
		contract: { name: "uasset-io", version: { major: 1, minor: 0 } },
		limits,
		operation,
		requestId: `unreal-assets-${process.pid}-${protocolRequestCounter}`
	};
}

function protocolPhase(
	phase: Extract<ProtocolEvent, { readonly kind: "progress" }>["phase"]
): SavedAssetScanProgress["phase"] {
	switch (phase) {
		case "starting":
			return "enumerating";
		case "discovering":
			return "enumerating";
		case "reading":
		case "inspecting":
			return "scanning";
		case "emitting":
			return "ready";
	}
}

function savedWorldPhase(
	phase: Extract<ProtocolEvent, { readonly kind: "progress" }>["phase"]
): SavedWorldProgress["phase"] {
	switch (phase) {
		case "starting":
		case "discovering":
			return "enumerating";
		case "reading":
			return "scanning";
		case "inspecting":
			return "resolving";
		case "emitting":
			return "ready";
	}
}

function updateSavedWorldProgress(store: SavedWorldProgressStore, event: ProtocolEvent): void {
	if (event.kind === "progress") {
		store.current = {
			...store.current,
			phase: savedWorldPhase(event.phase),
			processedPackages: event.completedItems,
			...(event.totalItems === undefined ? {} : { totalPackages: event.totalItems })
		};
		return;
	}
	if (event.kind === "result" && event.result.kind === "saved_world") {
		store.current = {
			actorsFound: event.result.world.actors.length,
			phase: "ready",
			processedPackages: event.result.world.summary.scannedPackages,
			totalPackages: event.result.world.summary.scannedPackages
		};
	}
}

function protocolFailureFromEvent(
	event: Extract<ProtocolEvent, { readonly kind: "failed" | "rejected" }>
): ProtocolStreamFailure {
	if (event.kind === "rejected") {
		return new ProtocolStreamFailure("contract", event.problems.join("; "));
	}
	const kind: ProtocolFailureKind =
		event.code === "resource_limit"
			? "resource_limit"
			: event.code === "io" || event.code === "discovery"
				? "discovery"
				: event.code === "timeout"
					? "timeout"
					: "process";
	return new ProtocolStreamFailure(
		kind,
		event.message,
		event.code === "resource_limit" ? 7 : undefined
	);
}

function mapProtocolFailure(
	cause: unknown,
	operation: AssetReaderError["operation"],
	path: string
): AssetReaderError {
	if (cause instanceof ProtocolStreamFailure) {
		return new AssetReaderError({
			kind: cause.kind === "timeout" ? "timeout" : cause.kind,
			operation,
			message: cause.message,
			path,
			retrySafe:
				cause.kind === "timeout" || cause.kind === "discovery" || cause.kind === "process",
			...(cause.exitCode === undefined ? {} : { exitCode: cause.exitCode })
		});
	}
	return new AssetReaderError({
		kind: "process",
		operation,
		message: cause instanceof Error ? cause.message : String(cause),
		path,
		retrySafe: false
	});
}

async function* protocolEvents(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly signal: AbortSignal | undefined;
	readonly telemetry: ProtocolTelemetry;
	readonly timeoutMs: number;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): AsyncGenerator<ProtocolEvent> {
	const queuedAt = options.telemetry.queuedAt;
	const child = spawn(options.configuration.executable, ["protocol"], {
		signal: options.signal,
		timeout: options.timeoutMs,
		windowsHide: true
	});
	if (child.pid !== undefined) {
		options.telemetry.workerPid = child.pid;
		notifyProtocolObserver(options.telemetry, { kind: "worker_started", pid: child.pid });
	}
	let closed = false;
	options.telemetry.startedAt = nowMs();
	let processError: Error | undefined;
	let stderr = "";
	const onAbort = () => {
		if (!closed) options.telemetry.cancelled = true;
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (child.stderr !== null) {
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT_BYTES)
				stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
		});
	}
	const closePromise = new Promise<{
		readonly code: number | null;
		readonly signal: string | null;
	}>((resolvePromise) => {
		child.once("error", (cause) => {
			processError = cause;
		});
		child.once("close", (code, signal) => {
			closed = true;
			resolvePromise({ code, signal });
		});
	});
	try {
		if (child.stdin === null || child.stdout === null) {
			throw new ProtocolStreamFailure(
				"process",
				"Asset reader did not expose protocol pipes"
			);
		}
		child.stdin.setDefaultEncoding("utf8");
		child.stdin.end(`${JSON.stringify(options.request)}\n`);
		child.stdout.setEncoding("utf8");
		let pending = "";
		const outputBudget = new ProtocolOutputBudget(
			options.request.limits.maximumOutputBytes ?? MAX_OUTPUT_BYTES
		);
		const validator = new ProtocolStreamValidator(
			options.request.contract,
			options.request.requestId
		);
		for await (const chunk of child.stdout as AsyncIterable<string>) {
			observeProtocolChunk(chunk, options.telemetry);
			outputBudget.observe(chunk);
			pending += chunk;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const decoded = validator.pushLine(line);
				observeProtocolEvent(decoded, options.telemetry);
				options.onEvent?.(decoded);
				yield decoded;
			}
		}
		if (pending.length > 0) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol output ended with an incomplete JSON line"
			);
		}
		validator.finish();
		const closedResult = await closePromise;
		if (processError !== undefined)
			throw new ProtocolStreamFailure("process", processError.message);
		if (closedResult.code !== 0) {
			throw new ProtocolStreamFailure(
				"process",
				stderr.trim() ||
					`Protocol worker exited ${closedResult.code ?? closedResult.signal ?? "unknown"}`,
				closedResult.code ?? undefined
			);
		}
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		if (options.telemetry.startedAt === undefined) options.telemetry.startedAt = queuedAt;
		if (!closed && !child.killed) child.kill();
	}
}

async function collectProtocolScan(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore,
	telemetry: ProtocolTelemetry,
	signal?: AbortSignal
): Promise<SavedAssetScan> {
	const request = makeProtocolRequest(
		{
			kind: "scan",
			projectRoot: options.projectRoot,
			depth: options.depth ?? "full",
			...(options.paths === undefined ? {} : { paths: [...options.paths] }),
			...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
			...(options.inventory === undefined ? {} : { inventory: options.inventory }),
			...(options.classes === undefined ? {} : { classes: [...options.classes] }),
			...(options.classPrefixes === undefined
				? {}
				: { classPrefixes: [...options.classPrefixes] }),
			...(options.classNameSuffixes === undefined
				? {}
				: { classNameSuffixes: [...options.classNameSuffixes] }),
			...(options.names === undefined ? {} : { names: [...options.names] })
		},
		{
			...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
			...(options.maximumAssets === undefined
				? {}
				: { maximumAssets: options.maximumAssets }),
			maximumOutputBytes: MAX_OUTPUT_BYTES,
			timeoutMs: configuration.catalogTimeoutMs
		}
	);
	const assets: SavedAssetScanEntry[] = [];
	const failures: SavedAssetScanFailure[] = [];
	const inventory: SavedAssetManifestEntry[] = [];
	let summary: SavedAssetScanSummary | undefined;
	let partial = false;
	for await (const event of protocolEvents({
		configuration,
		operation: "scan",
		path: options.projectRoot,
		request,
		signal,
		telemetry,
		timeoutMs: configuration.catalogTimeoutMs
	})) {
		if (event.kind === "progress") {
			progress.current = {
				...progress.current,
				phase: protocolPhase(event.phase),
				processedAssets: event.completedItems,
				...(event.totalItems === undefined ? {} : { totalAssets: event.totalItems })
			};
		} else if (event.kind === "diagnostic") {
			partial = true;
			failures.push({
				code: event.code,
				message: event.message,
				path: options.projectRoot,
				retrySafe: true
			});
		} else if (event.kind === "result") {
			switch (event.result.kind) {
				case "scan_asset":
					assets.push(event.result.entry);
					break;
				case "scan_inventory":
					inventory.push(event.result.entry);
					break;
				case "scan_summary":
					summary = event.result.summary;
					progress.current = {
						...progress.current,
						cacheHits: event.result.summary.cacheHits,
						emittedAssets: event.result.summary.emittedAssets,
						totalAssets: event.result.summary.scannedAssets
					};
					break;
			}
		} else if (event.kind === "failed" || event.kind === "rejected") {
			throw protocolFailureFromEvent(event);
		} else if (event.kind === "completed" && event.outcome === "partial") {
			partial = true;
		}
	}
	if (summary === undefined) {
		throw new ProtocolStreamFailure("contract", "Protocol scan ended without a summary result");
	}
	progress.current = { ...progress.current, phase: "ready" };
	return {
		assets,
		failures,
		...(inventory.length === 0 ? {} : { inventory }),
		summary: {
			...summary,
			partialAssets: Math.max(summary.partialAssets, partial ? 1 : 0)
		}
	};
}

function invokeProtocolScan(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore
): Effect.Effect<SavedAssetScan, AssetReaderError> {
	const telemetry = makeProtocolTelemetry(
		options.cachePath !== undefined,
		configuration.protocolObserver
	);
	const operation = Effect.tryPromise({
		try: (signal) => collectProtocolScan(configuration, options, progress, telemetry, signal),
		catch: (cause) => mapProtocolFailure(cause, "scan", options.projectRoot)
	});
	return Effect.gen(function* () {
		const exit = yield* Effect.exit(operation);
		if (Exit.isFailure(exit) && telemetry.terminalState === undefined && !telemetry.cancelled) {
			telemetry.terminalState = "failed";
		}
		yield* recordProtocolTelemetry("scan", telemetry);
		return yield* exit;
	}).pipe(
		Effect.withSpan("unreal_assets.protocol_scan"),
		Effect.withSpan("unreal_assets.protocol_process", {
			attributes: { "unreal.operation": "scan", "unreal.path": options.projectRoot }
		})
	);
}

async function collectProtocolSingle<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly signal: AbortSignal | undefined;
	readonly telemetry: ProtocolTelemetry;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Promise<A> {
	let selected: A | undefined;
	for await (const event of protocolEvents({
		configuration: options.configuration,
		operation: options.operation,
		path: options.path,
		request: options.request,
		signal: options.signal,
		telemetry: options.telemetry,
		timeoutMs: options.configuration.timeoutMs,
		...(options.onEvent === undefined ? {} : { onEvent: options.onEvent })
	})) {
		if (event.kind === "failed" || event.kind === "rejected") {
			throw protocolFailureFromEvent(event);
		}
		if (event.kind === "result" && event.result.kind === options.expected) {
			selected = options.select(event.result);
		}
	}
	if (selected === undefined) {
		throw new ProtocolStreamFailure(
			"contract",
			`Protocol stream did not produce ${options.expected}`
		);
	}
	return selected;
}

function invokeProtocolSingle<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Effect.Effect<A, AssetReaderError> {
	const telemetry = makeProtocolTelemetry(false, options.configuration.protocolObserver);
	const operation = Effect.tryPromise({
		try: (signal) => collectProtocolSingle({ ...options, signal, telemetry }),
		catch: (cause) => mapProtocolFailure(cause, options.operation, options.path)
	});
	return Effect.gen(function* () {
		const exit = yield* Effect.exit(operation);
		if (Exit.isFailure(exit) && telemetry.terminalState === undefined && !telemetry.cancelled) {
			telemetry.terminalState = "failed";
		}
		yield* recordProtocolTelemetry(options.operation, telemetry);
		return yield* exit;
	}).pipe(
		Effect.withSpan(`unreal_assets.protocol_${options.operation}`, {
			attributes: { "unreal.asset_path": options.path }
		}),
		Effect.withSpan("unreal_assets.protocol_process", {
			attributes: { "unreal.operation": options.operation, "unreal.path": options.path }
		})
	);
}

function protocolProjectionStream<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly extraction: SavedAssetExtractionOptions;
	readonly projection: "text" | "texture";
	readonly scanStore: ScanProgressStore;
	readonly decode: (event: UAssetIoResult) => A | undefined;
}): Stream.Stream<A, AssetReaderError> {
	const operation = options.projection === "text" ? "extract_text" : "extract_texture";
	const request = makeProtocolRequest(
		{
			kind: operation,
			projectRoot: options.extraction.projectRoot,
			...(options.extraction.paths === undefined
				? {}
				: { paths: [...options.extraction.paths] })
		},
		{
			...(options.extraction.concurrency === undefined
				? {}
				: { concurrency: options.extraction.concurrency }),
			...(options.extraction.maximumAssets === undefined
				? {}
				: { maximumAssets: options.extraction.maximumAssets }),
			maximumOutputBytes: MAX_OUTPUT_BYTES,
			timeoutMs: options.configuration.catalogTimeoutMs
		}
	);
	const telemetry = makeProtocolTelemetry(false, options.configuration.protocolObserver);
	const controller = new AbortController();
	const events = (async function* (): AsyncGenerator<A> {
		try {
			for await (const event of protocolEvents({
				configuration: options.configuration,
				operation,
				path: options.extraction.projectRoot,
				request,
				signal: controller.signal,
				telemetry,
				timeoutMs: options.configuration.catalogTimeoutMs
			})) {
				if (event.kind === "failed" || event.kind === "rejected") {
					throw protocolFailureFromEvent(event);
				}
				if (event.kind === "progress") {
					options.scanStore.current = {
						...options.scanStore.current,
						phase: protocolPhase(event.phase),
						processedAssets: event.completedItems,
						...(event.totalItems === undefined ? {} : { totalAssets: event.totalItems })
					};
				}
				if (event.kind === "result") {
					if (
						(event.result.kind === "extract_text" ||
							event.result.kind === "extract_texture") &&
						(event.result.event.event === "text_summary" ||
							event.result.event.event === "texture_summary")
					) {
						options.scanStore.current = {
							...options.scanStore.current,
							cacheHits: event.result.event.cacheHits,
							emittedAssets: event.result.event.emittedAssets,
							processedAssets: event.result.event.scannedAssets,
							totalAssets: event.result.event.scannedAssets
						};
					}
					const value = options.decode(event.result);
					if (value !== undefined) yield value;
				}
			}
		} catch (cause) {
			if (telemetry.terminalState === undefined && !telemetry.cancelled) {
				telemetry.terminalState = "failed";
			}
			throw cause;
		}
	})();
	return Stream.fromAsyncIterable(events, (cause) =>
		mapProtocolFailure(cause, operation, options.extraction.projectRoot)
	).pipe(
		Stream.ensuring(Effect.sync(() => controller.abort())),
		Stream.ensuring(recordProtocolTelemetry(operation, telemetry)),
		Stream.withSpan(`unreal_assets.protocol_extract_${options.projection}`, {
			attributes: { "unreal.project_root": options.extraction.projectRoot }
		}),
		Stream.withSpan("unreal_assets.protocol_process", {
			attributes: {
				"unreal.operation": operation,
				"unreal.path": options.extraction.projectRoot
			}
		})
	);
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
				{ maximumOutputBytes: MAX_OUTPUT_BYTES, timeoutMs: configuration.timeoutMs }
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
				{ maximumOutputBytes: MAX_OUTPUT_BYTES, timeoutMs: configuration.timeoutMs }
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
					maximumOutputBytes: MAX_OUTPUT_BYTES,
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
export interface ResolvedScanTarget {
	/** Roots to enumerate. Empty means the project's whole `Content` directory. */
	readonly paths: readonly string[];
	readonly projectRoot: string;
}

/** Carries an already-explained resolution failure out of the async resolver body. */
class ScanTargetError extends Error {}

async function projectFilesIn(directory: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".uproject")
			.map((entry) => join(directory, entry.name));
	} catch {
		// An unreadable ancestor is not the target's fault; keep walking toward the root.
		return [];
	}
}

/**
 * Resolves any user-supplied path onto a scan target. A project root or `.uproject` file scans the
 * whole project; a subdirectory or a single asset walks up to the owning project and scopes
 * enumeration to that path, so `/Game` object paths stay resolvable either way.
 */
export function resolveScanTarget(
	path: string
): Effect.Effect<ResolvedScanTarget, AssetReaderError> {
	return Effect.tryPromise({
		try: async (): Promise<ResolvedScanTarget> => {
			const target = resolve(path);
			const details = await stat(target).catch(() => {
				throw new ScanTargetError(`Scan target does not exist: ${target}`);
			});
			if (details.isFile() && extname(target).toLowerCase() === ".uproject") {
				return { paths: [], projectRoot: dirname(target) };
			}
			if (details.isDirectory()) {
				const projects = await projectFilesIn(target);
				if (projects.length > 1) {
					throw new ScanTargetError(
						`Project directory contains more than one .uproject file: ${target}`
					);
				}
				if (projects.length === 1) return { paths: [], projectRoot: target };
			}
			let directory = dirname(target);
			for (;;) {
				const projects = await projectFilesIn(directory);
				if (projects.length > 1) {
					throw new ScanTargetError(
						`Project directory containing ${target} has more than one .uproject file: ${directory}`
					);
				}
				if (projects.length === 1) return { paths: [target], projectRoot: directory };
				const parent = dirname(directory);
				if (parent === directory) {
					throw new ScanTargetError(
						`No .uproject file at or above ${target}; scans resolve object paths against a project root.`
					);
				}
				directory = parent;
			}
		},
		catch: (cause) =>
			new AssetReaderError({
				kind: "discovery",
				operation: "discovery",
				message:
					cause instanceof ScanTargetError
						? cause.message
						: `Could not resolve a scan target from ${path}: ${String(cause)}`,
				path,
				retrySafe: false
			})
	}).pipe(Effect.withSpan("unreal_assets.resolve_scan_target"));
}

export function readSavedWorld(
	options: SavedWorldReadOptions
): Effect.Effect<SavedWorld, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readSavedWorld(options));
}

export function getAssetReaderSource(): Effect.Effect<"configured" | "path", never, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.source());
}
