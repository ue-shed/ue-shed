import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, unlink, mkdtemp, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Context, Effect, Layer, Schema, Result, Semaphore, type Scope } from "effect";
import {
	decodeStringBlock,
	snapshotCheck,
	SnapshotFormatError,
	snapshotFailure
} from "./snapshot-format.js";
import {
	openSnapshotFile,
	writeSnapshotFile,
	type SnapshotSource,
	type SnapshotSourceColumn,
	type SnapshotFileReader
} from "./snapshot-file.js";
import {
	SnapshotStore,
	SnapshotStoreError,
	snapshotStoreNodeLayer,
	snapshotStoreDirectory,
	type SnapshotStoreOptions,
	type SnapshotReader
} from "./snapshot-store.js";
import { SharedStringFiles, SharedSegment, maximumSharedSegments } from "./shared-string-file.js";
import { sortColdStrings, FileReuse, type ColdLayerSource } from "./shared-string-sort.js";
import {
	StringArena,
	absentId,
	sortBytes,
	comparePacked,
	type PackedStrings
} from "./shared-string-codec.js";

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const LayerRecord = Schema.Struct({
	file: Schema.String.check(Schema.isPattern(/^layer-[a-f0-9-]+\.snapshot$/u)),
	key: Schema.String.check(Schema.isMaxLength(1024)),
	storeGeneration: Schema.String,
	segmentCount: Natural,
	bytes: Natural,
	stringColumns: Schema.Record(Schema.String, Schema.String),
	idEncoding: Schema.optionalKey(Schema.Literal("delta32"))
});
export type SharedLayerRecord = typeof LayerRecord.Type;
const Index = Schema.Struct({
	version: Schema.Literal(2),
	generation: Schema.String,
	garbageUpperBytes: Schema.optionalKey(Natural),
	active: Schema.Record(Schema.String, Schema.String),
	segments: Schema.Array(SharedSegment).check(Schema.isMaxLength(maximumSharedSegments)),
	layers: Schema.Record(Schema.String, LayerRecord)
});
export type SharedIndexManifest = typeof Index.Type;
type Failure = SnapshotStoreError | SnapshotFormatError;
const boundary = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause): Failure =>
			cause instanceof SnapshotFormatError || cause instanceof SnapshotStoreError
				? cause
				: new SnapshotStoreError({
						operation,
						code: "unavailable",
						message: String(cause),
						recovery: "Reopen or rebuild the disposable shared index."
					})
	}).pipe(Effect.uninterruptible);
const initial = (): SharedIndexManifest => ({
	version: 2,
	generation: randomUUID(),
	garbageUpperBytes: 0,
	active: {},
	segments: [],
	layers: {}
});
const configuration = (options: SnapshotStoreOptions) => ({
	...options,
	targetKey: `shared-index-v2:${options.targetKey}`
});
export const sharedIndexDirectory = (options: SnapshotStoreOptions) =>
	snapshotStoreDirectory(configuration(options));

export interface SharedIndexReader {
	readonly manifest: SharedIndexManifest;
	readonly metrics: () => {
		readBytes: number;
		blocksLoaded: number;
		columnLoadMs: number;
		idDecodeMs: number;
		idValidateMs: number;
		decodedBlocks: number;
		decodedBytes: number;
		decodedHits: number;
		decodedMisses: number;
	};
	readonly layer: (
		name: string
	) => Effect.Effect<
		Pick<SnapshotReader, "directory" | "section" | "strings">,
		Failure,
		Scope.Scope
	>;
	readonly strings: (ids: readonly number[]) => Effect.Effect<string[], Failure>;
	readonly domain: (
		domain: string
	) => Effect.Effect<Awaited<ReturnType<SharedStringFiles["domain"]>>, Failure>;
	readonly range: (
		prefix: string
	) => Effect.Effect<Awaited<ReturnType<SharedStringFiles["range"]>>, Failure>;
}
export interface SharedIndexWriter {
	/** Replace several active layers and remove retired names in one root publication. */
	readonly publishBatch: (
		entries: readonly ColdLayerSource[],
		removedNames?: readonly string[]
	) => Effect.Effect<readonly SharedLayerRecord[], Failure>;
	/** One atomic cold target publication, with a single external dictionary sort. */
	readonly publishCold: (
		entries: readonly ColdLayerSource[],
		removedNames?: readonly string[]
	) => Effect.Effect<readonly SharedLayerRecord[], Failure>;
	readonly manifest: () => SharedIndexManifest;
	readonly metrics: () => {
		readBytes: number;
		indexReadBytes: number;
		appendedBytes: number;
		lookupStrings: number;
		reusedStrings: number;
		probePasses: number;
		sortMs: number;
		probeMs: number;
		appendMs: number;
		segments: number;
		timings: SharedStringFiles["timings"];
	};
	readonly publish: (
		name: string,
		key: string,
		source: SnapshotSource,
		previousKey?: string
	) => Effect.Effect<SharedLayerRecord, Failure>;
	readonly compact: (
		force?: boolean
	) => Effect.Effect<{ compacted: boolean; deadBytes: number; totalBytes: number }, Failure>;
}
export class SharedIndex extends Context.Service<
	SharedIndex,
	{
		readonly inspect: () => Effect.Effect<SharedIndexManifest, Failure, Scope.Scope>;
		readonly cached: (key: string) => Effect.Effect<SharedLayerRecord, Failure, Scope.Scope>;
		readonly open: () => Effect.Effect<SharedIndexReader, Failure, Scope.Scope>;
		readonly writer: () => Effect.Effect<SharedIndexWriter, Failure, Scope.Scope>;
	}
>()("@ue-shed/game-text/SharedIndex") {}

function readIndex(reader: SnapshotReader) {
	if ((reader.directory.entries.get("index.meta")?.rawLength ?? Infinity) > 16 * 1024 ** 2)
		return Effect.fail(snapshotFailure("index.meta", "Shared root exceeds 16 MiB"));
	return reader
		.section("index.meta")
		.pipe(
			Effect.flatMap((bytes) =>
				Schema.decodeUnknownEffect(Schema.fromJsonString(Index))(
					new TextDecoder().decode(bytes)
				).pipe(Effect.mapError((cause) => snapshotFailure("index.meta", String(cause))))
			)
		);
}

