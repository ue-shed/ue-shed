import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { LocalizationError } from "@ue-shed/localization";
import { SharedIndex, sharedIndexDirectory } from "./shared-index.js";
import { SnapshotStoreError } from "./snapshot-store.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import { openSnapshotFile, type SnapshotFileReader } from "./snapshot-file.js";
import type {
	LocalizationFileImportRequest,
	LocalizationFileSnapshotKey
} from "./localization-import.js";

const Reply = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		file: Schema.Struct({
			key: Schema.String,
			contentHash: Schema.String,
			relativePath: Schema.String,
			format: Schema.Literals(["manifest", "archive", "po"]),
			inputBytes: Schema.Number
		}),
		rss: Schema.Number
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([LocalizationError, SnapshotStoreError, SnapshotFormatError])
	})
]);
function parserWorker() {
	const compiled = new URL("./localization-import-worker.js", import.meta.url);
	if (existsSync(compiled))
		return new Worker(compiled, { resourceLimits: { maxOldGenerationSizeMb: 16384 } });
	const source = new URL("./localization-import-worker.ts", import.meta.url);
	// The repository's source tests use tsx; installed packages start their emitted JS directly.
	return new Worker(
		`import("tsx/esm/api").then(async ({ register }) => { register(); await import(${JSON.stringify(source.href)}); });`,
		{ eval: true, resourceLimits: { maxOldGenerationSizeMb: 16384 } }
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
	function* (requests: readonly LocalizationFileImportRequest[]) {
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
						const order = sizes
							.map((size, row) => ({ row, bytes: size.size }))
							.sort((a, b) => b.bytes - a.bytes);
						const replies: Extract<typeof Reply.Type, { ok: true }>[] = [];
						const started = performance.now(),
							baselineRss = process.memoryUsage().rss;
						if (signal.aborted) throw new Error("Cold target parsing was cancelled.");
						const first = parserWorker();
						workers.push(first);
						const largest = order.shift()!.row;
						replies[largest] = await prepare(
							first,
							requests[largest]!,
							join(staging, `file-${largest}.snapshot`)
						);
						const measuredWorkerRss = Math.max(1, replies[largest]!.rss - baselineRss);
						// Reserve 4 GB for the coordinator/sort, round each worker up to at least 2 GB.
						const workerBudget = Math.max(2_000_000_000, measuredWorkerRss * 1.5);
						const workerCount = Math.max(
							1,
							Math.min(
								8,
								availableParallelism(),
								requests.length,
								Math.floor(16_000_000_000 / workerBudget)
							)
						);
						while (workers.length < workerCount) workers.push(parserWorker());
						await Promise.all(
							workers.map(async (worker) => {
								for (let task = order.shift(); task; task = order.shift())
									replies[task.row] = await prepare(
										worker,
										requests[task.row]!,
										join(staging, `file-${task.row}.snapshot`)
									);
							})
						);
						await Promise.all(workers.map((worker) => worker.terminate()));
						workers.length = 0;
						const parseMs = performance.now() - started;
						for (let row = 0; row < requests.length; row++)
							readers.push(
								await openSnapshotFile(join(staging, `file-${row}.snapshot`))
							);
						return {
							staging,
							readers,
							replies,
							workerCount,
							measuredWorkerRss,
							parseMs
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
					cause instanceof LocalizationError ||
					cause instanceof SnapshotFormatError ||
					cause instanceof SnapshotStoreError
						? cause
						: new SnapshotStoreError({
								operation: "cold.parse",
								code: "unavailable",
								message: String(cause),
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
			source: {
				columns: [...result.readers[row]!.directory.entries.values()].map((entry) => ({
					...entry,
					load: () => result.readers[row]!.load(entry.name)
				}))
			}
		}));
		const publishStarted = performance.now();
		const records = yield* writer.publishCold(entries);
		const metrics = writer.metrics();
		yield* Effect.annotateCurrentSpan({
			"localization.import.workerCount": result.workerCount,
			"localization.import.measuredWorkerRss": result.measuredWorkerRss,
			"localization.import.parseMs": result.parseMs,
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
				measuredWorkerRss: result.measuredWorkerRss,
				parseMs: result.parseMs,
				publishMs: performance.now() - publishStarted,
				...metrics
			}
		};
	}
);
