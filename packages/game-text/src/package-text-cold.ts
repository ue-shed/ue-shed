import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { Effect, Schema } from "effect";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { SharedIndex } from "./shared-index.js";
import { openSnapshotFile, type SnapshotFileReader } from "./snapshot-file.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
import { packageTextSelection, type PackageTextInventoryEntry } from "./package-text-layer.js";
import { type PreparedColdStrings, type ColdLayerSource } from "./shared-string-sort.js";
import { coldMemoryBudget, coldParserReservation, runColdTasks } from "./cold-task-pool.js";
import { PackageTextWorkerReply as Reply } from "./package-text-worker-protocol.js";

function worker() {
	const compiled = new URL("./package-text-worker.js", import.meta.url);
	if (existsSync(compiled)) return new Worker(compiled);
	const source = new URL("./package-text-worker.ts", import.meta.url);
	return new Worker(
		`import("tsx/esm/api").then(async ({ register }) => { register(); await import(${JSON.stringify(source.href)}); });`,
		{ eval: true }
	);
}

export interface ColdPackageTextInput {
	readonly inventory: readonly PackageTextInventoryEntry[];
	readonly recordDirectory: string;
	readonly stagingRoot: string;
	readonly additionalSources?: readonly ColdLayerSource[];
	/** Workers started earlier (see `startPackageTextWorkers`); the import still terminates them. */
	readonly workers?: readonly Worker[];
	/** Explicit prepare-pool budget when another cold pool runs beside this import. */
	readonly memoryBudgetBytes?: number;
	/**
	 * The reader staged the selected packages' records itself (`GameTextIndexSource.stage`):
	 * the files `files[g]` together hold group `g`'s lines, and `groups[g]` names its shards.
	 * Each group is converted by one worker, which also adds the unselected packages.
	 */
	readonly staged?: {
		readonly projectRoot: string;
		readonly groups: readonly (readonly string[])[];
		readonly files: readonly (readonly string[])[];
	};
}

/**
 * Workers for a cold import of `packages` read packages in `shards` non-empty shards. Each worker
 * loads its own module graph, which costs time and memory, so small reads use fewer.
 */
export function packageTextWorkerCount(packages: number, shards: number) {
	return Math.max(
		1,
		Math.min(
			8,
			Math.max(1, availableParallelism() - 1),
			shards,
			Math.ceil(packages / PACKAGES_PER_WORKER)
		)
	);
}
const PACKAGES_PER_WORKER = 400;

/**
 * Starts cold import workers before the records exist, so their module loading overlaps the
 * package read instead of following it.
 */
export const startPackageTextWorkers = (count: number) =>
	Effect.acquireRelease(
		Effect.sync(() => Array.from({ length: count }, () => worker())),
		(workers) => Effect.promise(() => Promise.all(workers.map((item) => item.terminate())))
	);

/** Parallel bounded shard preparation; publishCold performs the one target-wide external sort.
 * Record files contain validated PackageTextStored NDJSON, already grouped by the fixed shard hash.
 */
export const importColdPackageTextLayer = (input: ColdPackageTextInput) =>
	Effect.suspend(() => importColdPackageTextShards(input, packageTextSelection(input.inventory)));

