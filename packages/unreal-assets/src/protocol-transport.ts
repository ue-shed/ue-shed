import { spawn } from "node:child_process";
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
	SavedWorldProgressStore,
	ScanProgressStore
} from "./asset-reader.js";
import {
	AssetReaderError,
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

export class ProtocolStreamFailure extends Error {
	readonly _tag = "ProtocolStreamFailure";

	constructor(
		readonly kind: ProtocolFailureKind,
		message: string,
		readonly exitCode?: number,
		readonly stderr?: string
	) {
		super(message);
	}
}

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
	operation: string,
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

export function makeProtocolRequest(
	operation: UAssetIoOperation,
	limits: UAssetIoRequest["limits"],
	options?: { readonly contractMinor?: number }
): UAssetIoRequest {
	protocolRequestCounter += 1;
	return {
		contract: {
			name: "uasset-io",
			version: { major: 1, minor: options?.contractMinor ?? 0 }
		},
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

export async function* runUassetProtocolEvents(options: {
	readonly configuration: Pick<AssetReaderConfiguration, "executable" | "protocolObserver">;
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
					? {}
					: { protocolObserver: options.configuration.protocolObserver }),
				timeoutMs: options.timeoutMs
			},
			operation: options.request.operation.kind,
			path: "project-index",
			request: options.request,
			signal: options.signal,
			telemetry,
			timeoutMs: options.timeoutMs,
			...(options.onEvent === undefined ? {} : { onEvent: options.onEvent })
		});
	} finally {
		if (telemetry.terminalState === undefined && !telemetry.cancelled) {
			telemetry.terminalState = "failed";
		}
		await Effect.runPromise(recordProtocolTelemetry("project_index", telemetry));
	}
}

async function* protocolEvents(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly operation: string;
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
		child.stdin.end(`${JSON.stringify(options.request)}\n`);
		child.stdout.setEncoding("utf8");
		let pending = "";
		const outputBudget = new ProtocolOutputBudget(
			options.request.limits.maximumOutputBytes ?? MAX_PROTOCOL_OUTPUT_BYTES
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
				closedResult.code ?? undefined,
				stderr.trim() || undefined
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
			maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
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

export function invokeProtocolScan(
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

export function invokeProtocolSingle<A>(options: {
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

export function protocolProjectionStream<A>(options: {
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
			maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
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
