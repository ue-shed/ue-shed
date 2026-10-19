import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect, Stream, Scope, Exit, Schema, Result } from "effect";
import { describe, expect, it } from "vitest";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexBuilder } from "./index-builder.js";
import { GameTextIndexQuery } from "./index-query-native.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import { packageTextShard } from "./package-text-layer.js";
import { columnarTextCorpusQuery } from "./columnar-query.test-support.js";
import { openJoinedTarget } from "./joined-target-reader.js";
import { target } from "./localization.test-support.js";
import { TextCorpusSearchRequest } from "./schema.js";
import { encodeStringBlock } from "./snapshot-format.js";
import { snapshotColumnsSource } from "./snapshot-file.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
// Debug native builds take close to two minutes here alone, and longer under full-suite load.
const TEST_TIMEOUT_MS = 300_000;
const sourceTarget = { ...target, cultures: [] };
const header = {
	packageFlags: 0x40000,
	gatherableTextDataCount: 0,
	gatherableTextDataOffset: 0,
	hasTextProperty: false
};

const record = (
	path: string,
	source: string,
	key: string,
	copies = 0
): SavedAssetPackageTextRecord => {
	const name = basename(path, ".uasset");
	const object = `/Game/Text/${name}.${name}`;
	return {
		...emptyPackageTextRecord(path),
		fileBytes: 100 + source.length,
		blueprintClasses: [
			{
				blueprint: object,
				generatedClass: `${object}_C`,
				classDefault: `/Game/Text/${name}.Default__${name}_C`
			}
		],
		occurrences: Array.from({ length: copies + 1 }, (_, copy) => ({
			source,
			dev_notes: "",
			identity: { status: "resolved", namespace: "UI", key },
			location: {
				kind: "asset_property",
				object_path: `${object}${copy ? "_C" : ""}.WidgetTree.Title`,
				class_path: "/Script/UMG.TextBlock",
				property_path: "Text"
			},
			edit_capability: "read_only"
		}))
	};
};

