import { spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { Effect, Schema } from "effect";
import type { GameTextContract } from "@ue-shed/protocol";
import { AssetReaderError, type AssetReaderProtocolObservation } from "./asset-reader.js";
import {
	encodeFrame,
	type EngineFrame,
	FRAME_HEADER_BYTES,
	FrameDecoder,
	FrameKind,
	LAST_FRAME,
	MAX_FRAME_BODY_BYTES
} from "./game-text-engine-frames.js";
import { type BatchRow, EngineBatch } from "./game-text-engine-batch.js";

const benchmark = channel("ue-shed.game-text-benchmark");

/** Bytes of a worker's stderr kept for its failure message. */
const MAX_STDERR_BYTES = 64 * 1024;
/** How long closing waits for the worker to exit after its input ends. */
const CLOSE_WAIT_MS = 1_000;
/** How long a cancelled request may run before the session counts the engine stuck. */
const CANCEL_WAIT_MS = 2_000;

/** One engine process, as the session drives it; tests supply scripted ones. */
export interface GameTextEngineProcess {
	readonly pid: number | undefined;
	/** Writes bytes to the engine's input. */
	readonly write: (bytes: Uint8Array) => void;
	/** Ends the engine's input, which ends its session. */
	readonly end: () => void;
	readonly kill: () => void;
	/** Detaches the process from the host's liveness, for one that won't exit. */
	readonly unref: () => void;
	readonly onOutput: (listener: (chunk: Uint8Array) => void) => void;
	readonly onStderr: (listener: (text: string) => void) => void;
	/** Called once, after the process exited and its output closed. */
	readonly onExit: (listener: (code: number | null, signal: string | null) => void) => void;
}

export type GameTextEngineProcessFactory = () => GameTextEngineProcess;

function spawnEngine(executable: string): GameTextEngineProcess {
	const child = spawn(executable, ["game-text-engine"], { windowsHide: true });
	// A worker that exits while a write is pending fails that write with EPIPE; the exit fails the
	// requests, so the stream error has nothing to add.
	child.stdin.on("error", () => {});
	return {
		pid: child.pid,
		write: (bytes) => {
			child.stdin.write(bytes);
		},
		end: () => child.stdin.end(),
		kill: () => {
			child.kill();
		},
		unref: () => {
			child.unref();
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		},
		onOutput: (listener) => {
			child.stdout.on("data", listener);
		},
		onStderr: (listener) => {
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", listener);
		},
		onExit: (listener) => {
			child.once("error", () => listener(null, null));
			child.once("close", listener);
		}
	};
}

/**
 * A failure probe: it holds until cancelled, panics, aborts the process, or sends batches until
 * cancelled. Only debug and probe builds of the engine answer it, for the session's tests.
 */
export interface EngineProbe {
	readonly action: "probe";
	readonly probe: "hold" | "panic" | "abort" | "stream";
	/** Run it as bulk work rather than interactive. */
	readonly bulk?: boolean;
	/** How many batches `stream` sends before it ends; none sends until cancelled. */
	readonly batches?: number;
}

/**
 * A request's answer: its JSON parts, each one frame's body, its column batches in the order they
 * came, and what the request cost.
 */
export interface EngineAnswer {
	readonly parts: ReadonlyArray<ArrayBuffer>;
	readonly batches: ReadonlyArray<EngineBatch>;
	/** A stream sink's text frames, when the call had no writer for them. */
	readonly texts: ReadonlyArray<ArrayBuffer>;
	readonly profile: GameTextContract.EngineProfile;
}

const decoder = new TextDecoder();
/** A `credit` body for one consumed frame. */
const creditBody = new TextEncoder().encode(JSON.stringify({ frames: 1 }));

/** A JSON frame body as the contract type `T` the engine serialized it from. */
const contractJson = <T>(body: ArrayBuffer): T =>
	// SAFETY: the engine serializes each JSON body from the contract type its frame kind or
	// request names; the session's handshake checked that host and engine share that contract.
	// Verified by: the Rust contract test, which regenerates the host's types from the engine's.
	JSON.parse(decoder.decode(body)) as T;

/** An answer's first part, parsed as the contract type `T` its request replies with. */
export const answerJson = <T>(answer: EngineAnswer): T | undefined => {
	const part = answer.parts[0];
	return part === undefined ? undefined : contractJson<T>(part);
};

/** The rows of one part of an answer, as objects, in the order the engine sent them. */
export const answerRows = (answer: EngineAnswer, part: string): BatchRow[] => {
	const rows: BatchRow[] = [];
	for (const batch of answer.batches) if (batch.part === part) rows.push(...batch.objects());
	return rows;
};

/** Watches one request's progress; it runs on the session's thread, so it must be cheap. */
export type EngineProgressObserver = (progress: GameTextContract.EngineProgress) => void;

/**
 * Writes the rows a stream sink encoded, in order. The engine sends the next `text` frame once
 * a write finishes, so a slow destination holds the request back rather than filling memory.
 */
export type EngineTextWriter = (chunk: Uint8Array) => Promise<void>;

/** How long a request whose sink failed has to stop once cancelled. */
const SINK_CANCEL_WAIT_MS = 2000;

interface Pending {
	readonly parts: ArrayBuffer[];
	readonly batches: EngineBatch[];
	/** Text frames gathered when the call has no writer. */
	readonly texts: ArrayBuffer[];
	readonly progress: EngineProgressObserver | undefined;
	readonly text: EngineTextWriter | undefined;
	/** The writes in flight: the answer waits for them, and a failed one fails it. */
	written: Promise<void>;
	writeFailed: unknown;
	readonly resume: (effect: Effect.Effect<EngineAnswer, AssetReaderError>) => void;
	/** Output bytes and the largest frame, for the reader's protocol observer. */
	outputBytes: number;
	largestFrameBytes: number;
}

const failure = (
	kind: AssetReaderError["kind"],
	message: string,
	fields: { readonly code?: string; readonly exitCode?: number; readonly cause?: unknown } = {}
) =>
	new AssetReaderError({
		kind,
		operation: "game_text_engine",
		message,
		retrySafe: kind === "process",
		nextStep:
			kind === "process" ? "retry" : kind === "resource_limit" ? "fix_input" : "escalate",
		recovery:
			kind === "contract"
				? "Install the native reader from the same UE Shed build as this host, then reopen the snapshot."
				: kind === "resource_limit"
					? "Ask for a smaller page or a narrower selection."
					: "Reopen the Game Text snapshot. If the engine keeps failing, check that the configured uasset executable starts.",
		...fields
	});

/** One running engine process and its requests in flight. */
class Worker {
	readonly pending = new Map<number, Pending>();
	/** Cancelled requests awaiting their terminal frame: when each was cancelled, and its timer. */
	private readonly cancelling = new Map<
		number,
		{ readonly at: number; readonly timer: ReturnType<typeof setTimeout> }
	>();
	private readonly decoder = new FrameDecoder();
	private next = 0;
	private stderr = "";
	exited = false;
	readonly closed: Promise<void>;

	constructor(
		readonly process: GameTextEngineProcess,
		readonly generation: number,
		onExit: (worker: Worker) => void,
		private readonly observe: (event: AssetReaderProtocolObservation) => void
	) {
		process.onStderr((text) => {
			if (this.stderr.length < MAX_STDERR_BYTES)
				this.stderr += text.slice(0, MAX_STDERR_BYTES - this.stderr.length);
		});
		process.onOutput((chunk) => {
			if (this.exited) return;
			let frames: EngineFrame[];
			try {
				frames = this.decoder.push(chunk);
			} catch (cause) {
				// A malformed frame is an engine defect; nothing after it can be trusted.
				this.fail(
					failure("contract", "The Game Text engine sent a malformed frame.", { cause })
				);
				process.kill();
				return;
			}
			for (const frame of frames) this.receive(frame);
		});
		this.closed = new Promise((resolve) =>
			process.onExit((code, signal) => {
				const detail = this.stderr.trim();
				this.fail(
					failure(
						"process",
						detail ||
							`The Game Text engine exited ${code ?? signal ?? "unexpectedly"} with requests in flight.`,
						code === null
							? { code: "engine_unavailable" }
							: { code: "engine_unavailable", exitCode: code }
					)
				);
				onExit(this);
				resolve();
			})
		);
	}

	/** The next request ID; IDs are never 0 and never reused while a request is in flight. */
	id(): number {
		do this.next = this.next === 0xffff_ffff ? 1 : this.next + 1;
		while (this.pending.has(this.next));
		return this.next;
	}

	/**
	 * Sends `cancel` for a request the host stopped waiting for. An engine that hasn't ended it
	 * within `wait` is stuck: the session kills it and fails what is in flight.
	 */
	cancel(id: number, wait: number): void {
		if (!this.pending.delete(id) || this.exited) return;
		this.process.write(encodeFrame(FrameKind.cancel, id));
		const timer = setTimeout(() => {
			this.fail(
				failure(
					"process",
					"The Game Text engine did not stop a cancelled request, so it was restarted.",
					{ code: "engine_unavailable" }
				)
			);
			this.process.kill();
		}, wait);
		timer.unref();
		this.cancelling.set(id, { at: performance.now(), timer });
	}

	private receive(frame: EngineFrame): void {
		const pending = this.pending.get(frame.request);
		if (pending === undefined) {
			// A late frame for a request the host cancelled; its last one ends the wait.
			const cancelled = this.cancelling.get(frame.request);
			if (cancelled !== undefined && frame.flags & LAST_FRAME) {
				clearTimeout(cancelled.timer);
				this.cancelling.delete(frame.request);
				if (benchmark.hasSubscribers)
					benchmark.publish({
						stage: "engineCancel",
						ms: performance.now() - cancelled.at
					});
			}
			return;
		}
		const bytes = FRAME_HEADER_BYTES + frame.body.byteLength;
		pending.outputBytes += bytes;
		pending.largestFrameBytes = Math.max(pending.largestFrameBytes, bytes);
		if (frame.flags & LAST_FRAME) {
			this.pending.delete(frame.request);
			const completed = {
				kind: "worker_completed" as const,
				outputBytes: pending.outputBytes,
				largestFrameBytes: pending.largestFrameBytes,
				terminalState:
					frame.kind === FrameKind.end
						? ("complete" as const)
						: frame.kind === FrameKind.cancelled
							? ("cancelled" as const)
							: ("failed" as const)
			};
			const pid = this.process.pid;
			this.observe(pid === undefined ? completed : { ...completed, pid });
		}
		switch (frame.kind) {
			case FrameKind.part:
				pending.parts.push(frame.body);
				return;
			case FrameKind.batch: {
				let batch: EngineBatch;
				const viewStarted = benchmark.hasSubscribers ? performance.now() : undefined;
				try {
					batch = new EngineBatch(frame.body);
					if (viewStarted !== undefined)
						benchmark.publish({
							stage: "tsBatchView",
							ms: performance.now() - viewStarted
						});
				} catch (cause) {
					this.fail(
						failure("contract", "The Game Text engine sent a malformed batch.", {
							cause
						})
					);
					this.process.kill();
					return;
				}
				pending.batches.push(batch);
				// The answer is gathered in memory, so each batch is consumed as it arrives.
				this.process.write(encodeFrame(FrameKind.credit, frame.request, creditBody));
				return;
			}
			case FrameKind.text: {
				const writer = pending.text;
				if (writer === undefined) {
					pending.texts.push(frame.body);
					this.process.write(encodeFrame(FrameKind.credit, frame.request, creditBody));
					return;
				}
				const request = frame.request;
				const chunk = new Uint8Array(frame.body);
				pending.written = pending.written.then(async () => {
					if (pending.writeFailed !== undefined) return;
					try {
						await writer(chunk);
						this.process.write(encodeFrame(FrameKind.credit, request, creditBody));
					} catch (cause) {
						// The engine waits for a credit that won't come, so the request is cancelled.
						pending.writeFailed = cause;
						pending.resume(
							Effect.fail(
								failure("process", "The sink's destination could not be written.", {
									cause
								})
							)
						);
						this.cancel(request, SINK_CANCEL_WAIT_MS);
					}
				});
				return;
			}
			case FrameKind.progress:
				try {
					pending.progress?.(contractJson<GameTextContract.EngineProgress>(frame.body));
				} catch {
					// A progress observer's failure must never change the request.
				}
				return;
			case FrameKind.end: {
				const { profile } = contractJson<GameTextContract.EngineEnd>(frame.body);
				const answer = {
					parts: pending.parts,
					batches: pending.batches,
					texts: pending.texts,
					profile
				};
				// Every text frame is written before the answer.
				void pending.written.then(() => {
					if (pending.writeFailed === undefined) pending.resume(Effect.succeed(answer));
				});
				return;
			}
			case FrameKind.error: {
				const { error } = contractJson<GameTextContract.EngineFailure>(frame.body);
				pending.resume(
					Effect.fail(
						failure(
							error.code === "limit_exceeded" ? "resource_limit" : "process",
							error.message,
							{ code: error.code }
						)
					)
				);
				return;
			}
			case FrameKind.cancelled:
				pending.resume(Effect.interrupt);
				return;
			default:
				this.fail(
					failure("contract", `The Game Text engine sent frame kind ${frame.kind}.`)
				);
				this.process.kill();
		}
	}

	/** Fails every request in flight. */
	fail(error: AssetReaderError): void {
		this.exited = true;
		for (const { timer } of this.cancelling.values()) clearTimeout(timer);
		this.cancelling.clear();
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) request.resume(Effect.fail(error));
	}
}

