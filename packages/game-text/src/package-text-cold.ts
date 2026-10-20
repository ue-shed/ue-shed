import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
}

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
	const prepared = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: async (signal) => {
				await mkdir(input.stagingRoot, { recursive: true });
				const directory = await mkdtemp(join(input.stagingRoot, "package-"));
				const workers: Worker[] = [],
					readers: SnapshotFileReader[] = [];
				const preparedStrings = new Map<string, PreparedColdStrings>();
				const workerCount = Math.min(
					8,
					availableParallelism(),
					Math.max(1, selection.length)
				);
				const pending = [...selection];
				const abort = () => {
					for (const instance of workers) void instance.terminate();
				};
				signal.addEventListener("abort", abort, { once: true });
				try {
					if (signal.aborted) throw new Error("Cold package import cancelled");
					await Promise.all(
						Array.from({ length: workerCount }, async () => {
							const instance = worker();
							workers.push(instance);
							for (let shard = pending.shift(); shard; shard = pending.shift()) {
								const current = shard;
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
												preparedStrings.set(
													current.name,
													reply.preparedStrings
												);
												completed += current.entries.length;
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
									instance.postMessage({
										input: join(
											input.recordDirectory,
											`${current.name}.ndjson`
										),
										output: join(directory, `${current.name}.snapshot`),
										expected: current.entries.map(({ entry, selected }) => ({
											path: entry.path,
											signature: entry.signature,
											selected
										}))
									});
								});
							}
						})
					);
					await Promise.all(workers.map((instance) => instance.terminate()));
					workers.length = 0;
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
	reportProgress({ phase: "package_publish", completed: 0, total: 0 });
	const records = yield* writer.publishCold([
		...(input.additionalSources ?? []),
		...selection.map((shard, row) => ({
			name: shard.name,
			key: shard.key,
			stagedFile: join(prepared.directory, `${shard.name}.snapshot`),
			preparedStrings: prepared.preparedStrings.get(shard.name)!,
			source: {
				columns: [...prepared.readers[row]!.directory.entries.values()].map((entry) => ({
					...entry,
					load: () => prepared.readers[row]!.load(entry.name)
				}))
			}
		}))
	]);
	return {
		packages: input.inventory.length,
		shards: records.length,
		workerCount: prepared.workerCount,
		layerBytes: records.reduce((sum, record) => sum + record.bytes, 0),
		profile: writer.metrics()
	};
});
