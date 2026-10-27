import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { SavedAssetScanProgress, UAssetIoRequest } from "@ue-shed/protocol";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type {
	AssetReaderConfiguration,
	AssetReaderProtocolObservation,
	ScanProgressStore
} from "./asset-reader.js";
import { MAX_PROTOCOL_REQUEST_BYTES } from "./protocol-request-limit.js";
import {
	invokeProtocolScan,
	type ProtocolProcessFactory,
	protocolProjectionStream
} from "./protocol-transport.js";

/** One scripted worker frame, before the contract, requestId and sequence are added. */
type Frame = object;
type Reply = readonly Frame[] | "hang";

/** A one-shot `protocol` worker that answers its parsed request with scripted frames. */
class ScriptedProtocolChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	killed = false;

	constructor(
		readonly pid: number,
		reply: (request: UAssetIoRequest) => Reply,
		signal: AbortSignal | undefined
	) {
		super();
		const chunks: Buffer[] = [];
		this.stdin = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunks.push(chunk);
				callback();
			},
			final: (callback) => {
				callback();
				// SAFETY: the transport under test writes exactly one encoded UAssetIoRequest.
				const request = JSON.parse(
					Buffer.concat(chunks).toString("utf8")
				) as UAssetIoRequest;
				setImmediate(() => this.answer(request, reply(request)));
			}
		});
		// Like `spawn({ signal })`, an abort ends the worker.
		signal?.addEventListener("abort", () => this.kill(), { once: true });
	}

	private answer(request: UAssetIoRequest, frames: Reply): void {
		if (frames === "hang" || this.killed) return;
		const fields = { contract: request.contract, requestId: request.requestId };
		this.stdout.end(
			frames
				.map((frame, sequence) => `${JSON.stringify({ ...fields, ...frame, sequence })}\n`)
				.join("")
		);
		this.stderr.end();
		this.stdout.once("end", () => setImmediate(() => this.emit("close", 0, null)));
	}

	kill(): boolean {
		if (this.killed) return false;
		this.killed = true;
		this.stdout.end();
		this.stderr.end();
		setImmediate(() => this.emit("close", null, "SIGTERM"));
		return true;
	}
}

/** Records every request and the worker that answered it. */
class ScriptedSpawner {
	readonly requests: UAssetIoRequest[] = [];
	readonly children: ScriptedProtocolChild[] = [];
	private waiting: Array<() => void> = [];

	constructor(private readonly reply: (request: UAssetIoRequest, index: number) => Reply) {}

	readonly factory: ProtocolProcessFactory = (_executable, options) => {
		const index = this.children.length;
		const child = new ScriptedProtocolChild(
			100 + index,
			(request) => {
				this.requests.push(request);
				return this.reply(request, index);
			},
			options.signal
		);
		this.children.push(child);
		for (const wake of this.waiting.splice(0)) wake();
		return child;
	};

	/** Resolves once `count` workers have started. */
	started(count: number): Promise<void> {
		return new Promise((resolve) => {
			const check = () => {
				if (this.children.length >= count) resolve();
				else this.waiting.push(check);
			};
			check();
		});
	}
}

const configuration: AssetReaderConfiguration = {
	catalogTimeoutMs: 60_000,
	executable: "scripted-reader",
	timeoutMs: 60_000
};

/** By default about 40,000 package paths of 120 characters: just over 4 MiB as one JSON list. */
function largePathList(count = 40_000, length = 120): readonly string[] {
	return Array.from({ length: count }, (_, index) => {
		const name = `/Package_${String(index).padStart(6, "0")}.uasset`;
		return `Content/Batched/${"x".repeat(length - name.length - 16)}${name}`;
	});
}

function requestedPaths(request: UAssetIoRequest): readonly string[] {
	const operation = request.operation;
	return "paths" in operation && operation.paths !== undefined ? operation.paths : [];
}

function summaryFields(paths: readonly string[], index: number) {
	return {
		cacheHits: index,
		diagnostics: [
			{ code: `batch_${index}`, message: `batch ${index}`, path: "p", retrySafe: true }
		],
		emittedAssets: 2,
		failedAssets: 1,
		inventoryComplete: index === 0,
		inventoryFiles: 3,
		partialAssets: 0,
		projectRoot: "C:/Project",
		roots: ["Content/Shared", `Content/Batch${index}`],
		scannedAssets: paths.length,
		schema_version: 8,
		skippedAssets: paths.length - 3
	};
}

