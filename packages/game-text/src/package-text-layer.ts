import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { Effect, Option, Schema, Stream } from "effect";
import { ProjectIndexHeader, SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import { SharedIndex } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import {
	isPackageTextCandidate,
	textCorpusWithExcludedPackages
} from "./package-text-candidates.js";
import {
	packageTextColumns,
	decodePackageTextColumns,
	type PackageTextStored
} from "./package-text-columns.js";
import type { ColdLayerSource } from "./shared-string-sort.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { comparePackageTextPathBytes } from "./package-text-order.js";
import { encodeWtf8 } from "./wtf8.js";
import { LocalizationImportSession } from "./localization-import-session.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { writeSnapshotFile, openSnapshotFile, type SnapshotFileReader } from "./snapshot-file.js";
import { importColdPackageTextShards } from "./package-text-cold.js";
import { TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import { HostSliceClock, sortRowsInSlices } from "./host-slices.js";
import { StageClock } from "./stage-clock.js";
import { replacePackageTextRecords } from "./package-text-delta.js";

/** The caller supplies the Project Index's opaque package-and-sidecar signature, never a layer hash.
 * Header evidence and signatures must come from the same complete inventory generation.
 */
export const PackageTextInventoryEntry = Schema.Struct({
	path: Schema.String,
	signature: Schema.String,
	headerData: ProjectIndexHeader.fields.headerData
});
export type PackageTextInventoryEntry = typeof PackageTextInventoryEntry.Type;
/** Bump when package text columns change; older shards are read again instead of decoded.
 * v3: object paths are completed with the package name; v2 shards from UE 4.27 projects held
 * package-relative names.
 * v4: occurrences keep the reader's gather-table editor-only bit and their audience
 * (`text-audience.ts`). The audience policy table and matcher version are part of every shard key,
 * so a policy or matcher change re-encodes each shard from its stored evidence without reading
 * packages again.
 * v5: records keep the reader's Blueprint classes (uasset-io 1.12) and are stored with their
 * representation copies folded into the authored sites (`representation-copies.ts`); copies keep
 * their raw paths and text in `copy.*` columns.
 * v6: re-extract saved packages so caches built before graph pin extraction cannot retain
 * silently incomplete Blueprint text.
 * v7: re-extract bytecode identities reconciled with saved pin package namespaces.
 * v8: re-extract so a package moved or copied outside Unreal stores its object paths under the
 * file's package instead of the name its summary serializes, which records keep as `packageName`
 * (uasset-io 1.17), and so every package records its main asset's class as `assetClass`.
 * v9: re-extract with the UE 4.27 decoders and the reader's text-capable gap status (uasset-io
 * 1.18), so cached records do not keep packages partial for text-free gaps. */
export const PACKAGE_TEXT_FORMAT = "package-text-v9";
export const PACKAGE_TEXT_SHARDS = 256;
export function packageTextShard(path: string) {
	let hash = 2166136261;
	for (let index = 0; index < path.length; index++)
		hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
	return (hash >>> 0) % PACKAGE_TEXT_SHARDS;
}
const shardName = (shard: number) => `package-text.${shard}`;

export interface PackageTextRefreshInput<E, R> {
	/** Override the cold-path inventory threshold for bounded integration fixtures. */
	readonly coldMinimumPackages?: number;
	readonly inventory: readonly PackageTextInventoryEntry[];
	readonly changedFiles?: readonly string[];
	readonly read: (
		paths: readonly string[]
	) => Stream.Stream<typeof SavedAssetPackageTextEvent.Type, E, R>;
}

/** Signature keys include eligibility, so header transitions invalidate reuse.
 * Digest framing prevents ambiguous concatenations. Inventory order is required to be path sorted.
 */
export function packageTextSelection(
	inventory: readonly PackageTextInventoryEntry[],
	retainedEligibility?: ReadonlyMap<string, boolean>
) {
	const selection = new PackageTextSelectionBuilder(retainedEligibility);
	for (const entry of inventory) selection.add(entry);
	return selection.finish();
}

/** Selection state shared by the synchronous export and the host-sliced refresh. */
class PackageTextSelectionBuilder {
	private readonly buckets: { entry: PackageTextInventoryEntry; selected: boolean }[][] =
		Array.from({ length: PACKAGE_TEXT_SHARDS }, () => []);
	private readonly hashes = Array.from({ length: PACKAGE_TEXT_SHARDS }, () =>
		createHash("sha256")
			.update(PACKAGE_TEXT_FORMAT)
			.update(JSON.stringify([TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY]))
	);
	private previous: Uint8Array | undefined;
	private readonly retainedEligibility: ReadonlyMap<string, boolean> | undefined;
	constructor(retainedEligibility?: ReadonlyMap<string, boolean>) {
		this.retainedEligibility = retainedEligibility;
	}
	add(entry: PackageTextInventoryEntry) {
		// Each path is encoded once and kept as the next entry's predecessor.
		const bytes = encodeWtf8(entry.path);
		if (this.previous !== undefined && Buffer.compare(bytes, this.previous) <= 0)
			throw snapshotFailure(
				"package-text.inventory",
				"Inventory must have unique paths in byte order"
			);
		this.previous = bytes;
		if (entry.headerData === undefined)
			throw snapshotFailure(
				"package-text.inventory",
				"Missing header evidence; upgrade the paired reader"
			);
		const selected =
			this.retainedEligibility?.get(entry.path) ?? isPackageTextCandidate(entry.headerData);
		const shard = packageTextShard(entry.path);
		this.buckets[shard]!.push({ entry, selected });
		this.hashes[shard]!.update(JSON.stringify([entry.path, entry.signature, selected]));
	}
	finish() {
		return this.buckets.map((entries, shard) => ({
			name: shardName(shard),
			entries,
			key: `${PACKAGE_TEXT_FORMAT}:${shard}:${this.hashes[shard]!.digest("hex")}`
		}));
	}
}

/** `packageTextSelection` in bounded host slices, with the refresh's inventory failure. */
export const packageTextSelectionInSlices = Effect.fn("PackageText.selection")(function* (
	inventory: readonly PackageTextInventoryEntry[],
	retainedEligibility?: ReadonlyMap<string, boolean>
) {
	const clock = new HostSliceClock();
	const selection = new PackageTextSelectionBuilder(retainedEligibility);
	for (let next = 0; next < inventory.length; ) {
		yield* Effect.try({
			try: () => {
				do selection.add(inventory[next++]!);
				while (next < inventory.length && !clock.step());
			},
			catch: (cause) =>
				snapshotFailure(
					"package-text.inventory",
					"The package inventory could not be prepared.",
					cause
				)
		});
		if (next < inventory.length) yield* Effect.yieldNow;
	}
	return selection.finish();
});

/** Own the writer lock across comparison, selected reads, and atomic multi-shard publication. */
export const refreshPackageTextLayer = Effect.fn("PackageText.refresh")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>
) {
	const store = yield* SharedIndex;
	const leased = yield* store.writer();
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
	const reportProgress = yield* GameTextIndexProgressReporter;
	const stages = new StageClock();
	const manifest = writer.manifest();
	let inventory = input.inventory;
	const retainedEligibility = new Map<string, boolean>();
	if (
		input.changedFiles !== undefined &&
		Object.keys(manifest.active).some((name) => name.startsWith("package-text."))
	) {
		const selected = new Set(
			input.changedFiles.flatMap((path) => {
				const normalized = path.replaceAll("\\", "/");
				return /\.(?:uexp|ubulk|uptnl)$/u.test(normalized)
					? [
							normalized.replace(/\.[^.]+$/u, ".uasset"),
							normalized.replace(/\.[^.]+$/u, ".umap")
						]
					: [normalized];
			})
		);
		const retained = new Map<string, PackageTextInventoryEntry>();
		const reader = yield* store.open();
		for (const name of Object.keys(manifest.active).filter((name) =>
			name.startsWith("package-text.")
		)) {
			const layer = yield* reader.layer(name);
			const paths = yield* layer.section("package.path"),
				signatures = yield* layer.section("package.signature"),
				statuses = yield* layer.section("package.status");
			if (
				!(paths instanceof Uint32Array) ||
				!(signatures instanceof Uint32Array) ||
				!(statuses instanceof Uint32Array)
			)
				return yield* Effect.fail(
					snapshotFailure(name, "Expected package inventory columns")
				);
			const pathValues = yield* layer.strings("paths", [...paths]),
				signatureValues = yield* layer.strings("identity", [...signatures]);
			for (let row = 0; row < paths.length; row++) {
				const path = pathValues[row]!;
				if (!selected.has(path)) {
					retainedEligibility.set(path, statuses[row] !== 2);
					retained.set(path, {
						path,
						signature: signatureValues[row]!,
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
			if (selected.has(entry.path)) retained.set(entry.path, entry);
		const entries = [...retained.values()],
			clock = new HostSliceClock(),
			keys: Uint8Array[] = [];
		for (const entry of entries) {
			keys.push(encodeWtf8(entry.path));
			if (clock.step()) yield* Effect.yieldNow;
		}
		const rows = yield* sortRowsInSlices(
			Uint32Array.from(keys, (_, row) => row),
			(left, right) => Buffer.compare(keys[left]!, keys[right]!),
			clock
		);
		inventory = Array.from(rows, (row) => entries[row]!);
	}
	const selection = yield* packageTextSelectionInSlices(inventory, retainedEligibility);
	stages.mark("selection");
	if (!inventory.length && manifest.active[selection[0]!.name] === selection[0]!.key)
		return {
			readPackages: 0,
			reusedPackages: 0,
			changedShards: 0,
			removedShards: 0,
			published: false,
			profile: writer.metrics()
		};
	const changed = selection.filter(
		(shard) => shard.entries.length && manifest.active[shard.name] !== shard.key
	);
	const removed = selection
		.filter((shard) => !shard.entries.length && manifest.active[shard.name])
		.map((shard) => shard.name);
	let completed =
		inventory.length - changed.reduce((count, shard) => count + shard.entries.length, 0);
	const report = () => reportProgress({ phase: "packages", completed, total: inventory.length });
	report();
	if (!inventory.length && !Object.keys(manifest.layers).length) {
		yield* writer.publishCold([
			{ name: selection[0]!.name, key: selection[0]!.key, source: packageTextColumns([]) }
		]);
		return {
			readPackages: 0,
			reusedPackages: 0,
			changedShards: 0,
			removedShards: 0,
			published: true,
			profile: writer.metrics()
		};
	}
	if (!changed.length && !removed.length)
		return {
			readPackages: 0,
			reusedPackages: inventory.length,
			changedShards: 0,
			removedShards: 0,
			published: false,
			profile: writer.metrics()
		};
	const reader = Object.keys(manifest.active).some((name) => name.startsWith("package-text."))
		? yield* store.open()
		: undefined;
	const session = yield* Effect.serviceOption(LocalizationImportSession);
	if (
		reader &&
		writer.replacePackages &&
		changed.length <= 8 &&
		changed.every((shard) => manifest.active[shard.name]?.startsWith(`${PACKAGE_TEXT_FORMAT}:`))
	) {
		return yield* replacePackageTextRecords(
			{ ...input, inventory },
			changed,
			removed,
			reader,
			writer,
			writer.replacePackages
		);
	}
	if (!reader && changed.length > 8 && inventory.length >= (input.coldMinimumPackages ?? 256)) {
		const directory = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					const root = Option.isSome(session)
						? join(session.value.configuration.cacheRoot, "staging")
						: tmpdir();
					await mkdir(root, { recursive: true });
					return mkdtemp(join(root, "package-cold-"));
				},
				catch: (cause) =>
					snapshotFailure(
						"package-text.stage",
						"The package text staging operation failed.",
						cause
					)
			}),
			(value) => Effect.promise(() => rm(value, { recursive: true, force: true }))
		);
		const buffers = new Map<string, { lines: string[]; bytes: number }>();
		const flush = async (name: string) => {
			const buffer = buffers.get(name)!;
			if (!buffer.lines.length) return;
			await appendFile(join(directory, `${name}.ndjson`), buffer.lines.join(""));
			buffer.lines.length = 0;
			buffer.bytes = 0;
		};
		const append = (record: PackageTextStored) =>
			Effect.tryPromise({
				try: async () => {
					const name = shardName(packageTextShard(record.path)),
						buffer = buffers.get(name) ?? { lines: [], bytes: 0 },
						line = `${JSON.stringify(record)}\n`;
					buffers.set(name, buffer);
					buffer.lines.push(line);
					buffer.bytes += Buffer.byteLength(line);
					if (buffer.bytes >= 64 * 1024) await flush(name);
				},
				catch: (cause) =>
					snapshotFailure(
						"package-text.stage",
						"The package text staging operation failed.",
						cause
					)
			});
		const requested = new Map<string, PackageTextInventoryEntry>();
		for (const shard of changed)
			for (const { entry, selected } of shard.entries) {
				if (selected) requested.set(entry.path, entry);
				else {
					yield* append({
						path: entry.path,
						signature: entry.signature,
						evidence: { event: "not_gatherable", path: entry.path }
					});
					completed++;
				}
			}
		report();
		const received = new Set<string>();
		if (requested.size)
			yield* input.read([...requested.keys()]).pipe(
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						if (event.event === "text_summary") return;
						const entry = requested.get(event.path);
						if (!entry || received.has(event.path))
							return yield* Effect.fail(
								snapshotFailure(
									"package-text.read",
									"Unexpected or duplicate package"
								)
							);
						received.add(event.path);
						yield* append({
							path: event.path,
							signature: entry.signature,
							evidence: event
						});
						completed++;
						report();
					})
				)
			);
		if (received.size !== requested.size)
			return yield* Effect.fail(
				snapshotFailure("package-text.read", "Reader omitted requested packages")
			);
		yield* Effect.tryPromise({
			try: async () => {
				for (const name of buffers.keys()) await flush(name);
			},
			catch: (cause) =>
				snapshotFailure(
					"package-text.stage",
					"The package text staging operation failed.",
					cause
				)
		});
		// Reading includes the reader's own work and staging the records it returns.
		stages.mark("read");
		const result = yield* importColdPackageTextShards(
			{ inventory, recordDirectory: directory, stagingRoot: directory },
			selection
		).pipe(
			Effect.provideService(
				SharedIndex,
				SharedIndex.of({
					...store,
					writer: () => Effect.succeed(writer),
					inspect: () => Effect.succeed(writer.manifest())
				})
			)
		);
		stages.mark("import");
		yield* Effect.annotateCurrentSpan({
			"package-text.readPackages": requested.size,
			...stages.attributes("package-text.stage_ms")
		});
		return {
			readPackages: requested.size,
			reusedPackages: inventory.length - requested.size,
			changedShards: changed.length,
			removedShards: removed.length,
			published: true,
			profile: result.profile
		};
	}
	const sources: ColdLayerSource[] = [];
	// A cold build must release each shard's authored objects before reading the next shard.
	// Disk-backed sources retain the atomic dictionary/root publication without retaining the corpus.
	const staged =
		changed.length > 8
			? yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: async () => {
							const root = Option.isSome(session)
								? join(session.value.configuration.cacheRoot, "staging")
								: tmpdir();
							await mkdir(root, { recursive: true });
							const readers: SnapshotFileReader[] = [];
							return {
								directory: await mkdtemp(join(root, "package-refresh-")),
								readers
							};
						},
						catch: (cause) =>
							snapshotFailure(
								"package-text.stage",
								"The package text staging operation failed.",
								cause
							)
					}),
					(value) =>
						Effect.promise(async () => {
							await Promise.all(value.readers.map((reader) => reader.close()));
							await rm(value.directory, { recursive: true, force: true });
						})
				)
			: undefined;
	let readPackages = 0;
	for (const shard of changed) {
		// A shard written in an older column format is read again rather than decoded.
		const old =
			reader && manifest.active[shard.name]?.startsWith(`${PACKAGE_TEXT_FORMAT}:`)
				? yield* decodePackageTextColumns(yield* reader.layer(shard.name))
				: [];
		const byPath = new Map(old.map((record) => [record.path, record]));
		const next: PackageTextStored[] = [],
			requests: string[] = [];
		const signatures = new Map<string, string>();
		for (const { entry, selected } of shard.entries) {
			const prior = byPath.get(entry.path);
			if (
				prior &&
				prior.signature === entry.signature &&
				selected === (prior.evidence.event !== "not_gatherable")
			) {
				next.push(prior);
				continue;
			}
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
		const received = new Set<string>();
		completed += shard.entries.length - requests.length;
		report();
		if (requests.length)
			yield* input.read(requests).pipe(
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						if (event.event === "text_summary") return;
						const signature = signatures.get(event.path);
						if (signature === undefined || received.has(event.path))
							return yield* Effect.fail(
								snapshotFailure(
									"package-text.read",
									"Unexpected or duplicate package"
								)
							);
						received.add(event.path);
						next.push({ path: event.path, signature, evidence: event });
						readPackages++;
						completed++;
						report();
					})
				)
			);
		if (received.size !== requests.length)
			return yield* Effect.fail(
				snapshotFailure("package-text.read", "Reader omitted requested packages")
			);
		next.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		if (staged) {
			const file = yield* Effect.tryPromise({
				try: async () => {
					const path = join(staged.directory, `${shard.name}.snapshot`);
					await writeSnapshotFile(path, packageTextColumns(next), 1);
					return openSnapshotFile(path);
				},
				catch: (cause) =>
					snapshotFailure(
						"package-text.stage",
						"The package text staging operation failed.",
						cause
					)
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
		} else sources.push({ name: shard.name, key: shard.key, source: packageTextColumns(next) });
	}
	// Reading includes the reader's own work and each shard's staging.
	stages.mark("read");
	reportProgress({ phase: "package_publish", completed: 0, total: 0 });
	if (!Object.keys(manifest.layers).length || sources.length > 8)
		yield* writer.publishCold(sources, removed);
	else yield* writer.publishBatch(sources, removed);
	stages.mark("publish");
	yield* Effect.annotateCurrentSpan({
		"package-text.readPackages": readPackages,
		"package-text.changedShards": changed.length,
		"package-text.removedShards": removed.length,
		...stages.attributes("package-text.stage_ms")
	});
	return {
		readPackages,
		reusedPackages: inventory.length - readPackages,
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
export const textCorpusFromPackageTextLayer = Effect.fn("PackageText.oracleCorpus")(function* (
	projectRoot: string
) {
	const reader = yield* (yield* SharedIndex).open();
	const records: PackageTextStored[] = [];
	for (const name of Object.keys(reader.manifest.active).filter((name) =>
		name.startsWith("package-text.")
	))
		records.push(...(yield* decodePackageTextColumns(yield* reader.layer(name))));
	// Shards are a storage partition, not the native reader's package emission order.
	records.sort((a, b) => comparePackageTextPathBytes(encodeWtf8(a.path), encodeWtf8(b.path)));
	const corpus = textCorpusFromExtractionEvents({
		projectRoot,
		discoveredPackages: records.length,
		events: records.flatMap((record) =>
			record.evidence.event === "not_gatherable"
				? []
				: [{ ...record.evidence, path: resolve(projectRoot, record.path) }]
		)
	});
	return textCorpusWithExcludedPackages(
		corpus,
		records
			.filter((record) => record.evidence.event === "not_gatherable")
			.map((record) => relative(projectRoot, resolve(projectRoot, record.path)))
	);
});
