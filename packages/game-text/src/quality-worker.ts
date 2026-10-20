import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { Effect, Exit, Fiber, Schema, Tracer } from "effect";
import { LocalizationFileAccessLive } from "@ue-shed/localization";
import { sharedIndexNodeLayer } from "./shared-index.js";
import { openJoinedTarget } from "./joined-target-reader.js";
import { snapshotCheck } from "./snapshot-format.js";
import { readIndexedLocalizationEvidence } from "./index-context.js";
import { indexedLocalizationQuality } from "./localization-quality-index.js";
import type { LocalizationQuality } from "./localization-workspace.js";
import { withHostSlices } from "./host-slices.js";
import { postSyncReply } from "./worker-calls.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import {
	QualityWorkerCall,
	QualityWorkerCallReply,
	QualityWorkerFailure,
	QualityWorkerFindings,
	QualityWorkerInput,
	QualityWorkerReply,
	QualityWorkerTask,
	qualityWorkerCallValues,
	qualityWorkerFailure
} from "./quality-worker-protocol.js";

if (!parentPort) throw new Error("Game Text quality scans require their owning worker adapter.");
const port = parentPort;
const WorkerData = Schema.Struct({
	input: QualityWorkerInput,
	calls: Schema.instanceOf(MessagePort),
	signal: Schema.instanceOf(SharedArrayBuffer)
});

/** Posts a reply, moving its position arrays to the host instead of copying them. */
function reply(value: QualityWorkerReply) {
	const encoded = Schema.encodeSync(QualityWorkerReply)(value);
	const transfer =
		value.kind === "done"
			? [
					value.findings.groupOf.buffer,
					...value.findings.groups.map((group) => group.positions.buffer)
				]
			: [];
	port.postMessage(encoded, transfer);
}

/** The host's copy of a finished scan: its groups, each position's group and its limits. */
function hostFindings(quality: LocalizationQuality): QualityWorkerFindings {
	const { findings, metadata } = quality;
	const groups = findings.groups ?? [];
	const groupOf = new Uint32Array(findings.length);
	groups.forEach((group, index) => {
		for (const position of group.positions) groupOf[position] = index;
	});
	return {
		length: findings.length,
		// Copies, so moving them to the host leaves the worker's own findings intact.
		groups: groups.map((group) => ({ ...group, positions: group.positions.slice() })),
		groupOf,
		limits: [
			{ culture: "", counts: findings.limits(undefined) },
			...metadata.join.cultures.map((culture) => ({
				culture,
				counts: findings.limits(culture)
			}))
		],
		metadata: {
			join: metadata.join,
			rules: metadata.rules,
			unsupportedRuleCultures: metadata.unsupportedRuleCultures,
			...(metadata.customChecks ? { customChecks: metadata.customChecks } : undefined),
			status: metadata.status,
			coverage: metadata.coverage,
			sourceKeys: metadata.sourceKeyOfUnit !== undefined
		}
	};
}

/**
 * Where a scan's time goes, for the host's trace: each span's total milliseconds by name
 * (`span_ms.<name>`), and the numeric `game_text.*` attributes the scan annotates, such as its
 * stage timings. The worker has no tracer of the host's, so it records them itself.
 */
function scanTimings() {
	const timings: Record<string, number> = {};
	const isNumber = Schema.is(Schema.Number);
	const round = (ms: number) => Math.round(ms * 10) / 10;
	class Timed extends Tracer.NativeSpan {
		override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
			super.end(endTime, exit);
			const key = `span_ms.${this.name}`;
			timings[key] = round((timings[key] ?? 0) + Number(endTime - this.startTime) / 1e6);
			for (const [name, value] of this.attributes)
				if (name.startsWith("game_text.") && isNumber(value)) timings[name] = value;
		}
	}
	return { tracer: Tracer.make({ span: (options) => new Timed(options) }), timings };
}

/** Reads one finished scan for a synchronous call. */
function callValue(scans: ReadonlyMap<number, LocalizationQuality>, call: QualityWorkerCall) {
	const quality = scans.get(call.scan);
	snapshotCheck(quality !== undefined, "quality.worker", "The quality scan was released");
	const values = qualityWorkerCallValues;
	switch (call.method) {
		case "items":
			return Schema.encodeSync(values.items)(quality.findings.items(call.positions));
		case "find":
			return Schema.encodeSync(values.find)(
				quality.findings.find(call.findingId, call.culture)
			);
		case "lineOfUnit":
			return Schema.encodeSync(values.lineOfUnit)(quality.metadata.lineOfUnit(call.unitId));
		case "sourceKeyOfUnit":
			return Schema.encodeSync(values.sourceKeyOfUnit)(
				quality.metadata.sourceKeyOfUnit?.(call.unitId)
			);
	}
}

