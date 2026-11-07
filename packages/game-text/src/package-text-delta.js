import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { snapshotFailure } from "./snapshot-format.js";
import { packageTextAudienceRules, packageTextSnapshotBatches, preparePackageTextSnapshots } from "./package-text-native.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
/** One shard's entries in a plan file, as the writer's planner and comparison write them. */
export const PackageTextPlanLine = Schema.fromJsonString(Schema.Struct({
    group: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    expected: Schema.Array(Schema.Struct({
        path: Schema.String,
        signature: Schema.String,
        selected: Schema.Boolean
    }))
}));
const decodePlanLine = Schema.decodeEffect(PackageTextPlanLine);
const stagingFailure = (cause) => snapshotFailure("package-text.stage", "The package text staging operation failed.", cause);
const group = (name) => Number(name.slice("package-text.".length));
/** A plan file's shards: paths, signatures and selection only, never package records. */
const readPlanLines = Effect.fnUntraced(function* (file) {
    const text = yield* Effect.tryPromise({
        try: () => readFile(file, "utf8"),
        catch: stagingFailure
    });
    const shards = [];
    for (const line of text.split("\n"))
        if (line)
            shards.push(yield* decodePlanLine(line).pipe(Effect.mapError((cause) => snapshotFailure("package-text.compare", "Invalid package comparison.", cause))));
    return shards;
});
/**
 * Compares the changed shards with the index in the native writer, which writes each shard's
 * rows and changed entries to a scoped directory. The writer's plan file is compared as it is;
 * a plan made here is written out first.
 */
export const comparePackageText = Effect.fn("PackageText.compare")(function* (plan, context) {
    const directory = yield* Effect.acquireRelease(Effect.tryPromise({
        try: async () => {
            await mkdir(context.stagingRoot, { recursive: true });
            return mkdtemp(join(context.stagingRoot, "package-delta-"));
        },
        catch: stagingFailure
    }), (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
    let planFile = plan.file;
    if (planFile === undefined) {
        const shards = yield* plan.entries;
        const file = join(directory, "plan.ndjson");
        yield* Effect.tryPromise({
            try: async () => {
                const handle = await open(file, "wx");
                try {
                    for (const shard of shards)
                        await handle.write(`${JSON.stringify({
                            group: group(shard.name),
                            expected: shard.entries.map(({ entry, selected }) => ({
                                path: entry.path,
                                signature: entry.signature,
                                selected
                            }))
                        })}\n`);
                }
                finally {
                    await handle.close();
                }
            },
            catch: stagingFailure
        });
        planFile = file;
    }
    const comparison = yield* context.compare({
        format: context.format,
        policyJson: context.policyJson,
        planFile,
        groups: plan.changed.map((shard) => group(shard.name)),
        outputDirectory: join(directory, "compared")
    });
    return { shards: comparison.shards, directory };
});
/** Decoded records held before the spool writes them out; a larger record is written alone. */
const SPOOL_BUFFER_CHARACTERS = 4 * 1024 * 1024;
/**
 * Reads packages and appends each record to its shard's file in `directory` as it arrives, so
 * the host holds at most one buffer of decoded evidence however many packages change. Fails on a
 * package that wasn't requested, a duplicate or an omission. Returns each shard's record file.
 */
export const spoolPackageReads = Effect.fn("PackageText.spoolReads")(function* (read, requests, directory, onRead) {
    const files = new Map();
    const pending = new Map();
    const received = new Set();
    let buffered = 0;
    const flush = Effect.tryPromise({
        try: async () => {
            for (const [group, lines] of pending) {
                let file = files.get(group);
                if (file === undefined) {
                    file = join(directory, `${group}.ndjson`);
                    files.set(group, file);
                }
                await appendFile(file, lines.join(""));
            }
            pending.clear();
            buffered = 0;
        },
        catch: stagingFailure
    });
    yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true }),
        catch: stagingFailure
    });
    if (requests.size)
        yield* read([...requests.keys()], new Map([...requests].map(([path, { signature }]) => [path, signature]))).pipe(Stream.runForEach(Effect.fnUntraced(function* (event) {
            if (event.event === "text_summary")
                return;
            const request = requests.get(event.path);
            if (request === undefined || received.has(event.path))
                return yield* snapshotFailure("package-text.read", "Unexpected or duplicate package");
            received.add(event.path);
            const line = `${JSON.stringify({
                path: event.path,
                signature: request.signature,
                evidence: event
            })}\n`;
            const lines = pending.get(request.group);
            if (lines)
                lines.push(line);
            else
                pending.set(request.group, [line]);
            buffered += line.length;
            if (buffered >= SPOOL_BUFFER_CHARACTERS)
                yield* flush;
            onRead(event.path);
        })));
    yield* flush;
    if (received.size !== requests.size)
        return yield* snapshotFailure("package-text.read", "Reader omitted requested packages");
    const spooled = files;
    return spooled;
});
/**
 * Converts spooled records into one snapshot per shard with the paired reader, in batches that
 * bound each request. Entries that weren't read are written from the inventory alone, so a shard
 * without a record file gets the snapshot of its unread entries, or an empty one.
 */
