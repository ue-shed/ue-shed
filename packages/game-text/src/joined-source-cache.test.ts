import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { describe, expect, it, vi } from "vitest";
import * as sourceCache from "./joined-source-cache.test-support.js";
import { decodeWtf8, encodeWtf8 } from "./wtf8.js";
import { JoinStrings } from "./joined-target-input.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";
import {
	GameTextIndexRefresh,
	GameTextIndexSource,
	gameTextIndexRefreshLayer
} from "./index-refresh.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import {
	prepareJoinedSourceCache,
	readJoinedSourceCache,
	addSourceTrigrams,
	rejectSourceTrigrams
} from "./joined-source-cache.test-support.js";

describe("persisted joined source cache", () => {
	it("rejects missing ASCII trigrams without crossing sources or rejecting short terms", () => {
		const index = new Uint8Array(128 ** 3 / 8);
		for (const value of ["hello world", "abcd", "efgh"])
			addSourceTrigrams(index, encodeWtf8(value));
		expect(rejectSourceTrigrams(index, [encodeWtf8("world")])).toBe(false);
		expect(rejectSourceTrigrams(index, [encodeWtf8("cde")])).toBe(true);
		expect(rejectSourceTrigrams(index, [encodeWtf8("unknown")])).toBe(true);
		expect(rejectSourceTrigrams(index, [encodeWtf8("xy")])).toBe(false);
		expect(rejectSourceTrigrams(index, [encodeWtf8("hello"), encodeWtf8("absent")])).toBe(true);
	});
	it("preserves empty, Unicode and lone-surrogate bytes and flags remapped IDs", () => {
		const values = ["", "lower", "Upper", "\u00e9", "\ud800", "\udc00", "\ud83d\ude00"];
		const encoded = values.map(encodeWtf8),
			starts = new Uint32Array(values.length + 1);
		let size = 0;
		for (let row = 0; row < encoded.length; row++) {
			starts[row] = size;
			size += encoded[row]!.length;
		}
		starts[values.length] = size;
		const bytes = new Uint8Array(size);
		for (let row = 0; row < encoded.length; row++) bytes.set(encoded[row]!, starts[row]!);
		// Compaction can change the order of IDs without changing the byte projection.
		const ids = Uint32Array.of(8, 2, 5, 1, 9, 4, 0);
		const cached = readJoinedSourceCache(
			{ version: 1, count: ids.length, bytes: size },
			ids,
			starts,
			bytes,
			10
		);
		expect(Array.from(cached.simple)).toEqual([1, 1, 0, 0, 0, 0, 0]);
		for (let row = 0; row < ids.length; row++) {
			expect(cached.index[ids[row]!]).toBe(row + 1);
			expect(decodeWtf8(cached.packed.bytes.subarray(starts[row], starts[row + 1]))).toBe(
				values[row]
			);
		}
	});

	it("rejects malformed IDs, ranges and WTF-8 before using a cached predicate", () => {
		const meta = { version: 1 as const, count: 2, bytes: 2 };
		const read = (ids: Uint32Array, starts: Uint32Array, bytes = Uint8Array.of(97, 98)) =>
			readJoinedSourceCache(meta, ids, starts, bytes, 4);
		expect(() => read(Uint32Array.of(1, 1), Uint32Array.of(0, 1, 2))).toThrow(
			"Invalid source cache ID"
		);
		expect(() => read(Uint32Array.of(1, 4), Uint32Array.of(0, 1, 2))).toThrow(
			"Invalid source cache ID"
		);
		expect(() => read(Uint32Array.of(1, 2), Uint32Array.of(0, 3, 2))).toThrow(
			"Invalid packed string range"
		);
		expect(() =>
			read(Uint32Array.of(1, 2), Uint32Array.of(0, 1, 2), Uint8Array.of(0xff, 98))
		).toThrow("Invalid packed WTF-8");
		expect(() => read(Uint32Array.of(1, 2), Uint32Array.of(0, 1, 1))).toThrow(
			"Invalid source cache lengths"
		);
	});

	it("publishes optional cache columns, bounds preparation and remaps their IDs on compaction", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-source-cache-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* SharedIndex,
							writer = yield* store.writer();
						const ids = yield* writer.intern("source", [
							"",
							"alpha",
							"\ud800",
							"new source"
						]);
						yield* writer.publishIds(
							"input",
							"input",
							{
								columns: [
									{
										name: "entry.source",
										kind: "stringIds",
										domain: "source",
										load: async () => ids
									}
								]
							},
							writer.manifest().generation
						);
						const reader = yield* store.open(),
							strings = new JoinStrings(reader, ids[0]!);
						yield* strings.need([ids]);
						expect(
							yield* prepareJoinedSourceCache(writer, strings, [ids])
						).toBeUndefined();
						expect(
							yield* prepareJoinedSourceCache(writer, strings, [ids], {
								minimumEntries: 0,
								maximumBytes: 3
							})
						).toBeUndefined();
						// A source synthesized during joining need not exist in the pinned reader yet.
						const fresh = yield* writer.intern("source", ["combined source"]);
						const selected = Uint32Array.from([...ids, ...fresh]);
						const prepared = yield* prepareJoinedSourceCache(
							writer,
							strings,
							[selected],
							{ minimumEntries: 0 }
						);
						if (!prepared) throw new Error("Expected source cache");
						yield* writer.publishIds(
							"joined",
							"joined",
							{ columns: prepared.columns },
							writer.manifest().generation
						);
						yield* writer.compact(true);
						const current = yield* store.open(),
							layer = yield* current.layer("joined");
						const cacheIds = yield* layer.section("query.source.ids"),
							starts = yield* layer.section("query.source.starts"),
							bytes = yield* layer.section("query.source.bytes"),
							trigrams = yield* layer.section("query.source.trigrams"),
							flags = yield* layer.section("query.source.simple");
						if (
							!(cacheIds instanceof Uint32Array) ||
							!(starts instanceof Uint32Array) ||
							!(bytes instanceof Uint8Array) ||
							!(trigrams instanceof Uint8Array) ||
							!(flags instanceof Uint8Array)
						)
							throw new Error("Invalid test cache kind");
						const last = current.manifest.segments.at(-1)!;
						const cached = readJoinedSourceCache(
							prepared.meta,
							cacheIds,
							starts,
							bytes,
							last.start + last.count,
							trigrams,
							flags
						);
						const expected = yield* current.strings(Array.from(cacheIds));
						expect(expected).toContain("combined source");
						for (let row = 0; row < cacheIds.length; row++)
							expect(
								decodeWtf8(
									cached.packed.bytes.subarray(starts[row], starts[row + 1])
								)
							).toBe(expected[row]);
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: root,
							projectKey: "source-cache-fixture",
							targetKey: "Fixture"
						})
					)
				)
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads published sources whose segments the caller has not loaded", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-source-cache-unloaded-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* SharedIndex,
							writer = yield* store.writer();
						const values = ["", "alpha", "é"],
							ids = yield* writer.intern("source", values);
						yield* writer.publishIds(
							"input",
							"input",
							{
								columns: [
									{
										name: "entry.source",
										kind: "stringIds",
										domain: "source",
										load: async () => ids
									}
								]
							},
							writer.manifest().generation
						);
						// No strings.need() here: preparation must request published segments itself.
						const strings = new JoinStrings(yield* store.open(), ids[0]!);
						const prepared = yield* prepareJoinedSourceCache(writer, strings, [ids], {
							minimumEntries: 0
						});
						expect(prepared?.meta).toMatchObject({
							count: ids.length,
							bytes: values.reduce(
								(size, value) => size + encodeWtf8(value).length,
								0
							)
						});
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: root,
							projectKey: "source-cache-unloaded-fixture",
							targetKey: "Fixture"
						})
					)
				)
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reopens cached sources after ASCII and Unicode edits while retaining the previous reader", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-cached-source-refresh-"));
		let value = "originalsource zero with enough characters for a bounded source overlay",
			signature = "first";
		const prepare = sourceCache.prepareJoinedSourceCache;
		const preparation = vi
			.spyOn(sourceCache, "prepareJoinedSourceCache")
			.mockImplementation((writer, strings, columns, options) =>
				prepare(writer, strings, columns, {
					minimumEntries: 8,
					...options
				})
			);
		const path = "Content/Text/Fixture.uasset";
		const record = (): SavedAssetPackageTextRecord => ({
			...emptyPackageTextRecord(path),
			occurrences: Array.from({ length: 24 }, (_, row) => ({
				source: row === 0 ? value : `lowercase source ${row}`,
				dev_notes: "",
				identity: { status: "resolved", namespace: "UI", key: `K${row}` },
				location: {
					kind: "asset_property",
					object_path: "/Game/Text/Fixture.Fixture",
					class_path: "/Script/Engine.DataAsset",
					property_path: `Label${row}`
				},
				edit_capability: "read_only"
			}))
		});
		const source = Layer.succeed(
			GameTextIndexSource,
			GameTextIndexSource.of({
				inventory: () =>
					Effect.succeed([
						{
							path,
							signature,
							headerData: {
								packageFlags: 0x40000,
								gatherableTextDataCount: 0,
								gatherableTextDataOffset: 0,
								hasTextProperty: false
							}
						}
					]),
				read: () => Stream.succeed(record())
			})
		);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refresh = yield* GameTextIndexRefresh;
						const first = yield* refresh.refresh({ projectRoot: root });
						expect(first.joined.meta.sourceCache?.flagsVersion).toBe(1);
						const search = (query: string) => ({
							query,
							capability: "all" as const,
							pageSize: 10
						});
						expect((yield* first.query.search(search("originalsource"))).total).toBe(1);
						expect((yield* first.query.search(search("novelcacheterm"))).total).toBe(0);
						value =
							"qzxwyv novelcacheterm with enough characters for a bounded source overlay";
						signature = "ascii";
						const changed = yield* refresh.refresh({
							projectRoot: root,
							changedFiles: [path]
						});
						expect(changed.join.strategy).toBe("incremental");
						expect((yield* changed.query.search(search("NOVELCACHETERM"))).total).toBe(
							1
						);
						expect((yield* changed.query.search(search("originalsource"))).total).toBe(
							0
						);
						expect((yield* first.query.search(search("originalsource"))).total).toBe(1);
						expect((yield* first.query.search(search("novelcacheterm"))).total).toBe(0);
						value =
							"\u0130STANBUL caf\u00e9 \ud800 with enough characters for a bounded source overlay";
						signature = "unicode";
						const unicode = yield* refresh.refresh({
							projectRoot: root,
							changedFiles: [path]
						});
						expect((yield* unicode.query.search(search("caf\u00e9"))).total).toBe(1);
						expect((yield* unicode.query.search(search("\ud800"))).total).toBe(1);
						expect((yield* changed.query.search(search("novelcacheterm"))).total).toBe(
							1
						);
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(root).pipe(
							Layer.provide(source),
							Layer.provide(typeScriptIndexBuilderLayer),
							Layer.provide(LocalizationEvidenceNodeLive)
						)
					)
				)
			);
		} finally {
			preparation.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	}, 30000);
});
