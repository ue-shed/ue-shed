import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { SharedIndex, sharedIndexDirectory, sharedIndexNodeLayer } from "./shared-index.js";
import { openJoinedTarget } from "./joined-target-reader.js";
import { columnarTextCorpusQuery } from "./columnar-query.test-support.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { target, cultureCode } from "./localization.test-support.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const sourceTarget = { ...target, cultures: [] };
const path = "Content/Text/Example.uasset";
const firstSource =
	"A first unique source that is sufficiently long for stable incremental updates. \ud800 😀";
const secondSource =
	"A second unique source that is sufficiently long for stable incremental updates. \udfff 😀";
const readerConfiguration = () => {
	if (!executable) throw new Error("Native reader is required");
	return { executable, timeoutMs: 30_000, catalogTimeoutMs: 120_000 };
};

describe.skipIf(!executable)("native index build capability", () => {
	it("imports localization through the existing producers and patches a stable PO translation", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-native-po-"));
		try {
			const projectRoot = join(root, "project");
			await mkdir(projectRoot);
			const value =
				"A stable manifest source with enough characters for the source update threshold.";
			const authored = {
				...target,
				outputPaths: {
					...target.outputPaths,
					manifest: "Test.manifest",
					archives: { en: "en.archive", de: "de.archive" },
					portableObjects: { en: "en.po", de: "de.po" }
				}
			};
			await writeFile(
				join(projectRoot, "Test.manifest"),
				JSON.stringify({
					FormatVersion: 1,
					Namespace: "UI",
					Children: [
						{
							Source: { Text: value },
							Keys: [{ Key: "K", Path: "/Game/Text/Example.Example.Label" }]
						}
					]
				})
			);
			for (const culture of ["en", "de"])
				await writeFile(
					join(projectRoot, `${culture}.archive`),
					JSON.stringify({
						FormatVersion: 2,
						Namespace: "UI",
						Children: [
							{ Key: "K", Source: { Text: value }, Translation: { Text: "Shipped" } }
						]
					})
				);
			const outputs = [];
			for (const backend of ["javascript", "native"] as const) {
				const options = {
					cacheRoot: join(root, backend),
					projectKey: projectRoot,
					targetKey: authored.name,
					projectView: { kind: "localization" as const, target: authored.name }
				};
				outputs.push(
					await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const builder = yield* GameTextIndexBuilder;
								const snapshots = [];
								for (const translation of ["Shipped", "Updated translation"]) {
									const provenance = {
										relativePath: "de.po",
										size: translation.length,
										modifiedTime: "2026-10-18T00:00:00.000Z",
										contentHash: (translation === "Shipped" ? "0" : "1").repeat(
											64
										)
									};
									yield* Effect.promise(() =>
										writeFile(
											join(projectRoot, "de.po"),
											`msgctxt "UI,K"\nmsgid ${JSON.stringify(value)}\nmsgstr ${JSON.stringify(translation)}\n`
										)
									);
									const result = yield* builder.withSession(
										{ configuration: options },
										Effect.gen(function* () {
											for (const [relativePath, format] of [
												["Test.manifest", "manifest"],
												["de.archive", "archive"],
												["en.archive", "archive"],
												["de.po", "po"]
											] as const)
												yield* builder.importLocalizationFile({
													projectRoot,
													cacheRoot: options.cacheRoot,
													relativePath,
													format,
													poFormat: "Unreal",
													sharedTargetKey: authored.name,
													projectScoped: true
												});
											yield* builder.refreshPackageTextLayer({
												inventory: [
													{
														path,
														signature: "stable",
														headerData: {
															packageFlags: 0x40000,
															gatherableTextDataCount: 0,
															gatherableTextDataOffset: 0,
															hasTextProperty: false
														}
													}
												],
												read: () =>
													Stream.succeed({
														...emptyPackageTextRecord(path),
														occurrences: [
															{
																source: value,
																dev_notes: "",
																identity: {
																	status: "resolved",
																	namespace: "UI",
																	key: "K"
																},
																location: {
																	kind: "asset_property",
																	object_path:
																		"/Game/Text/Example.Example",
																	class_path:
																		"/Script/Engine.DataAsset",
																	property_path: "Label"
																},
																edit_capability: "read_only"
															}
														]
													})
											});
											return yield* builder.refreshJoinedTarget({
												projectRoot,
												target: authored,
												fileProvenances: { "de.po": provenance }
											});
										})
									);
									if (translation !== "Shipped")
										expect(result.strategy).toBe("incremental");
									const joined = yield* openJoinedTarget().pipe(
										Effect.provide(sharedIndexNodeLayer(options))
									);
									const query = columnarTextCorpusQuery(
										joined,
										"2026-10-17T00:00:00.000Z"
									);
									expect(joined.meta.input.fileProvenances?.["de.po"]).toEqual(
										provenance
									);
									snapshots.push(
										query.search({
											query: "",
											capability: "all",
											pageSize: 50,
											localization: {
												target: authored.name,
												culture: cultureCode("de")
											},
											facets: { cultures: true, audiences: true }
										})
									);
								}
								return snapshots;
							})
						).pipe(
							Effect.provide(
								backend === "native"
									? nativeIndexBuilderLayer(readerConfiguration())
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
	}, 120_000);
	it("matches queries across builder switches, stable-source updates, structural changes and compaction", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-native-index-"));
		try {
			const outputs = [];
			for (const backend of ["javascript", "native", "javascript"] as const) {
				const options = {
					cacheRoot: root,
					projectKey: "invented",
					targetKey: "text",
					projectView: { kind: "source" as const }
				};
				outputs.push(
					await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const builder = yield* GameTextIndexBuilder;
								let revision = 0;
								const refresh = (value: string, key = "Example") =>
									builder.withSession(
										{ configuration: options },
										Effect.gen(function* () {
											yield* builder.refreshPackageTextLayer({
												inventory: [
													{
														path,
														signature: String(++revision),
														headerData: {
															packageFlags: 0x40000,
															gatherableTextDataCount: 0,
															gatherableTextDataOffset: 0,
															hasTextProperty: false
														}
													}
												],
												read: () =>
													Stream.succeed({
														...emptyPackageTextRecord(path),
														occurrences: [
															{
																source: value,
																dev_notes: "",
																identity: {
																	status: "resolved",
																	namespace: "UI",
																	key
																},
																location: {
																	kind: "asset_property",
																	object_path:
																		"/Game/Text/Example.Example",
																	class_path:
																		"/Script/Engine.DataAsset",
																	property_path: "Label"
																},
																edit_capability: "read_only"
															}
														]
													})
											});
											return yield* builder.refreshJoinedTarget({
												projectRoot: root,
												target: sourceTarget
											});
										})
									);
								const snapshot = Effect.fn("Test.NativeIndex.snapshot")(
									function* () {
										const joined = yield* openJoinedTarget().pipe(
											Effect.provide(sharedIndexNodeLayer(options))
										);
										const query = columnarTextCorpusQuery(
											joined,
											"2026-10-17T00:00:00.000Z"
										);
										const pages = [
											"",
											"unique",
											"missing-query",
											"😀",
											"\ud800",
											"\udfff"
										].map((queryText) =>
											query.search({
												query: queryText,
												capability: "all",
												pageSize: 50
											})
										);
										const filtered = query.search({
											query: "",
											capability: "all",
											pageSize: 50,
											filter: [
												{ field: "finding", op: "is", values: ["long"] }
											],
											group: "audience"
										});
										return {
											query,
											value: {
												summary: query.summary(),
												pages,
												filtered,
												focus: query.focus({
													id: pages[0]!.units[0]!.id,
													pageSize: 50
												})
											}
										};
									}
								);
								yield* refresh(firstSource);
								const pinned = yield* snapshot(),
									before = pinned.value;
								const changed = yield* refresh(secondSource);
								expect(changed.strategy).toBe("incremental");
								expect(
									pinned.query.search({
										query: "first",
										capability: "all",
										pageSize: 50
									}).total
								).toBe(1);
								const after = (yield* snapshot()).value;
								yield* refresh("Short structural replacement", "NewIdentity");
								const structural = (yield* snapshot()).value;
								yield* builder.withSession(
									{ configuration: options },
									Effect.gen(function* () {
										expect((yield* builder.compact(true)).compacted).toBe(true);
										yield* builder.refreshJoinedTarget({
											projectRoot: root,
											target: sourceTarget
										});
									})
								);
								expect(
									pinned.query.search({
										query: "first",
										capability: "all",
										pageSize: 50
									}).total
								).toBe(1);
								const compacted = (yield* snapshot()).value;
								expect(compacted).toEqual(structural);
								const switchResult = yield* Effect.gen(function* () {
									const other = yield* GameTextIndexBuilder;
									return yield* other.withSession(
										{ configuration: options },
										other.refreshJoinedTarget({
											projectRoot: root,
											target: sourceTarget
										})
									);
								}).pipe(
									Effect.provide(
										backend === "native"
											? typeScriptIndexBuilderLayer
											: nativeIndexBuilderLayer(readerConfiguration())
									)
								);
								expect(switchResult.rebuilt).toBe(true);
								expect((yield* snapshot()).value).toEqual(compacted);
								yield* builder.withSession(
									{ configuration: options },
									builder.refreshJoinedTarget({
										projectRoot: root,
										target: sourceTarget
									})
								);
								expect((yield* snapshot()).value).toEqual(compacted);
								return { before, after, structural, compacted };
							})
						).pipe(
							Effect.provide(
								backend === "native"
									? nativeIndexBuilderLayer(readerConfiguration())
									: typeScriptIndexBuilderLayer
							)
						)
					)
				);
			}
			expect(outputs[1]).toEqual(outputs[0]);
			expect(outputs[2]).toEqual(outputs[0]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("owns one lease, preserves WTF-8 IDs, rejects stale publication, and releases after failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-native-lease-"));
		const options = {
			cacheRoot: root,
			projectKey: "invented",
			targetKey: "text",
			projectView: { kind: "source" as const }
		};
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const builder = yield* GameTextIndexBuilder;
						yield* builder.withSession(
							{ configuration: options },
							Effect.gen(function* () {
								const index = yield* SharedIndex,
									writer = yield* index.writer();
								const values = [
									"",
									"lone \ud800 \udfff 😀",
									"duplicate",
									"duplicate"
								];
								const ids = yield* writer.intern("source", values);
								expect(ids[2]).toBe(ids[3]);
								expect(yield* writer.strings([...ids])).toEqual(values);
								const busy = yield* Effect.exit(
									builder.withSession({ configuration: options }, Effect.void)
								);
								expect(Exit.isFailure(busy)).toBe(true);
								yield* writer.publishIds(
									"probe",
									"probe-one",
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
								const failed = yield* Effect.exit(
									writer.publishIds(
										"probe",
										"bad",
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
										"stale-generation"
									)
								);
								expect(Exit.isFailure(failed)).toBe(true);
							})
						);
						yield* builder.withSession(
							{ configuration: options },
							Effect.gen(function* () {
								const index = yield* SharedIndex,
									writer = yield* index.writer();
								const reader = yield* index.open(),
									layer = yield* reader.layer("probe");
								const ids = yield* layer.section("entry.source");
								if (!(ids instanceof Uint32Array))
									throw new Error("Expected ID column");
								expect(yield* reader.strings([...ids])).toEqual([
									"",
									"lone \ud800 \udfff 😀",
									"duplicate",
									"duplicate"
								]);
								const generation = writer.manifest().generation;
								expect((yield* writer.compact(true)).compacted).toBe(true);
								expect(writer.manifest().generation).not.toBe(generation);
								expect(yield* reader.strings([...ids])).toEqual([
									"",
									"lone \ud800 \udfff 😀",
									"duplicate",
									"duplicate"
								]);
							})
						);
					})
				).pipe(Effect.provide(nativeIndexBuilderLayer(readerConfiguration())))
			);
			expect(
				(await readdir(root)).some(
					(name) => name.endsWith(".lock") || name.startsWith("native-build-")
				)
			).toBe(false);
			const manifest = JSON.parse(
				await readFile(join(sharedIndexDirectory(options), "manifest.json"), "utf8")
			);
			expect(manifest.formatVersion).toBe(4);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);
});