/** A text projection that emits a package for the first and last path of its batch. */
function textReply(request: UAssetIoRequest, index: number): Reply {
	const paths = requestedPaths(request);
	const textPackage = (path: string) => ({
		kind: "result",
		result: {
			kind: "extract_text",
			event: {
				event: "text_package",
				coverage_gaps: 0,
				diagnostics: [],
				fileBytes: 10,
				occurrences: 1,
				path,
				schema_version: 1,
				status: "complete"
			}
		}
	});
	return [
		{ kind: "accepted", operation: "extract_text" },
		{ kind: "progress", phase: "reading", completedItems: 1, totalItems: paths.length },
		textPackage(paths[0]!),
		textPackage(paths.at(-1)!),
		{
			kind: "result",
			result: {
				kind: "extract_text",
				event: { event: "text_summary", ...summaryFields(paths, index), depth: "text" }
			}
		},
		{ kind: "completed", outcome: "complete" }
	];
}

/** A header scan that emits an entry for the first and last path of its batch. */
function scanReply(request: UAssetIoRequest, index: number): Reply {
	const paths = requestedPaths(request);
	const entry = (path: string) => ({
		kind: "result",
		result: {
			kind: "scan_asset",
			entry: {
				depth: "header",
				fileBytes: 10,
				header: { exports: [], package: { name: path }, path, schema_version: 8 }
			}
		}
	});
	return [
		{ kind: "accepted", operation: "scan" },
		{ kind: "progress", phase: "reading", completedItems: 1, totalItems: paths.length },
		entry(paths[0]!),
		entry(paths.at(-1)!),
		{
			kind: "progress",
			phase: "reading",
			completedItems: paths.length,
			totalItems: paths.length
		},
		{
			kind: "result",
			result: {
				kind: "scan_summary",
				summary: { ...summaryFields(paths, index), depth: "header" }
			}
		},
		{ kind: "completed", outcome: "complete" }
	];
}

/** A progress store that keeps every published value. */
function recordingStore(): ScanProgressStore & { readonly history: SavedAssetScanProgress[] } {
	const history: SavedAssetScanProgress[] = [];
	let current: SavedAssetScanProgress = {
		cacheHits: 0,
		emittedAssets: 0,
		phase: "idle",
		processedAssets: 0,
		totalAssets: 0
	};
	return {
		history,
		get current() {
			return current;
		},
		set current(next) {
			current = next;
			history.push(next);
		}
	};
}

/** Progress only grows across batches, reaches every package, and is `ready` only at the end. */
function expectCumulative(history: readonly SavedAssetScanProgress[], total: number) {
	for (const [index, progress] of history.entries()) {
		const previous = history[index - 1];
		if (previous !== undefined) {
			expect(progress.processedAssets).toBeGreaterThanOrEqual(previous.processedAssets);
			expect(progress.totalAssets).toBeGreaterThanOrEqual(previous.totalAssets);
		}
		if (index < history.length - 1) expect(progress.phase).not.toBe("ready");
	}
	expect(history.at(-1)?.processedAssets).toBe(total);
	expect(history.at(-1)?.totalAssets).toBe(total);
}

const decodeText = (result: import("@ue-shed/protocol").UAssetIoResult) =>
	result.kind === "extract_text" ? result.event : undefined;