/** One lock and atomic root for segments and every layer; individual cache keys remain independent. */
export function sharedIndexNodeLayer(options: SnapshotStoreOptions) {
	const directory = sharedIndexDirectory(options);
	return Layer.effect(
		SharedIndex,
		Effect.gen(function* () {
			const store = yield* SnapshotStore;
			const read = Effect.fn("SharedIndex.read")(function* () {
				const root = yield* store.open();
				return yield* readIndex(root);
			});
			const cached = Effect.fn("SharedIndex.cached")(function* (key: string) {
				const manifest = yield* read();
				return yield* boundary("cached", () =>
					validateCachedLayer(directory, manifest, key, options.onRead)
				);
			});
			const openOnce = Effect.fn("SharedIndex.open")(function* () {
				const manifest = yield* read();
				const files = yield* Effect.acquireRelease(
					boundary("segments", () =>
						new SharedStringFiles(directory, manifest.segments).open()
					),
					(files) => Effect.promise(() => files.close())
				);
				const layers = yield* Effect.acquireRelease(
					boundary("layers", async () => {
						const opened = new Map<string, SnapshotFileReader>();
						try {
							for (const [key, record] of Object.entries(manifest.layers)) {
								snapshotCheck(
									record.storeGeneration === manifest.generation &&
										record.segmentCount <= manifest.segments.length,
									"layer",
									"Layer store dependency differs"
								);
								const file = await openSnapshotFile(join(directory, record.file));
								opened.set(key, file);
								snapshotCheck(
									file.directory.fileLength === record.bytes,
									"layer",
									"Layer size differs"
								);
							}
							return opened;
						} catch (cause) {
							for (const file of opened.values()) await file.close();
							throw cause;
						}
					}),
					(layers) =>
						Effect.promise(async () => {
							for (const file of layers.values()) await file.close();
						})
				);
				const columns = new Map<string, Uint8Array | Uint32Array>();
				const columnTimings = { columnLoadMs: 0, idDecodeMs: 0, idValidateMs: 0 };
				let active = true;
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						active = false;
						columns.clear();
					})
				);
				const layer = Effect.fn("SharedIndex.layer")(function* (name: string) {
					const key = Object.hasOwn(manifest.active, name)
							? manifest.active[name]!
							: name,
						record = Object.hasOwn(manifest.layers, key)
							? manifest.layers[key]
							: undefined;
					if (!record)
						return yield* Effect.fail(
							new SnapshotStoreError({
								operation: "layer",
								code: "missing",
								message: "Layer is absent.",
								recovery: "Import this input."
							})
						);
					const file = layers.get(key)!;
					const end = manifest.segments[record.segmentCount - 1];
					const maximumId = end ? end.start + end.count : 0;
					return {
						directory: file.directory,
						section: Effect.fn("SharedIndex.section")((name: string) =>
							boundary("section", async () => {
								snapshotCheck(active, name, "Shared reader scope is closed");
								const cached = columns.get(`${key}:${name}`);
								if (cached) return cached;
								const values = await readLayerColumn(
									file,
									record,
									name,
									(timings) => {
										columnTimings.columnLoadMs += timings.columnLoadMs;
										columnTimings.idDecodeMs += timings.idDecodeMs;
									}
								);
								const validating = performance.now();
								if (record.stringColumns[name])
									for (let row = 0; row < values.length; row++)
										snapshotCheck(
											values[row]! < maximumId,
											name,
											"Shared ID outside layer dependency"
										);
								columnTimings.idValidateMs += performance.now() - validating;
								columns.set(`${key}:${name}`, values);
								return values;
							})
						),
						strings: Effect.fn("SharedIndex.strings")(
							(_domain: string, ids: readonly number[]) =>
								boundary("strings", () => files.strings(ids))
						)
					};
				});
				return {
					manifest,
					metrics: () => ({
						readBytes: files.readBytes,
						blocksLoaded: files.blocksLoaded,
						...columnTimings,
						...files.cacheMetrics()
					}),
					layer,
					strings: Effect.fn("SharedIndex.strings")((ids: readonly number[]) =>
						boundary("strings", () => files.strings(ids))
					),
					domain: Effect.fn("SharedIndex.domain")((domain: string) =>
						boundary("domain", () => files.domain(domain))
					),
					range: Effect.fn("SharedIndex.range")((prefix: string) =>
						boundary("range", () => files.range(prefix))
					)
				};
			});
			const open = Effect.fn("SharedIndex.openRetained")(function* () {
				for (let attempt = 0; ; attempt++) {
					const result = yield* openOnce().pipe(Effect.result);
					if (Result.isSuccess(result)) return result.success;
					// Retirement can race the interval between reading the root and opening every handle.
					if (
						attempt >= 2 ||
						!(result.failure instanceof SnapshotStoreError) ||
						!result.failure.message.includes("ENOENT")
					)
						return yield* Effect.fail(result.failure);
				}
			});
			const writer = Effect.fn("SharedIndex.writer")(function* () {
				const rootWriter = yield* store.writer();
				const opened = yield* read().pipe(Effect.result);
				if (
					Result.isFailure(opened) &&
					(!(opened.failure instanceof SnapshotStoreError) ||
						opened.failure.code !== "missing")
				)
					return yield* Effect.fail(opened.failure);
				let manifest = Result.isSuccess(opened) ? opened.success : initial();
				let files: SharedStringFiles = yield* Effect.acquireRelease(
					boundary("segments", () =>
						new SharedStringFiles(directory, manifest.segments).open()
					),
					() => Effect.promise(() => files.close())
				);
				const mutex = yield* Semaphore.make(1);
				const retiredMetrics = {
					readBytes: 0,
					indexReadBytes: 0,
					appendedBytes: 0,
					lookupStrings: 0,
					reusedStrings: 0,
					probePasses: 0
				};
				let active = true,
					uncertain = false;
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						active = false;
					})
				);
				const publishRoot = Effect.fn("SharedIndex.publishRoot")(function* (
					next: SharedIndexManifest
				) {
					const started = performance.now();
					yield* Schema.decodeUnknownEffect(Index)(next).pipe(
						Effect.mapError((cause) => snapshotFailure("index.meta", String(cause)))
					);
					const bytes = new TextEncoder().encode(JSON.stringify(next));
					if (bytes.length > 16 * 1024 ** 2)
						return yield* Effect.fail(
							snapshotFailure("index.meta", "Shared root exceeds 16 MiB")
						);
					uncertain = true;
					yield* rootWriter.publish(
						{
							columns: [
								{ name: "index.meta", kind: "bytes", load: async () => bytes }
							]
						},
						{ generation: next.generation }
					);
					manifest = next;
					uncertain = false;
					files.timings.rootPublishMs += performance.now() - started;
				});
				const guard = () =>
					snapshotCheck(
						active && !uncertain,
						"writer",
						"Writer is closed or publication outcome is uncertain"
					);
				const publishOne = Effect.fn("SharedIndex.publish")(
					(name: string, key: string, source: SnapshotSource, previousKey?: string) =>
						Effect.gen(function* () {
							yield* boundary("writer", async () => guard());
							const old = manifest.layers[manifest.active[name] ?? previousKey ?? ""];
							const existing = Object.hasOwn(manifest.layers, key)
								? yield* boundary("cached", () =>
										validateCachedLayer(
											directory,
											manifest,
											key,
											options.onRead
										)
									).pipe(Effect.result)
								: undefined;
							if (existing && Result.isSuccess(existing)) {
								if (manifest.active[name] === key) return manifest.layers[key]!;
								const possible = old
									? yield* boundary("garbage", () =>
											obsoleteBytes(
												directory,
												files,
												old,
												manifest.layers[key]!
											)
										)
									: 0;
								uncertain = true;
								yield* publishRoot({
									...manifest,
									garbageUpperBytes: (manifest.garbageUpperBytes ?? 0) + possible,
									active: { ...manifest.active, [name]: key }
								});
								uncertain = false;
								return manifest.layers[key]!;
							}
							const layer = yield* boundary("layer", () =>
								convertLayer(
									directory,
									files,
									name,
									key,
									manifest.generation,
									source,
									old
								)
							);
							const possible =
								old && old.key !== key
									? yield* boundary("garbage", () =>
											obsoleteBytes(directory, files, old, layer)
										)
									: 0;
							uncertain = true;
							yield* publishRoot({
								...manifest,
								garbageUpperBytes: (manifest.garbageUpperBytes ?? 0) + possible,
								active: { ...manifest.active, [name]: key },
								segments: [...files.segments],
								layers: { ...manifest.layers, [key]: layer }
							});
							uncertain = false;
							return layer;
						}).pipe(Effect.uninterruptible)
				);
				const compactOne = Effect.fn("SharedIndex.compact")((force = false) =>
					Effect.gen(function* () {
						yield* boundary("writer", async () => guard());
						const upper = manifest.garbageUpperBytes ?? 0;
						const total = manifest.segments.reduce(
							(sum, segment) => sum + segment.utf8Bytes,
							0
						);
						const segmentLimit = files.segments.length >= maximumSharedSegments;
						if (!force && !segmentLimit && (upper < 8 * 1024 ** 2 || upper < total / 4))
							return { compacted: false, deadBytes: 0, totalBytes: total };
						const usage = yield* boundary("compaction.census", () =>
							liveStrings(directory, manifest, (bytes) => {
								files.readBytes += bytes;
							})
						);
						const { deadBytes, totalBytes } = yield* boundary(
							"compaction.bytes",
							async () => {
								let deadBytes = 0,
									totalBytes = 0;
								for (let begin = 0; begin < files.count; begin += 8192) {
									const ids = Array.from(
										{ length: Math.min(8192, files.count - begin) },
										(_, row) => begin + row
									);
									const strings = await files.bytes(ids);
									for (let row = 0; row < ids.length; row++) {
										const id = ids[row]!,
											length = strings[row]!.length;
										totalBytes += length;
										if (!(usage[id >>> 3]! & (1 << (id & 7))))
											deadBytes += length;
									}
								}
								return { deadBytes, totalBytes };
							}
						);
						if (
							!force &&
							!segmentLimit &&
							(deadBytes < 8 * 1024 ** 2 || deadBytes < totalBytes / 4)
						) {
							yield* publishRoot({ ...manifest, garbageUpperBytes: deadBytes });
							return { compacted: false, deadBytes, totalBytes };
						}
						const fresh = yield* boundary("compaction", () =>
							new SharedStringFiles(directory, []).open()
						);
						try {
							const next = initial();
							const mapping = yield* boundary("compaction.strings", async () => {
								const map = new Uint32Array(files.count),
									arena = new StringArena(totalBytes - deadBytes, files.count),
									live = new Uint32Array(files.count),
									owners = new Uint32Array(files.count);
								const domains = [
									...new Set(files.segments.flatMap((segment) => segment.domains))
								];
								let count = 0;
								for (let segment = 0; segment < files.segments.length; segment++) {
									const meta = files.segments[segment]!,
										ownership = await files.ownership(segment);
									for (let begin = 0; begin < meta.count; begin += 8192) {
										const ids: number[] = [];
										for (
											let row = begin;
											row < Math.min(meta.count, begin + 8192);
											row++
										) {
											const id = meta.start + row;
											if (usage[id >>> 3]! & (1 << (id & 7))) ids.push(id);
										}
										const strings = await files.bytes(ids);
										for (let row = 0; row < ids.length; row++) {
											const id = ids[row]!;
											arena.add(strings[row]!);
											live[count] = id;
											owners[count++] = domains.indexOf(
												meta.domains[ownership?.[id - meta.start] ?? 0]!
											);
										}
									}
								}
								const inverse = await fresh.merged(
									arena.finish(),
									owners.subarray(0, count),
									domains
								);
								for (let row = 0; row < count; row++)
									map[live[row]!] = inverse[row]!;
								return map;
							});
							const layers: Record<string, SharedLayerRecord> = {};
							for (const key of new Set(Object.values(manifest.active))) {
								const layer = manifest.layers[key]!;
								layers[key] = yield* boundary("compaction.layer", async () => {
									const reader = await openSnapshotFile(
										join(directory, layer.file),
										{
											onRead: (bytes) => {
												fresh.readBytes += bytes;
											}
										}
									);
									try {
										return await remapLayer(
											directory,
											reader,
											mapping,
											fresh,
											layer,
											next.generation
										);
									} finally {
										await reader.close();
									}
								});
							}
							uncertain = true;
							yield* publishRoot({
								...next,
								active: manifest.active,
								segments: [...fresh.segments],
								layers
							});
							uncertain = false;
							yield* boundary("compaction.close", () => files.close());
							retiredMetrics.readBytes += files.readBytes;
							retiredMetrics.indexReadBytes += files.indexReadBytes;
							retiredMetrics.appendedBytes += files.appendedBytes;
							retiredMetrics.lookupStrings += files.lookupStrings;
							retiredMetrics.reusedStrings += files.reusedStrings;
							retiredMetrics.probePasses += files.probePasses;
							files = fresh;
							yield* retireSharedIndexFiles(directory, manifest);
						} finally {
							if (files !== fresh)
								yield* boundary("compaction.close", () => fresh.close());
						}
						return { compacted: true, deadBytes, totalBytes };
					}).pipe(Effect.uninterruptible)
				);
				const compact = Effect.fn("SharedIndex.compactLocked")((force = false) =>
					mutex.withPermits(1)(compactOne(force))
				);
				const publish = Effect.fn("SharedIndex.publishAndCompact")(
					(name: string, key: string, source: SnapshotSource, previousKey?: string) =>
						mutex.withPermits(1)(
							Effect.gen(function* () {
								const domains = new Set(
									source.columns
										.filter((column) => column.kind === "strings")
										.map((column) => column.domain)
								);
								if (files.segments.length + domains.size > maximumSharedSegments)
									yield* compactOne(true);
								yield* publishOne(name, key, source, previousKey);
								yield* compactOne();
								return manifest.layers[key]!;
							}).pipe(Effect.uninterruptible)
						)
				);
				const publishCold = Effect.fn("SharedIndex.publishCold")(
					(entries: readonly ColdLayerSource[], removedNames: readonly string[] = []) =>
						mutex.withPermits(1)(
							Effect.gen(function* () {
								yield* boundary("writer", async () => {
									guard();
									const names = new Set(entries.map((entry) => entry.name));
									snapshotCheck(
										names.size === entries.length,
										"cold",
										"Duplicate cold layer names"
									);
								});
								const staging = yield* boundary("cold.sort", () =>
									mkdtemp(join(directory, "sort-"))
								);
								try {
									const maps = yield* boundary("cold.sort", () =>
										sortColdStrings(entries, files, staging)
									);
									const layers = { ...manifest.layers },
										active = { ...manifest.active };
									for (let row = 0; row < entries.length; row++) {
										const entry = entries[row]!;
										layers[entry.key] = yield* boundary("cold.layer", () =>
											convertLayer(
												directory,
												files,
												entry.name,
												entry.key,
												manifest.generation,
												entry.source,
												undefined,
												maps[row]!.maps,
												maps[row]!.hashes
											)
										);
										active[entry.name] = entry.key;
									}
									for (const name of removedNames) delete active[name];
									yield* publishRoot({
										...manifest,
										active,
										layers,
										segments: [...files.segments]
									});
									return entries.map((entry) => layers[entry.key]!);
								} finally {
									yield* boundary("cold.cleanup", () =>
										rm(staging, { recursive: true, force: true })
									);
								}
							}).pipe(Effect.uninterruptible)
						)
				);
				const publishBatch = Effect.fn("SharedIndex.publishBatch")(
					(entries: readonly ColdLayerSource[], removedNames: readonly string[] = []) =>
						mutex.withPermits(1)(
							Effect.gen(function* () {
								yield* boundary("writer", async () => guard());
								const domains = new Set(
									entries.flatMap((entry) =>
										entry.source.columns
											.filter((column) => column.kind === "strings")
											.map((column) => column.domain)
									)
								);
								if (
									files.segments.length + domains.size * entries.length >
									maximumSharedSegments
								)
									yield* compactOne(true);
								const active = { ...manifest.active },
									layers = { ...manifest.layers };
								let garbage = manifest.garbageUpperBytes ?? 0;
								const records: SharedLayerRecord[] = [];
								for (const entry of entries) {
									if (
										files.segments.length + domains.size >
										maximumSharedSegments
									)
										return yield* Effect.fail(
											snapshotFailure(
												"batch",
												"Batch exceeds segment cap; use cold publication"
											)
										);
									const old = layers[active[entry.name] ?? ""];
									const record = yield* boundary("batch.layer", () =>
										convertLayer(
											directory,
											files,
											entry.name,
											entry.key,
											manifest.generation,
											entry.source,
											old
										)
									);
									if (old)
										garbage += yield* boundary("batch.garbage", () =>
											obsoleteBytes(directory, files, old, record)
										);
									layers[entry.key] = record;
									active[entry.name] = entry.key;
									records.push(record);
								}
								for (const name of removedNames) delete active[name];
								yield* publishRoot({
									...manifest,
									active,
									layers,
									garbageUpperBytes: garbage,
									segments: [...files.segments]
								});
								return records;
							}).pipe(Effect.uninterruptible)
						)
				);
				// Immutable files are retained until explicit retirement; open handles survive unlink.
				return {
					publishCold,
					publishBatch,
					publish,
					compact,
					manifest: () => manifest,
					metrics: () => ({
						readBytes: retiredMetrics.readBytes + files.readBytes,
						indexReadBytes: retiredMetrics.indexReadBytes + files.indexReadBytes,
						appendedBytes: retiredMetrics.appendedBytes + files.appendedBytes,
						lookupStrings: retiredMetrics.lookupStrings + files.lookupStrings,
						reusedStrings: retiredMetrics.reusedStrings + files.reusedStrings,
						probePasses: retiredMetrics.probePasses + files.probePasses,
						sortMs: files.sortMs,
						probeMs: files.probeMs,
						appendMs: files.appendMs,
						segments: files.segments.length,
						timings: { ...files.timings }
					})
				};
			});

			async function obsoleteBytes(
				directory: string,
				files: SharedStringFiles,
				old: SharedLayerRecord,
				next: SharedLayerRecord
			) {
				const started = performance.now();
				const referenced = new Uint8Array(Math.ceil(files.count / 8));
				const newer = await openSnapshotFile(join(directory, next.file), {
					onRead: (bytes) => {
						files.readBytes += bytes;
					}
				});
				try {
					for (const name of Object.keys(next.stringColumns))
						for (const id of await readLayerColumn(newer, next, name))
							referenced[id >>> 3]! |= 1 << (id & 7);
				} finally {
					await newer.close();
				}
				const previous = await openSnapshotFile(join(directory, old.file), {
					onRead: (bytes) => {
						files.readBytes += bytes;
					}
				});
				const candidates: number[] = [];
				try {
					for (const name of Object.keys(old.stringColumns))
						for (const id of await readLayerColumn(previous, old, name)) {
							const mask = 1 << (id & 7);
							if (!(referenced[id >>> 3]! & mask)) {
								candidates.push(id);
								referenced[id >>> 3]! |= mask;
							}
						}
				} finally {
					await previous.close();
				}
				let bytes = 0;
				for (let start = 0; start < candidates.length; start += 8192)
					for (const value of await files.bytes(candidates.slice(start, start + 8192)))
						bytes += value.length;
				files.timings.garbageMs += performance.now() - started;
				return bytes;
			}
			return { open, writer, inspect: read, cached };
		})
	).pipe(Layer.provide(snapshotStoreNodeLayer(configuration(options))));
}

