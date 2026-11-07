import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { AssetReader, AssetReaderLive, assetReaderLayer } from "@ue-shed/unreal-assets";
import { openSnapshotFile } from "./snapshot-file.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
import { encodeTextAudience, TEXT_AUDIENCE_POLICY } from "./text-audience.js";
const nativeFailure = (cause) => snapshotStoreFailure("package-text.native", cause, "Rebuild the derived package snapshots with the paired native reader.");
/** The writer's paired executable also owns conversion when no extraction source is involved. */
export class PackageTextReaderConfiguration extends Context.Service()("@ue-shed/game-text/PackageTextReaderConfiguration") {
}
/** Bind conversion to the executable already selected by the enclosing native writer. */
export const packageTextReaderConfigurationLayer = (configuration) => Layer.succeed(PackageTextReaderConfiguration, configuration);
/** Keep every shard in one bounded native request, including its signature inventory. */
export function packageTextSnapshotBatches(shards) {
    const batches = [];
    let batch = [], bytes = 0;
    for (const shard of shards) {
        const size = Buffer.byteLength(JSON.stringify(shard)) +
            shard.expected.reduce((sum, entry) => sum + (entry.selected ? Buffer.byteLength(JSON.stringify(entry.path)) + 8 : 0), 0);
        if (batch.length && bytes + size > 3 * 1024 * 1024) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(shard);
        bytes += size;
    }
    if (batch.length)
        batches.push(batch);
    return batches;
}
export const packageTextAudienceRules = () => TEXT_AUDIENCE_POLICY.map((rule) => ({
    code: encodeTextAudience({ audience: rule.audience, reason: rule.reason, rule: rule.id }),
    when: rule.when
}));
export const preparePackageTextSnapshots = Effect.fn("PackageText.prepareSnapshots")(function* (options) {
    const convert = Effect.gen(function* () {
        const reader = yield* AssetReader, stage = reader.stageProjectTextPackages;
        if (!stage)
            return yield* nativeFailure(new Error("The paired reader cannot prepare package snapshots."));
        yield* stage(options).pipe(Stream.runDrain, Effect.mapError(nativeFailure));
    });
    const configuration = yield* Effect.serviceOption(PackageTextReaderConfiguration);
    if (Option.isSome(configuration))
        return yield* convert.pipe(Effect.provide(assetReaderLayer(configuration.value)));
    const supplied = yield* Effect.serviceOption(AssetReader);
    yield* Option.isSome(supplied)
        ? convert.pipe(Effect.provideService(AssetReader, supplied.value))
        : convert.pipe(Effect.provide(AssetReaderLive));
});
/** Replay retained record files without decoding their authored contents in the host. */
export const prepareRetainedPackageTextSnapshots = Effect.fn("PackageText.prepareRetained")(function* (selection, recordDirectory, stagingRoot) {
    const directory = yield* Effect.acquireRelease(Effect.tryPromise({
        try: async () => {
            await mkdir(stagingRoot, { recursive: true });
            return mkdtemp(join(stagingRoot, "package-snapshots-"));
        },
        catch: nativeFailure
    }), (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
    const shards = selection.filter((shard) => shard.entries.length);
    const shardRequests = shards.map((shard) => ({
        group: Number(shard.name.slice("package-text.".length)),
        expected: shard.entries.map(({ entry, selected }) => ({
            path: entry.path,
            signature: entry.signature,
            selected
        }))
    }));
    for (const batch of packageTextSnapshotBatches(shardRequests))
        yield* preparePackageTextSnapshots({
            projectRoot: directory,
            paths: [],
            staging: {
                directory,
                groups: [],
                snapshots: {
                    rules: packageTextAudienceRules(),
                    recordFiles: batch.map((shard) => join(recordDirectory, `package-text.${shard.group}.ndjson`)),
                    shards: batch
                }
            }
        });
    return new Map(shards.map((shard) => [
        shard.name,
        join(directory, `${Number(shard.name.slice("package-text.".length))}.snapshot`)
    ]));
});
/** Convert explicit retained records with the same reader encoder used by package extraction. */
export const nativePackageTextColumns = Effect.fn("PackageText.nativeColumns")(function* (records) {
    const directory = yield* Effect.acquireRelease(Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "ue-shed-package-columns-")),
        catch: (cause) => nativeFailure(cause)
    }), (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
    const strings = [], files = [];
    let bytes = 0;
    for (const [index, record] of records.entries()) {
        const text = JSON.stringify(record), size = Buffer.byteLength(JSON.stringify(text));
        if (size + bytes > 2 * 1024 * 1024) {
            const file = join(directory, `${index}.record`);
            yield* Effect.tryPromise({
                try: () => writeFile(file, text, { flag: "wx" }),
                catch: (cause) => nativeFailure(cause)
            });
            files.push(file);
        }
        else {
            strings.push(text);
            bytes += size;
        }
    }
    const snapshots = {
        shards: [
            {
                group: 0,
                expected: records.map((record) => ({
                    path: record.path,
                    signature: record.signature,
                    selected: record.evidence.event !== "not_gatherable"
                }))
            }
        ],
        rules: packageTextAudienceRules(),
        records: strings,
        recordFiles: files
    };
    yield* preparePackageTextSnapshots({
        projectRoot: directory,
        paths: [],
        staging: { directory, groups: [], snapshots }
    });
    const reader = yield* Effect.acquireRelease(Effect.tryPromise({
        try: () => openSnapshotFile(join(directory, "0.snapshot")),
        catch: (cause) => nativeFailure(cause)
    }), (file) => Effect.promise(() => file.close()));
    return {
        columns: [...reader.directory.entries.values()].map((entry) => ({
            ...entry,
            load: () => reader.load(entry.name)
        }))
    };
});
