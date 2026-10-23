import { PassThrough, Writable } from "node:stream";
import { gameTextEngineContract } from "@ue-shed/protocol";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { AssetReaderError } from "./asset-reader.js";
import {
	NativeGameTextEngineClient,
	nativeGameTextEngineClientLayer
} from "./game-text-engine-client.js";
import type { ProtocolSessionProcess } from "./protocol-transport.js";

/** A persistent engine worker that answers every request, reporting the given contract. */
class EngineWorker implements ProtocolSessionProcess {
	readonly pid = 11;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly actions: string[] = [];
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	private readonly closeListeners: Array<(code: number | null, signal: string | null) => void> =
		[];

	constructor(private readonly contractHash: string) {
		this.stdin = new Writable({
			decodeStrings: false,
			write: (chunk: string, _encoding, callback) => {
				for (const line of chunk.split("\n").filter((line) => line.length > 0))
					this.answer(JSON.parse(line));
				callback();
			}
		});
	}

	private answer(request: {
		readonly contract: unknown;
		readonly requestId: string;
		readonly operation: { readonly request: { readonly action: string } };
	}) {
		const action = request.operation.request.action;
		this.actions.push(action);
		const frame = { contract: request.contract, requestId: request.requestId };
		const outcome = {
			action,
			capabilities: ["game_text_engine_v1"],
			reader: null,
			generation: null,
			joinedKey: null,
			payload: null,
			io: {
				opens: 0,
				sectionLoads: 0,
				storedBytes: 0,
				rawBytes: 0,
				fullVerifies: 0,
				indexBytes: 0,
				writtenBytes: 0
			},
			stageSeconds: {},
			...(action === "capabilities"
				? {
						contract: {
							buildId: gameTextEngineContract.buildId,
							contractHash: this.contractHash
						}
					}
				: undefined)
		};
		for (const event of [
			{ ...frame, kind: "accepted", operation: "game_text_engine", sequence: 0 },
			{
				...frame,
				kind: "result",
				result: { kind: "game_text_engine", outcome },
				sequence: 1
			},
			{ ...frame, kind: "completed", outcome: "complete", sequence: 2 }
		])
			this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	/** The worker exits on its own, as a crash would. */
	exit(): void {
		this.exitCode = 1;
		this.stdin.destroy();
		this.stdout.end();
		this.stderr.end();
		for (const listener of this.closeListeners) listener(1, null);
	}

	kill = (): boolean => {
		if (this.killed) return false;
		this.killed = true;
		queueMicrotask(() => this.exit());
		return true;
	};

	onClose(listener: (code: number | null, signal: string | null) => void): void {
		this.closeListeners.push(listener);
	}

	onError(): void {}

	unref(): void {}
}

const configuration = { catalogTimeoutMs: 1_000, executable: "engine", timeoutMs: 1_000 };
const close = { action: "close", reader: "reader" } as const;

/** Run calls through one client whose workers come from `workers` in order. */
const withClient = <A, E>(
	workers: EngineWorker[],
	use: (client: NativeGameTextEngineClient["Service"]) => Effect.Effect<A, E>
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* use(yield* NativeGameTextEngineClient);
		}).pipe(
			Effect.provide(
				nativeGameTextEngineClientLayer(configuration, () => {
					const worker = workers.shift();
					if (worker === undefined) throw new Error("unexpected worker start");
					return worker;
				})
			)
		)
	);

it("checks a worker's contract once, before its first request", async () => {
	const worker = new EngineWorker(gameTextEngineContract.contractHash);
	await withClient([worker], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			yield* client.execute(close);
		})
	);
	expect(worker.actions).toEqual(["capabilities", "close", "close"]);
});

it("refuses a different contract without remembering the failure", async () => {
	const wrong = new EngineWorker("0".repeat(64));
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

it("checks a replacement worker before it serves a request", async () => {
	const first = new EngineWorker(gameTextEngineContract.contractHash);
	const second = new EngineWorker(gameTextEngineContract.contractHash);
	await withClient([first, second], (client) =>
		Effect.gen(function* () {
			yield* client.execute(close);
			first.exit();
			// The call that finds the worker gone fails; the next one starts a new worker.
			yield* Effect.flip(client.execute(close));
			yield* client.execute(close);
		})
	);
	expect(first.actions).toEqual(["capabilities", "close"]);
	expect(second.actions).toEqual(["capabilities", "close"]);
});