async function convertLayer(
	directory: string,
	files: SharedStringFiles,
	name: string,
	key: string,
	generation: string,
	source: SnapshotSource,
	previous?: SharedLayerRecord,
	coldMaps?: Map<string, Uint32Array>,
	coldHashes?: typeof FileReuse.Type
): Promise<SharedLayerRecord> {
	const collectStarted = performance.now();
	const arenas = new Map<string, StringArena>(),
		packed = new Map<string, PackedStrings>();
	const maps = coldMaps ?? new Map<string, Uint32Array>();
	const reusable = source.columns.some((column) => column.name === "file.meta");
	const reuseBlocks: typeof FileReuse.Type = coldHashes ?? {};
	const input = new Map<string, Uint8Array | Uint32Array>();
	for (const column of source.columns) {
		if (coldMaps) break;
		if (column.kind !== "strings") continue;
		const domain = column.domain!,
			arena = arenas.get(domain) ?? new StringArena();
		arenas.set(domain, arena);
		const bytes = await column.load();
		snapshotCheck(bytes instanceof Uint8Array, column.name, "Invalid string block");
		const block = decodeStringBlock(bytes);
		if (reusable) {
			const blocks = reuseBlocks[domain] ?? [],
				last = blocks.at(-1);
			blocks.push({
				start: last ? last.start + last.count : 0,
				count: block.count,
				hash: createHash("sha256").update(bytes).digest("hex")
			});
			reuseBlocks[domain] = blocks;
		}
		for (let row = 0; row < block.count; row++) arena.add(block.bytes(row));
	}
	for (const [domain, arena] of arenas) packed.set(domain, arena.finish());
	if (coldMaps && reusable && !coldHashes) {
		for (const column of source.columns) {
			if (column.kind !== "strings") continue;
			const bytes = await column.load();
			snapshotCheck(bytes instanceof Uint8Array, column.name, "Invalid local string block");
			const block = decodeStringBlock(bytes),
				domain = column.domain!,
				blocks = reuseBlocks[domain] ?? [],
				last = blocks.at(-1);
			blocks.push({
				start: last ? last.start + last.count : 0,
				count: block.count,
				hash: createHash("sha256").update(bytes).digest("hex")
			});
			reuseBlocks[domain] = blocks;
		}
	}
	files.timings.collectMs += performance.now() - collectStarted;
	const reuseStarted = performance.now();
	// The prior publication is indexed by file path, independent of the new content hash.
	// Its own strings already have IDs. Merge sorted local strings with that mapping;
	// only new/changed values enter the project dictionary's segment probe passes.
	if (previous) {
		snapshotCheck(
			previous.storeGeneration === generation &&
				previous.segmentCount <= files.segments.length,
			"layer",
			"Previous layer dependency differs"
		);
		const reader = await openSnapshotFile(join(directory, previous.file), {
			onRead: (bytes) => {
				files.readBytes += bytes;
			}
		}).catch((cause: unknown) => {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
				return undefined;
			throw cause;
		});
		try {
			let seeded = false;
			if (reader && reusable && reader.directory.entries.has("reuse.meta")) {
				snapshotCheck(
					reader.directory.entries.get("reuse.meta")!.rawLength <= 16 * 1024 ** 2,
					"reuse",
					"Reuse metadata exceeds cap"
				);
				const oldBlocks = Schema.decodeUnknownSync(Schema.fromJsonString(FileReuse))(
					new TextDecoder().decode(await reader.load("reuse.meta"))
				);
				let total = 0,
					unresolved = 0;
				for (const [domain, values] of packed) {
					const column = `reuse.${domain}`,
						prior = oldBlocks[domain];
					if (!prior || !previous.stringColumns[column]) {
						unresolved = Infinity;
						break;
					}
					const ids = await readLayerColumn(reader, previous, column);
					const dependency = files.segments[previous.segmentCount - 1];
					for (const id of ids)
						snapshotCheck(
							id < (dependency ? dependency.start + dependency.count : 0),
							column,
							"Previous reuse ID outside dependency"
						);
					const reuse = new Uint32Array(values.offsets.length - 1).fill(absentId);
					for (let block = 0; block < reuseBlocks[domain]!.length; block++) {
						const current = reuseBlocks[domain]![block]!,
							old = prior[block];
						if (!old || old.hash !== current.hash || old.count !== current.count)
							continue;
						snapshotCheck(
							old.start + old.count <= ids.length &&
								current.start + current.count <= reuse.length,
							column,
							"Reuse block outside map"
						);
						reuse.set(ids.subarray(old.start, old.start + old.count), current.start);
					}
					for (const id of reuse) if (id === absentId) unresolved++;
					total += reuse.length;
					maps.set(domain, reuse);
				}
				// Sparse changes benefit from block reuse; broad changes retain exact identity matching.
				seeded = unresolved * 20 <= total;
				if (!seeded) maps.clear();
				else {
					// Decode only prior blocks whose local SHA changed. Exact byte matching reuses
					// their unchanged neighbours without expanding the complete previous file.
					const sparseKnown: {
						values: PackedStrings;
						order: Uint32Array;
						ids: Uint32Array;
					}[] = [];
					for (const [domain, values] of packed) {
						const reuse = maps.get(domain)!,
							current = reuseBlocks[domain]!,
							prior = oldBlocks[domain]!,
							ids = await readLayerColumn(reader, previous, `reuse.${domain}`);
						snapshotCheck(ids instanceof Uint32Array, "reuse", "Invalid reuse column");
						const candidates: Uint32Array[] = [];
						for (let block = 0; block < current.length; block++) {
							const old = prior[block];
							if (!old || old.hash === current[block]!.hash) continue;
							snapshotCheck(
								old.start + old.count <= ids.length,
								"reuse",
								"Prior block outside map"
							);
							candidates.push(ids.subarray(old.start, old.start + old.count));
						}
						if (!candidates.length) continue;
						const known = new Uint32Array(
							candidates.reduce((n, part) => n + part.length, 0)
						);
						let count = 0;
						for (const part of candidates) {
							known.set(part, count);
							count += part.length;
						}
						known.sort();
						count = 0;
						for (const id of known)
							if (!count || known[count - 1] !== id) known[count++] = id;
						const oldIds = known.subarray(0, count),
							arena = new StringArena(0, count);
						await files.collectSorted(oldIds, arena);
						const old = arena.finish(),
							oldOrder = sortBytes(old),
							missing = new Uint32Array(
								reuse.reduce((n, id) => n + Number(id === absentId), 0)
							);
						let position = 0;
						for (let id = 0; id < reuse.length; id++)
							if (reuse[id] === absentId) missing[position++] = id;
						const order = sortBytes(values, missing);
						sparseKnown.push({ values: old, order: oldOrder, ids: oldIds });
						let cursor = 0;
						for (const id of order) {
							let comparison = 1;
							while (cursor < oldOrder.length) {
								comparison = comparePacked(old, oldOrder[cursor]!, values, id);
								if (comparison >= 0) break;
								cursor++;
							}
							if (cursor < oldOrder.length && comparison === 0)
								reuse[id] = oldIds[oldOrder[cursor]!]!;
						}
					}
					// An implicit source-equal translation becomes explicit when its source changes.
					// Its old bytes are still in the sparse source candidates and keep their ID.
					for (const [domain, values] of packed) {
						const reuse = maps.get(domain)!;
						for (let id = 0; id < reuse.length; id++) {
							if (reuse[id] !== absentId) continue;
							for (const known of sparseKnown) {
								let low = 0,
									high = known.order.length;
								while (low < high) {
									const middle = (low + high) >>> 1;
									if (
										comparePacked(
											known.values,
											known.order[middle]!,
											values,
											id
										) < 0
									)
										low = middle + 1;
									else high = middle;
								}
								if (
									low < known.order.length &&
									comparePacked(known.values, known.order[low]!, values, id) === 0
								) {
									reuse[id] = known.ids[known.order[low]!]!;
									break;
								}
							}
						}
					}
				}
			}
			if (!seeded) {
				const oldColumns = new Map<string, Uint32Array>();
				const emptyId =
					reader && files.count && (await files.strings([0]))[0] === "" ? 0 : undefined;
				if (reader)
					for (const column of Object.keys(previous.stringColumns)) {
						if (column.startsWith("reuse.")) continue;
						const ids = await readLayerColumn(reader, previous, column);
						snapshotCheck(
							ids instanceof Uint32Array,
							column,
							"Invalid previous ID column"
						);
						const dependency = files.segments[previous.segmentCount - 1];
						for (const id of ids)
							snapshotCheck(
								id < (dependency ? dependency.start + dependency.count : 0),
								column,
								"Previous ID outside dependency"
							);
						oldColumns.set(column, ids);
					}
				for (const column of source.columns)
					if (column.kind === "stringIds") input.set(column.name, await column.load());
				let matched: Int32Array | undefined;
				let priorSource:
					| { values: PackedStrings; order: Uint32Array; ids: Uint32Array }
					| undefined;
				const priority = (domain: string) =>
					domain === "identity" ? 0 : domain === "source" ? 1 : 2;
				const domains = [...packed.keys()].sort((a, b) => priority(a) - priority(b));
				if (reader)
					for (const domain of domains) {
						const values = packed.get(domain)!;
						const columns: Uint32Array[] = [];
						for (const [column, owner] of Object.entries(previous.stringColumns)) {
							if (column.startsWith("reuse.")) continue;
							if (owner !== domain) continue;
							const ids = oldColumns.get(column)!;
							if (matched && domain !== "identity") {
								const candidates = new Uint32Array(matched.length);
								let count = 0;
								for (const row of matched)
									if (row >= 0) candidates[count++] = ids[row]!;
								columns.push(candidates.subarray(0, count));
							} else columns.push(ids);
						}
						const known = new Uint32Array(
							columns.reduce((n, column) => n + column.length, 0)
						);
						let position = 0;
						for (const column of columns) {
							known.set(column, position);
							position += column.length;
						}
						known.sort();
						let count = 0;
						for (const id of known)
							if (!count || known[count - 1] !== id) known[count++] = id;
						const oldIds = known.subarray(0, count),
							oldArena = new StringArena();
						for (let start = 0; start < count; start += 8192)
							await files.collectSorted(
								oldIds.subarray(start, start + 8192),
								oldArena
							);
						const old = oldArena.finish(),
							oldOrder = priorStringOrder(old, oldIds, files.segments),
							order = sortBytes(values),
							reuse = new Uint32Array(order.length).fill(absentId);
						let prior = 0;
						for (const id of order) {
							if (
								values.offsets[id] === values.offsets[id + 1] &&
								emptyId !== undefined
							) {
								reuse[id] = emptyId;
								continue;
							}
							let comparison = 1;
							while (prior < oldOrder.length) {
								comparison = comparePacked(old, oldOrder[prior]!, values, id);
								if (comparison >= 0) break;
								prior++;
							}
							if (prior < oldOrder.length && comparison === 0)
								reuse[id] = oldIds[oldOrder[prior]!]!;
						}
						if (domain === "source")
							priorSource = { values: old, order: oldOrder, ids: oldIds };
						// Equal-to-source translations were implicit; their original source IDs are known.
						if (domain === "translation" && priorSource)
							for (const id of order) {
								if (reuse[id] !== absentId) continue;
								let low = 0,
									high = priorSource.order.length;
								while (low < high) {
									const middle = (low + high) >>> 1;
									if (
										comparePacked(
											priorSource.values,
											priorSource.order[middle]!,
											values,
											id
										) < 0
									)
										low = middle + 1;
									else high = middle;
								}
								if (
									low < priorSource.order.length &&
									comparePacked(
										priorSource.values,
										priorSource.order[low]!,
										values,
										id
									) === 0
								)
									reuse[id] = priorSource.ids[priorSource.order[low]!]!;
							}
						maps.set(domain, reuse);
						if (domain === "identity") {
							const ns = input.get("entry.namespace"),
								keys = input.get("entry.key"),
								oldNs = oldColumns.get("entry.namespace"),
								oldKeys = oldColumns.get("entry.key");
							if (ns && keys && oldNs && oldKeys) {
								matched = new Int32Array(ns.length).fill(-1);
								const oldRows = identityRows(oldNs, oldKeys),
									newRows = identityRows(ns, keys, reuse);
								let priorRow = 0;
								for (const row of newRows) {
									const namespace = reuse[ns[row]!]!,
										key = reuse[keys[row]!]!;
									if (namespace === absentId || key === absentId) continue;
									while (
										priorRow < oldRows.length &&
										(oldNs[oldRows[priorRow]!]! < namespace ||
											(oldNs[oldRows[priorRow]!] === namespace &&
												oldKeys[oldRows[priorRow]!]! < key))
									)
										priorRow++;
									const oldRow = oldRows[priorRow];
									if (
										oldRow !== undefined &&
										oldNs[oldRow] === namespace &&
										oldKeys[oldRow] === key
									) {
										matched[row] = oldRow;
										priorRow++;
									}
								}
							}
						}
					}
			}
		} finally {
			await reader?.close();
		}
	}
	files.timings.reuseMs += performance.now() - reuseStarted;
	const culture = name
		.replaceAll("\\", "/")
		.match(/\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\/[^/]+\.(?:archive|po)$/u)?.[1];
	for (const [domain, values] of packed) {
		const storageDomain =
			domain === "translation" && culture && culture.length <= 16
				? `culture.${culture}`
				: domain;
		maps.set(domain, await files.internPacked(storageDomain, values, maps.get(domain)));
	}
	const stringColumns: Record<string, string> = {},
		columns: SnapshotSourceColumn[] = [];
	for (const column of source.columns) {
		if (
			column.kind === "strings" ||
			(column.name.endsWith(".starts") && maps.has(column.name.slice(0, -7)))
		)
			continue;
		if (column.kind === "stringIds") {
			stringColumns[column.name] = column.domain!;
			const map = maps.get(column.domain!);
			snapshotCheck(
				map !== undefined && map.length === column.stringCount,
				column.name,
				"Incomplete string domain"
			);
			columns.push({
				name: column.name,
				kind: "u32",
				load: async () => {
					const values = input.get(column.name) ?? (await column.load());
					return Uint32Array.from(values, (id) => {
						snapshotCheck(id < map.length, column.name, "Invalid local ID");
						return map[id]!;
					});
				}
			});
		} else columns.push(column);
	}
	if (reusable) {
		for (const [domain, map] of maps) {
			const name = `reuse.${domain}`;
			stringColumns[name] = domain;
			columns.push({ name, kind: "u32", load: async () => map });
		}
		columns.push({
			name: "reuse.meta",
			kind: "bytes",
			load: async () => new TextEncoder().encode(JSON.stringify(reuseBlocks))
		});
	}
	return writeLayer(directory, files, key, generation, stringColumns, columns);
}

