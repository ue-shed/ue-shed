import { Effect } from "effect";
import { expect, it } from "vitest";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import {
	openJoinedTarget,
	type JoinedTargetMeta
} from "../packages/game-text/src/joined-target-reader.ts";
import { synchronousJoinedTarget } from "../packages/game-text/src/joined-query-reader.ts";
import {
	JoinedQueryData,
	reuseJoinedQueryProjection
} from "../packages/game-text/src/joined-query-data.test-support.ts";
import { incrementJoinedTarget } from "../packages/game-text/src/joined-target-incremental.test-support.ts";
import { joinedPhysicalChunkName } from "../packages/game-text/src/joined-column-chunks.ts";
import { withJoinCache, joinStoreOptions } from "./columnar-join.test-support.ts";
import { target } from "../packages/game-text/src/localization.test-support.ts";
import { spliceJoinedSources } from "../packages/game-text/src/joined-source-patches.ts";

it("source-list patches reject duplicate, unordered, out-of-range and unbounded rows", () => {
	const splice = (rows: number[], offsets: number[], values: number[]) =>
		spliceJoinedSources(
			Uint32Array.of(0, 1, 2),
			Uint32Array.of(1, 2, 3),
			Uint32Array.of(1, 2, 3),
			Uint32Array.from(rows),
			Uint32Array.from(offsets),
			Uint32Array.from(values)
		);
	for (const rows of [
		[0, 0],
		[2, 0],
		[0, 3]
	])
		expect(() => splice(rows, [0, 1, 2], [1, 2])).toThrow("Invalid source patch row");
	expect(() => splice([0], [0, 0], [])).toThrow("Invalid source patch row");
	expect(() => splice([0], [0, 1], [1, 2])).toThrow("Invalid source patch lengths");
	expect(() =>
		splice(
			[0],
			[0, 8193],
			Array.from({ length: 8193 }, () => 1)
		)
	).toThrow("Invalid source patch lengths");
});

it("variable source patches span chunks and keep unpatched aliases pinned to the base", async () => {
	await withJoinCache(async (cache) => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const writer = yield* (yield* SharedIndex).writer();
					const generation = writer.manifest().generation;
					const ids = yield* writer.intern("source", ["A", "B", "C", "D"]);
					const metadata: JoinedTargetMeta = {
						version: 3,
						count: 0,
						generation,
						aliases: {
							"query.raw.source_start": "starts",
							"query.raw.source_end": "ends",
							"query.slice.source_start": "starts",
							"query.slice.source_end": "ends"
						},
						chunks: { "query.raw.sources": ["sources.chunk0", "sources.chunk1"] },
						input: { projectRoot: cache, target },
						dependencies: {},
						packageNames: [],
						packageStarts: [0],
						pairs: [],
						ambiguous: 0,
						oldCandidates: 0,
						reducedSourceChecking: []
					};
					const column = (name: string, values: Uint32Array) => ({
						name,
						kind: "u32" as const,
						load: async () => values
					});
					const bytes = (value: JoinedTargetMeta) => ({
						name: "join.meta",
						kind: "bytes" as const,
						load: async () => new TextEncoder().encode(JSON.stringify(value))
					});
					yield* writer.publishIds(
						"joined",
						"source-base",
						{
							columns: [
								column("line.source", ids.slice(0, 3)),
								column("starts", Uint32Array.of(0, 1, 2)),
								column("ends", Uint32Array.of(1, 2, 3)),
								column("sources.chunk0", ids.slice(0, 1)),
								column("sources.chunk1", ids.slice(1, 3)),
								bytes(metadata)
							]
						},
						generation
					);
					const baseline = yield* openJoinedTarget();
					const projection = reuseJoinedQueryProjection(baseline);
					const pinned = new JoinedQueryData(baseline, projection);
					pinned.prepareSources();
					const pinnedStarts = pinned.column("query.slice.source_start");
					const sourcePatches = {
						raw: {
							rows: "source.rows",
							starts: "source.starts",
							values: "source.values"
						}
					};
					yield* writer.publishIds(
						"joined",
						"source-overlay",
						{
							columns: [
								column("source.rows", Uint32Array.of(0, 2)),
								column("source.starts", Uint32Array.of(0, 2, 3)),
								column("source.values", Uint32Array.of(ids[1]!, ids[3]!, ids[0]!)),
								bytes({
									...metadata,
									version: 4,
									base: "source-base",
									sourcePatches
								})
							]
						},
						generation,
						{ "joined-base": "source-base" }
					);
					const joined = yield* openJoinedTarget();
					const decoded: number[] = [];
					const reader = {
						...joined.reader,
						bytesSync: (id: number) => {
							decoded.push(id);
							return joined.reader.bytesSync!(id);
						}
					};
					const next = reuseJoinedQueryProjection(joined, projection);
					const data = new JoinedQueryData({ ...joined, reader }, next);
					data.prepareSources();
					expect(decoded).toEqual([ids[3]]);
					expect(data.column("query.slice.source_start")).toBe(pinnedStarts);
					expect(projection.sources!.index[ids[3]!]).toBe(0);
					expect(next.sourceSeed).toBeUndefined();
					expect(data.searchSourceBytes([Buffer.from("D")])![ids[3]!]).toBe(1);
					const invalidated = reuseJoinedQueryProjection(joined, {
						...projection,
						generation: "retired-generation"
					});
					expect(invalidated.columns.size).toBe(0);
					expect(invalidated.sourceSeed).toBeUndefined();
					const expected = {
						"query.raw.sources": [ids[1]!, ids[3]!, ids[1]!, ids[0]!],
						"query.raw.source_start": [0, 2, 3],
						"query.raw.source_end": [2, 3, 4],
						"query.slice.source_start": [0, 1, 2],
						"query.slice.source_end": [1, 2, 3]
					};
					// Read patched aliases first so a cache collision cannot conceal a stale offset.
					for (const [name, values] of Object.entries(expected)) {
						expect(Array.from(yield* joined.layer.section(name)), name).toEqual(values);
						expect(Array.from(data.column(name)), `sync ${name}`).toEqual(values);
					}
				})
			).pipe(
				Effect.provide(sharedIndexNodeLayer(joinStoreOptions(cache, cache, "source-patch")))
			)
		);
	});
});

