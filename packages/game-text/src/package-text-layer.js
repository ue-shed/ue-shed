import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { Effect, Option, Schema, Stream } from "effect";
import { ProjectIndexHeader, SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import { SharedIndex } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import { isPackageTextCandidate, textCorpusWithExcludedPackages } from "./package-text-candidates.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { comparePackageTextPathBytes } from "./package-text-order.js";
import { encodeWtf8 } from "./wtf8.js";
import { LocalizationImportSession } from "./localization-import-session.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { writeSnapshotFile, openSnapshotFile } from "./snapshot-file.js";
import { importColdPackageTextShards } from "./package-text-cold.js";
import { nativePackageTextColumns, packageTextAudienceRules } from "./package-text-native.js";
import { SAVED_TEXT_AUDIENCE_POLICY_KEY } from "./text-audience.js";
import { HostSliceClock, sortRowsInSlices } from "./host-slices.js";
import { StageClock } from "./stage-clock.js";
import { comparePackageText, convertSpooledPackageText, PackageTextPlanLine, replacePackageTextRecords, spoolPackageReads, stagePlannedPackageText } from "./package-text-delta.js";
const decodePackageTextPlanLine = Schema.decodeEffect(PackageTextPlanLine);
/** The caller supplies the Project Index's opaque package-and-sidecar signature, never a layer hash.
 * Header evidence and signatures must come from the same complete inventory generation.
 */
export const PackageTextInventoryEntry = Schema.Struct({
    path: Schema.String,
    signature: Schema.String,
    headerData: ProjectIndexHeader.fields.headerData
});
/**
 * Bump when package text columns or extraction change; older shards are read again instead of
 * decoded. The audience policy table and matcher version are part of every shard key, so a policy
 * or matcher change re-encodes each shard from its stored evidence without reading packages again.
 */
export const PACKAGE_TEXT_FORMAT = "package-text-v10";
export const PACKAGE_TEXT_SHARDS = 256;
export function packageTextShard(path) {
    let hash = 2166136261;
    for (let index = 0; index < path.length; index++)
        hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
    return (hash >>> 0) % PACKAGE_TEXT_SHARDS;
}
const shardName = (shard) => `package-text.${shard}`;
/** A target's code layer (`code_layer` in `package_text_contract.rs`). */
export const codeLayerName = (target) => `code-text:${target}`;
/** Signature keys include eligibility, so header transitions invalidate reuse.
 * Digest framing prevents ambiguous concatenations. Inventory order is required to be path sorted.
 */
export function packageTextSelection(inventory, retainedEligibility) {
    const selection = new PackageTextSelectionBuilder(retainedEligibility);
    for (const entry of inventory)
        selection.add(entry);
    return selection.finish();
}
/** Selection state shared by the synchronous export and the host-sliced refresh. */
class PackageTextSelectionBuilder {
    buckets = Array.from({ length: PACKAGE_TEXT_SHARDS }, () => []);
    hashes = Array.from({ length: PACKAGE_TEXT_SHARDS }, () => createHash("sha256").update(PACKAGE_TEXT_FORMAT).update(SAVED_TEXT_AUDIENCE_POLICY_KEY));
    previous;
    retainedEligibility;
    constructor(retainedEligibility) {
        this.retainedEligibility = retainedEligibility;
    }
    add(entry) {
        // Each path is encoded once and kept as the next entry's predecessor.
        const bytes = encodeWtf8(entry.path);
        if (this.previous !== undefined && Buffer.compare(bytes, this.previous) <= 0)
            throw snapshotFailure("package-text.inventory", "Inventory must have unique paths in byte order");
        this.previous = bytes;
        if (entry.headerData === undefined)
            throw snapshotFailure("package-text.inventory", "Missing header evidence; upgrade the paired reader");
        const selected = this.retainedEligibility?.get(entry.path) ?? isPackageTextCandidate(entry.headerData);
        const shard = packageTextShard(entry.path);
        this.buckets[shard].push({ entry, selected });
        this.hashes[shard].update(JSON.stringify([entry.path, entry.signature, selected]));
    }
    finish() {
        return this.buckets.map((entries, shard) => ({
            name: shardName(shard),
            entries,
            key: `${PACKAGE_TEXT_FORMAT}:${shard}:${this.hashes[shard].digest("hex")}`
        }));
    }
}
/** The changed shards with their entries: planned here, or read from the writer's plan file. */
const shardEntries = Effect.fn("PackageText.planEntries")(function* (plan) {
    const byGroup = new Map();
    if (plan.file && plan.changed.some((shard) => !shard.entries)) {
        const text = yield* Effect.tryPromise({
            try: () => readFile(plan.file, "utf8"),
            catch: (cause) => snapshotFailure("package-text.plan", "The package text plan could not be read.", cause)
        });
        for (const line of text.split("\n")) {
            if (!line)
                continue;
            const { group, expected } = yield* decodePackageTextPlanLine(line).pipe(Effect.mapError((cause) => snapshotFailure("package-text.plan", "Invalid package text plan.", cause)));
            byGroup.set(shardName(group), expected.map(({ path, signature, selected }) => ({
                entry: { path, signature },
                selected
            })));
        }
    }
    const shards = [];
    for (const shard of plan.changed) {
        const entries = shard.entries ?? byGroup.get(shard.name);
        if (!entries)
            return yield* snapshotFailure("package-text.plan", "The package text plan lacks a shard.");
        shards.push({ name: shard.name, key: shard.key, entries });
    }
    return shards;
});
/** The writer plans from the Catalog generation and writes the changed shards' entries to a file. */
const planOnWriter = Effect.fn("PackageText.plan")(function* (catalog, changedFiles, plan, stagingRoot) {
    const file = yield* Effect.acquireRelease(Effect.tryPromise({
        try: async () => {
            await mkdir(stagingRoot, { recursive: true });
            return join(await mkdtemp(join(stagingRoot, "package-plan-")), "plan.ndjson");
        },
        catch: (cause) => snapshotFailure("package-text.plan", "The package text plan could not be staged.", cause)
    }), (file) => Effect.promise(() => rm(dirname(file), { recursive: true, force: true })));
    const result = yield* plan({
        ...catalog,
        format: PACKAGE_TEXT_FORMAT,
        policyJson: SAVED_TEXT_AUDIENCE_POLICY_KEY,
        ...(changedFiles ? { changedFiles: [...changedFiles] } : undefined),
        planFile: file
    });
    yield* Effect.annotateCurrentSpan({
        "package-text.plan.packages": result.packages,
        "package-text.plan.changed": result.changed.length,
        "package-text.plan.removed": result.removed.length
    });
    return {
        packages: result.packages,
        first: { name: shardName(0), key: result.firstKey },
        changed: result.changed.map((shard) => ({
            name: shardName(shard.group),
            key: shard.key,
            packages: shard.packages,
            selected: shard.selected
        })),
        removed: result.removed,
        file
    };
});
/** `packageTextSelection` in bounded host slices, with the refresh's inventory failure. */
export const packageTextSelectionInSlices = Effect.fn("PackageText.selection")(function* (inventory, retainedEligibility) {
    const clock = new HostSliceClock();
    const selection = new PackageTextSelectionBuilder(retainedEligibility);
    for (let next = 0; next < inventory.length;) {
        yield* Effect.try({
            try: () => {
                do
                    selection.add(inventory[next++]);
                while (next < inventory.length && !clock.step());
            },
            catch: (cause) => snapshotFailure("package-text.inventory", "The package inventory could not be prepared.", cause)
        });
        if (next < inventory.length)
            yield* Effect.yieldNow;
    }
    return selection.finish();
});
/** Own the writer lock across comparison, selected reads, and atomic multi-shard publication. */
export const refreshPackageTextLayer = Effect.fn("PackageText.refresh")(function* (input) {
    const store = yield* SharedIndex;
    const leased = yield* store.writer;
    const initial = leased.metrics();
    const writer = {
        ...leased,
        metrics: () => {
            const current = leased.metrics();
            return {
                ...current,
                readBytes: current.readBytes - initial.readBytes,
                indexReadBytes: current.indexReadBytes - initial.indexReadBytes,
                appendedBytes: current.appendedBytes - initial.appendedBytes,
                lookupStrings: current.lookupStrings - initial.lookupStrings,
                reusedStrings: current.reusedStrings - initial.reusedStrings,
                probePasses: current.probePasses - initial.probePasses,
                sortMs: current.sortMs - initial.sortMs,
                probeMs: current.probeMs - initial.probeMs,
                appendMs: current.appendMs - initial.appendMs,
                timings: {
                    collectMs: current.timings.collectMs - initial.timings.collectMs,
                    reuseMs: current.timings.reuseMs - initial.timings.reuseMs,
                    layerEncodeMs: current.timings.layerEncodeMs - initial.timings.layerEncodeMs,
                    layerVerifyMs: current.timings.layerVerifyMs - initial.timings.layerVerifyMs,
                    garbageMs: current.timings.garbageMs - initial.timings.garbageMs,
                    rootPublishMs: current.timings.rootPublishMs - initial.timings.rootPublishMs
                }
            };
        }
    };
    const stages = new StageClock();
    const manifest = writer.manifest();
    const session = yield* Effect.serviceOption(LocalizationImportSession);
    const stagingRoot = Option.isSome(session)
        ? join(session.value.configuration.cacheRoot, "staging")
        : tmpdir();
    const onWriter = input.catalog && writer.planPackages;
    // Planning here sends the writer nothing, so its other commands needn't wait for it.
    if (!onWriter && input.planned)
        yield* input.planned;
    const planned = onWriter
        ? yield* planOnWriter(input.catalog, input.changedFiles, writer.planPackages, stagingRoot)
        : yield* planHere(input.inventory ?? [], input.changedFiles, manifest);
    stages.mark("selection");
    if (onWriter && input.planned)
        yield* input.planned;
    if (!planned.packages && manifest.active[planned.first.name] === planned.first.key)
        return {
            readPackages: 0,
            reusedPackages: 0,
            changedShards: 0,
            removedShards: 0,
            published: false,
            profile: writer.metrics()
        };
    const changed = planned.changed;
    const removed = planned.removed;
    if (!planned.packages) {
        const empty = {
            name: planned.first.name,
            key: planned.first.key,
            source: yield* nativePackageTextColumns([])
        };
        const retired = removed.filter((name) => name !== empty.name);
        if (input.publishGate)
            yield* input.publishGate;
        // Retain an empty prepared-inventory marker after deleting the last package, including
        // when localization layers were imported before this first package preparation.
        if (!Object.keys(writer.manifest().layers).length)
            yield* writer.publishCold([empty]);
        else
            yield* writer.publishBatch([empty], retired);
        return {
            readPackages: 0,
            reusedPackages: 0,
            changedShards: 0,
            removedShards: retired.length,
            published: true,
            profile: writer.metrics()
        };
    }
    if (!changed.length && !removed.length)
        return {
            readPackages: 0,
            reusedPackages: planned.packages,
            changedShards: 0,
            removedShards: 0,
            published: false,
            profile: writer.metrics()
        };
    // An existing index in this encoding is refreshed in place, however many shards changed.
    // Without one (no index, or one in an older format or audience policy), the changed shards
    // are read and written again once. The writer compares the shards, and tells their encoding.
    const comparable = writer.replacePackages !== undefined &&
        writer.comparePackages !== undefined &&
        changed.some((shard) => manifest.active[shard.name]?.startsWith(`${PACKAGE_TEXT_FORMAT}:`));
    stages.mark("selection");
    const comparison = comparable
        ? yield* comparePackageText({
            changed,
            entries: shardEntries(planned),
            file: planned.file
        }, {
            compare: writer.comparePackages,
            stagingRoot,
            format: PACKAGE_TEXT_FORMAT,
            policyJson: SAVED_TEXT_AUDIENCE_POLICY_KEY
        })
        : undefined;
    const inPlace = comparison?.shards.some((shard) => shard.current) ?? false;
    const result = comparison && inPlace
        ? yield* replacePackageTextRecords(input, { packages: planned.packages, changed, removed }, comparison, { writer, replace: writer.replacePackages, stages })
        : yield* rebuildChangedShards(input, planned, { writer, stages, stagingRoot });
    // The refresh span holds the whole refresh's counts and stage times.
    yield* Effect.annotateCurrentSpan({
        "package-text.mode": inPlace ? "in_place" : "rebuild",
        "package-text.packages": planned.packages,
        "package-text.readPackages": result.readPackages,
        "package-text.reusedPackages": result.reusedPackages,
        "package-text.changedShards": result.changedShards,
        "package-text.removedShards": result.removedShards,
        ...stages.attributes("package-text.stage_ms")
    });
    return result;
});
/** Plans an explicit inventory here: selects, shards and keys every package. */
const planHere = Effect.fn("PackageText.planHere")(function* (input, changedFiles, manifest) {
    const store = yield* SharedIndex;
    let inventory = input;
    const retainedEligibility = new Map();
    if (changedFiles !== undefined &&
        Object.keys(manifest.active).some((name) => name.startsWith("package-text."))) {
        const selected = new Set(changedFiles.flatMap((path) => {
            const normalized = path.replaceAll("\\", "/");
            return /\.(?:uexp|ubulk|uptnl)$/u.test(normalized)
                ? [
                    normalized.replace(/\.[^.]+$/u, ".uasset"),
                    normalized.replace(/\.[^.]+$/u, ".umap")
                ]
                : [normalized];
        }));
        const retained = new Map();
        const reader = yield* store.open;
        for (const name of Object.keys(manifest.active).filter((name) => name.startsWith("package-text."))) {
            const layer = yield* reader.layer(name);
            const paths = yield* layer.section("package.path"), signatures = yield* layer.section("package.signature"), statuses = yield* layer.section("package.status");
            if (!(paths instanceof Uint32Array) ||
                !(signatures instanceof Uint32Array) ||
                !(statuses instanceof Uint32Array))
                return yield* snapshotFailure(name, "Expected package inventory columns");
            const pathValues = yield* layer.strings("paths", [...paths]), signatureValues = yield* layer.strings("identity", [...signatures]);
            for (let row = 0; row < paths.length; row++) {
                const path = pathValues[row];
                if (!selected.has(path)) {
                    retainedEligibility.set(path, statuses[row] !== 2);
                    retained.set(path, {
                        path,
                        signature: signatureValues[row],
                        headerData: {
                            packageFlags: statuses[row] === 2 ? 0 : 0x40000,
                            gatherableTextDataCount: 0,
                            gatherableTextDataOffset: 0,
                            hasTextProperty: false
                        }
                    });
                }
            }
        }
        for (const entry of inventory)
            if (selected.has(entry.path))
                retained.set(entry.path, entry);
        const entries = [...retained.values()], clock = new HostSliceClock(), keys = [];
        for (const entry of entries) {
            keys.push(encodeWtf8(entry.path));
            if (clock.step())
                yield* Effect.yieldNow;
        }
        const rows = yield* sortRowsInSlices(Uint32Array.from(keys, (_, row) => row), (left, right) => Buffer.compare(keys[left], keys[right]), clock);
        inventory = Array.from(rows, (row) => entries[row]);
    }
    const selection = yield* packageTextSelectionInSlices(inventory, retainedEligibility);
    return {
        packages: inventory.length,
        first: { name: selection[0].name, key: selection[0].key },
        changed: selection
            .filter((shard) => shard.entries.length && manifest.active[shard.name] !== shard.key)
            .map((shard) => ({
            name: shard.name,
            key: shard.key,
            packages: shard.entries.length,
            selected: shard.entries.filter(({ selected }) => selected).length,
            entries: shard.entries
        })),
        removed: selection
            .filter((shard) => !shard.entries.length && manifest.active[shard.name])
            .map((shard) => shard.name)
    };
});
/**
 * Reads every selected package of the changed shards and writes those shards again: a cold
 * build, an index in an older format or audience policy, or a writer that can't replace records.
 * A large rebuild is staged by the reader, from the writer's plan file when it planned; otherwise
 * packages are read here.
 */
const rebuildChangedShards = Effect.fn("PackageText.rebuildShards")(function* (input, planned, context) {
    const store = yield* SharedIndex;
    const reportProgress = yield* GameTextIndexProgressReporter;
    const { writer, stages, stagingRoot } = context;
    const changed = planned.changed;
    const removed = planned.removed;
    const unchanged = planned.packages - changed.reduce((count, shard) => count + shard.packages, 0);
    const reads = changed.reduce((count, shard) => count + shard.selected, 0);
    let completed = 0;
    const report = () => reportProgress({ phase: "package_read", completed, total: reads, unchanged });
    report();
    if (changed.length > 8 && planned.packages >= (input.coldMinimumPackages ?? 256)) {
        const directory = yield* Effect.acquireRelease(Effect.tryPromise({
            try: async () => {
                await mkdir(stagingRoot, { recursive: true });
                return mkdtemp(join(stagingRoot, "package-cold-"));
            },
            catch: (cause) => snapshotFailure("package-text.stage", "The package text staging operation failed.", cause)
        }), (value) => Effect.promise(() => rm(value, { recursive: true, force: true })));
        const requested = new Map();
        const received = new Set();
        const snapshots = new Map();
        const stage = input.stage;
        const group = (shard) => Number(shard.name.slice("package-text.".length));
        // The reader stages the plan file's shards: no package crosses into the host.
        const fromPlan = stage !== undefined && planned.file !== undefined;
        const shards = fromPlan ? [] : yield* shardEntries(planned);
        for (const shard of shards)
            for (const { entry, selected } of shard.entries)
                if (selected)
                    requested.set(entry.path, entry);
        const expected = reads;
        const onRead = (path) => {
            received.add(path);
            completed++;
            report();
        };
        if (stage && planned.file) {
            const staged = yield* stagePlannedPackageText(stage, { file: planned.file, groups: changed.map(group), selected: expected }, directory, onRead);
            for (const shard of changed)
                snapshots.set(shard.name, staged.get(group(shard)));
        }
        else if (stage) {
            const paths = [...requested.keys()];
            yield* stage
                .read(paths, directory, paths.map(packageTextShard), {
                rules: packageTextAudienceRules(),
                shards: shards.map((shard) => ({
                    group: Number(shard.name.slice("package-text.".length)),
                    expected: shard.entries.map(({ entry, selected }) => ({
                        path: entry.path,
                        signature: entry.signature,
                        selected
                    }))
                }))
            })
                .pipe(Stream.runForEach((event) => Effect.gen(function* () {
                if (!requested.has(event.path) || received.has(event.path))
                    return yield* snapshotFailure("package-text.read", "Unexpected or duplicate package");
                received.add(event.path);
                completed++;
                report();
            })));
            for (const shard of changed)
                snapshots.set(shard.name, join(directory, `${Number(shard.name.slice("package-text.".length))}.snapshot`));
        }
        else {
            // Without staging, records are spooled to files as they arrive and converted from those.
            const requests = new Map();
            const shardRequests = shards.map((shard) => ({
                group: group(shard),
                expected: shard.entries.map(({ entry, selected }) => {
                    if (selected)
                        requests.set(entry.path, {
                            signature: entry.signature,
                            group: group(shard)
                        });
                    return { path: entry.path, signature: entry.signature, selected };
                })
            }));
            const files = yield* spoolPackageReads(input.read, requests, join(directory, "records"), onRead);
            const converted = yield* convertSpooledPackageText(shardRequests, files, join(directory, "converted"));
            for (const shard of changed)
                snapshots.set(shard.name, converted.get(group(shard)));
        }
        if (received.size !== expected)
            return yield* snapshotFailure("package-text.read", "Reader omitted requested packages");
        stages.mark("read");
        if (input.publishGate)
            yield* input.publishGate;
        stages.restart();
        const result = yield* importColdPackageTextShards({ snapshots, removed }, changed.map(({ name, key, packages }) => ({ name, key, packages })), planned.packages).pipe(Effect.provideService(SharedIndex, SharedIndex.of({
            ...store,
            writer: Effect.sync(() => writer),
            inspect: Effect.sync(() => writer.manifest())
        })));
        stages.mark("import");
        return {
            readPackages: expected,
            reusedPackages: planned.packages - expected,
            changedShards: changed.length,
            removedShards: removed.length,
            published: true,
            profile: result.profile
        };
    }
    const sources = [];
    // A large rebuild must release each shard's authored objects before reading the next shard.
    // Disk-backed sources retain the atomic dictionary/root publication without retaining the corpus.
    const staged = changed.length > 8
        ? yield* Effect.acquireRelease(Effect.tryPromise({
            try: async () => {
                await mkdir(stagingRoot, { recursive: true });
                const readers = [];
                return {
                    directory: await mkdtemp(join(stagingRoot, "package-refresh-")),
                    readers
                };
            },
            catch: (cause) => snapshotFailure("package-text.stage", "The package text staging operation failed.", cause)
        }), (value) => Effect.promise(async () => {
            await Promise.all(value.readers.map((reader) => reader.close()));
            await rm(value.directory, { recursive: true, force: true });
        }))
        : undefined;
    let readPackages = 0;
    for (const shard of yield* shardEntries(planned)) {
        const next = [], requests = [];
        const signatures = new Map();
        for (const { entry, selected } of shard.entries) {
            if (!selected)
                next.push({
                    path: entry.path,
                    signature: entry.signature,
                    evidence: { event: "not_gatherable", path: entry.path }
                });
            else {
                requests.push(entry.path);
                signatures.set(entry.path, entry.signature);
            }
        }
        const received = new Set();
        if (requests.length)
            yield* input.read(requests, signatures).pipe(Stream.runForEach((event) => Effect.gen(function* () {
                if (event.event === "text_summary")
                    return;
                const signature = signatures.get(event.path);
                if (signature === undefined || received.has(event.path))
                    return yield* snapshotFailure("package-text.read", "Unexpected or duplicate package");
                received.add(event.path);
                next.push({ path: event.path, signature, evidence: event });
                readPackages++;
                completed++;
                report();
            })));
        if (received.size !== requests.length)
            return yield* snapshotFailure("package-text.read", "Reader omitted requested packages");
        next.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
        const source = yield* nativePackageTextColumns(next);
        if (staged) {
            const file = yield* Effect.tryPromise({
                try: async () => {
                    const path = join(staged.directory, `${shard.name}.snapshot`);
                    // Staged for the writer: uncompressed and unsynced.
                    await writeSnapshotFile(path, source, 0, undefined, undefined, {
                        durable: false
                    });
                    return openSnapshotFile(path);
                },
                catch: (cause) => snapshotFailure("package-text.stage", "The package text staging operation failed.", cause)
            });
            staged.readers.push(file);
            sources.push({
                name: shard.name,
                key: shard.key,
                source: {
                    columns: [...file.directory.entries.values()].map((entry) => ({
                        ...entry,
                        load: () => file.load(entry.name)
                    }))
                }
            });
        }
        else
            sources.push({ name: shard.name, key: shard.key, source: source });
    }
    // Reading includes the reader's own work and each shard's staging.
    stages.mark("read");
    if (input.publishGate)
        yield* input.publishGate;
    stages.restart();
    reportProgress({ phase: "package_publish", completed: 0, total: 0 });
    if (!Object.keys(writer.manifest().layers).length || sources.length > 8)
        yield* writer.publishCold(sources, removed);
    else
        yield* writer.publishBatch(sources, removed);
    stages.mark("publish");
    return {
        readPackages,
        reusedPackages: planned.packages - readPackages,
        changedShards: changed.length,
        removedShards: removed.length,
        published: true,
        profile: writer.metrics()
    };
});
/**
 * Read the published package-text layer back as a text corpus, as a test oracle. Deliberately only
 * for bounded fixture and tiny corpora.
 */
export const textCorpusFromPackageTextLayer = Effect.fn("PackageText.oracleCorpus")(function* (projectRoot) {
    const reader = yield* (yield* SharedIndex).open;
    const records = [];
    for (const name of Object.keys(reader.manifest.active).filter((name) => name.startsWith("package-text.")))
        records.push(...(yield* decodePackageTextColumns(yield* reader.layer(name))));
    // Shards are a storage partition, not the native reader's package emission order.
    records.sort((a, b) => comparePackageTextPathBytes(encodeWtf8(a.path), encodeWtf8(b.path)));
    const corpus = textCorpusFromExtractionEvents({
        projectRoot,
        discoveredPackages: records.length,
        events: records.flatMap((record) => record.evidence.event === "not_gatherable"
            ? []
            : [{ ...record.evidence, path: resolve(projectRoot, record.path) }])
    });
    return textCorpusWithExcludedPackages(corpus, records
        .filter((record) => record.evidence.event === "not_gatherable")
        .map((record) => relative(projectRoot, resolve(projectRoot, record.path))));
});