/**
 * The host's Game Text engine: one `uasset game-text-engine` process, started by the first call
 * and again after it exits. Requests carry IDs, so calls may overlap. Reader handles belong to the
 * process that opened them; `generation` names it, so callers can tell when a restart lost them.
 */
export class GameTextEngineSession {
	private worker: Worker | undefined;
	private started = 0;
	private disposed = false;

	constructor(
		executable: string,
		private readonly processFactory: GameTextEngineProcessFactory = () =>
			spawnEngine(executable),
		/** The reader's protocol observer: a start and a completion for each request. */
		private readonly observer?: (event: AssetReaderProtocolObservation) => void,
		/** How long a cancelled request may run before the engine counts as stuck. */
		private readonly cancelWait = CANCEL_WAIT_MS
	) {}

	private observe = (event: AssetReaderProtocolObservation): void => {
		try {
			this.observer?.(event);
		} catch {
			// Optional measurement hooks must never change engine behaviour.
		}
	};

	/** The running process, numbered by start; undefined while none runs. */
	get generation(): number | undefined {
		return this.worker === undefined || this.worker.exited ? undefined : this.worker.generation;
	}

	private start(): Worker {
		if (this.disposed) throw failure("process", "The Game Text engine session is closed.");
		if (this.worker !== undefined && !this.worker.exited) return this.worker;
		this.started += 1;
		const worker = new Worker(
			this.processFactory(),
			this.started,
			(exited) => {
				if (this.worker === exited) this.worker = undefined;
			},
			this.observe
		);
		this.worker = worker;
		return worker;
	}

