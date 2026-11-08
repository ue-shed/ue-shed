import { Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import {
	encodeFrame,
	type EngineFrame,
	FrameDecoder,
	FrameKind
} from "./game-text-engine-frames.js";
import { type GameTextEngineProcess, GameTextEngineSession } from "./game-text-engine-session.js";

/** An engine process the test answers by hand. */
function fakeEngine() {
	const written: EngineFrame[] = [];
	const decoder = new FrameDecoder();
	let output: (chunk: Uint8Array) => void = () => undefined;
	const process: GameTextEngineProcess = {
		pid: undefined,
		write: (bytes) => {
			written.push(...decoder.push(bytes));
		},
		end: () => undefined,
		kill: () => undefined,
		unref: () => undefined,
		onOutput: (listener) => {
			output = listener;
		},
		onStderr: () => undefined,
		onExit: () => undefined
	};
	const text = (frame: EngineFrame): string => new TextDecoder().decode(frame.body);
	return {
		process,
		requests: () => written.filter((frame) => frame.kind === FrameKind.request).map(text),
		send: (frame: Uint8Array) => output(frame),
		lastRequestId: () => written.findLast((frame) => frame.kind === FrameKind.request)!.request
	};
}

it("G2.c closes a reader whose open finished after the host cancelled it", async () => {
	const engine = fakeEngine();
	const session = new GameTextEngineSession("unused", () => engine.process, undefined, 60_000);
	await Effect.runPromise(
		Effect.gen(function* () {
			const opening = yield* Effect.forkChild(
				session.call({
					action: "open",
					configuration: {
						cacheRoot: "cache",
						projectKey: "project",
						targetKey: "target",
						sharedProject: false
					},
					expectedGeneration: "generation",
					expectedJoined: "joined",
					policy: { audienceRules: [] }
				})
			);
			yield* Effect.yieldNow;
			const id = engine.lastRequestId();
			yield* Fiber.interrupt(opening);
			// The engine had already answered: the reader is open, and only the host knows it.
			const encoder = new TextEncoder();
			engine.send(
				encodeFrame(
					FrameKind.part,
					id,
					encoder.encode(
						JSON.stringify({
							reader: "r1",
							generation: "generation",
							joinedKey: "joined"
						})
					)
				)
			);
			const end = encodeFrame(FrameKind.end, id, encoder.encode("{}"));
			end[5] = 1;
			engine.send(end);
			expect(engine.requests().at(-1)).toBe(
				JSON.stringify({ action: "close", reader: "r1" })
			);
		})
	);
});

it("G2.c closes a reader whose open reply arrived just before the host cancelled it", async () => {
	const engine = fakeEngine();
	const session = new GameTextEngineSession("unused", () => engine.process, undefined, 60_000);
	await Effect.runPromise(
		Effect.gen(function* () {
			const opening = yield* Effect.forkChild(
				session.call({
					action: "open",
					configuration: {
						cacheRoot: "cache",
						projectKey: "project",
						targetKey: "target",
						sharedProject: false
					},
					expectedGeneration: "generation",
					expectedJoined: "joined",
					policy: { audienceRules: [] }
				})
			);
			yield* Effect.yieldNow;
			const id = engine.lastRequestId();
			// The reply's part is in, its end not yet: the reader is open, and only the host knows it.
			const encoder = new TextEncoder();
			engine.send(
				encodeFrame(
					FrameKind.part,
					id,
					encoder.encode(
						JSON.stringify({
							reader: "r1",
							generation: "generation",
							joinedKey: "joined"
						})
					)
				)
			);
			yield* Fiber.interrupt(opening);
			const end = encodeFrame(FrameKind.end, id, encoder.encode("{}"));
			end[5] = 1;
			engine.send(end);
			expect(engine.requests().at(-1)).toBe(
				JSON.stringify({ action: "close", reader: "r1" })
			);
		})
	);
});