it("large path projections keep physical chunk names within the directory field", () => {
	const names = [
		"query.raw.id_utf8",
		"query.place.manifest_bytes",
		"query.place.namespace_values"
	];
	const fields = names.flatMap((name, column) =>
		[0, 1].map((part) => joinedPhysicalChunkName(name, column, part))
	);
	expect(fields.every((field) => /^[\x20-\x7e]{1,31}$/u.test(field))).toBe(true);
	expect(new Set(fields).size).toBe(fields.length);
});

it("reads and patches a logical ID arena across bounded physical sections", async () => {
	await withJoinCache(async (cache) => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const index = yield* SharedIndex,
						writer = yield* index.writer();
					const generation = writer.manifest().generation;
					const metadata = {
						version: 3,
						count: 0,
						aliases: { "state.alias": "state" },
						chunks: { "query.raw.id_utf8": ["id.chunk0", "id.chunk1"] },
						generation,
						input: { projectRoot: cache, target },
						dependencies: {},
						packageNames: [],
						packageStarts: [0],
						pairs: [],
						ambiguous: 0,
						oldCandidates: 0,
						reducedSourceChecking: []
					};
					const bytes = <A extends typeof metadata>(value: A) =>
						new TextEncoder().encode(JSON.stringify(value));
					yield* writer.publishIds(
						"joined",
						"chunk-base",
						{
							columns: [
								{
									name: "id.chunk0",
									kind: "u32",
									load: async () => Uint32Array.of(1, 2)
								},
								{
									name: "id.chunk1",
									kind: "u32",
									load: async () => Uint32Array.of(3, 4, 5)
								},
								{
									name: "state",
									kind: "u32",
									load: async () => Uint32Array.of(0, 0)
								},
								{
									name: "join.meta",
									kind: "bytes",
									load: async () => bytes(metadata)
								}
							]
						},
						generation
					);
					const base = yield* openJoinedTarget();
					expect(Array.from(yield* base.layer.section("query.raw.id_utf8"))).toEqual([
						1, 2, 3, 4, 5
					]);
					expect(
						Array.from(
							yield* synchronousJoinedTarget(base).layer.section("query.raw.id_utf8")
						)
					).toEqual([1, 2, 3, 4, 5]);
					yield* writer.publishIds(
						"joined",
						"chunk-patch",
						{
							columns: [
								{
									name: "patch.rows",
									kind: "u32",
									load: async () => Uint32Array.of(1, 3)
								},
								{
									name: "patch.ids",
									kind: "u32",
									load: async () => Uint32Array.of(12, 14)
								},
								{
									name: "patch.state.rows",
									kind: "u32",
									load: async () => Uint32Array.of(1)
								},
								{
									name: "patch.state",
									kind: "u32",
									load: async () => Uint32Array.of(2)
								},
								{
									name: "join.meta",
									kind: "bytes",
									load: async () =>
										bytes({
											...metadata,
											base: "chunk-base",
											patches: {
												"query.raw.id_utf8": "patch.ids",
												state: "patch.state"
											},
											patchRows: { state: "patch.state.rows" }
										})
								}
							]
						},
						generation,
						{ "joined-base": "chunk-base" }
					);
					const patched = yield* openJoinedTarget();
					expect(Array.from(yield* patched.layer.section("query.raw.id_utf8"))).toEqual([
						1, 12, 3, 14, 5
					]);
					expect(
						Array.from(
							yield* synchronousJoinedTarget(patched).layer.section(
								"query.raw.id_utf8"
							)
						)
					).toEqual([1, 12, 3, 14, 5]);
					const data = new JoinedQueryData(patched);
					expect(Array.from(data.column("state"))).toEqual([0, 2]);
					expect(Array.from(data.column("state.alias"))).toEqual([0, 0]);
					// A compaction changes the generation while the overlay metadata still
					// describes its old base. Refresh must rebuild before opening that base.
					yield* writer.compact(true);
					let fallback = "";
					const increment = yield* incrementJoinedTarget(
						{ projectRoot: cache, target },
						"after-compaction",
						{},
						yield* index.open(),
						writer,
						(reason) => {
							fallback = reason;
						}
					);
					expect(increment).toBeNull();
					expect(fallback).toBe("generation-or-retired-base");
				})
			).pipe(Effect.provide(sharedIndexNodeLayer(joinStoreOptions(cache, cache, "chunks"))))
		);
	});
});