/** Numeric IDs are byte ranks inside a segment; only segment joins can break byte order. */
function priorStringOrder(
	values: PackedStrings,
	ids: Uint32Array,
	segments: readonly SharedSegment[]
) {
	for (const segment of segments.slice(1)) {
		let low = 0,
			high = ids.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (ids[middle]! < segment.start) low = middle + 1;
			else high = middle;
		}
		if (low > 0 && low < ids.length && comparePacked(values, low - 1, values, low) > 0)
			return sortBytes(values);
	}
	return Uint32Array.from(ids, (_, row) => row);
}

/** Most parser rows already follow identity ID order; validate before avoiding a second sort. */
function identityRows(
	namespace: Uint8Array | Uint32Array,
	keys: Uint8Array | Uint32Array,
	map?: Uint32Array
) {
	const order = Uint32Array.from(namespace, (_, row) => row);
	const compare = (a: number, b: number) =>
		(map?.[namespace[a]!] ?? namespace[a]!) - (map?.[namespace[b]!] ?? namespace[b]!) ||
		(map?.[keys[a]!] ?? keys[a]!) - (map?.[keys[b]!] ?? keys[b]!) ||
		a - b;
	for (let row = 1; row < namespace.length; row++)
		if (compare(row - 1, row) > 0) return order.sort(compare);
	return order;
}
async function validateCachedLayer(
	directory: string,
	manifest: SharedIndexManifest,
	key: string,
	onRead?: (bytes: number) => void
) {
	const record = Object.hasOwn(manifest.layers, key) ? manifest.layers[key] : undefined;
	if (!record)
		throw new SnapshotStoreError({
			operation: "cached",
			code: "missing",
			message: "File content is not cached.",
			recovery: "Import this file."
		});
	snapshotCheck(
		record.storeGeneration === manifest.generation &&
			record.segmentCount <= manifest.segments.length,
		"cached",
		"Invalid store dependency"
	);
	let reader: SnapshotFileReader;
	try {
		reader = await openSnapshotFile(
			join(directory, record.file),
			onRead ? { onRead } : undefined
		);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
			throw new SnapshotStoreError({
				operation: "cached",
				code: "missing",
				message: "Cached layer is absent.",
				recovery: "Import this file again."
			});
		throw cause;
	}
	try {
		snapshotCheck(
			reader.directory.fileLength === record.bytes &&
				(reader.directory.entries.get("shared.meta")?.rawLength ?? Infinity) <= 1024 ** 2,
			"cached",
			"Layer metadata or size differs"
		);
		const bytes = await reader.load("shared.meta");
		const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(LayerRecord))(
			new TextDecoder().decode(bytes)
		);
		snapshotCheck(
			JSON.stringify({ ...metadata, bytes: record.bytes }) === JSON.stringify(record),
			"cached",
			"Layer dependency differs from root"
		);
		return record;
	} finally {
		await reader.close();
	}
}
async function writeLayer(
	directory: string,
	files: SharedStringFiles,
	key: string,
	generation: string,
	stringColumns: Record<string, string>,
	columns: SnapshotSourceColumn[]
) {
	const encodeStarted = performance.now();
	const file = `layer-${randomUUID()}.snapshot`;
	const record = {
		file,
		key,
		storeGeneration: generation,
		segmentCount: files.segments.length,
		bytes: 0,
		stringColumns,
		idEncoding: "delta32" as const
	};
	columns.push({
		name: "shared.meta",
		kind: "bytes",
		load: async () => new TextEncoder().encode(JSON.stringify(record))
	});
	const encoded = columns.map(
		(column): SnapshotSourceColumn =>
			!stringColumns[column.name]
				? column
				: {
						...column,
						load: async () => {
							const ids = await column.load(),
								output = new Uint32Array(ids.length);
							let previous = 0;
							for (let row = 0; row < ids.length; row++) {
								const id = ids[row]!,
									delta = (id - previous) | 0;
								output[row] = ((delta << 1) ^ (delta >> 31)) >>> 0;
								previous = id;
							}
							return output;
						}
					}
	);
	const result = await writeSnapshotFile(join(directory, file), { columns: encoded }, 1);
	files.timings.layerEncodeMs += performance.now() - encodeStarted;
	const verifyStarted = performance.now();
	const reader = await openSnapshotFile(join(directory, file), {
		onRead: (bytes) => {
			files.readBytes += bytes;
		}
	});
	try {
		await reader.verify();
	} finally {
		await reader.close();
	}
	files.timings.layerVerifyMs += performance.now() - verifyStarted;
	return { ...record, bytes: result.fileLength };
}
async function liveStrings(
	directory: string,
	manifest: SharedIndexManifest,
	onRead?: (bytes: number) => void
) {
	const last = manifest.segments.at(-1);
	const usage = new Uint8Array(Math.ceil((last ? last.start + last.count : 0) / 8));
	for (const key of new Set(Object.values(manifest.active))) {
		const layer = manifest.layers[key]!;
		snapshotCheck(
			layer !== undefined &&
				layer.storeGeneration === manifest.generation &&
				layer.segmentCount <= manifest.segments.length,
			"compact",
			"Invalid layer dependency"
		);
		const dependency = manifest.segments[layer.segmentCount - 1];
		const maximumId = dependency ? dependency.start + dependency.count : 0;
		const reader = await openSnapshotFile(
			join(directory, layer.file),
			onRead ? { onRead } : undefined
		);
		try {
			for (const column of Object.keys(layer.stringColumns))
				for (const id of await readLayerColumn(reader, layer, column)) {
					snapshotCheck(id < maximumId, column, "Invalid shared ID");
					usage[id >>> 3]! |= 1 << (id & 7);
				}
		} finally {
			await reader.close();
		}
	}
	return usage;
}
async function remapLayer(
	directory: string,
	reader: SnapshotFileReader,
	mapping: Uint32Array,
	fresh: SharedStringFiles,
	layer: SharedLayerRecord,
	generation: string
) {
	const columns: SnapshotSourceColumn[] = [];
	for (const entry of reader.directory.entries.values()) {
		if (entry.name === "shared.meta") continue;
		const domain = layer.stringColumns[entry.name];
		if (!domain) {
			columns.push({ ...entry, load: () => reader.load(entry.name) });
			continue;
		}
		const values = await readLayerColumn(reader, layer, entry.name);
		const remapped = new Uint32Array(values.length);
		for (let row = 0; row < values.length; row++) remapped[row] = mapping[values[row]!]!;
		columns.push({ name: entry.name, kind: "u32", load: async () => remapped });
	}
	await fresh.flush();
	return writeLayer(directory, fresh, layer.key, generation, { ...layer.stringColumns }, columns);
}

