import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { Effect, Exit, Metric, Schema, Scope } from "effect";
import {
	QualityWorkerCall,
	QualityWorkerCallReply,
	QualityWorkerInput,
	QualityWorkerReply,
	QualityWorkerTask,
	qualityWorkerCallValues,
	qualityWorkerFailure,
	type QualityWorkerFailure,
	type QualityWorkerFindings
} from "./quality-worker-protocol.js";
import type { LocalizationQuality } from "./localization-workspace.js";
import type { IndexedLocalizationQualityOptions } from "./localization-quality-index.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import type { TextCorpus } from "./schema.js";
import { receiveSyncReply, type SyncCallChannel } from "./worker-calls.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";

const started = Metric.counter("game_text.index.quality_workers_started");
const scans = Metric.counter("game_text.index.worker_quality_scans_completed");
const callTimeoutMs = 30_000;

function launch(input: QualityWorkerInput, calls: MessagePort, signal: SharedArrayBuffer) {
	const options = { workerData: { input, calls, signal }, transferList: [calls] };
	const compiled = new URL("./quality-worker.js", import.meta.url);
	if (existsSync(compiled)) return new Worker(compiled, options);
	const source = new URL("./quality-worker.ts", import.meta.url);
	return new Worker(
		`import("tsx/esm/api").then(async ({ register }) => { register(); await import(${JSON.stringify(source.href)}); });`,
		{ ...options, eval: true }
	);
}

/** Blocks this thread until the worker answers one read of a finished scan. */
function callSync<S extends Schema.ConstraintDecoder<unknown>>(
	calls: SyncCallChannel,
	failed: () => QualityWorkerFailure | undefined,
	call: QualityWorkerCall,
	value: S
): S["Type"] {
	const broken = failed();
	if (broken) throw broken;
	calls.port.postMessage(Schema.encodeSync(QualityWorkerCall)(call));
	const reply = receiveSyncReply(
		calls,
		QualityWorkerCallReply,
		(reply) => reply.id,
		call.id,
		callTimeoutMs,
		() => qualityWorkerFailure("quality.worker.call", "The quality worker did not answer.")
	);
	if (reply.kind === "failed") throw reply.error;
	return Schema.decodeUnknownSync(value)(reply.value);
}

/**
 * A finished scan as the host reads it. Facts come from the scan's groups; `items`, `find` and
 * the unit lookups read the worker's scan, which stays there until this object is collected.
 */
function hostQuality(
	calls: SyncCallChannel,
	failed: () => QualityWorkerFailure | undefined,
	next: () => number,
	scan: number,
	findings: QualityWorkerFindings
): LocalizationQuality {
	const values = qualityWorkerCallValues;
	const limits = new Map(findings.limits.map((entry) => [entry.culture, entry.counts]));
	const group = (position: number) => findings.groups[findings.groupOf[position]!]!;
	const { sourceKeys, ...metadata } = findings.metadata;
	return {
		findings: {
			length: findings.length,
			groups: findings.groups,
			culture: (position) => group(position).culture,
			filter: (position) => group(position).filter,
			severity: (position) => group(position).severity,
			ruleId: (position) => group(position).ruleId,
			eligible: (position) => group(position).eligible,
			reportedBySource: (position) => group(position).reportedBySource,
			find: (findingId, culture) =>
				callSync(
					calls,
					failed,
					{
						id: next(),
						scan,
						method: "find",
						findingId,
						...(culture === undefined ? undefined : { culture })
					},
					values.find
				),
			items: (positions) =>
				positions.length === 0
					? Effect.succeed([])
					: Effect.try({
							try: () =>
								callSync(
									calls,
									failed,
									{
										id: next(),
										scan,
										method: "items",
										positions: [...positions]
									},
									values.items
								),
							catch: (cause) => qualityWorkerFailure("quality.worker.items", cause)
						}),
			limits: (culture) => limits.get(culture ?? "") ?? []
		},
		metadata: {
			...metadata,
			lineOfUnit: (unitId) =>
				callSync(
					calls,
					failed,
					{ id: next(), scan, method: "lineOfUnit", unitId },
					values.lineOfUnit
				),
			...(sourceKeys
				? {
						sourceKeyOfUnit: (
							unitId: Parameters<LocalizationQuality["metadata"]["lineOfUnit"]>[0]
						) =>
							callSync(
								calls,
								failed,
								{ id: next(), scan, method: "sourceKeyOfUnit", unitId },
								values.sourceKeyOfUnit
							)
					}
				: undefined)
		}
	};
}

type Pending = {
	readonly onProgress: (progress: GameTextIndexProgress) => void;
	readonly resolve: (findings: QualityWorkerFindings, timings: Record<string, number>) => void;
	readonly reject: (cause: QualityWorkerFailure) => void;
};

/** What a quality scan reads besides the generation the worker pins. */
export interface QualityWorkerScanRequest {
	readonly corpus: Pick<TextCorpus, "status" | "coverage">;
	readonly rows: Uint32Array;
	readonly options?: IndexedLocalizationQualityOptions | undefined;
	readonly ruleDocument?: GameTextRuleDocument | undefined;
}

/**
 * A worker that runs localization quality scans over one pinned generation, off the host's
 * thread. A scope owns the worker; each scan's findings stay in the worker until the host's
 * result object is collected.
 */