describe("AssetReader path batching", () => {
	it("splits a projection over 4 MiB, runs the batches in order and merges their summaries", async () => {
		const paths = largePathList();
		expect(Buffer.byteLength(JSON.stringify(paths))).toBeGreaterThan(
			MAX_PROTOCOL_REQUEST_BYTES
		);
		const spawner = new ScriptedSpawner(textReply);
		const store = recordingStore();
		const observed: AssetReaderProtocolObservation[] = [];
		const events = await Effect.runPromise(
			Stream.runCollect(
				protocolProjectionStream({
					configuration: {
						...configuration,
						protocolObserver: (event) => observed.push(event)
					},
					extraction: { maximumAssets: 50_000, paths, projectRoot: "C:/Project" },
					projection: "text",
					scanStore: store,
					processFactory: spawner.factory,
					decode: decodeText
				})
			)
		);

		const batches = spawner.requests.map(requestedPaths);
		expect(batches.length).toBe(2);
		expect(batches.flat()).toEqual(paths);
		for (const request of spawner.requests)
			expect(Buffer.byteLength(`${JSON.stringify(request)}\n`)).toBeLessThanOrEqual(
				MAX_PROTOCOL_REQUEST_BYTES
			);
		// The package limit bounds the whole read: the second batch gets what the first left.
		expect(spawner.requests.map((request) => request.limits.maximumAssets)).toEqual([
			50_000,
			50_000 - batches[0]!.length
		]);
		// One process per batch, each with its own telemetry, recorded once that process is done.
		expect(observed.map((event) => [event.kind, event.pid])).toEqual([
			["worker_started", 100],
			["worker_completed", 100],
			["worker_started", 101],
			["worker_completed", 101]
		]);
		for (const event of observed)
			if (event.kind === "worker_completed") {
				expect(event.terminalState).toBe("complete");
				expect(event.outputBytes).toBeGreaterThan(0);
			}

		expect(events.map((event) => event.event)).toEqual([
			"text_package",
			"text_package",
			"text_package",
			"text_package",
			"text_summary"
		]);
		expect(events.slice(0, 4).map((event) => ("path" in event ? event.path : ""))).toEqual([
			batches[0]![0],
			batches[0]!.at(-1),
			batches[1]![0],
			batches[1]!.at(-1)
		]);
		expect(events.at(-1)).toEqual({
			event: "text_summary",
			cacheHits: 1,
			depth: "text",
			diagnostics: [
				{ code: "batch_0", message: "batch 0", path: "p", retrySafe: true },
				{ code: "batch_1", message: "batch 1", path: "p", retrySafe: true }
			],
			emittedAssets: 4,
			failedAssets: 2,
			inventoryComplete: false,
			inventoryFiles: 6,
			partialAssets: 0,
			projectRoot: "C:/Project",
			roots: ["Content/Shared", "Content/Batch0", "Content/Batch1"],
			scannedAssets: paths.length,
			schema_version: 8,
			skippedAssets: paths.length - 6
		});
		expectCumulative(store.history, paths.length);
	});

	it("sends a small path list as one request with its summary unchanged", async () => {
		const paths = largePathList(10);
		const spawner = new ScriptedSpawner(textReply);
		const events = await Effect.runPromise(
			Stream.runCollect(
				protocolProjectionStream({
					configuration,
					extraction: { paths, projectRoot: "C:/Project" },
					projection: "text",
					scanStore: recordingStore(),
					processFactory: spawner.factory,
					decode: decodeText
				})
			)
		);
		expect(spawner.requests.map(requestedPaths)).toEqual([paths]);
		expect(events.at(-1)).toEqual({
			event: "text_summary",
			...summaryFields(paths, 0),
			depth: "text"
		});
	});

	it("splits a scan over 4 MiB and merges the batches into one result", async () => {
		const paths = largePathList();
		const spawner = new ScriptedSpawner(scanReply);
		const store = recordingStore();
		const scan = await Effect.runPromise(
			invokeProtocolScan(
				configuration,
				{ depth: "header", paths, projectRoot: "C:/Project" },
				store,
				spawner.factory
			)
		);

		const batches = spawner.requests.map(requestedPaths);
		expect(batches.length).toBe(2);
		expect(batches.flat()).toEqual(paths);
		expect(scan.assets.map((entry) => ("header" in entry ? entry.header.path : ""))).toEqual([
			batches[0]![0],
			batches[0]!.at(-1),
			batches[1]![0],
			batches[1]!.at(-1)
		]);
		expect(scan.summary).toMatchObject({
			cacheHits: 1,
			depth: "header",
			emittedAssets: 4,
			failedAssets: 2,
			inventoryComplete: false,
			inventoryFiles: 6,
			roots: ["Content/Shared", "Content/Batch0", "Content/Batch1"],
			scannedAssets: paths.length,
			skippedAssets: paths.length - 6
		});
		expect(scan.summary.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"batch_0",
			"batch_1"
		]);
		expectCumulative(store.history, paths.length);
		expect(store.current).toMatchObject({ cacheHits: 1, emittedAssets: 4, phase: "ready" });
	});

	it("stops the running scan batch when cancelled and starts no more", async () => {
		const paths = largePathList(40_000, 250);
		const spawner = new ScriptedSpawner((request, index) =>
			index === 0 ? scanReply(request, index) : "hang"
		);
		const store = recordingStore();
		const fiber = Effect.runFork(
			invokeProtocolScan(
				configuration,
				{ depth: "header", paths, projectRoot: "C:/Project" },
				store,
				spawner.factory
			)
		);
		await spawner.started(2);
		const exit = await Effect.runPromise(
			Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
		);

		expect(Exit.hasInterrupts(exit)).toBe(true);
		expect(spawner.children.length).toBe(2);
		expect(spawner.children[1]?.killed).toBe(true);
		expect(store.current.phase).not.toBe("ready");
	});

	it("stops the running projection batch when its consumer stops and starts no more", async () => {
		const paths = largePathList(40_000, 250);
		const spawner = new ScriptedSpawner(textReply);
		const events = await Effect.runPromise(
			Stream.runCollect(
				protocolProjectionStream({
					configuration,
					extraction: { paths, projectRoot: "C:/Project" },
					projection: "text",
					scanStore: recordingStore(),
					processFactory: spawner.factory,
					decode: decodeText
				}).pipe(Stream.take(1))
			)
		);
		expect(events.length).toBe(1);
		expect(spawner.children.length).toBe(1);
		expect(spawner.children[0]?.killed).toBe(true);
	});

	it("fails the operation with a failed batch's error and starts no more", async () => {
		const paths = largePathList(40_000, 250);
		const spawner = new ScriptedSpawner((request, index) =>
			index === 0
				? scanReply(request, index)
				: [
						{ kind: "accepted", operation: "scan" },
						{
							kind: "failed",
							code: "io",
							message: "batch two could not read",
							retrySafe: true
						}
					]
		);
		const error = await Effect.runPromise(
			Effect.flip(
				invokeProtocolScan(
					configuration,
					{ depth: "header", paths, projectRoot: "C:/Project" },
					recordingStore(),
					spawner.factory
				)
			)
		);
		expect(error).toMatchObject({ kind: "discovery", message: "batch two could not read" });
		expect(spawner.children.length).toBe(2);
	});

	it("rejects one path larger than a request as bad input, before starting its worker", async () => {
		const spawner = new ScriptedSpawner(scanReply);
		const error = await Effect.runPromise(
			Effect.flip(
				invokeProtocolScan(
					configuration,
					{
						depth: "header",
						paths: ["x".repeat(MAX_PROTOCOL_REQUEST_BYTES)],
						projectRoot: "C:/Project"
					},
					recordingStore(),
					spawner.factory
				)
			)
		);
		expect(error).toMatchObject({
			kind: "request_too_large",
			nextStep: "fix_input",
			retrySafe: false
		});
		expect(error.message).not.toMatch(/batchProtocolPaths/u);
		expect(error.recovery).toBe(
			"A package path or option in this request is too large for the asset reader. Shorten it or leave it out, then try again."
		);
		expect(spawner.children.length).toBe(0);
	});
});

