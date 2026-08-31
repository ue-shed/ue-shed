import { PassThrough } from "node:stream";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { AssetReaderError } from "./asset-reader.js";
import {
	invokeProtocolSessionSingle,
	makeProtocolRequest,
	type ProtocolSessionProcess,
	UassetProtocolSession
} from "./protocol-transport.js";

class RejectingProtocolInput {
	destroyed = false;

	constructor(
		private readonly message = "protocol input closed",
		private readonly onWrite?: () => void
	) {}

	end(): void {
		this.destroyed = true;
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
	readonly stdin: RejectingProtocolInput;
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
		onWrite?: () => void
	) {
		this.stdin = new RejectingProtocolInput(inputMessage, onWrite);
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
	expect(failure.message).toContain("protocol input closed");
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
	expect(failure.message).toContain("protocol input closed");
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
	expect(failure.message).toContain("replacement input closed");
	expect(failure.message).not.toContain("stale worker error");
	await session.close();
});