const acquireGameTextQualityWorker = Effect.fn("GameTextIndex.qualityWorker.acquire")(function* (
	input: QualityWorkerInput
) {
	const boundary = yield* Schema.decodeUnknownEffect(QualityWorkerInput)(input).pipe(
		Effect.mapError((cause) => qualityWorkerFailure("quality.worker.input", cause))
	);
	const channel = yield* Effect.acquireRelease(
		Effect.sync(() => new MessageChannel()),
		(channel) =>
			Effect.sync(() => {
				channel.port1.close();
				channel.port2.close();
			})
	);
	const signal = new SharedArrayBuffer(4);
	const calls: SyncCallChannel = { port: channel.port1, signal: new Int32Array(signal) };
	const worker = yield* Effect.acquireRelease(
		Effect.try({
			try: () => launch(boundary, channel.port2, signal),
			catch: (cause) => qualityWorkerFailure("quality.worker.start", cause)
		}),
		(worker) =>
			Effect.promise(async () => {
				calls.port.close();
				await worker.terminate();
			})
	);
	yield* Metric.update(started, 1);
	const pending = new Map<number, Pending>();
	let sequence = 0,
		callSequence = 0;
	let failed: QualityWorkerFailure | undefined;
	let readyResolve: () => void = () => {};
	let readyReject: (cause: QualityWorkerFailure) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const fail = (cause: unknown) => {
		failed = qualityWorkerFailure("quality.worker", cause);
		readyReject(failed);
		for (const scan of pending.values()) scan.reject(failed);
		pending.clear();
	};
	// The worker forgets a scan once the host objects that read it, its findings and its
	// metadata, are both collected; hosts often keep only one of them.
	const holders = new Map<number, number>();
	const released = new FinalizationRegistry<number>((id) => {
		const remaining = (holders.get(id) ?? 1) - 1;
		if (remaining > 0) {
			holders.set(id, remaining);
			return;
		}
		holders.delete(id);
		if (!failed)
			worker.postMessage(Schema.encodeSync(QualityWorkerTask)({ kind: "release", id }));
	});
	worker.on("error", fail);
	worker.on("exit", (code) => fail(new Error(`Game Text quality worker exited (${code}).`)));
	worker.on("message", (raw: typeof QualityWorkerReply.Encoded) => {
		try {
			const reply = Schema.decodeUnknownSync(QualityWorkerReply)(raw);
			if (reply.kind === "ready") return readyResolve();
			if (reply.kind === "failed" && reply.id === undefined) return fail(reply.error);
			if (reply.kind === "cancelled" || reply.id === undefined) return;
			const scan = pending.get(reply.id);
			if (!scan) return;
			if (reply.kind === "progress") {
				scan.onProgress(reply.progress);
				return;
			}
			pending.delete(reply.id);
			if (reply.kind === "done") scan.resolve(reply.findings, reply.timings);
			else scan.reject(reply.error);
		} catch (cause) {
			fail(cause);
		}
	});
	yield* Effect.tryPromise({
		try: () => ready,
		catch: (cause) => qualityWorkerFailure("quality.worker.open", cause)
	}).pipe(
		Effect.timeout("30 seconds"),
		Effect.mapError((cause) => qualityWorkerFailure("quality.worker.open", cause))
	);
	const scan = Effect.fn("GameTextIndex.qualityWorker.scan")(function* (
		request: QualityWorkerScanRequest
	) {
		const id = ++sequence;
		const options = request.options ?? {};
		const onProgress = yield* GameTextIndexProgressReporter;
		const scanned = performance.now();
		const { findings, timings } = yield* Effect.callback<
			{ findings: QualityWorkerFindings; timings: Record<string, number> },
			QualityWorkerFailure
		>((resume) => {
			if (failed) {
				resume(Effect.fail(failed));
				return;
			}
			pending.set(id, {
				onProgress,
				resolve: (findings, timings) => resume(Effect.succeed({ findings, timings })),
				reject: (cause) => resume(Effect.fail(cause))
			});
			try {
				// A copy the worker owns; the query keeps its cached rows.
				const rows = request.rows.slice();
				worker.postMessage(
					Schema.encodeSync(QualityWorkerTask)({
						kind: "scan",
						id,
						corpus: {
							status: request.corpus.status,
							coverage: request.corpus.coverage
						},
						rows,
						options,
						...(request.ruleDocument === undefined
							? undefined
							: { ruleDocument: request.ruleDocument })
					}),
					[rows.buffer]
				);
			} catch (cause) {
				pending.delete(id);
				resume(Effect.fail(qualityWorkerFailure("quality.worker.scan", cause)));
			}
			// Interrupted: the worker stops the scan, and its late replies are ignored.
			return Effect.sync(() => {
				if (!pending.delete(id) || failed) return;
				worker.postMessage(Schema.encodeSync(QualityWorkerTask)({ kind: "cancel", id }));
			});
		});
		yield* Metric.update(scans, 1);
		yield* Effect.annotateCurrentSpan({
			"game_text.quality.worker_scan_ms": performance.now() - scanned,
			"game_text.quality.findings": findings.length,
			// The worker's own spans and stages, which its thread could not trace.
			...Object.fromEntries(
				Object.entries(timings).map(([name, ms]) => [
					name.startsWith("game_text.") ? name : `game_text.quality.worker.${name}`,
					ms
				])
			)
		});
		const quality = hostQuality(
			calls,
			() => failed,
			() => ++callSequence,
			id,
			findings
		);
		holders.set(id, 2);
		released.register(quality.findings, id);
		released.register(quality.metadata, id);
		return quality;
	});
	return { scan, healthy: () => failed === undefined };
});

/** Failed or interrupted readiness closes the candidate; a ready worker belongs to its parent. */
export const makeGameTextQualityWorkerResource = Effect.fn("GameTextIndex.qualityWorker")(
	function* (input: QualityWorkerInput) {
		const candidate = yield* Scope.fork(yield* Scope.Scope);
		return yield* acquireGameTextQualityWorker(input).pipe(
			Effect.provideService(Scope.Scope, candidate),
			Effect.onError(() => Scope.close(candidate, Exit.void))
		);
	}
);
