import { snapshotStoreGuidance } from "./snapshot-store.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { LocalizationError, FileProvenance } from "@ue-shed/localization";
import { SharedIndex, sharedIndexDirectory } from "./shared-index.js";
import { SnapshotStoreError } from "./snapshot-store.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import { openSnapshotFile, type SnapshotFileReader } from "./snapshot-file.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { coldMemoryBudget, coldParserReservation, runColdTasks } from "./cold-task-pool.js";
import { PreparedColdStrings } from "./shared-string-sort.js";
import type {
	LocalizationFileImportRequest,
	LocalizationFileSnapshotKey
} from "./localization-import.js";

const FileStages = Schema.Struct({
	readMs: Schema.Number,
	hashMs: Schema.Number,
	decodeMs: Schema.Number,
	parseMs: Schema.Number,
	finishMs: Schema.Number,
	prepareMs: Schema.Number,
	writeMs: Schema.Number,
	cachedLookupMs: Schema.Number
});
const Reply = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		file: Schema.Struct({
			key: Schema.String,
			contentHash: Schema.String,
			provenance: FileProvenance,
			relativePath: Schema.String,
			format: Schema.Literals(["manifest", "archive", "po"]),
			inputBytes: Schema.Number,
			stages: Schema.optionalKey(FileStages),
			totalMs: Schema.optionalKey(Schema.Number)
		}),
		preparedStrings: PreparedColdStrings
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([LocalizationError, SnapshotStoreError, SnapshotFormatError])
	})
]);
function parserWorker() {
	const compiled = new URL("./localization-import-worker.js", import.meta.url);
	if (existsSync(compiled)) return new Worker(compiled);
	const source = new URL("./localization-import-worker.ts", import.meta.url);
	// The repository's source tests use tsx; installed packages start their emitted JS directly.
	return new Worker(
		`import("tsx/esm/api").then(async ({ register }) => { register(); await import(${JSON.stringify(source.href)}); });`,
		{ eval: true }
	);
}
function prepare(worker: Worker, request: LocalizationFileImportRequest, stagedFile: string) {
	return new Promise<Extract<typeof Reply.Type, { ok: true }>>((resolve, reject) => {
		const clean = () => {
			worker.off("message", message);
			worker.off("error", error);
			worker.off("exit", exit);
		};
		const message = (input: typeof Reply.Encoded) => {
			clean();
			try {
				const reply = Schema.decodeUnknownSync(Reply)(input);
				if (reply.ok) resolve(reply);
				else reject(reply.error);
			} catch (cause) {
				reject(cause);
			}
		};
		const error = (cause: Error) => {
			clean();
			reject(cause);
		};
		const exit = (code: number) => {
			clean();
			reject(new Error(`Localization parser exited (${code}).`));
		};
		worker.once("message", message);
		worker.once("error", error);
		worker.once("exit", exit);
		worker.postMessage({ request, stagedFile });
	});
}

