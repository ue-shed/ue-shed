import { gameTextEngineContract, type GameTextContract } from "@ue-shed/protocol";
import { Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { AssetReaderError } from "./asset-reader.js";
import {
	answerJson,
	NativeGameTextEngineClient,
	nativeGameTextEngineClientLayer
} from "./game-text-engine-client.js";
import {
	encodeFrame,
	FrameDecoder,
	FrameKind,
	LAST_FRAME,
	MalformedFrame,
	MAX_FRAME_BODY_BYTES
} from "./game-text-engine-frames.js";
import type { GameTextEngineProcess } from "./game-text-engine-session.js";

const encoder = new TextEncoder();
const json = (value: GameTextContract.JsonValue) => encoder.encode(JSON.stringify(value));
/** A request's terminal frame. */
const terminal = (kind: FrameKind, id: number, body: Uint8Array) => {
	const frame = encodeFrame(kind, id, body);
	frame[5] = LAST_FRAME;
	return frame;
};
const profile: GameTextContract.EngineProfile = {
	io: {
		opens: 0,
		sectionLoads: 0,
		storedBytes: 0,
		rawBytes: 0,
		fullVerifies: 0,
		indexBytes: 0,
		writtenBytes: 0
	},
	stageSeconds: {}
};

/** A scripted engine: it decodes request frames and answers each one, or holds it. */
class ScriptedEngine implements GameTextEngineProcess {
	readonly pid = 11;
	readonly actions: string[] = [];
	readonly cancels: number[] = [];
	/** Requests held, unanswered, by ID. */
	readonly holding = new Map<number, GameTextContract.EngineRequest>();
	hold = false;
	private readonly requests = new FrameDecoder();
	private output: ((chunk: Uint8Array) => void) | undefined;
	private exit: ((code: number | null, signal: string | null) => void) | undefined;
	private exited = false;

	constructor(private readonly contractHash: string = gameTextEngineContract.contractHash) {}

	write = (bytes: Uint8Array) => {
		for (const frame of this.requests.push(bytes)) {
			if (frame.kind === FrameKind.cancel) {
				this.cancels.push(frame.request);
				continue;
			}
			// SAFETY: the session encodes each request body from `EngineRequest`.
			const request = JSON.parse(
				new TextDecoder().decode(frame.body)
			) as GameTextContract.EngineRequest;
			this.actions.push(request.action);
			if (this.hold && request.action !== "capabilities")
				this.holding.set(frame.request, request);
			else this.answer(frame.request, request);
		}
	};

	/** The held request at `index`, in arrival order. */
	held(index: number): readonly [number, GameTextContract.EngineRequest] {
		const entry = [...this.holding][index];
		if (entry === undefined) throw new Error(`No request ${index} is held.`);
		return entry;
	}

	answer(id: number, request: GameTextContract.EngineRequest): void {
		const send = (bytes: Uint8Array) => queueMicrotask(() => this.output?.(bytes));
		if (request.action === "capabilities")
			send(
				encodeFrame(
					FrameKind.part,
					id,
					json({
						buildId: gameTextEngineContract.buildId,
						contractHash: this.contractHash
					})
				)
			);
		if (request.action === "summary") {
			send(
				terminal(
					FrameKind.error,
					id,
					json({ error: { code: "not_found", message: "No reader." }, profile })
				)
			);
			return;
		}
		send(terminal(FrameKind.end, id, json({ profile })));
	}

	/** Sends the engine's bytes as they are, in one chunk. */
	send(bytes: Uint8Array): void {
		this.output?.(bytes);
	}

	end = () => this.crash(0);
	kill = () => this.crash(null);
	unref = () => {};
	onOutput = (listener: (chunk: Uint8Array) => void) => {
		this.output = listener;
	};
	onStderr = () => {};
	onExit = (listener: (code: number | null, signal: string | null) => void) => {
		this.exit = listener;
	};

	/** The engine exits, as a crash would. */
	crash(code: number | null = 1): void {
		if (this.exited) return;
		this.exited = true;
		queueMicrotask(() => this.exit?.(code, code === null ? "SIGTERM" : null));
	}
}

const configuration = { executable: "engine" };
const close = { action: "close", reader: "reader" } as const;

/** Run calls through one client whose engines come from `engines` in order. */
const withClient = <A, E>(
	engines: ScriptedEngine[],
	use: (client: NativeGameTextEngineClient["Service"]) => Effect.Effect<A, E>,
	cancelWaitMs?: number
) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				return yield* use(yield* NativeGameTextEngineClient);
			}).pipe(
				Effect.provide(
					nativeGameTextEngineClientLayer(
						configuration,
						() => {
							const engine = engines.shift();
							if (engine === undefined) throw new Error("unexpected engine start");
							return engine;
						},
						cancelWaitMs
					)
				)
			)
		)
	);

