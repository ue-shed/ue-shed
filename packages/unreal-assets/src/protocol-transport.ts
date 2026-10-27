import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { channel } from "node:diagnostics_channel";
import type { Readable, Writable } from "node:stream";
import {
	SavedAssetManifestEntry,
	SavedAssetScan,
	SavedAssetScanEntry,
	SavedAssetScanFailure,
	SavedAssetScanProgress,
	SavedAssetScanSummary,
	SavedWorldProgress,
	UAssetIoEvent,
	type UAssetIoOperation,
	type UAssetIoRequest,
	type UAssetIoResult
} from "@ue-shed/protocol";
import { Effect, Exit, Metric, Schema, Stream } from "effect";
import type {
	AssetReaderConfiguration,
	AssetReaderProtocolObservation,
	ProtocolTerminalState,
	SavedAssetExtractionOptions,
	SavedAssetScanOptions,
	SavedAssetStagedTextExtractionOptions,
	SavedWorldProgressStore,
	ScanProgressStore
} from "./asset-reader.js";
import { readerPathKey, uniqueRequestPathIndices } from "./protocol-path-identity.js";
import {
	MAX_PROTOCOL_REQUEST_BYTES,
	protocolPathBytes,
	requestPathBudget,
	stagedPathBytes
} from "./protocol-request-limit.js";
import {
	AssetReaderError,
	assetReaderGuidance,
	MAX_CAPTURED_STDERR_BYTES,
	MAX_PROTOCOL_OUTPUT_BYTES,
	assetReaderCacheOutcome,
	assetReaderCancellations,
	assetReaderDiscoveryDuration,
	assetReaderInspectedFiles,
	assetReaderPartialFailures,
	assetReaderQueueDuration,
	assetReaderReadBytes,
	assetReaderStartupDuration,
	assetReaderTerminalState
} from "./asset-reader.js";

export type ProtocolEvent = Schema.Schema.Type<typeof UAssetIoEvent>;
export type ProtocolDiagnostic = Pick<
	Extract<ProtocolEvent, { readonly kind: "diagnostic" }>,
	"code" | "message" | "severity"
>;
export interface ProtocolSingleEvidence<A> {
	readonly diagnostics: readonly ProtocolDiagnostic[];
	readonly outcome: "complete" | "partial";
	readonly value: A;
}

const TYPE_SIDE_VALIDATION_MIN_FRAME_CHARACTERS = 8 * 1024 * 1024;
const PROJECT_INDEX_TYPE_SIDE_MIN_FRAME_CHARACTERS = 128 * 1024;
const MAX_PROTOCOL_TERMINATION_WAIT_MS = 1_000;
const benchmark = channel("ue-shed.game-text-benchmark");
/** Bytes each request moves between the host and a native process, for boundary measurements. */
const boundary = channel("ue-shed.native-boundary");
const exactProtocolParseOptions = { onExcessProperty: "error" } as const;
const validateProtocolEventType = Schema.decodeUnknownExit(
	Schema.toType(UAssetIoEvent),
	exactProtocolParseOptions
);
const decodeProtocolEvent = Schema.decodeUnknownSync(UAssetIoEvent, exactProtocolParseOptions);

const isProjectIndexPageFrame = Schema.is(
	Schema.Struct({
		kind: Schema.Literal("result"),
		result: Schema.Struct({
			kind: Schema.Literals(["project_index_page", "project_index_dictionary_page"])
		})
	})
);

/** @internal Validate one exact wire event through the measured type-side path. */
export function validateProtocolEvent<Input>(input: Input, frameCharacters: number): ProtocolEvent {
	// Project Index strings usually already satisfy the decoded type (including trimming). Type-side
	// validation avoids repeating those transformations; the fallback still normalizes wire input.
	// Their bounded 1–3 MB frames benefit below the general large-frame threshold.
	const useTypeSide =
		frameCharacters >= TYPE_SIDE_VALIDATION_MIN_FRAME_CHARACTERS ||
		(frameCharacters >= PROJECT_INDEX_TYPE_SIDE_MIN_FRAME_CHARACTERS &&
			isProjectIndexPageFrame(input));
	if (!useTypeSide) {
		return decodeProtocolEvent(input);
	}
	const validation = validateProtocolEventType(input);
	if (Exit.isSuccess(validation)) return validation.value;
	// Preserve the decoder's detailed issue tree on the exceptional invalid-input path.
	return decodeProtocolEvent(input);
}

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
		const parseStarted = benchmark.hasSubscribers ? performance.now() : undefined;
		if (line.trim().length === 0) {
			throw new ProtocolStreamFailure("contract", "Protocol stream contains an empty frame");
		}
		let event: ProtocolEvent;
		try {
			event = validateProtocolEvent(JSON.parse(line), line.length);
		} catch (cause) {
			throw new ProtocolStreamFailure(
				"contract",
				"A native protocol event is not valid JSON or does not match its negotiated contract.",
				undefined,
				undefined,
				undefined,
				cause
			);
		}
		this.push(event);
		if (parseStarted !== undefined)
			benchmark.publish({
				stage: "tsFrameParse",
				requestId: event.requestId,
				ms: performance.now() - parseStarted
			});
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

type ProtocolFailureKind =
	| "contract"
	| "discovery"
	| "process"
	| "request_too_large"
	| "resource_limit"
	| "timeout";

export class ProtocolStreamFailure extends Error {
	readonly _tag = "ProtocolStreamFailure";

	constructor(
		readonly kind: ProtocolFailureKind,
		message: string,
		readonly exitCode?: number,
		readonly stderr?: string,
		readonly protocolCode?: string,
		cause?: unknown
	) {
		super(message, { cause });
	}
}

function processFailureCode(cause: Error | undefined): string | undefined {
	if (cause === undefined || !("code" in cause)) return undefined;
	return cause.code === "ENOENT" ? "executable_missing" : undefined;
}

interface ProtocolTelemetry {
	readonly queuedAt: number;
	startedAt: number | undefined;
	acceptedAt: number | undefined;
	discoveryStartedAt: number | undefined;
	discoveryDurationMs: number | undefined;
	framePendingBytes: number;
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
	requestBytes: number;
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
		framePendingBytes: 0,
		inspectedFiles: 0,
		largestFrameBytes: 0,
		observer,
		outputBytes: 0,
		requestBytes: 0,
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
		case "blueprint":
			telemetry.inspectedFiles += 1;
			if (result.blueprint.coverage_gaps.length > 0) telemetry.partialFailures += 1;
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
		case "extract_text_packages":
			if (
				result.event.event === "text_package" ||
				result.event.event === "text_package_record"
			) {
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
	const segments = chunk.split("\n");
	for (let index = 0; index < segments.length - 1; index += 1) {
		telemetry.framePendingBytes += Buffer.byteLength(segments[index] ?? "", "utf8") + 1;
		telemetry.largestFrameBytes = Math.max(
			telemetry.largestFrameBytes,
			telemetry.framePendingBytes
		);
		telemetry.framePendingBytes = 0;
	}
	telemetry.framePendingBytes += Buffer.byteLength(segments.at(-1) ?? "", "utf8");
}

/** @internal Incremental NDJSON framing without repeatedly copying a growing partial line. */
export class ProtocolLineDecoder {
	private parts: string[] = [];

	push(chunk: string): readonly string[] {
		const lines: string[] = [];
		let start = 0;
		for (
			let newline = chunk.indexOf("\n");
			newline >= 0;
			newline = chunk.indexOf("\n", start)
		) {
			this.parts.push(chunk.slice(start, newline));
			const line = this.parts.join("");
			lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
			this.parts = [];
			start = newline + 1;
		}
		if (start < chunk.length) this.parts.push(chunk.slice(start));
		return lines;
	}