/** The target owns the writer lock and parser pool until all staged layers are published. */
export const importColdLocalizationTarget = Effect.fn("LocalizationSnapshot.importColdTarget")(
	function* (requests: readonly LocalizationFileImportRequest[], budgetOverride?: number) {
		const reportProgress = yield* GameTextIndexProgressReporter;
		let completed = 0;
		const report = () =>
			reportProgress({ phase: "localization", completed, total: requests.length });
		report();
		const store = yield* SharedIndex,
			writer = yield* store.writer();
		const result = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: async (signal) => {
					const root = join(requests[0]!.cacheRoot, "localization-import-staging");
					await mkdir(root, { recursive: true });
					const staging = await mkdtemp(join(root, "target-"));
					const workers: Worker[] = [],
						readers: SnapshotFileReader[] = [];
					const abort = () => {
						for (const worker of workers) void worker.terminate();
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						const sizes = await Promise.all(
							requests.map((request) =>
								stat(join(request.projectRoot, request.relativePath))
							)
						);
						const tasks = sizes.map((size, row) => ({
							row,
							bytes: coldParserReservation(size.size)
						}));
						const memoryBudgetBytes =
							budgetOverride ?? coldMemoryBudget(process.availableMemory());
						const started = performance.now();
						if (signal.aborted) throw new Error("Cold target parsing was cancelled.");
						const { results: replies, workerCount } = await runColdTasks(
							tasks,
							memoryBudgetBytes,
							Math.min(8, availableParallelism(), requests.length),
							async (row, slot) => {
								if (signal.aborted)
									throw new Error("Cold target parsing was cancelled.");
								const worker = workers[slot] ?? (workers[slot] = parserWorker());
								const reply = await prepare(
									worker,
									requests[row]!,
									join(staging, `file-${row}.snapshot`)
								);
								completed++;
								report();
								return reply;
							}
						);
						await Promise.all(workers.map((worker) => worker.terminate()));
						workers.length = 0;
						const parseMs = performance.now() - started;
						const readersStarted = performance.now();
						for (let row = 0; row < requests.length; row++)
							readers.push(
								await openSnapshotFile(join(staging, `file-${row}.snapshot`))
							);
						return {
							staging,
							readers,
							replies,
							workerCount,
							memoryBudgetBytes,
							parseMs,
							readersMs: performance.now() - readersStarted
						};
					} catch (cause) {
						await Promise.all(workers.map((worker) => worker.terminate()));
						await Promise.all(readers.map((reader) => reader.close()));
						await rm(staging, { recursive: true, force: true });
						throw cause;
					} finally {
						signal.removeEventListener("abort", abort);
					}
				},
				catch: (cause) =>
					Schema.is(LocalizationError)(cause) ||
					Schema.is(SnapshotFormatError)(cause) ||
					Schema.is(SnapshotStoreError)(cause)
						? cause
						: new SnapshotStoreError({
								retrySafe: snapshotStoreGuidance("unavailable").retrySafe,
								nextStep: snapshotStoreGuidance("unavailable").nextStep,
								operation: "cold.parse",
								code: "unavailable",
								message:
									"The localization import could not parse the target files.",
								cause,
								recovery: "Retry the cold target import."
							})
			}),
			(result) =>
				Effect.promise(async () => {
					await Promise.all(result.readers.map((reader) => reader.close()));
					await rm(result.staging, { recursive: true, force: true });
				}),
			{ interruptible: true }
		);
		const entries = requests.map((request, row) => ({
			name: request.relativePath,
			key: result.replies[row]!.file.key,
			stagedFile: join(result.staging, `file-${row}.snapshot`),
			preparedStrings: result.replies[row]!.preparedStrings,
			source: {
				columns: [...result.readers[row]!.directory.entries.values()].map((entry) => ({
					...entry,
					load: () => result.readers[row]!.load(entry.name)
				}))
			}
		}));
		const publishStarted = performance.now();
		reportProgress({ phase: "localization_publish", completed: 0, total: 0 });
		const records = yield* writer.publishCold(entries);
		const publishMs = performance.now() - publishStarted;
		const metrics = writer.metrics();
		const workerSums: Record<string, number> = {};
		const byFormat: Record<string, { files: number; bytes: number }> = {};
		const slowest: { format: string; bytes: number; ms: number }[] = [];
		for (const reply of result.replies) {
			const format = reply.file.format;
			const entry = (byFormat[format] ??= { files: 0, bytes: 0 });
			entry.files++;
			entry.bytes += reply.file.inputBytes;
			if (reply.file.stages)
				for (const [stage, ms] of Object.entries(reply.file.stages))
					workerSums[stage] = (workerSums[stage] ?? 0) + ms;
			slowest.push({
				format,
				bytes: reply.file.inputBytes,
				ms: reply.file.totalMs ?? 0
			});
		}
		slowest.sort((a, b) => b.ms - a.ms);
		yield* Effect.annotateCurrentSpan({
			"localization.import.workerCount": result.workerCount,
			"localization.import.memoryBudgetBytes": result.memoryBudgetBytes,
			"localization.import.parseMs": result.parseMs,
			"localization.import.stage_ms.parse": Math.round(result.parseMs * 1000) / 1000,
			"localization.import.stage_ms.readers": Math.round(result.readersMs * 1000) / 1000,
			"localization.import.stage_ms.publish": Math.round(publishMs * 1000) / 1000,
			...Object.fromEntries(
				Object.entries(workerSums).map(([stage, ms]) => [
					`localization.import.stage_ms.worker_${stage}`,
					Math.round(ms * 1000) / 1000
				])
			),
			...Object.fromEntries(
				Object.entries(byFormat).flatMap(([format, entry]) => [
					[`localization.import.files.${format}`, entry.files],
					[`localization.import.bytes.${format}`, entry.bytes]
				])
			),
			...Object.fromEntries(
				slowest.slice(0, 3).flatMap((file, index) => [
					[`localization.import.slowest${index + 1}.${file.format}.bytes`, file.bytes],
					[
						`localization.import.slowest${index + 1}.${file.format}.ms`,
						Math.round(file.ms * 1000) / 1000
					]
				])
			),
			"localization.import.probePasses": metrics.probePasses,
			"localization.import.segments": metrics.segments
		});
		const files: LocalizationFileSnapshotKey[] = result.replies.map((reply, row) => ({
			...reply.file,
			parsed: true,
			statHit: false,
			readBytes: reply.file.inputBytes,
			snapshotBytes: records[row]!.bytes,
			directory: sharedIndexDirectory({
				cacheRoot: requests[row]!.cacheRoot,
				projectKey: requests[row]!.projectRoot,
				targetKey: requests[row]!.sharedTargetKey ?? "localization"
			}),
			sharedBytesAppended: row ? 0 : metrics.appendedBytes,
			sharedReadBytes: row ? 0 : metrics.readBytes,
			sharedIndexReadBytes: row ? 0 : metrics.indexReadBytes,
			lookupStrings: 0,
			reusedStrings: 0,
			probePasses: 0,
			profile: {
				sortMs: metrics.sortMs,
				probeMs: 0,
				appendMs: metrics.appendMs,
				segments: metrics.segments
			}
		}));
		return {
			files,
			profile: {
				workerCount: result.workerCount,
				memoryBudgetBytes: result.memoryBudgetBytes,
				parseMs: result.parseMs,
				publishMs,
				...metrics
			}
		};
	}
);
