import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
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
import { SharedStringFiles, SharedSegment } from "./shared-string-file.js";

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
	version: Schema.Literal(1),
	generation: Schema.String,
	garbageUpperBytes: Schema.optionalKey(Natural),
	active: Schema.Record(Schema.String, Schema.String),
	segments: Schema.Array(SharedSegment).check(Schema.isMaxLength(4096)),
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
	version: 1,
	generation: randomUUID(),
	garbageUpperBytes: 0,
	active: {},
	segments: [],
	layers: {}
});
const configuration = (options: SnapshotStoreOptions) => ({
	...options,
	targetKey: `shared-index-v1:${options.targetKey}`
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
}
export interface SharedIndexWriter {
	readonly manifest: () => SharedIndexManifest;
	readonly metrics: () => { readBytes: number; indexReadBytes: number; appendedBytes: number };
	readonly publish: (
		name: string,
		key: string,
		source: SnapshotSource
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
						...columnTimings
					}),
					layer,
					strings: Effect.fn("SharedIndex.strings")((ids: readonly number[]) =>
						boundary("strings", () => files.strings(ids))
					),
					domain: Effect.fn("SharedIndex.domain")((domain: string) =>
						boundary("domain", () => files.domain(domain))
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
				const retiredMetrics = { readBytes: 0, indexReadBytes: 0, appendedBytes: 0 };
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
				});
				const guard = () =>
					snapshotCheck(
						active && !uncertain,
						"writer",
						"Writer is closed or publication outcome is uncertain"
					);
				const publishOne = Effect.fn("SharedIndex.publish")(
					(name: string, key: string, source: SnapshotSource) =>
						Effect.gen(function* () {
							yield* boundary("writer", async () => guard());
							const old = manifest.layers[manifest.active[name] ?? ""];
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
									source
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
						if (!force && (upper < 8 * 1024 ** 2 || upper < total / 4))
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
								for (let segment = 0; segment < files.segments.length; segment++) {
									const meta = files.segments[segment]!;
									for (const entry of files.files[
										segment
									]!.directory.entries.values()) {
										if (entry.kind !== "strings") continue;
										const bytes = await files.files[segment]!.load(entry.name);
										snapshotCheck(
											bytes instanceof Uint8Array,
											"compact",
											"Invalid strings"
										);
										const block = decodeStringBlock(bytes),
											starts =
												await files.files[segment]!.load("text.starts");
										const blockId = Number(entry.name.slice("text.b".length));
										for (let id = 0; id < block.count; id++) {
											const length = Buffer.byteLength(block.string(id));
											totalBytes += length;
											const global = meta.start + starts[blockId]! + id;
											if (!(usage[global >>> 3]! & (1 << (global & 7))))
												deadBytes += length;
										}
									}
								}
								return { deadBytes, totalBytes };
							}
						);
						if (!force && (deadBytes < 8 * 1024 ** 2 || deadBytes < totalBytes / 4)) {
							yield* publishRoot({ ...manifest, garbageUpperBytes: deadBytes });
							return { compacted: false, deadBytes, totalBytes };
						}
						const fresh = yield* boundary("compaction", () =>
							new SharedStringFiles(directory, []).open()
						);
						try {
							const next = initial();
							const mapping = yield* boundary("compaction.strings", async () => {
								const map = new Uint32Array(files.count);
								for (let segment = 0; segment < files.segments.length; segment++) {
									const meta = files.segments[segment]!,
										reader = files.files[segment]!;
									const starts = await reader.load("text.starts");
									for (const entry of reader.directory.entries.values()) {
										if (entry.kind !== "strings") continue;
										const bytes = await reader.load(entry.name);
										snapshotCheck(
											bytes instanceof Uint8Array,
											"compact",
											"Invalid block"
										);
										const block = decodeStringBlock(bytes),
											base =
												meta.start + starts[Number(entry.name.slice(6))]!;
										const live: number[] = [],
											strings: string[] = [];
										for (let id = 0; id < block.count; id++) {
											const global = base + id;
											if (usage[global >>> 3]! & (1 << (global & 7))) {
												live.push(global);
												strings.push(block.string(id));
											}
										}
										const ids = await fresh.copyUnique(meta.domain, strings);
										for (let row = 0; row < live.length; row++)
											map[live[row]!] = ids[row]!;
									}
								}
								await fresh.flush();
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
					(name: string, key: string, source: SnapshotSource) =>
						mutex.withPermits(1)(
							Effect.gen(function* () {
								yield* publishOne(name, key, source);
								yield* compactOne();
								return manifest.layers[key]!;
							}).pipe(Effect.uninterruptible)
						)
				);
				// Immutable files are retained until explicit retirement; open handles survive unlink.
				return {
					publish,
					compact,
					manifest: () => manifest,
					metrics: () => ({
						readBytes: retiredMetrics.readBytes + files.readBytes,
						indexReadBytes: retiredMetrics.indexReadBytes + files.indexReadBytes,
						appendedBytes: retiredMetrics.appendedBytes + files.appendedBytes
					})
				};
			});

			async function obsoleteBytes(
				directory: string,
				files: SharedStringFiles,
				old: SharedLayerRecord,
				next: SharedLayerRecord
			) {
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
					for (const value of await files.strings(candidates.slice(start, start + 8192)))
						bytes += Buffer.byteLength(value);
				return bytes;
			}
			return { open, writer, inspect: read, cached };
		})
	).pipe(Layer.provide(snapshotStoreNodeLayer(configuration(options))));
}

async function convertLayer(
	directory: string,
	files: SharedStringFiles,
	_name: string,
	key: string,
	generation: string,
	source: SnapshotSource
): Promise<SharedLayerRecord> {
	const maps = new Map<string, Uint32Array>();
	const positions = new Map<string, number>();
	for (const column of source.columns) {
		if (column.kind !== "strings") continue;
		const domain = column.domain!;
		let map = maps.get(domain);
		if (!map) {
			map = new Uint32Array(column.stringCount!);
			maps.set(domain, map);
		}
		const bytes = await column.load();
		snapshotCheck(bytes instanceof Uint8Array, column.name, "Invalid string block");
		const block = decodeStringBlock(bytes),
			start = positions.get(domain) ?? 0;
		const values = Array.from({ length: block.count }, (_, id) => block.string(id));
		const culture = _name
			.replaceAll("\\", "/")
			.match(/\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\/[^/]+\.(?:archive|po)$/u)?.[1];
		const storageDomain =
			domain === "translation" && culture && culture.length <= 16
				? `culture.${culture}`
				: domain;
		map.set(await files.intern(storageDomain, values), start);
		positions.set(domain, start + block.count);
	}
	await files.flush();
	const stringColumns: Record<string, string> = {};
	const columns: SnapshotSourceColumn[] = [];
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
				map !== undefined && positions.get(column.domain!) === map.length,
				column.name,
				"Incomplete string domain"
			);
			columns.push({
				name: column.name,
				kind: "u32",
				load: async () => {
					const values = await column.load();
					return Uint32Array.from(values, (id) => {
						snapshotCheck(id < map.length, column.name, "Invalid local ID");
						return map[id]!;
					});
				}
			});
		} else columns.push(column);
	}
	return writeLayer(directory, files, key, generation, stringColumns, columns);
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
