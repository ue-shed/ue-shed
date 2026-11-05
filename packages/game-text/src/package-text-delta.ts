import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { PackageTextRefreshInput, PackageTextShardEntries } from "./package-text-layer.js";
import type { PackageTextStored } from "./package-text-columns.js";
import type { SharedIndexReader, SharedIndexWriter } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import {
	packageTextAudienceRules,
	packageTextSnapshotBatches,
	preparePackageTextSnapshots,
	type PackageTextSnapshots
} from "./package-text-native.js";
import { encodeWtf8 } from "./wtf8.js";
import { HostSliceClock } from "./host-slices.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import type { StageClock } from "./stage-clock.js";

/** A package entry of a shard: its path, inventory signature and whether it is read. */
interface ShardEntry {
	readonly path: string;
	readonly signature: string;
	readonly selected: boolean;
}

/** A shard's identity columns as the index holds them, in path order. */
interface HeldShard {
	readonly paths: readonly string[];
	readonly signatures: readonly string[];
	/** `package.status` per row; 2 is a package stored without reading it. */
	readonly statuses: Uint32Array;
}

const heldShard = (reader: SharedIndexReader, name: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const layer = yield* reader.layer(name);
			const paths = yield* layer.section("package.path");
			const signatures = yield* layer.section("package.signature");
			const statuses = yield* layer.section("package.status");
			if (
				!(paths instanceof Uint32Array) ||
				!(signatures instanceof Uint32Array) ||
				!(statuses instanceof Uint32Array) ||
				paths.length !== signatures.length ||
				paths.length !== statuses.length
			)
				return yield* Effect.fail(
					snapshotFailure(name, "Invalid package identity columns")
				);
			return {
				paths: yield* layer.strings("paths", [...paths]),
				signatures: yield* layer.strings("identity", [...signatures]),
				statuses: Uint32Array.from(statuses)
			} satisfies HeldShard;
		})
	);

/**
 * The key a shard's entries give, as `PackageTextSelectionBuilder` and the writer's planner
 * compute it: the format and audience policy, then each entry in path order.
 */
const shardKey = (format: string, policy: string, group: number, entries: Iterable<ShardEntry>) => {
	const hash = createHash("sha256").update(format).update(policy);
	for (const { path, signature, selected } of entries)
		hash.update(JSON.stringify([path, signature, selected]));
	return `${format}:${group}:${hash.digest("hex")}`;
};
function* heldEntries(held: HeldShard): Generator<ShardEntry> {
	for (let row = 0; row < held.paths.length; row++)
		yield {
			path: held.paths[row]!,
			signature: held.signatures[row]!,
			selected: held.statuses[row] !== 2
		};
}
const group = (name: string) => Number(name.slice("package-text.".length));

/**
 * Whether the index's package shards hold records encoded under this format and audience policy.
 * Every shard key includes both, and a refresh publishes all changed shards at once, so a policy
 * change changes every shard's key in one refresh: all held shards share one policy, and one
 * shard's key, recomputed from its own stored entries, tells it.
 */
export const packageTextEncodingCurrent = Effect.fn("PackageText.encodingCurrent")(function* (
	reader: SharedIndexReader,
	name: string,
	format: string,
	policy: string
) {
	const previousKey = reader.manifest.active[name];
	if (!previousKey?.startsWith(`${format}:`)) return false;
	const held = yield* heldShard(reader, name);
	return shardKey(format, policy, group(name), heldEntries(held)) === previousKey;
});

/** One changed shard: rows over its previous records and its changed entries' records. */
interface ShardChange {
	readonly name: string;
	readonly key: string;
	readonly previousKey: string | undefined;
	/** Per next record: a previous row, or -1 - its index in `changed`. */
	readonly rows: Int32Array;
	/** The changed entries in path order: the order of the converted snapshot's records. */
	readonly changed: readonly ShardEntry[];
	readonly retained: number;
}

/**
 * Compares a changed shard's planned entries with the records the index holds. Only a held shard
 * in the current encoding is retained from; any other shard has no retained row, so each of its
 * entries is converted again.
 */
const compareShard = Effect.fn("PackageText.compareShard")(function* (
	shard: PackageTextShardEntries,
	reader: SharedIndexReader,
	format: string,
	clock: HostSliceClock
) {
	const previousKey = reader.manifest.active[shard.name];
	const held = previousKey?.startsWith(`${format}:`)
		? yield* heldShard(reader, shard.name)
		: undefined;
	const byPath = new Map<string, number>();
	if (held) for (let row = 0; row < held.paths.length; row++) byPath.set(held.paths[row]!, row);
	const rows = new Int32Array(shard.entries.length);
	const changed: ShardEntry[] = [];
	let retained = 0;
	let previous: Uint8Array | undefined;
	for (let index = 0; index < shard.entries.length; index++) {
		const { entry, selected } = shard.entries[index]!;
		const row = byPath.get(entry.path);
		if (
			held &&
			row !== undefined &&
			held.signatures[row] === entry.signature &&
			selected === (held.statuses[row] !== 2)
		) {
			rows[index] = row;
			retained++;
		} else {
			// The reader writes a shard's records in path byte order; these rows assume it.
			const bytes = encodeWtf8(entry.path);
			if (previous !== undefined && Buffer.compare(previous, bytes) >= 0)
				return yield* Effect.fail(
					snapshotFailure("package-text.plan", "Shard entries are out of path order")
				);
			previous = bytes;
			rows[index] = -1 - changed.length;
			changed.push({ path: entry.path, signature: entry.signature, selected });
		}
		if (clock.step()) yield* Effect.yieldNow;
	}
	return {
		name: shard.name,
		key: shard.key,
		previousKey,
		rows,
		changed,
		retained
	} satisfies ShardChange;
});

