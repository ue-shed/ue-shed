import { Effect } from "effect";
import { SharedIndex } from "./shared-index.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { openSnapshotFile } from "./snapshot-file.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
import { packageTextSelection } from "./package-text-layer.js";
import { prepareRetainedPackageTextSnapshots } from "./package-text-native.js";
export const importColdPackageTextLayer = Effect.fn("PackageText.importColdLayer")(function* (input) {
    const selection = packageTextSelection(input.inventory);
    const snapshots = input.snapshots !== undefined
        ? input.snapshots
        : yield* prepareRetainedPackageTextSnapshots(selection, input.recordDirectory, input.stagingRoot);
    return yield* importColdPackageTextShards({
        snapshots,
        ...(input.additionalSources
            ? { additionalSources: input.additionalSources }
            : undefined)
    }, selection.map((shard) => ({
        name: shard.name,
        key: shard.key,
        packages: shard.entries.length
    })), input.inventory.length);
});
/** Publish the reader's completed shard files in one atomic cold publication. */
export const importColdPackageTextShards = Effect.fn("PackageText.importCold")(function* (input, shards, packages) {
    const writer = yield* (yield* SharedIndex).writer;
    const report = yield* GameTextIndexProgressReporter;
    const selection = shards.filter((shard) => shard.packages);
    const total = selection.reduce((sum, shard) => sum + shard.packages, 0);
    const snapshots = input.snapshots;
    report({ phase: "package_text", completed: 0, total });
    const entries = selection.map((shard) => {
        const stagedFile = snapshots.get(shard.name);
        if (!stagedFile)
            throw snapshotStoreFailure("package-text.cold", new Error("Reader omitted a package snapshot."), "Rebuild the derived package snapshots.");
        return { name: shard.name, key: shard.key, stagedFile };
    });
    report({ phase: "package_text", completed: total, total });
    yield* Effect.annotateCurrentSpan({
        "package-text.cold.packages": total,
        "package-text.cold.shards": selection.length,
        "package-text.cold.workers": 0,
        "package-text.cold.stage_ms.prepare": 0
    });
    report({ phase: "package_publish", completed: 0, total: 0 });
    const started = performance.now();
    const removed = input.removed?.length ? input.removed : undefined;
    const published = yield* writer.publishColdFiles && !input.additionalSources?.length
        ? writer.publishColdFiles(entries, removed)
        : Effect.gen(function* () {
            const sources = [...(input.additionalSources ?? [])];
            for (const entry of entries) {
                const file = yield* Effect.acquireRelease(Effect.tryPromise({
                    try: () => openSnapshotFile(entry.stagedFile),
                    catch: (cause) => snapshotStoreFailure("package-text.cold", cause, "Rebuild the derived package snapshots.")
                }), (reader) => Effect.promise(() => reader.close()));
                sources.push({
                    ...entry,
                    source: {
                        columns: [...file.directory.entries.values()].map((column) => ({
                            ...column,
                            load: () => file.load(column.name)
                        }))
                    }
                });
            }
            return yield* writer.publishCold(sources, removed);
        });
    yield* Effect.annotateCurrentSpan({
        "package-text.cold.stage_ms.publish": performance.now() - started
    });
    return {
        packages,
        shards: published.length,
        workerCount: 0,
        layerBytes: published.reduce((sum, record) => sum + record.bytes, 0),
        profile: writer.metrics()
    };
});