	/**
	 * Sends one request and gathers its frames until the terminal one. Interrupting the call stops
	 * waiting and sends `cancel`; an engine that doesn't end the request in time is restarted.
	 */
	call(
		request: GameTextContract.EngineRequest | EngineProbe,
		/** Watches the request's progress frames, for requests that report progress. */
		progress?: EngineProgressObserver,
		/** Writes a stream sink's text frames as they arrive; without it they are gathered. */
		text?: EngineTextWriter
	): Effect.Effect<EngineAnswer, AssetReaderError> {
		return Effect.callback<EngineAnswer, AssetReaderError>((resume) => {
			let worker: Worker;
			try {
				worker = this.start();
			} catch (cause) {
				resume(
					Effect.fail(
						Schema.is(AssetReaderError)(cause)
							? cause
							: failure("process", "The Game Text engine did not start.", { cause })
					)
				);
				return;
			}
			const encodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
			const body = new TextEncoder().encode(JSON.stringify(request));
			if (encodeStarted !== undefined)
				benchmark.publish({
					stage: "tsFrameEncode",
					action: request.action,
					ms: performance.now() - encodeStarted
				});
			if (body.byteLength > MAX_FRAME_BODY_BYTES) {
				resume(
					Effect.fail(
						failure(
							"resource_limit",
							`The ${request.action} request encodes to ${body.byteLength} bytes; one request carries at most ${MAX_FRAME_BODY_BYTES}.`
						)
					)
				);
				return;
			}
			const id = worker.id();
			worker.pending.set(id, {
				parts: [],
				batches: [],
				texts: [],
				text,
				written: Promise.resolve(),
				writeFailed: undefined,
				progress,
				resume,
				outputBytes: 0,
				largestFrameBytes: 0
			});
			if (worker.process.pid !== undefined)
				this.observe({ kind: "worker_started", pid: worker.process.pid });
			worker.process.write(encodeFrame(FrameKind.request, id, body));
			return Effect.sync(() => worker.cancel(id, this.cancelWait));
		});
	}

	/** Ends the engine's input and waits for it to exit, killing and then detaching one that won't. */
	async close(): Promise<void> {
		this.disposed = true;
		const worker = this.worker;
		if (worker === undefined) return;
		worker.process.end();
		const wait = (ms: number) =>
			Promise.race([
				worker.closed.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref())
			]);
		if (await wait(CLOSE_WAIT_MS)) return;
		worker.process.kill();
		if (await wait(CLOSE_WAIT_MS)) return;
		worker.fail(failure("process", "The Game Text engine session is closed."));
		worker.process.unref();
	}
}