async function readLayerColumn(
	reader: SnapshotFileReader,
	record: SharedLayerRecord,
	name: string,
	onTiming?: (timings: { columnLoadMs: number; idDecodeMs: number }) => void
) {
	const loading = onTiming ? performance.now() : 0;
	const values = await reader.load(name);
	const loaded = onTiming ? performance.now() : 0;
	if (record.stringColumns[name] && record.idEncoding === "delta32") {
		snapshotCheck(values instanceof Uint32Array, name, "Invalid ID column kind");
		let previous = 0;
		for (let row = 0; row < values.length; row++) {
			const encoded = values[row]!;
			previous = (previous + ((encoded >>> 1) ^ -(encoded & 1))) >>> 0;
			values[row] = previous;
		}
	}
	onTiming?.({ columnLoadMs: loaded - loading, idDecodeMs: performance.now() - loaded });
	return values;
}

/** Explicit retirement after readers have opened handles; interrupted candidates are also disposable. */
export const retireSharedIndexFiles = Effect.fn("SharedIndex.retire")(
	(directory: string, manifest: SharedIndexManifest) =>
		boundary("retire", async () => {
			const keep = new Set([
				...manifest.segments.map((segment) => segment.file),
				...Object.values(manifest.layers).map((layer) => layer.file)
			]);
			for (const name of await readdir(directory))
				if (/^(strings|layer)-[a-f0-9-]+\.snapshot$/u.test(name) && !keep.has(name))
					await unlink(join(directory, name));
		})
);