describe("AssetReader staged batching", () => {
	const stagedReply = (request: UAssetIoRequest): Reply => {
		const paths = requestedPaths(request);
		return [
			{ kind: "accepted", operation: "extract_text_packages" },
			{
				kind: "result",
				result: { kind: "staged_text_package", path: paths[0], group: 0, bytes: 1 }
			},
			{
				kind: "result",
				result: {
					kind: "extract_text_packages",
					event: { event: "text_summary", ...summaryFields(paths, 0), depth: "text" }
				}
			},
			{ kind: "completed", outcome: "complete" }
		];
	};
	const stage = (paths: readonly string[], groups: readonly number[], spawner: ScriptedSpawner) =>
		protocolProjectionStream({
			configuration,
			extraction: { paths, projectRoot: "C:/Project" },
			projection: "text_packages",
			staging: { directory: "C:/Staging", groups },
			scanStore: recordingStore(),
			processFactory: spawner.factory,
			decode: (result) => (result.kind === "staged_text_package" ? result.path : undefined)
		});
	const sentGroups = (request: UAssetIoRequest) =>
		request.operation.kind === "extract_text_packages"
			? (request.operation.staging?.groups ?? [])
			: [];

	it("cuts staged batches only where the group changes", async () => {
		const paths = largePathList();
		const groups = paths.map((_, index) => Math.floor(index / 7_000));
		const spawner = new ScriptedSpawner(stagedReply);
		await Effect.runPromise(Stream.runDrain(stage(paths, groups, spawner)));

		const sent = spawner.requests.map(sentGroups);
		expect(sent.length).toBe(2);
		expect(sent.flat()).toEqual(groups);
		expect(spawner.requests.flatMap(requestedPaths)).toEqual(paths);
		const firstGroups = new Set(sent[0]);
		expect(sent[1]?.some((group) => firstGroups.has(group))).toBe(false);
		for (const request of spawner.requests)
			expect(Buffer.byteLength(`${JSON.stringify(request)}\n`)).toBeLessThanOrEqual(
				MAX_PROTOCOL_REQUEST_BYTES
			);
	});

	it("refuses a staged read whose group cannot fit one request", async () => {
		const paths = largePathList();
		const spawner = new ScriptedSpawner(stagedReply);
		const error = await Effect.runPromise(
			Effect.flip(
				Stream.runDrain(
					stage(
						paths,
						paths.map(() => 0),
						spawner
					)
				)
			)
		);
		expect(error).toMatchObject({ kind: "request_too_large", nextStep: "fix_input" });
		expect(spawner.children.length).toBe(0);
	});
});