// This worker is a Node runtime boundary. Its scope pins the generation until shutdown.
void Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const data = yield* Schema.decodeUnknownEffect(WorkerData)(workerData);
			const input = data.input;
			const joined = yield* openJoinedTarget().pipe(
				Effect.provide(sharedIndexNodeLayer(input.configuration))
			);
			snapshotCheck(
				joined.reader.manifest.generation === input.generation &&
					joined.reader.manifest.active.joined === input.joinedKey,
				"quality.worker",
				"The quality generation changed before its worker opened it"
			);
			snapshotCheck(data.signal.byteLength === 4, "quality.worker", "Invalid call flag");
			const evidence = yield* readIndexedLocalizationEvidence(joined).pipe(
				Effect.provide(LocalizationFileAccessLive)
			);
			const signal = new Int32Array(data.signal);
			const scans = new Map<number, LocalizationQuality>();
			const running = new Map<number, Fiber.Fiber<void>>();
			const scan = (task: Extract<QualityWorkerTask, { kind: "scan" }>) => {
				const recorded = scanTimings();
				return indexedLocalizationQuality(
					joined,
					task.corpus,
					evidence,
					task.rows,
					task.ruleDocument,
					task.options
				).pipe(
					// The scan's progress goes to the host, which hands it to its own reporter.
					Effect.provideService(GameTextIndexProgressReporter, (progress) =>
						reply({ kind: "progress", id: task.id, progress })
					),
					Effect.withTracer(recorded.tracer),
					Effect.map((quality) => {
						scans.set(task.id, quality);
						reply({
							kind: "done",
							id: task.id,
							findings: hostFindings(quality),
							timings: recorded.timings
						});
					}),
					Effect.catchCause((cause) =>
						Effect.sync(() =>
							reply({
								kind: "failed",
								id: task.id,
								error: qualityWorkerFailure("quality.worker.scan", cause)
							})
						)
					),
					// Slices let the worker answer calls and cancellations during a long scan.
					withHostSlices
				);
			};
			yield* Effect.callback<void>((resume) => {
				const message = (raw: typeof QualityWorkerTask.Encoded) => {
					const decoded = Schema.decodeUnknownExit(QualityWorkerTask)(raw);
					if (Exit.isFailure(decoded)) {
						reply({
							kind: "failed",
							error: qualityWorkerFailure("quality.worker.task", decoded.cause)
						});
						return;
					}
					const task = decoded.value;
					if (task.kind === "scan") {
						const fiber = Effect.runFork(scan(task));
						running.set(task.id, fiber);
						fiber.addObserver(() => running.delete(task.id));
					} else if (task.kind === "cancel") {
						const fiber = running.get(task.id);
						// Completion can win before cancellation, or while interruption settles.
						// Always forget the result after the running fiber can no longer publish it.
						const forget = Effect.sync(() => {
							scans.delete(task.id);
							reply({ kind: "cancelled", id: task.id });
						});
						Effect.runFork(
							fiber ? Fiber.interrupt(fiber).pipe(Effect.andThen(forget)) : forget
						);
					} else scans.delete(task.id);
				};
				const call = (raw: typeof QualityWorkerCall.Encoded) => {
					let response: typeof QualityWorkerCallReply.Encoded;
					let id = 0;
					try {
						const decoded = Schema.decodeUnknownSync(QualityWorkerCall)(raw);
						id = decoded.id;
						response = { kind: "value", id, value: callValue(scans, decoded) };
					} catch (cause) {
						response = {
							kind: "failed",
							id,
							error: Schema.encodeSync(QualityWorkerFailure)(
								qualityWorkerFailure("quality.worker.call", cause)
							)
						};
					}
					postSyncReply(data.calls, signal, response);
				};
				const close = () => resume(Effect.void);
				port.on("message", message);
				port.once("close", close);
				data.calls.on("message", call);
				reply({ kind: "ready" });
				return Effect.sync(() => {
					port.off("message", message);
					port.off("close", close);
					data.calls.off("message", call);
					data.calls.close();
				});
			});
		})
	)
).catch((cause) =>
	reply({ kind: "failed", error: qualityWorkerFailure("quality.worker.open", cause) })
);