describe.skipIf(!executable)("native package record deltas", () => {
	it(
		"keeps dictionary IDs coherent in mixed leases and compacts repeated package and localization edits",
		async () => {
			if (!executable) throw new Error("Native reader required");
			const root = await mkdtemp(join(tmpdir(), "ue-shed-delta-capacity-"));
			const configuration = {
				cacheRoot: root,
				projectKey: "capacity",
				targetKey: "source",
				projectView: { kind: "source" as const }
			};
			const path = "Content/Text/Capacity.uasset";
			const local = (values: string[], localization = false) =>
				snapshotColumnsSource([
					{
						name: "source.b0",
						kind: "strings",
						domain: "source",
						stringCount: values.length,
						values: encodeStringBlock(values)
					},
					{ name: "source.starts", kind: "u32", values: Uint32Array.of(0) },
					{
						name: "entry.source",
						kind: "stringIds",
						domain: "source",
						stringCount: values.length,
						values: Uint32Array.from(values, (_, i) => i)
					},
					...(localization
						? [
								{
									name: "file.meta",
									kind: "bytes" as const,
									values: new TextEncoder().encode("{}")
								}
							]
						: [])
				]);
			try {
				await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const builder = yield* GameTextIndexBuilder;
							const generations = new Set<string>();
							for (let round = 0; round < 140; round++) {
								yield* builder.withSession(
									{ configuration },
									Effect.scoped(
										Effect.gen(function* () {
											const store = yield* SharedIndex;
											const writer = yield* store.writer();
											if (round === 1)
												yield* writer.publish(
													"large",
													"large",
													local(
														Array.from(
															{ length: 8200 },
															(_, i) => `large-${i}`
														)
													)
												);
											yield* builder.refreshPackageTextLayer({
												inventory: [
													{
														path,
														signature: `edit-${round}`,
														headerData: header
													}
												],
												read: () =>
													Stream.succeed(
														record(path, `source-${round}`, "K")
													)
											});
											yield* writer.publish(
												"probe.po",
												`po-${round}`,
												local(
													[
														"unchanged localization",
														`translation-${round}`
													],
													true
												)
											);
											const ids = yield* writer.intern("source", [
												`after-${round}`
											]);
											yield* writer.publishIds(
												"after",
												`after-${round}`,
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
											yield* builder.refreshJoinedTarget({
												projectRoot: root,
												target: sourceTarget
											});
											const current = yield* store.open();
											generations.add(current.manifest.generation);
											expect(
												current.manifest.segments.length
											).toBeLessThanOrEqual(256);
											const packages = yield* decodePackageTextColumns(
												yield* current.layer(
													`package-text.${packageTextShard(path)}`
												)
											);
											expect(packages[0]!.evidence).toMatchObject({
												occurrences: [{ source: `source-${round}` }]
											});
											for (const [name, expected] of [
												[
													"probe.po",
													[
														"unchanged localization",
														`translation-${round}`
													]
												],
												["after", [`after-${round}`]]
											] as const) {
												const layer = yield* current.layer(name);
												const values = yield* layer.section("entry.source");
												if (!(values instanceof Uint32Array))
													throw new Error("Expected IDs");
												expect(yield* current.strings([...values])).toEqual(
													expected
												);
											}
											let end = 0;
											for (const segment of current.manifest.segments) {
												expect(segment.start).toBe(end);
												end += segment.count;
											}
										})
									)
								);
							}
							expect(generations.size).toBeGreaterThan(1);
							const localizationGenerations = new Set<string>();
							for (let round = 0; round < 270; round++) {
								yield* builder.withSession(
									{ configuration },
									Effect.scoped(
										Effect.gen(function* () {
											const store = yield* SharedIndex;
											const writer = yield* store.writer();
											yield* writer.publish(
												"probe.po",
												`only-po-${round}`,
												local(
													[
														"unchanged localization",
														`only-translation-${round}`
													],
													true
												)
											);
											localizationGenerations.add(
												writer.manifest().generation
											);
											const reader = yield* store.open();
											const layer = yield* reader.layer("probe.po");
											const ids = yield* layer.section("entry.source");
											if (!(ids instanceof Uint32Array))
												throw new Error("Expected IDs");
											expect(yield* reader.strings([...ids])).toEqual([
												"unchanged localization",
												`only-translation-${round}`
											]);
										})
									)
								);
							}
							expect(localizationGenerations.size).toBeGreaterThan(1);
							// A new lease must retain all active layers rather than quarantine a broken dictionary.
							yield* builder.withSession(
								{ configuration },
								Effect.gen(function* () {
									const manifest =
										(yield* (yield* SharedIndex).writer()).manifest();
									expect(manifest.active.large).toBe("large");
									expect(manifest.active.after).toBe("after-139");
								})
							);
						})
					).pipe(
						Effect.provide(
							nativeIndexBuilderLayer({
								executable,
								timeoutMs: 30000,
								catalogTimeoutMs: 120000
							})
						)
					)
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS
	);
	it(
		"matches complete records and summaries across edits, copies, eligibility, deletion and undo",
		async () => {
			if (!executable) throw new Error("Native reader required");
			const root = await mkdtemp(join(tmpdir(), "ue-shed-package-delta-"));
			try {
				const projectRoot = join(root, "project");
				await mkdir(projectRoot);
				const paths: string[] = [];
				for (let id = 0; paths.length < 4; id++) {
					const path = `Content/Text/Item${id}.uasset`;
					if (packageTextShard(path) === packageTextShard("Content/Text/Item0.uasset"))
						paths.push(path);
				}
				const first = record(paths[0]!, "Shared 😀 \ud800 source", "A");
				const second = record(paths[1]!, first.occurrences[0]!.source, "B", 1);
				const third = record(paths[2]!, "Third source", "C");
				const original = [first, second, third];
				const textEdit = [
					{
						...first,
						fileBytes: first.fileBytes + 16,
						occurrences: first.occurrences.map((o) => ({
							...o,
							source: "Different \udfff source"
						}))
					},
					second,
					third
				];
				const structure = [
					textEdit[0]!,
					record(paths[1]!, "Changed copy", "New identity"),
					third
				];
				const inserted = [record(paths[3]!, "Inserted source", "D"), second, third];
				const states = [original, textEdit, structure, structure, inserted, original];
				const outputs = [];
				for (const backend of ["reference", "native"] as const) {
					const configuration = {
						cacheRoot: join(root, backend),
						projectKey: projectRoot,
						targetKey: "source",
						projectView: { kind: "source" as const }
					};
					outputs.push(
						await Effect.runPromise(
							Effect.scoped(
								Effect.gen(function* () {
									const builder = yield* GameTextIndexBuilder;
									const queries = yield* GameTextIndexQuery;
									const snapshots = [];
									for (const [step, state] of states.entries()) {
										const sorted = [...state].sort((a, b) =>
											Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
										);
										const result = yield* builder.withSession(
											{ configuration },
											Effect.gen(function* () {
												const refresh =
													yield* builder.refreshPackageTextLayer({
														inventory: sorted.map((value) => ({
															path: value.path,
															signature: createHash("sha256")
																.update(JSON.stringify(value))
																.digest("hex"),
															headerData:
																step === 3 &&
																value.path === first.path
																	? { ...header, packageFlags: 0 }
																	: header
														})),
														read: (wanted) =>
															Stream.fromIterable(
																[...wanted]
																	.reverse()
																	.map(
																		(path) =>
																			sorted.find(
																				(value) =>
																					value.path ===
																					path
																			)!
																	)
															)
													});
												yield* builder.refreshJoinedTarget({
													projectRoot,
													target: sourceTarget
												});
												return refresh;
											})
										);
										if (step === 1) expect(result.readPackages).toBe(1);
										const joined = yield* openJoinedTarget().pipe(
											Effect.provide(sharedIndexNodeLayer(configuration))
										);
										const native = yield* queries.open({
											configuration,
											generation: joined.reader.manifest.generation,
											joinedKey: joined.reader.manifest.active.joined!
										});
										if (backend === "native") {
											const owner = yield* Scope.make();
											const borrowed = yield* queries
												.open({
													joinedKey:
														joined.reader.manifest.active.joined!,
													generation: joined.reader.manifest.generation,
													configuration
												})
												.pipe(Effect.provideService(Scope.Scope, owner));
											expect(borrowed).toBe(native);
											yield* Scope.close(owner, Exit.void);
										}
										const oracle = columnarTextCorpusQuery(joined);
										expect(
											yield* native.summary(),
											`${backend} step ${step}`
										).toEqual(oracle.summary());
										const reader = yield* (yield* SharedIndex).open();
										const records = yield* decodePackageTextColumns(
											yield* reader.layer(
												`package-text.${packageTextShard(first.path)}`
											)
										);
										snapshots.push({
											records,
											summary: yield* native.summary(),
											page: yield* native.search({
												query: "",
												capability: "all",
												pageSize: 50
											})
										});
										if (backend === "native" && step === states.length - 1) {
											const invalid = Schema.decodeUnknownSync(
												TextCorpusSearchRequest
											)({
												query: "",
												capability: "all",
												pageSize: 1,
												localization: { target: "OtherTarget" }
											});
											expect(
												Result.isFailure(
													yield* native
														.search(invalid)
														.pipe(Effect.result)
												)
											).toBe(true);
											const request = {
												configuration,
												generation: joined.reader.manifest.generation,
												joinedKey: joined.reader.manifest.active.joined!
											};
											const recovered = yield* queries.open(request);
											expect(recovered).not.toBe(native);
											yield* native.search(invalid).pipe(Effect.result);
											expect(yield* queries.open(request)).toBe(recovered);
											expect(yield* recovered.summary()).toEqual(
												oracle.summary()
											);
										}
									}
									return snapshots;
								})
							).pipe(
								Effect.provide(sharedIndexNodeLayer(configuration)),
								Effect.provide(
									backend === "native"
										? nativeIndexBuilderLayer({
												executable,
												timeoutMs: 30000,
												catalogTimeoutMs: 120000
											})
										: typeScriptIndexBuilderLayer
								)
							)
						)
					);
				}
				expect(outputs[1]).toEqual(outputs[0]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS
	);
});
