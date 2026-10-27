import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { AssetReaderError } from "./asset-reader.js";
import { MAX_PROTOCOL_REQUEST_BYTES } from "./protocol-request-limit.js";
import {
	invokeProtocolSessionSingle,
	makeProtocolRequest,
	type ProtocolProcessFactory,
	type ProtocolSessionProcess,
	ProtocolStreamFailure,
	runUassetProtocolEvents,
	UassetProtocolSession
} from "./protocol-transport.js";

function closedPipeError(): Error {
	return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

/** A real stream whose writes fail like a pipe the worker already closed. */
function closedPipeInput(): Writable {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback(closedPipeError());
		}
	});
}

/** A one-shot `protocol` worker that exits before reading its request. */
class EarlyExitProtocolChild extends EventEmitter {
	readonly pid = 7;
	readonly stdin = closedPipeInput();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;

	constructor() {
		super();
		setImmediate(() => {
			this.stdout.end();
			this.stderr.end();
			setImmediate(() => this.emit("close", 1, null));
		});
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

/** A one-shot worker that writes raw stdout bytes, splitting one UTF-8 character in two. */
class SplitUtf8ProtocolChild extends EventEmitter {
	readonly pid = 9;
	readonly stdin = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		}
	});
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;

	constructor(output: string, character: string) {
		super();
		const bytes = Buffer.from(output, "utf8");
		const split = bytes.indexOf(Buffer.from(character, "utf8")) + 1;
		setImmediate(() => {
			this.stdout.write(bytes.subarray(0, split));
			setImmediate(() => {
				this.stdout.end(bytes.subarray(split));
				this.stderr.end();
				setImmediate(() => this.emit("close", 0, null));
			});
		});
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

function inspectRequestWithFrameBytes(frameBytes: number) {
	const request = makeProtocolRequest(
		{ assetPath: "", kind: "inspect" },
		{ maximumOutputBytes: 1_024, timeoutMs: 1_000 }
	);
	const emptyFrameBytes = Buffer.byteLength(`${JSON.stringify(request)}\n`, "utf8");
	const assetPath = "a".repeat(frameBytes - emptyFrameBytes);
	const sized = { ...request, operation: { assetPath, kind: "inspect" as const } };
	expect(Buffer.byteLength(`${JSON.stringify(sized)}\n`, "utf8")).toBe(frameBytes);
	return sized;
}

/** Counts spawns so tests can prove a request was rejected before any worker started. */
class EarlyExitProtocolSpawner {
	spawns = 0;

	readonly factory: ProtocolProcessFactory = () => {
		this.spawns += 1;
		return new EarlyExitProtocolChild();
	};
}

async function drainProtocolEvents(
	spawner: EarlyExitProtocolSpawner,
	request: ReturnType<typeof makeProtocolRequest>
): Promise<ProtocolStreamFailure | undefined> {
	try {
		for await (const _event of runUassetProtocolEvents({
			configuration: { executable: "early-exit-reader" },
			processFactory: spawner.factory,
			request,
			signal: undefined,
			timeoutMs: 1_000
		})) {
			// Drain until the worker failure surfaces.
		}
	} catch (cause) {
		if (cause instanceof ProtocolStreamFailure) return cause;
		throw cause;
	}
	return undefined;
}

function expectInputFailure(failure: AssetReaderError, originalMessage: string) {
	expect(failure.kind).toBe("process");
	expect(failure.message).toBe("The native protocol session could not write its request");
	expect(failure.cause).toBeInstanceOf(ProtocolStreamFailure);
	if (!(failure.cause instanceof ProtocolStreamFailure))
		throw new Error("Expected protocol evidence");
	expect(failure.cause.cause).toMatchObject({ code: "EPIPE", message: originalMessage });
}

class RejectingProtocolInput {
	destroyed = false;

	constructor(
		private readonly message = "protocol input closed",
		private readonly onWrite?: () => void
	) {}

	end(): void {
		this.destroyed = true;
	}

	on(_event: "error", _listener: (cause: Error) => void): this {
		return this;
	}

	destroy(): void {
		this.destroyed = true;
	}

	setDefaultEncoding(_encoding: BufferEncoding): void {}

	write(_chunk: string, callback: (cause?: Error | null) => void): boolean {
		this.onWrite?.();
		const failure = Object.assign(new Error(this.message), { code: "EPIPE" });
		queueMicrotask(() => callback(failure));
		return false;
	}
}

class StalledInputProcess implements ProtocolSessionProcess {
	readonly pid = 42;
	readonly stdin: RejectingProtocolInput | Writable;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	killCalls = 0;
	unrefCalls = 0;
	private readonly closeListeners: Array<(code: number | null, signal: string | null) => void> =
		[];
	private readonly errorListeners: Array<(cause: Error) => void> = [];

	constructor(
		private readonly closesOnKill = true,
		inputMessage?: string,
		onWrite?: () => void,
		stdin?: Writable
	) {
		this.stdin = stdin ?? new RejectingProtocolInput(inputMessage, onWrite);
	}

	kill = (): boolean => {
		this.killCalls += 1;
		if (this.killed) return false;
		if (!this.closesOnKill) return false;
		this.killed = true;
		queueMicrotask(() => {
			this.signalCode = "SIGTERM";
			for (const listener of this.closeListeners) listener(null, this.signalCode);
		});
		return true;
	};

	onClose(listener: (code: number | null, signal: string | null) => void): void {
		this.closeListeners.push(listener);
	}

	onError(listener: (cause: Error) => void): void {
		this.errorListeners.push(listener);
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emitClose(): void {
		this.signalCode = "SIGTERM";
		for (const listener of this.closeListeners) listener(null, this.signalCode);
	}

	emitError(cause: Error): void {
		for (const listener of this.errorListeners) listener(cause);
	}
}

it("terminates a session when stdin rejects while the worker remains alive", async () => {
	const assetPath = "C:/Fixture/BP_Stalled.uasset";
	const worker = new StalledInputProcess();
	const configuration = {
		catalogTimeoutMs: 1_000,
		executable: "stalled-reader",
		timeoutMs: 1_000
	};
	const session = new UassetProtocolSession(configuration, () => worker);
	const failure = await Effect.runPromise(
		invokeProtocolSessionSingle({
			configuration,
			expected: "inspect",
			operation: "inspect",
			path: assetPath,
			request: makeProtocolRequest(
				{ assetPath, kind: "inspect" },
				{ maximumOutputBytes: 1_024, timeoutMs: 1_000 }
			),
			select: () => undefined,
			session
		}).pipe(Effect.timeout("1 second"), Effect.flip)
	);

	expect(failure).toBeInstanceOf(AssetReaderError);
	if (!(failure instanceof AssetReaderError)) return;
	expect(failure.kind).toBe("process");
	expectInputFailure(failure, "protocol input closed");
	expect(worker.killCalls).toBe(1);
	expect(worker.killed).toBe(true);
	await session.close();
});

it("bounds termination when a worker ignores kill and never closes", async () => {
	const assetPath = "C:/Fixture/BP_NonCooperative.uasset";
	const worker = new StalledInputProcess(false);
	const configuration = {
		catalogTimeoutMs: 25,
		executable: "non-cooperative-reader",
		timeoutMs: 25
	};
	const session = new UassetProtocolSession(configuration, () => worker);
	const failure = await Effect.runPromise(
		invokeProtocolSessionSingle({
			configuration,
			expected: "inspect",
			operation: "inspect",
			path: assetPath,
			request: makeProtocolRequest(
				{ assetPath, kind: "inspect" },
				{ maximumOutputBytes: 1_024, timeoutMs: 25 }
			),
			select: () => undefined,
			session
		}).pipe(Effect.timeout("1 second"), Effect.flip)
	);

	expect(failure).toBeInstanceOf(AssetReaderError);
	if (!(failure instanceof AssetReaderError)) return;
	expect(failure.kind).toBe("process");
	expectInputFailure(failure, "protocol input closed");
	expect(worker.killCalls).toBe(1);
	expect(worker.killed).toBe(false);
	await Effect.runPromise(
		Effect.tryPromise(() => session.close()).pipe(Effect.timeout("1 second"))
	);
	expect(worker.killCalls).toBe(2);
	expect(worker.killed).toBe(false);
	expect(worker.unrefCalls).toBe(1);
	expect(worker.stdin.destroyed).toBe(true);
	expect(worker.stdout.destroyed).toBe(true);
	expect(worker.stderr.destroyed).toBe(true);
});

it("ignores delayed events from a terminated worker after its replacement starts", async () => {
	const firstPath = "C:/Fixture/BP_First.uasset";
	const secondPath = "C:/Fixture/BP_Replacement.uasset";
	const firstWorker = new StalledInputProcess(false);
	const secondWorker = new StalledInputProcess(true, "replacement input closed", () => {
		firstWorker.emitError(new Error("stale worker error"));
	});
	const workers = [firstWorker, secondWorker];
	const configuration = {
		catalogTimeoutMs: 25,
		executable: "generation-reader",
		timeoutMs: 25
	};
	const session = new UassetProtocolSession(configuration, () => {
		const worker = workers.shift();
		if (worker === undefined) throw new Error("unexpected worker request");
		return worker;
	});

	await Effect.runPromise(
		invokeProtocolSessionSingle({
			configuration,
			expected: "inspect",
			operation: "inspect",
			path: firstPath,
			request: makeProtocolRequest(
				{ assetPath: firstPath, kind: "inspect" },
				{ maximumOutputBytes: 1_024, timeoutMs: 25 }
			),
			select: () => undefined,
			session
		}).pipe(Effect.flip)
	);
	firstWorker.emitClose();
	await Promise.resolve();

	const failure = await Effect.runPromise(
		invokeProtocolSessionSingle({
			configuration,
			expected: "inspect",
			operation: "inspect",
			path: secondPath,
			request: makeProtocolRequest(
				{ assetPath: secondPath, kind: "inspect" },
				{ maximumOutputBytes: 1_024, timeoutMs: 25 }
			),
			select: () => undefined,
			session
		}).pipe(Effect.timeout("1 second"), Effect.flip)
	);

	expect(failure).toBeInstanceOf(AssetReaderError);
	if (!(failure instanceof AssetReaderError)) return;
	expectInputFailure(failure, "replacement input closed");
	expect(failure.message).not.toContain("stale worker error");
	await session.close();
});

it("fails a session request when stdin emits a closed-pipe error", async () => {
	const assetPath = "C:/Fixture/BP_ClosedPipe.uasset";
	const worker = new StalledInputProcess(true, undefined, undefined, closedPipeInput());
	const configuration = {
		catalogTimeoutMs: 1_000,
		executable: "closed-pipe-reader",
		timeoutMs: 1_000
	};
	const session = new UassetProtocolSession(configuration, () => worker);
	const failure = await Effect.runPromise(
		invokeProtocolSessionSingle({
			configuration,
			expected: "inspect",
			operation: "inspect",
			path: assetPath,
			request: makeProtocolRequest(
				{ assetPath, kind: "inspect" },
				{ maximumOutputBytes: 1_024, timeoutMs: 1_000 }
			),
			select: () => undefined,
			session
		}).pipe(Effect.timeout("1 second"), Effect.flip)
	);
	// Let the stream's deferred "error" emission run; an unhandled one fails the test run.
	await new Promise((resolvePromise) => setImmediate(resolvePromise));

	expect(failure).toBeInstanceOf(AssetReaderError);
	if (!(failure instanceof AssetReaderError)) return;
	expect(failure.kind).toBe("process");
	expectInputFailure(failure, "write EPIPE");
	await session.close();
});

it("fails a one-shot request when the worker closes stdin before reading", async () => {
	const spawner = new EarlyExitProtocolSpawner();

	const failure = await drainProtocolEvents(
		spawner,
		makeProtocolRequest(
			{ assetPath: "C:/Fixture/BP_EarlyExit.uasset", kind: "inspect" },
			{ maximumOutputBytes: 1_024, timeoutMs: 1_000 }
		)
	);

	expect(spawner.spawns).toBe(1);
	expect(failure?.kind).toBe("process");
	expect(failure?.message).toBe("The native protocol worker could not process its request.");
	expect(failure?.cause).toMatchObject({ code: "EPIPE", message: "write EPIPE" });
});

it("rejects a one-shot request over the native 4 MiB frame limit before spawning", async () => {
	const spawner = new EarlyExitProtocolSpawner();

	const oversized = await drainProtocolEvents(
		spawner,
		inspectRequestWithFrameBytes(MAX_PROTOCOL_REQUEST_BYTES + 1)
	);

	expect(spawner.spawns).toBe(0);
	expect(oversized?.kind).toBe("request_too_large");
	expect(oversized?.message).toBe("The asset reader request is larger than its 4 MiB limit.");

	// The native reader accepts a frame of exactly 4 MiB, trailing newline included.
	const atLimit = await drainProtocolEvents(
		spawner,
		inspectRequestWithFrameBytes(MAX_PROTOCOL_REQUEST_BYTES)
	);
	expect(spawner.spawns).toBe(1);
	expect(atLimit?.kind).toBe("process");
});

it("decodes worker stdout as UTF-8 text even when a character spans two chunks", async () => {
	const request = makeProtocolRequest(
		{ assetPath: "C:/Fixture/BP_Utf8.uasset", kind: "inspect" },
		{ maximumOutputBytes: 1_024, timeoutMs: 1_000 }
	);
	const frame = { contract: request.contract, requestId: request.requestId };
	const message = "Café graph preserved ✓";
	const output = [
		{ ...frame, kind: "accepted", operation: "inspect", sequence: 0 },
		{
			...frame,
			code: "unsupported_format",
			kind: "diagnostic",
			message,
			sequence: 1,
			severity: "warning"
		},
		{ ...frame, kind: "completed", outcome: "partial", sequence: 2 }
	]
		.map((event) => `${JSON.stringify(event)}\n`)
		.join("");
	const messages: Array<string> = [];
	for await (const event of runUassetProtocolEvents({
		configuration: { executable: "split-utf8-reader" },
		processFactory: () => new SplitUtf8ProtocolChild(output, "✓"),
		request,
		signal: undefined,
		timeoutMs: 1_000
	}))
		if (event.kind === "diagnostic") messages.push(event.message);

	expect(messages).toEqual([message]);
});

it("keeps Unicode line and paragraph separators inside persistent NDJSON frames", async () => {
	const request = makeProtocolRequest(
		{ kind: "inspect", assetPath: "C:/Fixture/Unicode.uasset" },
		{ timeoutMs: 1000, maximumOutputBytes: 4096 }
	);
	const frame = { contract: request.contract, requestId: request.requestId };
	const message = "first\u2028second\u2029third ✓";
	const bytes = Buffer.from(
		[
			{ ...frame, kind: "accepted", operation: "inspect", sequence: 0 },
			{
				...frame,
				kind: "diagnostic",
				code: "unicode",
				message,
				severity: "info",
				sequence: 1
			},
			{ ...frame, kind: "completed", outcome: "complete", sequence: 2 }
		]
			.map((event) => JSON.stringify(event) + "\n")
			.join("")
	);
	const split = bytes.indexOf(Buffer.from("\u2028")) + 1;
	const worker = new StalledInputProcess(
		true,
		undefined,
		undefined,
		new Writable({
			write(_chunk, _encoding, callback) {
				setImmediate(() => {
					worker.stdout.write(bytes.subarray(0, split));
					setImmediate(() => worker.stdout.write(bytes.subarray(split)));
				});
				callback();
			}
		})
	);
	const session = new UassetProtocolSession(
		{ executable: "unicode-session", timeoutMs: 1000 },
		() => worker
	);
	try {
		const events = [];
		for await (const event of session.events({ request, signal: undefined, timeoutMs: 1000 }))
			events.push(event);
		expect(events).toHaveLength(3);
		expect(events[1]).toMatchObject({ kind: "diagnostic", message });
		expect(events[2]).toMatchObject({ kind: "completed" });
	} finally {
		await session.close();
	}
});