/**
 * Converts the changed records into one snapshot per shard with the paired reader, in batches
 * that bound each request. Records go through files; entries that weren't read are written from
 * the inventory alone.
 */
const convertChanges = Effect.fn("PackageText.convertChanges")(function* (
	changes: readonly ShardChange[],
	records: ReadonlyMap<string, PackageTextStored>,
	directory: string
) {
	const snapshots = new Map<string, string>();
	const shards: PackageTextSnapshots["shards"] = changes.map((change) => ({
		group: group(change.name),
		expected: change.changed.map(({ path, signature, selected }) => ({
			path,
			signature,
			selected
		}))
	}));
	const batches = packageTextSnapshotBatches(shards);
	yield* Effect.annotateCurrentSpan({ "package-text.convert.batches": batches.length });
	for (const [index, batch] of batches.entries()) {
		const batchDirectory = join(directory, `batch-${index}`);
		const recordFile = join(batchDirectory, "records.ndjson");
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(batchDirectory);
				const file = await open(recordFile, "wx");
				try {
					let chunk = "";
					for (const shard of batch)
						for (const entry of shard.expected) {
							if (!entry.selected) continue;
							chunk += `${JSON.stringify(records.get(entry.path)!)}\n`;
							if (chunk.length > 1024 * 1024) {
								await file.write(chunk);
								chunk = "";
							}
						}
					if (chunk) await file.write(chunk);
				} finally {
					await file.close();
				}
			},
			catch: (cause) =>
				snapshotFailure(
					"package-text.stage",
					"The package text staging operation failed.",
					cause
				)
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
					recordFiles: [recordFile]
				}
			}
		});
		for (const shard of batch)
			snapshots.set(
				`package-text.${shard.group}`,
				join(batchDirectory, `${shard.group}.snapshot`)
			);
	}
	return snapshots;
});

/**
 * Refreshes changed shards of an existing index in place: only changed packages are read and
 * converted, and the native writer keeps every unchanged record and its dictionary IDs. All
 * changed shards and removals publish in one root publication, however many shards changed.
 */
export const replacePackageTextRecords = Effect.fn("PackageText.replaceRecords")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>,
	plan: {
		readonly packages: number;
		readonly shards: readonly PackageTextShardEntries[];
		readonly removed: readonly string[];
		readonly format: string;
	},
	context: {
		readonly reader: SharedIndexReader;
		readonly writer: SharedIndexWriter;
		readonly replace: NonNullable<SharedIndexWriter["replacePackages"]>;
		readonly stagingRoot: string;
		readonly stages: StageClock;
	}
) {
	const { reader, writer, replace, stages } = context;
	const report = yield* GameTextIndexProgressReporter;
	const clock = new HostSliceClock();
	const changes: ShardChange[] = [];
	for (const shard of plan.shards)
		changes.push(yield* compareShard(shard, reader, plan.format, clock));
	const requests = new Map<string, string>();
	let retained =
		plan.packages - plan.shards.reduce((sum, shard) => sum + shard.entries.length, 0);
	for (const change of changes) {
		retained += change.retained;
		for (const entry of change.changed)
			if (entry.selected) requests.set(entry.path, entry.signature);
	}
	stages.mark("compare");
	const total = requests.size;
	let completed = 0;
	report({ phase: "package_read", completed, total, unchanged: retained });
	const records = new Map<string, PackageTextStored>();
	if (total)
		yield* input.read([...requests.keys()], requests).pipe(
			Stream.runForEach((event) =>
				Effect.gen(function* () {
					if (event.event === "text_summary") return;
					const signature = requests.get(event.path);
					if (signature === undefined || records.has(event.path))
						return yield* Effect.fail(
							snapshotFailure("package-text.read", "Unexpected or duplicate package")
						);
					records.set(event.path, { path: event.path, signature, evidence: event });
					completed++;
					report({ phase: "package_read", completed, total, unchanged: retained });
				})
			)
		);
	if (records.size !== total)
		return yield* Effect.fail(
			snapshotFailure("package-text.read", "Reader omitted requested packages")
		);
	stages.mark("read");
	report({ phase: "package_update", completed: 0, total: 0 });
	const directory = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: async () => {
				await mkdir(context.stagingRoot, { recursive: true });
				return mkdtemp(join(context.stagingRoot, "package-delta-"));
			},
			catch: (cause) =>
				snapshotFailure(
					"package-text.stage",
					"The package text staging operation failed.",
					cause
				)
		}),
		(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
	);
	const snapshots = yield* convertChanges(changes, records, directory);
	records.clear();
	stages.mark("convert");
	if (input.publishGate) {
		yield* input.publishGate;
		stages.restart();
	}
	yield* replace(
		changes.map((change) => ({
			name: change.name,
			key: change.key,
			...(change.previousKey === undefined ? undefined : { previousKey: change.previousKey }),
			stagedFile: snapshots.get(change.name)!,
			rows: change.rows
		})),
		plan.removed
	);
	stages.mark("publish");
	yield* Effect.annotateCurrentSpan({
		"package-text.unchangedPackages": retained,
		"package-text.convertedPackages": changes.reduce((sum, c) => sum + c.changed.length, 0)
	});
	return {
		readPackages: total,
		reusedPackages: plan.packages - total,
		changedShards: changes.length,
		removedShards: plan.removed.length,
		published: true,
		profile: writer.metrics()
	};
});