/** Cold import for a refresh that has already selected the same inventory. */
export const importColdPackageTextShards = Effect.fn("PackageText.importCold")(function* (
	input: ColdPackageTextInput,
	inventorySelection: ReturnType<typeof packageTextSelection>
) {
	const store = yield* SharedIndex,
		writer = yield* store.writer();
	const reportProgress = yield* GameTextIndexProgressReporter;
	const selection = inventorySelection.filter((shard) => shard.entries.length);
	// Progress counts packages, so it reads on from the package read before it.
	const total = selection.reduce((sum, shard) => sum + shard.entries.length, 0);
	let completed = 0;
	reportProgress({ phase: "package_text", completed, total });
	// Worker time per shard: busy time near workers x wall time means the pool is CPU bound.
	let busyMs = 0,
		slowestShardMs = 0;
	const prepareStarted = performance.now();
	const prepared = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: async (signal) => {
				await mkdir(input.stagingRoot, { recursive: true });
				const directory = await mkdtemp(join(input.stagingRoot, "package-"));
				const workers: Worker[] = [],
					readers: SnapshotFileReader[] = [];
				const preparedStrings = new Map<string, PreparedColdStrings>();
				const started = input.workers ?? [];
				const workerCount =
					started.length > 0
						? Math.min(started.length, Math.max(1, selection.length))
						: packageTextWorkerCount(
								selection.reduce(
									(sum, shard) =>
										sum +
										shard.entries.filter((entry) => entry.selected).length,
									0
								),
								selection.length
							);
				const byName = new Map(selection.map((shard) => [shard.name, shard]));
				const expected = (shard: (typeof selection)[number]) =>
					shard.entries.map(({ entry, selected }) => ({
						path: entry.path,
						signature: entry.signature,
						selected
					}));
				const prepareStrings = writer.sortsColdStrings !== true;
				const pending = input.staged
					? input.staged.groups.flatMap((names, group) => {
							const shards = names.flatMap((name) => byName.get(name) ?? []);
							return shards.length === 0
								? []
								: [
										{
											shards,
											message: {
												files: [...(input.staged!.files[group] ?? [])],
												projectRoot: input.staged!.projectRoot,
												prepareStrings,
												shards: shards.map((shard) => ({
													name: shard.name,
													output: join(
														directory,
														`${shard.name}.snapshot`
													),
													expected: expected(shard)
												}))
											}
										}
									];
						})
					: selection.map((shard) => ({
							shards: [shard],
							message: {
								input: join(input.recordDirectory, `${shard.name}.ndjson`),
								output: join(directory, `${shard.name}.snapshot`),
								prepareStrings,
								expected: expected(shard)
							}
						}));
				const abort = () => {
					for (const instance of workers) void instance.terminate();
				};
				signal.addEventListener("abort", abort, { once: true });
				try {
					if (signal.aborted) throw new Error("Cold package import cancelled");
					const reservations = await Promise.all(
						pending.map(async (task) => {
							const files =
								"files" in task.message
									? task.message.files
									: [task.message.input];
							let bytes = 0;
							for (const file of files)
								bytes += await stat(file).then(
									(value) => value.size,
									() => 0
								);
							return coldParserReservation(bytes);
						})
					);
					await runColdTasks(
						pending.map((task, row) => ({ row, bytes: reservations[row]! })),
						input.memoryBudgetBytes ?? coldMemoryBudget(process.availableMemory()),
						workerCount,
						async (row, slot) => {
							if (signal.aborted) throw new Error("Cold package import cancelled");
							const instance =
								workers[slot] ?? (workers[slot] = started[slot] ?? worker());
							const current = pending[row]!;
							{
								const shardStarted = performance.now();
								await new Promise<void>((resolve, reject) => {
									const clean = () => {
										instance.off("message", message);
										instance.off("error", error);
										instance.off("exit", exit);
									};
									const message = (input: typeof Reply.Encoded) => {
										clean();
										try {
											const reply = Schema.decodeUnknownSync(Reply)(input);
											if (reply.ok) {
												const strings =
													"shards" in reply
														? reply.shards
														: [
																{
																	name: current.shards[0]!.name,
																	preparedStrings:
																		reply.preparedStrings
																}
															];
												for (const shard of strings)
													if (shard.preparedStrings)
														preparedStrings.set(
															shard.name,
															shard.preparedStrings
														);
												const shardMs = performance.now() - shardStarted;
												busyMs += shardMs;
												slowestShardMs = Math.max(slowestShardMs, shardMs);
												for (const shard of current.shards)
													completed += shard.entries.length;
												reportProgress({
													phase: "package_text",
													completed,
													total
												});
												resolve();
											} else reject(reply.error);
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
										reject(new Error(`Package worker exited (${code})`));
									};
									instance.once("message", message);
									instance.once("error", error);
									instance.once("exit", exit);
									instance.postMessage(current.message);
								});
							}
						}
					);
					await Promise.all(workers.map((instance) => instance.terminate()));
					workers.length = 0;
					// A writer that reads staged files itself needs no readers to describe them.
					if (!writer.publishColdFiles || input.additionalSources?.length)
						for (const shard of selection)
							readers.push(
								await openSnapshotFile(join(directory, `${shard.name}.snapshot`))
							);
					return { directory, readers, workerCount, preparedStrings };
				} catch (cause) {
					await Promise.all(workers.map((instance) => instance.terminate()));
					await Promise.all(readers.map((reader) => reader.close()));
					await rm(directory, { recursive: true, force: true });
					throw cause;
				} finally {
					signal.removeEventListener("abort", abort);
				}
			},
			catch: (cause) =>
				snapshotStoreFailure(
					"package-text.cold",
					cause,
					"Rebuild the derived package layer."
				)
		}),
		(result) =>
			Effect.promise(async () => {
				await Promise.all(result.readers.map((reader) => reader.close()));
				await rm(result.directory, { recursive: true, force: true });
			}),
		{ interruptible: true }
	);
	const prepareMs = performance.now() - prepareStarted;
	yield* Effect.annotateCurrentSpan({
		"package-text.cold.packages": total,
		"package-text.cold.shards": selection.length,
		"package-text.cold.workers": prepared.workerCount,
		"package-text.cold.prepare_ms": Math.round(prepareMs),
		"package-text.cold.stage_ms.prepare": Math.round(prepareMs * 1000) / 1000,
		"package-text.cold.worker_busy_ms": Math.round(busyMs),
		"package-text.cold.slowest_shard_ms": Math.round(slowestShardMs)
	});
	reportProgress({ phase: "package_publish", completed: 0, total: 0 });
	const publishStarted = performance.now();
	const records = yield* prepared.readers.length === 0 && writer.publishColdFiles
		? writer.publishColdFiles(
				selection.map((shard) => ({
					name: shard.name,
					key: shard.key,
					stagedFile: join(prepared.directory, `${shard.name}.snapshot`)
				}))
			)
		: writer.publishCold([
				...(input.additionalSources ?? []),
				...selection.map((shard, row) => ({
					name: shard.name,
					key: shard.key,
					stagedFile: join(prepared.directory, `${shard.name}.snapshot`),
					...(prepared.preparedStrings.has(shard.name)
						? { preparedStrings: prepared.preparedStrings.get(shard.name)! }
						: undefined),
					source: {
						columns: [...prepared.readers[row]!.directory.entries.values()].map(
							(entry) => ({
								...entry,
								load: () => prepared.readers[row]!.load(entry.name)
							})
						)
					}
				}))
			]);
	const publishMs = performance.now() - publishStarted;
	yield* Effect.annotateCurrentSpan({
		"package-text.cold.publish_ms": Math.round(publishMs),
		"package-text.cold.stage_ms.publish": Math.round(publishMs * 1000) / 1000
	});
	return {
		packages: input.inventory.length,
		shards: records.length,
		workerCount: prepared.workerCount,
		layerBytes: records.reduce((sum, record) => sum + record.bytes, 0),
		profile: writer.metrics()
	};
});