it("splits frames however the pipe delivers them, each body in its own aligned buffer", () => {
	const frames = [
		encodeFrame(FrameKind.part, 1, json({ a: 1 })),
		encodeFrame(FrameKind.batch, 2, new Uint8Array(24).fill(7)),
		encodeFrame(FrameKind.end, 2, json({ profile }))
	];
	const stream = new Uint8Array(frames.reduce((total, frame) => total + frame.byteLength, 0));
	let at = 0;
	for (const frame of frames) {
		stream.set(frame, at);
		at += frame.byteLength;
	}
	for (const size of [1, 5, 13, stream.byteLength]) {
		const decoder = new FrameDecoder();
		const read = [];
		for (let start = 0; start < stream.byteLength; start += size)
			read.push(...decoder.push(stream.subarray(start, start + size)));
		expect(read.map((frame) => [frame.kind, frame.request, frame.body.byteLength])).toEqual([
			[FrameKind.part, 1, 7],
			[FrameKind.batch, 2, 24],
			[FrameKind.end, 2, JSON.stringify({ profile }).length]
		]);
		expect(new Float64Array(read[1]!.body, 0, 3)).toHaveLength(3);
		expect(decoder.partial).toBe(false);
	}
	const oversized = encodeFrame(FrameKind.part, 1);
	new DataView(oversized.buffer).setUint32(0, MAX_FRAME_BODY_BYTES + 1, true);
	expect(() => new FrameDecoder().push(oversized)).toThrow(MalformedFrame);
	const reserved = encodeFrame(FrameKind.part, 1);
	reserved[6] = 1;
	expect(() => new FrameDecoder().push(reserved)).toThrow(MalformedFrame);
});

it("checks a process's contract once, before its first request", async () => {
	const engine = new ScriptedEngine();
	await withClient([engine], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			yield* client.execute(close);
		})
	);
	expect(engine.actions).toEqual(["capabilities", "close", "close"]);
});

it("refuses a different contract without remembering the failure", async () => {
	const wrong = new ScriptedEngine("0".repeat(64));
	const failures = await withClient([wrong], (client) =>
		Effect.gen(function* () {
			const first = yield* Effect.flip(client.execute(close));
			const second = yield* Effect.flip(client.execute(close));
			return [first, second];
		})
	);
	for (const failure of failures) {
		expect(failure).toBeInstanceOf(AssetReaderError);
		expect(failure).toMatchObject({ kind: "contract", operation: "game_text_engine" });
	}
	// Each call checked again, and no request reached the engine.
	expect(wrong.actions).toEqual(["capabilities", "capabilities"]);
});

it("checks a replacement process before it serves a request", async () => {
	const first = new ScriptedEngine();
	const second = new ScriptedEngine();
	await withClient([first, second], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			first.hold = true;
			const held = yield* Effect.forkChild(client.execute(close));
			yield* Effect.yieldNow;
			first.crash();
			// The call in flight fails when its process exits; the next call starts a new one.
			expect(yield* Effect.flip(Fiber.join(held))).toMatchObject({ kind: "process" });
			yield* client.execute(close);
		})
	);
	expect(first.actions).toEqual(["capabilities", "close", "close"]);
	expect(second.actions).toEqual(["capabilities", "close"]);
});

it("answers overlapping requests by ID and types an engine error", async () => {
	const engine = new ScriptedEngine();
	await withClient([engine], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			engine.hold = true;
			const first = yield* Effect.forkChild(client.execute(close));
			const second = yield* Effect.forkChild(
				client.execute({ action: "summary", reader: "r" })
			);
			yield* Effect.yieldNow;
			// The engine answers the second request first.
			const [firstId, firstRequest] = engine.held(0);
			const [secondId, secondRequest] = engine.held(1);
			engine.answer(secondId, secondRequest);
			expect(yield* Effect.flip(Fiber.join(second))).toMatchObject({
				kind: "process",
				code: "not_found",
				message: "No reader."
			});
			engine.answer(firstId, firstRequest);
			expect(answerJson(yield* Fiber.join(first))).toBeUndefined();
		})
	);
});

it("sends cancel for an interrupted request and ignores its late frames", async () => {
	const engine = new ScriptedEngine();
	await withClient([engine], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			engine.hold = true;
			const call = yield* Effect.forkChild(client.execute(close));
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(call);
			const [id, request] = engine.held(0);
			expect(engine.cancels).toEqual([id]);
			engine.answer(id, request);
			engine.hold = false;
			yield* client.execute(close);
		})
	);
	expect(engine.actions).toEqual(["capabilities", "close", "close", "close"]);
});

it("restarts an engine that doesn't stop a cancelled request, failing what was in flight", async () => {
	const stuck = new ScriptedEngine();
	const replacement = new ScriptedEngine();
	await withClient(
		[stuck, replacement],
		(client) =>
			Effect.gen(function* () {
				yield* client.execute(close);
				stuck.hold = true;
				const cancelled = yield* Effect.forkChild(client.execute(close));
				const waiting = yield* Effect.forkChild(client.execute(close));
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(cancelled);
				// The engine never answers the cancel, so the request still waiting fails with it.
				expect(yield* Effect.flip(Fiber.join(waiting))).toMatchObject({
					kind: "process",
					code: "engine_unavailable"
				});
				yield* client.execute(close);
			}),
		20
	);
	expect(stuck.actions).toEqual(["capabilities", "close", "close", "close"]);
	expect(replacement.actions).toEqual(["capabilities", "close"]);
});

it("ends the session on a malformed frame and fails what was in flight", async () => {
	const engine = new ScriptedEngine();
	const replacement = new ScriptedEngine();
	await withClient([engine, replacement], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			engine.hold = true;
			const call = yield* Effect.forkChild(client.execute(close));
			yield* Effect.yieldNow;
			const malformed = encodeFrame(FrameKind.part, 1);
			malformed[7] = 1;
			engine.send(malformed);
			expect(yield* Effect.flip(Fiber.join(call))).toMatchObject({ kind: "contract" });
			yield* client.execute(close);
		})
	);
	expect(replacement.actions).toEqual(["capabilities", "close"]);
});
