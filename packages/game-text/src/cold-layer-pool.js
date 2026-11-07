import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Schema } from "effect";
import { coldMemoryBudget, runColdTasks } from "./cold-task-pool.js";
import { LayerRecord } from "./shared-index.js";
import { SharedSegment } from "./shared-string-file.js";
import { FileReuse } from "./shared-string-sort.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import { SnapshotStoreError } from "./snapshot-store.js";
export function coldLayerReply() {
    return Schema.Union([
        Schema.Struct({
            ok: Schema.Literal(true),
            record: LayerRecord,
            readBytes: Schema.Finite,
            timings: Schema.Struct({
                collectMs: Schema.Finite,
                reuseMs: Schema.Finite,
                layerEncodeMs: Schema.Finite,
                layerVerifyMs: Schema.Finite,
                garbageMs: Schema.Finite,
                rootPublishMs: Schema.Finite
            })
        }),
        Schema.Struct({
            ok: Schema.Literal(false),
            error: Schema.Union([SnapshotFormatError, SnapshotStoreError])
        })
    ]);
}
export const ColdLayerTask = Schema.Struct({
    directory: Schema.String,
    generation: Schema.String,
    name: Schema.String,
    key: Schema.String,
    stagedFile: Schema.String,
    segments: Schema.Array(SharedSegment),
    maps: Schema.Array(Schema.Struct({ domain: Schema.String, ids: Schema.instanceOf(Uint32Array) })),
    hashes: FileReuse
});
function worker() {
    const compiled = new URL("./cold-layer-worker.js", import.meta.url);
    if (existsSync(compiled))
        return new Worker(compiled);
    const source = new URL("./cold-layer-worker.ts", import.meta.url);
    return new Worker(`import("tsx/esm/api").then(async ({ register }) => { register(); await import(${JSON.stringify(source.href)}); });`, { eval: true });
}
export async function prepareColdLayers(directory, generation, segments, entries, mappings) {
    const tasks = entries.flatMap((entry, row) => entry.stagedFile
        ? [
            {
                row,
                bytes: 384 * 1024 ** 2 +
                    [...mappings[row].maps.values()].reduce((total, ids) => total + ids.byteLength * 4, 0)
            }
        ]
        : []);
    const Reply = coldLayerReply();
    const decodeReply = Schema.decodeSync(Reply);
    const records = new Map();
    if (tasks.length < 2)
        return records;
    const workers = [];
    try {
        const result = await runColdTasks(tasks, coldMemoryBudget(process.availableMemory()), Math.min(8, availableParallelism()), (row, slot) => new Promise((resolve, reject) => {
            const instance = workers[slot] ?? (workers[slot] = worker());
            const clean = () => {
                instance.off("message", message);
                instance.off("error", error);
                instance.off("exit", exit);
            };
            const message = (input) => {
                clean();
                try {
                    const reply = decodeReply(input);
                    if (reply.ok)
                        resolve(reply);
                    else
                        reject(reply.error);
                }
                catch (cause) {
                    reject(cause);
                }
            };
            const error = (cause) => {
                clean();
                reject(cause);
            };
            const exit = (code) => {
                clean();
                reject(new Error(`Cold layer worker exited (${code}).`));
            };
            instance.once("message", message);
            instance.once("error", error);
            instance.once("exit", exit);
            const entry = entries[row], mapping = mappings[row];
            const maps = [...mapping.maps].map(([domain, ids]) => ({
                domain,
                ids: ids.slice()
            }));
            instance.postMessage({
                directory,
                generation,
                segments,
                name: entry.name,
                key: entry.key,
                stagedFile: entry.stagedFile,
                maps,
                hashes: mapping.hashes
            }, maps.map((map) => map.ids.buffer));
        }));
        for (const task of tasks)
            records.set(task.row, result.results[task.row]);
        return records;
    }
    finally {
        await Promise.all(workers.map((instance) => instance.terminate()));
    }
}