export const convertSpooledPackageText = Effect.fn("PackageText.convertSpooled")(function* (shards, files, directory) {
    const snapshots = new Map();
    const batches = packageTextSnapshotBatches(shards);
    yield* Effect.annotateCurrentSpan({ "package-text.convert.batches": batches.length });
    for (const [index, batch] of batches.entries()) {
        const batchDirectory = join(directory, `batch-${index}`);
        const recordFiles = batch.flatMap((shard) => files.get(shard.group) ?? []);
        yield* Effect.tryPromise({
            try: async () => {
                await mkdir(batchDirectory, { recursive: true });
                // The reader converts record files; a batch with no reads replays an empty one.
                if (!recordFiles.length) {
                    const empty = join(batchDirectory, "empty.ndjson");
                    await writeFile(empty, "", { flag: "wx" });
                    recordFiles.push(empty);
                }
            },
            catch: stagingFailure
        });
        yield* preparePackageTextSnapshots({
            projectRoot: batchDirectory,
            paths: [],
            staging: {
                directory: batchDirectory,
                groups: [],
                snapshots: {
                    rules: packageTextAudienceRules(),
                    shards: batch,
                    records: [],
                    recordFiles
                }
            }
        });
        for (const shard of batch)
            snapshots.set(shard.group, join(batchDirectory, `${shard.group}.snapshot`));
    }
    const converted = snapshots;
    return converted;
});
/**
 * The reader reads the selected packages of a plan file's shards and writes each shard's
 * snapshot itself, so no package record crosses into the host. Fails on a duplicate package or
 * when fewer than `selected` packages were staged. Returns each shard's snapshot.
 */
export const stagePlannedPackageText = Effect.fn("PackageText.stagePlanned")(function* (stage, plan, directory, onRead) {
    const received = new Set();
    yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true }),
        catch: stagingFailure
    });
    if (plan.groups.length)
        yield* stage
            .read([], directory, [], {
            rules: packageTextAudienceRules(),
            shards: [],
            planFile: plan.file,
            groups: [...plan.groups]
        })
            .pipe(Stream.runForEach(Effect.fnUntraced(function* (event) {
            if (received.has(event.path))
                return yield* snapshotFailure("package-text.read", "Unexpected or duplicate package");
            received.add(event.path);
            onRead(event.path);
        })));
    if (received.size !== plan.selected)
        return yield* snapshotFailure("package-text.read", "Reader omitted requested packages");
    const staged = new Map(plan.groups.map((group) => [group, join(directory, `${group}.snapshot`)]));
    return staged;
});
/**
 * Refreshes changed shards of an existing index in place: only changed packages are read and
 * converted, and the native writer keeps every unchanged record and its dictionary IDs. All
 * changed shards and removals publish in one root publication, however many shards changed.
 */
export const replacePackageTextRecords = Effect.fn("PackageText.replaceRecords")(function* (input, plan, comparison, context) {
    const { writer, replace, stages } = context;
    const report = yield* GameTextIndexProgressReporter;
    const compared = join(comparison.directory, "compared");
    const changedFile = join(compared, "changed.ndjson");
    const unchanged = plan.packages - comparison.shards.reduce((sum, shard) => sum + shard.changed, 0);
    const total = comparison.shards.reduce((sum, shard) => sum + shard.selected, 0);
    stages.mark("compare");
    let completed = 0;
    const onRead = () => report({ phase: "package_read", completed: ++completed, total, unchanged });
    report({ phase: "package_read", completed, total, unchanged });
    const snapshots = new Map();
    // A shard whose key changed only by removals has no changed entries: an empty snapshot.
    const emptied = comparison.shards
        .filter((shard) => !shard.changed)
        .map((shard) => ({ group: shard.group, expected: [] }));
    if (input.stage) {
        // The changed entries are a plan file, so the reader stages them as a cold build stages
        // its plan, and no package record crosses into the host.
        const staged = yield* stagePlannedPackageText(input.stage, {
            file: changedFile,
            groups: comparison.shards
                .filter((shard) => shard.changed)
                .map((shard) => shard.group),
            selected: total
        }, join(comparison.directory, "staged"), onRead);
        for (const [group, file] of staged)
            snapshots.set(group, file);
        stages.mark("read");
        report({ phase: "package_update", completed: 0, total: 0 });
    }
    else {
        // Without staging, records are spooled to files as they arrive and converted from those.
        const shards = yield* readPlanLines(changedFile);
        const requests = new Map();
        for (const shard of shards)
            for (const entry of shard.expected)
                if (entry.selected)
                    requests.set(entry.path, { signature: entry.signature, group: shard.group });
        const files = yield* spoolPackageReads(input.read, requests, join(comparison.directory, "records"), onRead);
        stages.mark("read");
        report({ phase: "package_update", completed: 0, total: 0 });
        emptied.push(...shards);
        const converted = yield* convertSpooledPackageText(emptied.splice(0), files, join(comparison.directory, "converted"));
        for (const [group, file] of converted)
            snapshots.set(group, file);
    }
    if (emptied.length) {
        const empty = yield* convertSpooledPackageText(emptied, new Map(), join(comparison.directory, "empty"));
        for (const [group, file] of empty)
            snapshots.set(group, file);
    }
    stages.mark("convert");
    if (input.publishGate) {
        yield* input.publishGate;
        stages.restart();
    }
    const keys = new Map(plan.changed.map((shard) => [group(shard.name), shard.key]));
    yield* replace(comparison.shards.map((shard) => ({
        name: `package-text.${shard.group}`,
        key: keys.get(shard.group),
        ...(shard.previousKey === undefined ? undefined : { previousKey: shard.previousKey }),
        stagedFile: snapshots.get(shard.group),
        rowsFile: join(compared, `${shard.group}.rows`)
    })), plan.removed);
    stages.mark("publish");
    yield* Effect.annotateCurrentSpan({
        "package-text.unchangedPackages": unchanged,
        "package-text.convertedPackages": comparison.shards.reduce((sum, shard) => sum + shard.changed, 0)
    });
    return {
        readPackages: total,
        reusedPackages: plan.packages - total,
        changedShards: comparison.shards.length,
        removedShards: plan.removed.length,
        published: true,
        profile: writer.metrics()
    };
});