	finish(): void {
		if (this.parts.length > 0) {
			throw new ProtocolStreamFailure(
				"contract",
				"Protocol output ended with an incomplete JSON line"
			);
		}
	}
}

function recordProtocolTelemetry(
	operation: string,
	telemetry: ProtocolTelemetry
): Effect.Effect<void> {
	const at = nowMs();
	finishDiscovery(telemetry, at);
	if (boundary.hasSubscribers)
		boundary.publish({
			transport: "reader",
			operation,
			requestBytes: telemetry.requestBytes,
			responseBytes: telemetry.outputBytes
		});
	const terminalState = telemetry.cancelled ? "cancelled" : (telemetry.terminalState ?? "failed");
	notifyProtocolObserver(telemetry, {
		kind: "worker_completed",
		largestFrameBytes: telemetry.largestFrameBytes,
		outputBytes: telemetry.outputBytes,
		...(telemetry.workerPid === undefined ? undefined : { pid: telemetry.workerPid }),
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

export function makeProtocolRequest(
	operation: UAssetIoOperation,
	limits: UAssetIoRequest["limits"],
	options?: { readonly contractMinor?: number }
): UAssetIoRequest {
	protocolRequestCounter += 1;
	const fields = {
		contract: {
			name: "uasset-io" as const,
			version: { major: 1 as const, minor: options?.contractMinor ?? 0 }
		},
		limits,
		requestId: `unreal-assets-${process.pid}-${protocolRequestCounter}`
	};
	// Narrow each branch to preserve the request union's operation/version correlation.
	if (operation.kind === "game_text_index") {
		const request = operation.request;
		if (request.action === "publish_packages" || request.action === "plan_packages")
			return { ...fields, operation: { kind: "game_text_index", request } };
		return { ...fields, operation: { kind: "game_text_index", request } };
	}
	if (operation.kind === "extract_text_packages") {
		if (operation.staging !== undefined) {
			const staging = operation.staging;
			if (staging.snapshots !== undefined)
				return {
					...fields,
					operation: {
						...operation,
						staging: {
							directory: staging.directory,
							groups: staging.groups,
							snapshots: staging.snapshots
						}
					}
				};
			return {
				...fields,
				operation: {
					...operation,
					staging: { directory: staging.directory, groups: staging.groups }
				}
			};
		}
		return { ...fields, operation };
	}
	return { ...fields, operation };
}

function protocolPhase(
	phase: Extract<ProtocolEvent, { readonly kind: "progress" }>["phase"]
): SavedAssetScanProgress["phase"] {
	switch (phase) {
		case "starting":
		case "discovering":
		case "enumerating":
			return "enumerating";
		case "reading":
		case "inspecting":
		case "comparing":
		case "reading_headers":
			return "scanning";
		case "emitting":
		case "committing":
			return "ready";
	}
}

function savedWorldPhase(
	phase: Extract<ProtocolEvent, { readonly kind: "progress" }>["phase"]
): SavedWorldProgress["phase"] {
	switch (phase) {
		case "starting":
		case "discovering":
		case "enumerating":
			return "enumerating";
		case "reading":
		case "comparing":
			return "scanning";
		case "inspecting":
		case "reading_headers":
			return "resolving";
		case "emitting":
		case "committing":
			return "ready";
	}
}

export function updateSavedWorldProgress(
	store: SavedWorldProgressStore,
	event: ProtocolEvent
): void {
	if (event.kind === "progress") {
		store.current = {
			...store.current,
			phase: savedWorldPhase(event.phase),
			processedPackages: event.completedItems,
			...(event.totalItems === undefined ? undefined : { totalPackages: event.totalItems })
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
		event.code === "resource_limit" ? 7 : undefined,
		undefined,
		event.code
	);
}

/** @internal Maps transport failures without discarding native protocol classification. */
export function mapProtocolFailure(
	cause: unknown,
	operation: AssetReaderError["operation"],
	path: string
): AssetReaderError {
	if (cause instanceof ProtocolStreamFailure) {
		const kind = cause.kind === "timeout" ? "timeout" : cause.kind;
		const retrySafe =
			cause.kind === "timeout" || cause.kind === "discovery" || cause.kind === "process";
		return new AssetReaderError({
			cause,
			...(cause.protocolCode === undefined ? undefined : { code: cause.protocolCode }),
			kind,
			operation,
			message: cause.message,
			path,
			retrySafe,
			...assetReaderGuidance(kind, retrySafe),
			...(cause.exitCode === undefined ? undefined : { exitCode: cause.exitCode })
		});
	}
	const code = cause instanceof Error ? processFailureCode(cause) : undefined;
	return new AssetReaderError({
		...(code === undefined ? undefined : { code }),
		kind: "process",
		operation,
		message:
			code === undefined
				? `The saved-asset reader process failed during ${operation}.`
				: `The saved-asset reader process failed during ${operation} (${code}).`,
		path,
		retrySafe: false,
		...assetReaderGuidance("process", false),
		cause
	});
}

/** @internal Narrow one-shot process boundary used to verify failures without a native worker. */
export interface ProtocolProcess {
	readonly pid?: number | undefined;
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly killed: boolean;
	kill(): boolean;
	once(event: "error", listener: (cause: Error) => void): void;
	once(event: "close", listener: (code: number | null, signal: string | null) => void): void;
}

/** @internal */
export type ProtocolProcessFactory = (
	executable: string,
	options: { readonly signal: AbortSignal | undefined; readonly timeoutMs: number }
) => ProtocolProcess;

function spawnProtocolProcess(
	executable: string,
	options: { readonly signal: AbortSignal | undefined; readonly timeoutMs: number }
): ProtocolProcess {
	return spawn(executable, ["protocol"], {
		signal: options.signal,
		timeout: options.timeoutMs,
		windowsHide: true
	});
}

export async function* runUassetProtocolEvents(options: {
	readonly configuration: Pick<AssetReaderConfiguration, "executable" | "protocolObserver">;
	readonly processFactory?: ProtocolProcessFactory;
	readonly request: UAssetIoRequest;
	readonly signal: AbortSignal | undefined;
	readonly telemetry?: ProtocolTelemetry;
	readonly timeoutMs: number;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): AsyncGenerator<ProtocolEvent> {
	const telemetry =
		options.telemetry ?? makeProtocolTelemetry(false, options.configuration.protocolObserver);
	try {
		yield* protocolEvents({
			configuration: {
				catalogTimeoutMs: options.timeoutMs,
				executable: options.configuration.executable,
				...(options.configuration.protocolObserver === undefined
					? undefined
					: { protocolObserver: options.configuration.protocolObserver }),
				timeoutMs: options.timeoutMs
			},
			operation: options.request.operation.kind,
			path: "project-index",
			...(options.processFactory === undefined
				? undefined
				: { processFactory: options.processFactory }),
			request: options.request,
			signal: options.signal,
			telemetry,
			timeoutMs: options.timeoutMs,
			...(options.onEvent === undefined ? undefined : { onEvent: options.onEvent })
		});
	} finally {
		if (telemetry.terminalState === undefined && !telemetry.cancelled) {
			telemetry.terminalState = "failed";
		}
		await Effect.runPromise(recordProtocolTelemetry("project_index", telemetry));
	}
}

/** @internal Narrow process boundary used to verify session termination without a native worker. */
export interface ProtocolSessionProcess {
	readonly pid: number | undefined;
	readonly stdin: {
		readonly destroyed: boolean;
		readonly destroy: () => void;
		readonly end: () => void;
		readonly on: (event: "error", listener: (cause: Error) => void) => void;
		readonly setDefaultEncoding: (encoding: BufferEncoding) => void;
		readonly write: (chunk: string, callback: (cause?: Error | null) => void) => boolean;
	} | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly exitCode: number | null;
	readonly signalCode: string | null;
	readonly killed: boolean;
	readonly kill: () => boolean;
	readonly onClose: (listener: (code: number | null, signal: string | null) => void) => void;
	readonly onError: (listener: (cause: Error) => void) => void;
	readonly unref: () => void;
}

export type ProtocolSessionProcessFactory = () => ProtocolSessionProcess;

async function waitForProtocolClose(
	closePromise: Promise<unknown>,
	timeoutMs: number
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			closePromise.then(() => true),
			new Promise<false>((resolvePromise) => {
				timer = setTimeout(() => resolvePromise(false), timeoutMs);
			})
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function spawnProtocolSession(executable: string): ProtocolSessionProcess {
	const child = spawn(executable, ["protocol-session"], { windowsHide: true });
	return {
		get exitCode() {
			return child.exitCode;
		},
		get killed() {
			return child.killed;
		},
		get pid() {
			return child.pid;
		},
		get signalCode() {
			return child.signalCode;
		},
		kill: () => child.kill(),
		onClose: (listener) => {
			child.once("close", listener);
		},
		onError: (listener) => {
			child.once("error", listener);
		},
		stderr: child.stderr,
		stdin: child.stdin,
		stdout: child.stdout,
		unref: () => child.unref()
	};
}

/** A scoped native protocol worker. Calls must be serialized by its owner. */
export class UassetProtocolSession {
	private child: ProtocolSessionProcess | undefined;
	private closePromise:
		| Promise<{ readonly code: number | null; readonly signal: string | null }>
		| undefined;
	private disposed = false;
	private iterator: AsyncIterator<string> | undefined;
	private processError: Error | undefined;
	private running = false;
	private stderr = "";
	private terminating = false;
	private started = 0;

	/** The running worker process, numbered by start; undefined while none runs. */
	get worker(): number | undefined {
		return this.child === undefined ? undefined : this.started;
	}

	constructor(
		private readonly configuration: Pick<
			AssetReaderConfiguration,
			"executable" | "protocolObserver" | "timeoutMs"
		>,
		private readonly processFactory: ProtocolSessionProcessFactory = () =>
			spawnProtocolSession(configuration.executable)
	) {}

	private start(): ProtocolSessionProcess {
		if (this.disposed) {
			throw new ProtocolStreamFailure("process", "Protocol session is closed");
		}
		if (this.child !== undefined) {
			if (this.terminating) {
				throw new ProtocolStreamFailure(
					"process",
					"Protocol session worker is still terminating"
				);
			}
			return this.child;
		}

		const child = this.processFactory();
		if (child.stdin === null || child.stdout === null) {
			child.kill();
			throw new ProtocolStreamFailure("process", "Protocol session did not expose pipes");
		}
		child.stdin.setDefaultEncoding("utf8");
		child.stdout.setEncoding("utf8");
		// NDJSON is framed by LF bytes. Node 26 readline also splits U+2028/U+2029,
		// which are valid literal characters inside a JSON string.
		const lines = (async function* (output: NonNullable<ProtocolSessionProcess["stdout"]>) {
			const decoder = new ProtocolLineDecoder();
			for await (const chunk of output) {
				const text = Schema.decodeUnknownSync(Schema.String)(chunk);
				for (const line of decoder.push(text)) yield line;
			}
			decoder.finish();
		})(child.stdout);
		this.child = child;
		this.started += 1;
		this.iterator = lines[Symbol.asyncIterator]();
		this.stderr = "";
		this.processError = undefined;
		this.terminating = false;
		// A worker may close its pipe while a request write is pending. Without a listener the
		// stream's EOF/EPIPE "error" event would crash the host instead of failing the request.
		child.stdin.on("error", (cause) => {
			if (this.child !== child) return;
			this.processError = cause;
		});
		if (child.stderr !== null) {
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				if (this.child !== child) return;
				if (this.stderr.length < MAX_CAPTURED_STDERR_BYTES) {
					this.stderr += chunk.slice(0, MAX_CAPTURED_STDERR_BYTES - this.stderr.length);
				}
			});
		}
		this.closePromise = new Promise((resolvePromise) => {
			child.onError((cause) => {
				if (this.child !== child) return;
				this.processError = cause;
			});
			child.onClose((code, signal) => resolvePromise({ code, signal }));
		});
		return child;
	}

	private releaseProcess(child: ProtocolSessionProcess): void {
		if (this.child !== child) return;
		this.child = undefined;
		this.closePromise = undefined;
		this.iterator = undefined;
		this.terminating = false;
	}

	private detachProcess(child: ProtocolSessionProcess): void {
		if (this.child !== child) return;
		// A worker that ignored termination must not keep Node/Electron alive after
		// scoped ownership ends. Late events are ignored by the child-generation guards.
		child.unref();
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
		this.releaseProcess(child);
	}

	private async nextLine(
		deadline: number,
		signal: AbortSignal | undefined
	): Promise<IteratorResult<string>> {
		if (signal?.aborted) {
			throw new ProtocolStreamFailure("process", "Protocol aborted");
		}
		const iterator = this.iterator;
		if (iterator === undefined) {
			throw new ProtocolStreamFailure("process", "Protocol session output is unavailable");
		}
		const remaining = Math.max(0, deadline - nowMs());
		return await new Promise<IteratorResult<string>>((resolvePromise, rejectPromise) => {
			let settled = false;
			const settle = (result: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				result();
			};
			const onAbort = () =>
				settle(() =>
					rejectPromise(new ProtocolStreamFailure("process", "Protocol aborted"))
				);
			const timer = setTimeout(
				() =>
					settle(() =>
						rejectPromise(
							new ProtocolStreamFailure("timeout", "Protocol session timed out")
						)
					),
				remaining
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			iterator.next().then(
				(value) => settle(() => resolvePromise(value)),
				(cause: unknown) => settle(() => rejectPromise(cause))
			);
		});
	}

	private async terminate(timeoutMs: number): Promise<boolean> {
		const child = this.child;
		const closePromise = this.closePromise;
		if (child === undefined) return true;
		this.terminating = true;
		if (child.exitCode === null && child.signalCode === null) child.kill();
		if (closePromise === undefined) return false;
		const closed = await waitForProtocolClose(
			closePromise,
			Math.min(Math.max(0, timeoutMs), MAX_PROTOCOL_TERMINATION_WAIT_MS)
		);
		if (closed) {
			this.releaseProcess(child);
		} else {
			void closePromise.then(() => this.releaseProcess(child));
		}
		return closed;
	}

	async *events(options: {
		readonly request: UAssetIoRequest;
		readonly signal: AbortSignal | undefined;
		readonly telemetryOperation?: string;
		readonly timeoutMs: number;
		readonly onEvent?: (event: ProtocolEvent) => void;
	}): AsyncGenerator<ProtocolEvent> {
		if (this.running) {
			throw new ProtocolStreamFailure("process", "Concurrent protocol session request");
		}
		this.running = true;
		const telemetry = makeProtocolTelemetry(false, this.configuration.protocolObserver);
		let terminal = false;
		try {
			const child = this.start();
			telemetry.startedAt = nowMs();
			if (child.pid !== undefined) {
				telemetry.workerPid = child.pid;
				notifyProtocolObserver(telemetry, { kind: "worker_started", pid: child.pid });
			}
			const validator = new ProtocolStreamValidator(
				options.request.contract,
				options.request.requestId
			);
			const outputBudget = new ProtocolOutputBudget(
				options.request.limits.maximumOutputBytes ?? MAX_PROTOCOL_OUTPUT_BYTES
			);
			const stdin = child.stdin;
			if (stdin === null) {
				throw new ProtocolStreamFailure("process", "Protocol session input is unavailable");
			}
			try {
				const encodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
				const frame = `${JSON.stringify(options.request)}\n`;
				telemetry.requestBytes = Buffer.byteLength(frame, "utf8");
				if (encodeStarted !== undefined)
					benchmark.publish({
						stage: "tsFrameEncode",
						requestId: options.request.requestId,
						ms: performance.now() - encodeStarted
					});
				const writeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
				await new Promise<void>((resolvePromise, rejectPromise) => {
					stdin.write(frame, (cause) => {
						if (cause === null || cause === undefined) resolvePromise();
						else rejectPromise(cause);
					});
				});
				if (writeStarted !== undefined)
					benchmark.publish({
						stage: "tsPipeWriteCallback",
						requestId: options.request.requestId,
						ms: performance.now() - writeStarted
					});
			} catch (cause) {
				const processCause =
					this.processError ?? (cause instanceof Error ? cause : undefined);
				throw new ProtocolStreamFailure(
					"process",
					"The native protocol session could not write its request",
					undefined,
					undefined,
					processFailureCode(processCause),
					processCause ?? cause
				);
			}
			const deadline = nowMs() + options.timeoutMs;
			while (!terminal) {
				const next = await this.nextLine(deadline, options.signal);
				if (next.done) {
					const closed = await this.closePromise;
					throw new ProtocolStreamFailure(
						"process",
						this.processError?.message ||
							this.stderr.trim() ||
							`Protocol session exited ${closed?.code ?? closed?.signal ?? "unknown"}`,
						closed?.code ?? undefined,
						this.stderr.trim() || undefined,
						processFailureCode(this.processError)
					);
				}
				const chunk = `${next.value}\n`;
				observeProtocolChunk(chunk, telemetry);
				outputBudget.observe(chunk);
				const event = validator.pushLine(next.value);
				observeProtocolEvent(event, telemetry);
				options.onEvent?.(event);
				terminal = isProtocolTerminal(event);
				if (terminal) validator.finish();
				yield event;
			}
		} finally {
			if (!terminal) {
				telemetry.cancelled = options.signal?.aborted ?? false;
				// Keep the request failure bounded while retaining ownership until the
				// worker actually closes. A later request cannot replace this child.
				await this.terminate(options.timeoutMs);
			}
			if (telemetry.terminalState === undefined && !telemetry.cancelled) {
				telemetry.terminalState = "failed";
			}
			await Effect.runPromise(
				recordProtocolTelemetry(
					options.telemetryOperation ?? options.request.operation.kind,
					telemetry
				)
			);
			this.running = false;
		}
	}

	async close(): Promise<void> {
		this.disposed = true;
		const child = this.child;
		if (child?.stdin !== null && child?.stdin !== undefined && !child.stdin.destroyed) {
			child.stdin.end();
		}
		// Scope release is bounded too. A worker that still refuses to close is detached
		// from every host-liveness handle after the final termination attempt.
		const closed = await this.terminate(this.configuration.timeoutMs);
		if (!closed && child !== undefined) this.detachProcess(child);
	}
}

async function* protocolEvents(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: string;
	readonly path: string;
	readonly processFactory?: ProtocolProcessFactory;
	readonly request: UAssetIoRequest;
	readonly signal: AbortSignal | undefined;
	readonly telemetry: ProtocolTelemetry;
	readonly timeoutMs: number;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): AsyncGenerator<ProtocolEvent> {
	const queuedAt = options.telemetry.queuedAt;
	const requestFrame = `${JSON.stringify(options.request)}\n`;
	options.telemetry.requestBytes = Buffer.byteLength(requestFrame, "utf8");
	if (Buffer.byteLength(requestFrame, "utf8") > MAX_PROTOCOL_REQUEST_BYTES) {
		throw new ProtocolStreamFailure(
			"request_too_large",
			"The asset reader request is larger than its 4 MiB limit."
		);
	}
	const child = (options.processFactory ?? spawnProtocolProcess)(
		options.configuration.executable,
		{ signal: options.signal, timeoutMs: options.timeoutMs }
	);
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
			if (stderr.length < MAX_CAPTURED_STDERR_BYTES) {
				stderr += chunk.slice(0, MAX_CAPTURED_STDERR_BYTES - stderr.length);
			}
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
		// A worker may reject input and close its pipe before the pending write completes.
		// Surface EOF/EPIPE through the typed process failure instead of crashing Node.
		child.stdin.on("error", (cause) => {
			processError = cause;
		});
		child.stdin.end(requestFrame);
		child.stdout.setEncoding("utf8");
		const lines = new ProtocolLineDecoder();
		const outputBudget = new ProtocolOutputBudget(
			options.request.limits.maximumOutputBytes ?? MAX_PROTOCOL_OUTPUT_BYTES
		);
		const validator = new ProtocolStreamValidator(
			options.request.contract,
			options.request.requestId
		);
		// SAFETY: spawn configures stdout encoding to utf8 above, so iterator chunks are strings.
		// Verified by: packages/unreal-assets/src/protocol-transport.test.ts
		// ("decodes worker stdout as UTF-8 text even when a character spans two chunks")
		for await (const chunk of child.stdout as AsyncIterable<string>) {
			observeProtocolChunk(chunk, options.telemetry);
			outputBudget.observe(chunk);
			for (const line of lines.push(chunk)) {
				const decoded = validator.pushLine(line);
				observeProtocolEvent(decoded, options.telemetry);
				options.onEvent?.(decoded);
				yield decoded;
			}
		}
		lines.finish();
		const closedResult = await closePromise;
		if (processError !== undefined)
			throw new ProtocolStreamFailure(
				"process",
				"The native protocol worker could not process its request.",
				undefined,
				undefined,
				processFailureCode(processError),
				processError
			);
		if (closedResult.code !== 0) {
			throw new ProtocolStreamFailure(
				"process",
				stderr.trim() ||
					`Protocol worker exited ${closedResult.code ?? closedResult.signal ?? "unknown"}`,
				closedResult.code ?? undefined,
				stderr.trim() || undefined
			);
		}
		validator.finish();
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		if (options.telemetry.startedAt === undefined) options.telemetry.startedAt = queuedAt;
		if (!closed && !child.killed) child.kill();
	}
}

/** Span attribute naming how many reader processes one operation's path list was split across. */
const READER_BATCHES_ATTRIBUTE = "ue_shed.reader.batches";

/**
 * Publishes each batch's progress on top of the finished batches before it, so a caller polling
 * the store sees counts that only grow and `ready` only once the last batch is done.
 */
class BatchedScanProgress {
	private done = { cacheHits: 0, emittedAssets: 0, processedAssets: 0, totalAssets: 0 };

	constructor(
		private readonly store: ScanProgressStore,
		private readonly batches: number
	) {}

	/** The store one batch writes to. A single batch writes to the caller's store directly. */
	batch(index: number): ScanProgressStore {
		if (this.batches === 1) return this.store;
		const store = this.store;
		const done = this.done;
		const last = index === this.batches - 1;
		let local: SavedAssetScanProgress = {
			cacheHits: 0,
			emittedAssets: 0,
			phase: store.current.phase,
			processedAssets: 0,
			totalAssets: 0
		};
		return {
			get current(): SavedAssetScanProgress {
				return local;
			},
			set current(next: SavedAssetScanProgress) {
				local = next;
				store.current = {
					cacheHits: done.cacheHits + next.cacheHits,
					emittedAssets: done.emittedAssets + next.emittedAssets,
					phase: next.phase === "ready" && !last ? "scanning" : next.phase,
					processedAssets: done.processedAssets + next.processedAssets,
					totalAssets: done.totalAssets + next.totalAssets
				};
			}
		};
	}

	/** Adds a finished batch's counts to the base the next batch publishes on. */
	finish(batch: ScanProgressStore): void {
		if (this.batches === 1) return;
		const finished = batch.current;
		const packages = Math.max(finished.processedAssets, finished.totalAssets);
		this.done = {
			cacheHits: this.done.cacheHits + finished.cacheHits,
			emittedAssets: this.done.emittedAssets + finished.emittedAssets,
			processedAssets: this.done.processedAssets + packages,
			totalAssets: this.done.totalAssets + packages
		};
	}
}

type ScanSummaryCounts = Pick<
	SavedAssetScanSummary,
	| "cacheHits"
	| "diagnostics"
	| "emittedAssets"
	| "failedAssets"
	| "inventoryComplete"
	| "inventoryFiles"
	| "partialAssets"
	| "roots"
	| "scannedAssets"
	| "skippedAssets"
>;

/**
 * The summary fields of consecutive batches over disjoint paths, merged into one: counts add,
 * diagnostics concatenate in order, roots are their ordered union, and the inventory is complete
 * only when every batch's was.
 */
function mergeScanSummaryCounts(summaries: readonly ScanSummaryCounts[]): ScanSummaryCounts {
	const sum = (
		field:
			| "cacheHits"
			| "emittedAssets"
			| "failedAssets"
			| "partialAssets"
			| "scannedAssets"
			| "skippedAssets"
	) => summaries.reduce((total, summary) => total + summary[field], 0);
	const complete = summaries.flatMap((summary) =>
		summary.inventoryComplete === undefined ? [] : [summary.inventoryComplete]
	);
	const files = summaries.flatMap((summary) =>
		summary.inventoryFiles === undefined ? [] : [summary.inventoryFiles]
	);
	return {
		cacheHits: sum("cacheHits"),
		diagnostics: summaries.flatMap((summary) => summary.diagnostics),
		emittedAssets: sum("emittedAssets"),
		failedAssets: sum("failedAssets"),
		...(complete.length === 0 ? undefined : { inventoryComplete: complete.every(Boolean) }),
		...(files.length === 0
			? undefined
			: { inventoryFiles: files.reduce((total, count) => total + count, 0) }),
		partialAssets: sum("partialAssets"),
		roots: [...new Set(summaries.flatMap((summary) => summary.roots))],
		scannedAssets: sum("scannedAssets"),
		skippedAssets: sum("skippedAssets")
	};
}

/** One scan over consecutive path batches: entries, failures and inventory in order. */
function mergeSavedAssetScans(scans: readonly SavedAssetScan[]): SavedAssetScan {
	const [first, ...rest] = scans;
	if (first === undefined) throw new RangeError("A scan has at least one batch");
	if (rest.length === 0) return first;
	const inventory = scans.flatMap((scan) => scan.inventory ?? []);
	return {
		assets: scans.flatMap((scan) => scan.assets),
		failures: scans.flatMap((scan) => scan.failures),
		...(inventory.length === 0 ? undefined : { inventory }),
		summary: {
			...(rest.at(-1) ?? first).summary,
			...mergeScanSummaryCounts(scans.map((scan) => scan.summary))
		}
	};
}

/** Internal seams of a batched operation: tests fake the worker and lower the request limit. */
export interface ProtocolBatchingOptions {
	readonly processFactory?: ProtocolProcessFactory;
	/** Request frame limit batches are cut against. Defaults to the native reader's 4 MiB. */
	readonly maximumRequestBytes?: number;
}

/** The native reader's own `maximumAssets` refusal, raised for packages counted across batches. */
function packageLimitFailure(count: number, maximum: number): ProtocolStreamFailure {
	return new ProtocolStreamFailure(
		"resource_limit",
		`Scan found ${count} packages, above the limit of ${maximum}.`,
		7,
		undefined,
		"resource_limit"
	);
}

const requestTooLarge = () =>
	new ProtocolStreamFailure(
		"request_too_large",
		"A package path in this request does not fit in one 4 MiB asset reader request next to the request's options."
	);

/**
 * Indices of `paths`, in consecutive batches whose requests each fit the frame limit next to an
 * envelope of `envelopeBytes`. A list that fits one request is sent whole and unchanged. A longer
 * list first drops paths the reader would read twice (`uniqueRequestPathIndices`), so batches are
 * disjoint. Fails only when the envelope cannot hold even one of the paths.
 */
function requestPathBatches(
	projectRoot: string,
	paths: readonly string[],
	envelopeBytes: number,
	maximumRequestBytes: number
): readonly (readonly number[])[] | ProtocolStreamFailure {
	const budget = requestPathBudget(envelopeBytes, maximumRequestBytes);
	// The options alone are over the limit, with or without paths.
	if (budget < 0) return requestTooLarge();
	const sizes = paths.map(protocolPathBytes);
	if (sizes.reduce((total, size) => total + size, 0) <= budget) return [paths.map((_, i) => i)];
	if (sizes.some((size) => size > budget)) return requestTooLarge();
	const batches: number[][] = [];
	let batch: number[] = [];
	let bytes = 0;
	for (const index of uniqueRequestPathIndices(projectRoot, paths)) {
		const size = sizes[index] ?? 0;
		if (batch.length > 0 && bytes + size > budget) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(index);
		bytes += size;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/**
 * The reader's package identities already emitted by earlier batches. A later batch's record for
 * one of them is dropped, so overlapping roots the path de-duplication could not see still yield
 * each package once.
 */
class BatchIdentities {
	private readonly earlier = new Set<string>();
	private readonly current = new Set<string>();
	private readonly dropped = new Set<string>();

	constructor(private readonly projectRoot: string) {}

	/** Whether a record for `path` in the running batch is new to the operation. */
	keep(path: string): boolean {
		const key = readerPathKey(this.projectRoot, path);
		if (this.earlier.has(key)) {
			this.dropped.add(key);
			return false;
		}
		this.current.add(key);
		return true;
	}

	/** Closes the running batch; returns how many of its packages earlier batches already had. */
	finish(): number {
		for (const key of this.current) this.earlier.add(key);
		const dropped = this.dropped.size;
		this.current.clear();
		this.dropped.clear();
		return dropped;
	}
}

/** The path of a package-level scan entry. */
function scanEntryPath(entry: SavedAssetScanEntry): string {
	return entry.depth === "header" ? entry.header.path : entry.inspection.path;
}

/**
 * Removes the per-batch header caches a longer earlier scan left behind, from batch `from` up to
 * the first index with no file. Removal failures are ignored: the files are only caches.
 */
async function removeLeftoverBatchCaches(cachePath: string, from: number): Promise<void> {
	for (let index = from; ; index += 1) {
		try {
			await unlink(batchCachePath(cachePath, index));
		} catch (cause) {
			const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
			if (code === "ENOENT" || code === "ENOTDIR") return;
		}
	}
}

/** The header cache file of batch `index` in a scan split across several requests. */
function batchCachePath(cachePath: string, index: number): string {
	return `${cachePath}.batch-${index}`;
}

/** The request one scan batch sends. */
function makeScanRequest(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions
): UAssetIoRequest {
	return makeProtocolRequest(
		{
			kind: "scan",
			projectRoot: options.projectRoot,
			depth: options.depth ?? "full",
			...(options.paths === undefined ? undefined : { paths: [...options.paths] }),
			...(options.cachePath === undefined ? undefined : { cachePath: options.cachePath }),
			...(options.inventory === undefined ? undefined : { inventory: options.inventory }),
			...(options.classes === undefined ? undefined : { classes: [...options.classes] }),
			...(options.classPrefixes === undefined
				? undefined
				: { classPrefixes: [...options.classPrefixes] }),
			...(options.classNameSuffixes === undefined
				? undefined
				: { classNameSuffixes: [...options.classNameSuffixes] }),
			...(options.names === undefined ? undefined : { names: [...options.names] })
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
		},
		{ contractMinor: options.depth === "header" ? (options.headerData ? 9 : 0) : 14 }
	);
}

async function collectProtocolScan(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore,
	telemetry: ProtocolTelemetry,
	signal?: AbortSignal,
	processFactory?: ProtocolProcessFactory
): Promise<SavedAssetScan> {
	const request = makeScanRequest(configuration, options);
	const assets: SavedAssetScanEntry[] = [];
	const failures: SavedAssetScanFailure[] = [];
	const inventory: SavedAssetManifestEntry[] = [];
	let summary: SavedAssetScanSummary | undefined;
	let partial = false;
	for await (const event of protocolEvents({
		configuration,
		operation: "scan",
		path: options.projectRoot,
		...(processFactory === undefined ? undefined : { processFactory }),
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
				...(event.totalItems === undefined ? undefined : { totalAssets: event.totalItems })
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
		...(inventory.length === 0 ? undefined : { inventory }),
		summary: {
			...summary,
			partialAssets: Math.max(summary.partialAssets, partial ? 1 : 0)
		}
	};
}

/** One scan request in one reader process, with that process's telemetry. */
function invokeProtocolScanBatch(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore,
	processFactory: ProtocolProcessFactory | undefined
): Effect.Effect<SavedAssetScan, AssetReaderError> {
	const telemetry = makeProtocolTelemetry(
		options.cachePath !== undefined,
		configuration.protocolObserver
	);
	const operation = Effect.tryPromise({
		try: (signal) =>
			collectProtocolScan(
				configuration,
				options,
				progress,
				telemetry,
				signal,
				processFactory
			),
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
		Effect.withSpan("unreal_assets.protocol_process", {
			attributes: { "unreal.operation": "scan", "unreal.path": options.projectRoot }
		})
	);
}

/**
 * Scans in one reader process per path batch, one after another, and merges the batches into one
 * result. A path list that fits one request is sent unchanged. A longer one is de-duplicated as the
 * reader would, cut against the measured request envelope, and each package is reported once even
 * where roots overlap. `maximumAssets` bounds the unique packages of the whole scan, and each batch
 * keeps its own header cache beside `cachePath`.
 */
export function invokeProtocolScan(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore,
	batching: ProtocolBatchingOptions = {}
): Effect.Effect<SavedAssetScan, AssetReaderError> {
	const projectRoot = options.projectRoot;
	return Effect.gen(function* () {
		const paths = options.paths;
		const batches =
			paths === undefined
				? undefined
				: requestPathBatches(
						projectRoot,
						paths,
						Buffer.byteLength(
							JSON.stringify(
								makeScanRequest(configuration, {
									...options,
									paths: [],
									...(options.cachePath === undefined
										? undefined
										: {
												cachePath: batchCachePath(
													options.cachePath,
													paths.length
												)
											})
								})
							),
							"utf8"
						),
						batching.maximumRequestBytes ?? MAX_PROTOCOL_REQUEST_BYTES
					);
		if (batches instanceof ProtocolStreamFailure)
			return yield* Effect.fail(mapProtocolFailure(batches, "scan", projectRoot));
		yield* Effect.annotateCurrentSpan({ [READER_BATCHES_ATTRIBUTE]: batches?.length ?? 1 });
		if (paths === undefined || batches === undefined || batches.length === 1) {
			// A list that only fit once its repeats were dropped is sent without them.
			const only = batches?.[0];
			return yield* invokeProtocolScanBatch(
				configuration,
				paths === undefined || only === undefined || only.length === paths.length
					? options
					: { ...options, paths: only.map((index) => paths[index] ?? "") },
				progress,
				batching.processFactory
			);
		}
		const batched = new BatchedScanProgress(progress, batches.length);
		const assetIdentities = new BatchIdentities(projectRoot);
		const inventoryIdentities = new BatchIdentities(projectRoot);
		const scans: SavedAssetScan[] = [];
		let counted = 0;
		for (const [index, batch] of batches.entries()) {
			const batchProgress = batched.batch(index);
			const scan = yield* invokeProtocolScanBatch(
				configuration,
				{
					...options,
					paths: batch.map((pathIndex) => paths[pathIndex] ?? ""),
					...(options.cachePath === undefined
						? undefined
						: { cachePath: batchCachePath(options.cachePath, index) })
				},
				batchProgress,
				batching.processFactory
			);
			const assets = scan.assets.filter((entry) =>
				assetIdentities.keep(scanEntryPath(entry))
			);
			const inventory = scan.inventory?.filter((entry) =>
				inventoryIdentities.keep(entry.path)
			);
			const repeated = assetIdentities.finish();
			const repeatedInventory = inventoryIdentities.finish();
			counted += scan.summary.scannedAssets - repeated;
			if (options.maximumAssets !== undefined && counted > options.maximumAssets)
				return yield* Effect.fail(
					mapProtocolFailure(
						packageLimitFailure(counted, options.maximumAssets),
						"scan",
						projectRoot
					)
				);
			scans.push({
				...scan,
				assets,
				...(inventory === undefined ? undefined : { inventory }),
				summary: {
					...scan.summary,
					emittedAssets: scan.summary.emittedAssets - repeated,
					scannedAssets: scan.summary.scannedAssets - repeated,
					...(scan.summary.inventoryFiles === undefined
						? undefined
						: { inventoryFiles: scan.summary.inventoryFiles - repeatedInventory })
				}
			});
			batched.finish(batchProgress);
		}
		const cachePath = options.cachePath;
		if (cachePath !== undefined)
			yield* Effect.promise(() => removeLeftoverBatchCaches(cachePath, batches.length));
		return mergeSavedAssetScans(scans);
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
	readonly telemetry: ProtocolTelemetry;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Promise<ProtocolSingleEvidence<A>> {
	return collectProtocolSingleEvents({
		events: protocolEvents({
			configuration: options.configuration,
			operation: options.operation,
			path: options.path,
			request: options.request,
			signal: options.signal,
			telemetry: options.telemetry,
			timeoutMs: options.configuration.timeoutMs,
			...(options.onEvent === undefined ? undefined : { onEvent: options.onEvent })
		}),
		expected: options.expected,
		select: options.select
	});
}

export async function collectProtocolSingleEvents<A>(options: {
	readonly events: AsyncIterable<ProtocolEvent>;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
}): Promise<ProtocolSingleEvidence<A>> {
	let selected: A | undefined;
	let outcome: ProtocolSingleEvidence<A>["outcome"] | undefined;
	const diagnostics: ProtocolDiagnostic[] = [];
	for await (const event of options.events) {
		if (event.kind === "failed" || event.kind === "rejected") {
			throw protocolFailureFromEvent(event);
		}
		if (event.kind === "diagnostic") {
			diagnostics.push({
				code: event.code,
				message: event.message,
				severity: event.severity
			});
		}
		if (event.kind === "result" && event.result.kind === options.expected) {
			selected = options.select(event.result);
		}
		if (event.kind === "completed") outcome = event.outcome;
	}
	if (selected === undefined) {
		throw new ProtocolStreamFailure(
			"contract",
			`Protocol stream did not produce ${options.expected}`
		);
	}
	if (outcome === undefined) {
		throw new ProtocolStreamFailure(
			"contract",
			`Protocol stream did not complete ${options.expected}`
		);
	}
	return { diagnostics, outcome, value: selected };
}

export function invokeProtocolSessionSingleWithEvidence<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly session: UassetProtocolSession;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Effect.Effect<ProtocolSingleEvidence<A>, AssetReaderError> {
	return Effect.tryPromise({
		try: (signal) =>
			collectProtocolSingleEvents({
				events: options.session.events({
					request: options.request,
					signal,
					timeoutMs: options.configuration.timeoutMs,
					...(options.onEvent === undefined ? undefined : { onEvent: options.onEvent })
				}),
				expected: options.expected,
				select: options.select
			}),
		catch: (cause) => mapProtocolFailure(cause, options.operation, options.path)
	}).pipe(
		Effect.withSpan(`unreal_assets.protocol_${options.operation}`, {
			attributes: { "unreal.asset_path": options.path }
		}),
		Effect.withSpan("unreal_assets.protocol_session", {
			attributes: { "unreal.operation": options.operation, "unreal.path": options.path }
		})
	);
}

export function invokeProtocolSessionSingle<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly session: UassetProtocolSession;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Effect.Effect<A, AssetReaderError> {
	return invokeProtocolSessionSingleWithEvidence(options).pipe(
		Effect.map((evidence) => evidence.value)
	);
}

export function invokeProtocolSingleWithEvidence<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Effect.Effect<ProtocolSingleEvidence<A>, AssetReaderError> {
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

export function invokeProtocolSingle<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: AssetReaderError["operation"];
	readonly path: string;
	readonly request: UAssetIoRequest;
	readonly expected: UAssetIoResult["kind"];
	readonly select: (result: UAssetIoResult) => A | undefined;
	readonly onEvent?: (event: ProtocolEvent) => void;
}): Effect.Effect<A, AssetReaderError> {
	return invokeProtocolSingleWithEvidence(options).pipe(Effect.map((evidence) => evidence.value));
}

type ProjectionStaging = SavedAssetStagedTextExtractionOptions["staging"];

/** The paths, and staging groups, one projection request sends. */
interface ProjectionBatch {
	readonly paths?: readonly string[];
	readonly groups?: readonly number[];
}

const stagedGroupTooLarge = () =>
	new ProtocolStreamFailure(
		"request_too_large",
		"This staged package-text read is larger than one 4 MiB asset reader request, and its staging groups cannot be split into requests that each hold whole groups."
	);

/**
 * Consecutive staged batches that each fit `budget`. Every batch writes into the same directory,
 * where the reader creates each group file exclusively, so batches are cut only where the group
 * changes and a group may not reappear in a later batch.
 */
function stagedProjectionBatches(
	paths: readonly string[],
	groups: readonly number[],
	indices: readonly number[],
	budget: number
): readonly ProjectionBatch[] | ProtocolStreamFailure {
	const batches: ProjectionBatch[] = [];
	const batchOfGroup = new Map<number, number>();
	let start = 0;
	let bytes = 0;
	let groupStart = 0;
	let groupBytes = 0;
	const close = (end: number) => {
		const batch = indices.slice(start, end);
		batches.push({
			paths: batch.map((index) => paths[index] ?? ""),
			groups: batch.map((index) => groups[index] ?? 0)
		});
		start = end;
	};
	for (const [position, index] of indices.entries()) {
		const group = groups[index] ?? 0;
		if (position > 0 && group !== groups[indices[position - 1] ?? 0]) {
			groupStart = position;
			groupBytes = 0;
		}
		const size = stagedPathBytes(paths[index] ?? "", group);
		if (size > budget) return requestTooLarge();
		if (bytes + size > budget && position > start) {
			if (groupStart === start) return stagedGroupTooLarge();
			close(groupStart);
			bytes = groupBytes;
			// The group's earlier paths moved into the new batch with it.
			if (groupStart < position) batchOfGroup.set(group, batches.length);
		}
		if ((batchOfGroup.get(group) ?? batches.length) !== batches.length)
			return stagedGroupTooLarge();
		batchOfGroup.set(group, batches.length);
		bytes += size;
		groupBytes += size;
	}
	close(indices.length);
	return batches;
}

/**
 * Consecutive projection batches that each fit one request next to the measured envelope. A list
 * that fits one request is sent whole and unchanged; snapshot staging is always sent whole, since
 * its shards carry their own inventories.
 */
function projectionBatches(
	options: ProjectionRequestOptions,
	operation: ProjectionOperation,
	maximumRequestBytes: number
): readonly ProjectionBatch[] | ProtocolStreamFailure {
	const { paths, projectRoot } = options.extraction;
	const staging = options.staging;
	if (paths === undefined) return [{}];
	if (staging?.snapshots !== undefined) return [{ paths, groups: staging.groups }];
	const envelopeBytes = Buffer.byteLength(
		JSON.stringify(makeProjectionRequest(options, operation, { paths: [], groups: [] })),
		"utf8"
	);
	if (staging === undefined) {
		const batches = requestPathBatches(projectRoot, paths, envelopeBytes, maximumRequestBytes);
		return batches instanceof ProtocolStreamFailure
			? batches
			: batches.map((batch) => ({ paths: batch.map((index) => paths[index] ?? "") }));
	}
	const { groups } = staging;
	if (groups.length !== paths.length) return [{ paths, groups }];
	const budget = requestPathBudget(envelopeBytes, maximumRequestBytes);
	if (budget < 0) return requestTooLarge();
	const sizes = paths.map((path, index) => stagedPathBytes(path, groups[index] ?? 0));
	if (sizes.reduce((total, size) => total + size, 0) <= budget) return [{ paths, groups }];
	return stagedProjectionBatches(
		paths,
		groups,
		uniqueRequestPathIndices(projectRoot, paths),
		budget
	);
}

/** The package path a projection record belongs to; summaries have none. */
function projectionRecordPath(result: UAssetIoResult): string | undefined {
	if (result.kind === "staged_text_package") return result.path;
	if (
		result.kind === "extract_text" ||
		result.kind === "extract_text_packages" ||
		result.kind === "extract_texture"
	)
		return "path" in result.event ? result.event.path : undefined;
	return undefined;
}

type ProjectionSummary = Extract<
	UAssetIoResult,
	{ readonly kind: "extract_text" | "extract_text_packages" | "extract_texture" }
>["event"] & { readonly event: "text_summary" | "texture_summary" };

function projectionSummary(result: UAssetIoResult): ProjectionSummary | undefined {
	return (result.kind === "extract_text" ||
		result.kind === "extract_text_packages" ||
		result.kind === "extract_texture") &&
		(result.event.event === "text_summary" || result.event.event === "texture_summary")
		? result.event
		: undefined;
}

/** `result`, a closing projection summary, with its counts replaced by `counts`. */
function withSummaryCounts(result: UAssetIoResult, counts: ScanSummaryCounts): UAssetIoResult {
	switch (result.kind) {
		case "extract_text":
			return result.event.event === "text_summary"
				? { ...result, event: { ...result.event, ...counts } }
				: result;
		case "extract_text_packages":
			return result.event.event === "text_summary"
				? { ...result, event: { ...result.event, ...counts } }
				: result;
		case "extract_texture":
			return result.event.event === "texture_summary"
				? { ...result, event: { ...result.event, ...counts } }
				: result;
		default:
			return result;
	}
}

type ProjectionOperation = "extract_text" | "extract_text_packages" | "extract_texture";

/** What a projection request is built from. */
interface ProjectionRequestOptions {
	readonly configuration: AssetReaderConfiguration;
	readonly extraction: SavedAssetExtractionOptions;
	readonly projection: "text" | "text_packages" | "texture";
	readonly staging?: ProjectionStaging;
}

/** The request one projection batch sends. */
function makeProjectionRequest(
	options: ProjectionRequestOptions,
	operation: ProjectionOperation,
	batch: ProjectionBatch
): UAssetIoRequest {
	const staging =
		options.staging === undefined
			? undefined
			: { ...options.staging, groups: batch.groups ?? options.staging.groups };
	const selection = {
		projectRoot: options.extraction.projectRoot,
		...(batch.paths === undefined ? undefined : { paths: [...batch.paths] })
	};
	return makeProtocolRequest(
		staging !== undefined && operation === "extract_text_packages"
			? {
					kind: operation,
					projectRoot: selection.projectRoot,
					paths: selection.paths ?? [],
					staging: staging.snapshots
						? {
								directory: staging.directory,
								groups: [...staging.groups],
								snapshots: staging.snapshots
							}
						: { directory: staging.directory, groups: [...staging.groups] }
				}
			: operation === "extract_text"
				? { kind: operation, ...selection }
				: operation === "extract_texture"
					? { kind: operation, ...selection }
					: { kind: operation, ...selection },
		{
			...(options.extraction.concurrency === undefined
				? undefined
				: { concurrency: options.extraction.concurrency }),
			...(options.extraction.maximumAssets === undefined
				? undefined
				: { maximumAssets: options.extraction.maximumAssets }),
			maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
			timeoutMs: options.configuration.catalogTimeoutMs
		},
		{
			contractMinor:
				staging !== undefined
					? staging.snapshots
						? 20
						: 19
					: options.projection === "text_packages" || options.projection === "text"
						? 18
						: 0
		}
	);
}

/**
 * Streams one compact projection. A path list that fits one request is sent unchanged. A longer
 * one is de-duplicated as the reader would, cut against the measured request envelope and sent in
 * consecutive batches, one reader process at a time. Their events are concatenated in order, a
 * package an earlier batch already reported is skipped, and their closing summaries merge into one,
 * emitted after the last batch. `maximumAssets` bounds the unique packages of the whole projection.
 */
export function protocolProjectionStream<A>(
	options: ProjectionRequestOptions & {
		readonly scanStore: ScanProgressStore;
		readonly decode: (event: UAssetIoResult) => A | undefined;
		readonly processFactory?: ProtocolProcessFactory;
		readonly maximumRequestBytes?: number;
	}
): Stream.Stream<A, AssetReaderError> {
	const operation: ProjectionOperation =
		options.projection === "text"
			? "extract_text"
			: options.projection === "text_packages"
				? "extract_text_packages"
				: "extract_texture";
	const projectRoot = options.extraction.projectRoot;
	const maximumAssets = options.extraction.maximumAssets;
	const batches = projectionBatches(
		options,
		operation,
		options.maximumRequestBytes ?? MAX_PROTOCOL_REQUEST_BYTES
	);
	const spans = <B>(stream: Stream.Stream<B, AssetReaderError>, count: number) =>
		stream.pipe(
			Stream.withSpan(`unreal_assets.protocol_extract_${options.projection}`, {
				attributes: {
					"unreal.project_root": projectRoot,
					[READER_BATCHES_ATTRIBUTE]: count
				}
			})
		);
	if (batches instanceof ProtocolStreamFailure)
		return spans(Stream.fail(mapProtocolFailure(batches, operation, projectRoot)), 0);
	if (batches.length === 1)
		return spans(
			protocolProjectionBatch(options, operation, batches[0] ?? {}, options.scanStore),
			1
		);
	// Batch state lives in the run, so every run of the stream starts from the first batch.
	const batched = Stream.suspend(() => {
		const progress = new BatchedScanProgress(options.scanStore, batches.length);
		const identities = new BatchIdentities(projectRoot);
		const summaries: ScanSummaryCounts[] = [];
		let lastSummary: UAssetIoResult | undefined;
		let counted = 0;
		/** Counts a finished batch's new packages and refuses the projection once over the limit. */
		const finish = (batchProgress: ScanProgressStore) =>
			Effect.suspend(() => {
				const repeated = identities.finish();
				const summary = summaries.at(-1);
				if (summary !== undefined && repeated > 0)
					summaries[summaries.length - 1] = {
						...summary,
						emittedAssets: Math.max(0, summary.emittedAssets - repeated),
						scannedAssets: Math.max(0, summary.scannedAssets - repeated)
					};
				counted += summaries.at(-1)?.scannedAssets ?? 0;
				progress.finish(batchProgress);
				return maximumAssets !== undefined && counted > maximumAssets
					? Effect.fail(
							mapProtocolFailure(
								packageLimitFailure(counted, maximumAssets),
								operation,
								projectRoot
							)
						)
					: Effect.void;
			});
		const batchStream = (batch: ProjectionBatch, index: number) => {
			const batchProgress = progress.batch(index);
			return protocolProjectionBatch(options, operation, batch, batchProgress, {
				identities,
				onSummary: (result, summary) => {
					lastSummary = result;
					summaries.push(summary);
				}
			}).pipe(Stream.concat(Stream.fromEffect(finish(batchProgress)).pipe(Stream.drain)));
		};
		const mergedSummary = Stream.suspend(() => {
			const value =
				lastSummary === undefined
					? undefined
					: options.decode(
							withSummaryCounts(lastSummary, mergeScanSummaryCounts(summaries))
						);
			return value === undefined ? Stream.empty : Stream.succeed(value);
		});
		return Stream.fromIterable(batches.map((batch, index) => ({ batch, index }))).pipe(
			Stream.flatMap(({ batch, index }) => batchStream(batch, index)),
			Stream.concat(mergedSummary)
		);
	});
	return spans(batched, batches.length);
}

/**
 * One projection request in one reader process, with that process's telemetry. In a batched
 * projection the closing summary goes to `onSummary` instead of the stream, records of packages
 * an earlier batch reported are skipped.
 */
function protocolProjectionBatch<A>(
	options: ProjectionRequestOptions & {
		readonly decode: (event: UAssetIoResult) => A | undefined;
		readonly processFactory?: ProtocolProcessFactory;
	},
	operation: ProjectionOperation,
	batch: ProjectionBatch,
	scanStore: ScanProgressStore,
	batched?: {
		readonly identities: BatchIdentities;
		readonly onSummary: (result: UAssetIoResult, summary: ProjectionSummary) => void;
	}
): Stream.Stream<A, AssetReaderError> {
	const request = makeProjectionRequest(options, operation, batch);
	const telemetry = makeProtocolTelemetry(false, options.configuration.protocolObserver);
	const controller = new AbortController();
	const events = (async function* (): AsyncGenerator<A> {
		try {
			for await (const event of protocolEvents({
				configuration: options.configuration,
				operation,
				path: options.extraction.projectRoot,
				...(options.processFactory === undefined
					? undefined
					: { processFactory: options.processFactory }),
				request,
				signal: controller.signal,
				telemetry,
				timeoutMs: options.configuration.catalogTimeoutMs
			})) {
				if (event.kind === "failed" || event.kind === "rejected") {
					throw protocolFailureFromEvent(event);
				}
				if (event.kind === "progress") {
					scanStore.current = {
						...scanStore.current,
						phase: protocolPhase(event.phase),
						processedAssets: event.completedItems,
						...(event.totalItems === undefined
							? undefined
							: { totalAssets: event.totalItems })
					};
				}
				if (event.kind === "result") {
					const summary = projectionSummary(event.result);
					if (summary !== undefined) {
						scanStore.current = {
							...scanStore.current,
							cacheHits: summary.cacheHits,
							emittedAssets: summary.emittedAssets,
							processedAssets: summary.scannedAssets,
							totalAssets: summary.scannedAssets
						};
						if (batched !== undefined) {
							batched.onSummary(event.result, summary);
							continue;
						}
					}
					const path = projectionRecordPath(event.result);
					if (path !== undefined && batched?.identities.keep(path) === false) continue;
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
		// Suspended: recording reads the telemetry, so it must run after the worker, not when built.
		Stream.ensuring(Effect.suspend(() => recordProtocolTelemetry(operation, telemetry))),
		Stream.withSpan("unreal_assets.protocol_process", {
			attributes: {
				"unreal.operation": operation,
				"unreal.path": options.extraction.projectRoot
			}
		})
	);
}
