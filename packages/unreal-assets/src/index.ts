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
import { Config, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 5 * 60_000;

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
	readonly timeoutMs: number;
}

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
	readonly timeoutMs: number;
}): AsyncGenerator<ProtocolEvent> {
	const child = spawn(options.configuration.executable, ["protocol"], {
		signal: options.signal,
		timeout: options.timeoutMs,
		windowsHide: true
	});
	let closed = false;
	let processError: Error | undefined;
	let stderr = "";
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
		let expectedSequence = 0;
		let sawAccepted = false;
		let sawTerminal = false;
		for await (const chunk of child.stdout as AsyncIterable<string>) {
			pending += chunk;
			if (Buffer.byteLength(pending, "utf8") > MAX_OUTPUT_BYTES) {
				throw new ProtocolStreamFailure("contract", "Protocol output exceeded 64 MiB");
			}
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim().length === 0) continue;
				let decoded: ProtocolEvent;
				try {
					decoded = Schema.decodeUnknownSync(UAssetIoEvent)(JSON.parse(line) as unknown);
				} catch (cause) {
					throw new ProtocolStreamFailure(
						"contract",
						`Invalid protocol event: ${String(cause)}`
					);
				}
				if (decoded.requestId !== options.request.requestId) {
					throw new ProtocolStreamFailure(
						"contract",
						"Protocol requestId changed during the stream"
					);
				}
				if (decoded.sequence !== expectedSequence) {
					throw new ProtocolStreamFailure(
						"contract",
						`Protocol sequence expected ${expectedSequence} but received ${decoded.sequence}`
					);
				}
				expectedSequence += 1;
				if (!sawAccepted && decoded.kind !== "accepted") {
					throw new ProtocolStreamFailure(
						"contract",
						"Protocol stream did not start with accepted"
					);
				}
				if (sawTerminal) {
					throw new ProtocolStreamFailure(
						"contract",
						"Protocol emitted an event after its terminal event"
					);
				}
				if (decoded.kind === "accepted") sawAccepted = true;
				if (
					decoded.kind === "completed" ||
					decoded.kind === "failed" ||
					decoded.kind === "rejected"
				) {
					sawTerminal = true;
				}
				yield decoded;
			}
		}
		if (pending.trim().length > 0) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol output ended with an incomplete JSON line"
			);
		}
		const closedResult = await closePromise;
		if (processError !== undefined)
			throw new ProtocolStreamFailure("process", processError.message);
		if (!sawAccepted || !sawTerminal) {
			throw new ProtocolStreamFailure(
				closedResult.signal === "SIGTERM" ? "timeout" : "contract",
				stderr.trim() || "Protocol stream ended without a terminal event"
			);
		}
		if (closedResult.code !== 0) {
			throw new ProtocolStreamFailure(
				"process",
				stderr.trim() ||
					`Protocol worker exited ${closedResult.code ?? closedResult.signal ?? "unknown"}`,
				closedResult.code ?? undefined
			);
		}
	} finally {
		if (!closed && !child.killed) child.kill();
	}
}

async function collectProtocolScan(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore,
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
	return Effect.tryPromise({
		try: (signal) => collectProtocolScan(configuration, options, progress, signal),
		catch: (cause) => mapProtocolFailure(cause, "scan", options.projectRoot)
	}).pipe(Effect.withSpan("unreal_assets.protocol_scan"));
}

async function collectProtocolSingle<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly signal: AbortSignal | undefined;
}): Promise<A> {
	let selected: A | undefined;
	for await (const event of protocolEvents({
		configuration: options.configuration,
		operation: options.operation,
		path: options.path,
		request: options.request,
		signal: options.signal,
		timeoutMs: options.configuration.timeoutMs
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
}): Effect.Effect<A, AssetReaderError> {
	return Effect.tryPromise({
		try: (signal) => collectProtocolSingle({ ...options, signal }),
		catch: (cause) => mapProtocolFailure(cause, options.operation, options.path)
	}).pipe(
		Effect.withSpan(`unreal_assets.protocol_${options.operation}`, {
			attributes: { "unreal.asset_path": options.path }
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
	const events = (async function* (): AsyncGenerator<A> {
		for await (const event of protocolEvents({
			configuration: options.configuration,
			operation,
			path: options.extraction.projectRoot,
			request,
			signal: undefined,
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
				const value = options.decode(event.result);
				if (value !== undefined) yield value;
			}
		}
	})();
	return Stream.fromAsyncIterable(events, (cause) =>
		mapProtocolFailure(cause, operation, options.extraction.projectRoot)
	).pipe(
		Stream.withSpan(`unreal_assets.protocol_extract_${options.projection}`, {
			attributes: { "unreal.project_root": options.extraction.projectRoot }
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
			select: (result) => (result.kind === "saved_world" ? result.world : undefined)
		});
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
