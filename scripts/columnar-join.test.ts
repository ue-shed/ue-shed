import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	assetReaderLayer,
	scanSavedProject,
	type SavedAssetPackageTextEvent
} from "../packages/unreal-assets/dist/index.js";
import {
	applyLocalizationReview,
	applyLocalizationKeyChanges,
	joinLocalizationTarget,
	localizationKeyChanges
} from "../packages/game-text/src/index.ts";
import { refreshJoinedTarget } from "../packages/game-text/src/joined-target.ts";
import { SharedIndex } from "../packages/game-text/src/shared-index.ts";
import {
	hydrateJoinedTarget,
	inspectJoinedTarget,
	openJoinedTarget
} from "../packages/game-text/src/joined-target-reader.ts";
import {
	refreshPackageTextLayer,
	textCorpusFromPackageTextLayer,
	type PackageTextInventoryEntry
} from "../packages/game-text/src/package-text-layer.ts";
import { compareLocalizationJoins } from "./localization-join-oracle.test-support.ts";
import { comparePackageTextLayerWithEvents } from "./package-text-layer-oracle.test-support.ts";
import {
	withJoinCache,
	tinyJoinInput,
	semanticJoinInput,
	runJoinIn,
	fixtureJoinEvidence,
	importJoinEvidence,
	joinFileErrors
} from "./columnar-join.test-support.ts";
import {
	committedPackagePaths,
	measureNativeText,
	packageTextFixtureProjects
} from "./package-text-reader.test-support.ts";
import { ensureUassetExecutable } from "./native-tools.ts";
import {
	localizationReviewFingerprint,
	parsePO,
	projectPOEvidence
} from "../packages/localization/dist/index.js";
import { success } from "../packages/game-text/src/localization.test-support.ts";
import { packageTextRecordsFromEvents } from "../packages/game-text/src/package-text-record.ts";
import { textCorpusQuery } from "../packages/game-text/src/query.ts";
import {
	TextProblem,
	type TextCorpus,
	type TextReviewSignal
} from "../packages/game-text/src/schema.ts";
import type { LocalizationJoin } from "../packages/game-text/src/localization-schema.ts";
import { u32 } from "../packages/game-text/src/joined-target-input.ts";
import { textProblems } from "../packages/game-text/src/text-problems.ts";
import { expectLocalizationImportMatchesParser } from "./localization-import-oracle.test-support.ts";
import { gatheredTextGroups } from "../packages/game-text/src/gathered-text.ts";
import {
	textFileLabel,
	textFolderLabel,
	manifestPathOrigin
} from "../packages/game-text/src/text-origin.ts";
import { localizationManifestNotes } from "../packages/game-text/src/localization.ts";

const expectProblemOracle = (
	corpus: TextCorpus,
	expected: LocalizationJoin,
	actual: LocalizationJoin,
	bits: Uint32Array
) => {
	const query = textCorpusQuery(corpus, undefined, expected);
	for (let index = 0; index < TextProblem.literals.length; index++) {
		const problem = TextProblem.literals[index]!;
		const ids = new Set(
			query
				.localizationLines({
					query: "",
					capability: "all",
					localization: { target: expected.target },
					filter: [{ field: "problem", op: "is", values: [problem] }]
				})
				.map((line) => line.id)
		);
		for (let row = 0; row < actual.lines.length; row++)
			if (actual.lines[row]!.source.trim() !== "")
				expect(
					Boolean(bits[row]! & (1 << index)),
					`STOP: problem oracle ${problem} ${actual.lines[row]!.id}`
				).toBe(ids.has(actual.lines[row]!.id));
	}
	for (let row = 0; row < actual.lines.length; row++)
		if (actual.lines[row]!.source.trim() === "") {
			// Query visibility omits empty text. Derive its signals from the same raw units
			// and gathered groups, including empty keyless text in committed legacy saves.
			const line = actual.lines[row]!;
			const ids = new Set(line.origin.kind === "corpus" ? line.origin.unitIds : []);
			const signals: TextReviewSignal[] = [];
			const groups = [...gatheredTextGroups(corpus).values()].map((group) => ({
				units: group.units,
				count: group.units.reduce((sum, unit) => sum + unit.occurrences.length, 0),
				sources: new Set(
					group.units.flatMap((unit) =>
						unit.occurrences
							.filter((item) => item.identity.status !== "string_table")
							.map((item) => item.source)
					)
				)
			}));
			const duplicate = new Set(
				[...new Set(groups.flatMap((group) => [...group.sources]))].filter(
					(source) => groups.filter((group) => group.sources.has(source)).length > 1
				)
			);
			for (const unit of corpus.units.filter((unit) => ids.has(unit.id))) {
				const grouped = groups.filter((group) =>
					group.units.some((slice) => slice.id === unit.id)
				);
				if (unit.identity.status === "unresolved") signals.push("unresolved");
				if (
					(unit.source.status === "consistent"
						? unit.source.value
						: unit.source.values.join(" ")
					).length >= 40
				)
					signals.push("long");
				if (grouped.some((group) => group.count > 1)) signals.push("shared");
				if (grouped.some((group) => group.sources.size > 1)) signals.push("conflicting");
				if (
					unit.occurrences.some(
						(item) =>
							item.identity.status !== "string_table" && duplicate.has(item.source)
					)
				)
					signals.push("duplicate_source");
			}
			expect(TextProblem.literals.filter((_, index) => bits[row]! & (1 << index))).toEqual(
				textProblems({
					signals,
					keyChanged: line.keyChange?.direction === "to",
					marks: line.cultures
				})
			);
		}
};

const expectFacetOracle = Effect.fn("JoinOracle.facets")(function* (
	corpus: TextCorpus,
	join: LocalizationJoin
) {
	const joined = yield* openJoinedTarget(),
		page = yield* hydrateJoinedTarget(joined, 0, 10000);
	const columns: Record<string, Uint32Array> = {};
	for (const field of [
		"origins",
		"editing",
		"notes",
		"file_start",
		"file_end",
		"folder_start",
		"folder_end"
	])
		columns[field] = yield* u32(joined.layer, `line.${field}`);
	const files = yield* u32(joined.layer, "facet.files"),
		folders = yield* u32(joined.layer, "facet.folders");
	const labels = new Map<number, string>();
	const ids = [...new Set([...files, ...folders])],
		values = yield* joined.reader.strings(ids);
	for (let i = 0; i < ids.length; i++) labels.set(ids[i]!, values[i]!);
	const units = new Map(corpus.units.map((unit) => [unit.id, unit]));
	for (let row = 0; row < page.lines.length; row++) {
		const line = page.lines[row]!,
			oracle = join.lines.find((candidate) => candidate.id === line.id)!;
		const occurrences =
			oracle.origin.kind === "corpus"
				? oracle.origin.unitIds.flatMap((id) => units.get(id)!.occurrences)
				: [];
		const expectedFiles = new Set(
			(oracle.origin.kind === "evidence"
				? oracle.manifest.map((entry) => entry.path)
				: occurrences.map((item) => item.packageFile)
			).map(textFileLabel)
		);
		expect(
			new Set(
				[...files.subarray(columns.file_start![row]!, columns.file_end![row]!)].map((id) =>
					labels.get(id)
				)
			)
		).toEqual(expectedFiles);
		const expectedFolders = new Set([...expectedFiles].map(textFolderLabel));
		expect(
			new Set(
				[...folders.subarray(columns.folder_start![row]!, columns.folder_end![row]!)].map(
					(id) => labels.get(id)
				)
			)
		).toEqual(expectedFolders);
		if (occurrences.length) {
			const origins = occurrences.reduce(
				(bits, item) =>
					bits |
					(1 <<
						(item.location.kind === "string_table_entry"
							? 0
							: item.location.kind === "data_table_cell"
								? 1
								: 2)),
				0
			);
			const editing = occurrences.reduce(
				(bits, item) => bits | (item.editCapability === "source_editable" ? 1 : 2),
				0
			);
			expect(columns.origins![row]).toBe(origins);
			expect(columns.editing![row]).toBe(editing);
			expect(Boolean(columns.notes![row])).toBe(
				occurrences.some((item) => item.devNotes.trim() !== "")
			);
		} else {
			const origins = oracle.manifest.reduce(
				(bits, item) =>
					bits |
					(1 <<
						(manifestPathOrigin(item.path) === "cpp"
							? 3
							: manifestPathOrigin(item.path) === "asset"
								? 2
								: 4)),
				0
			);
			expect(columns.origins![row]).toBe(origins);
			expect(columns.editing![row]).toBe(2);
			expect(Boolean(columns.notes![row])).toBe(
				oracle.manifest.some((item) => localizationManifestNotes(item).length > 0)
			);
		}
	}
});

const executable = ensureUassetExecutable();

describe("columnar join", () => {
	it("stable package/PO edits and compaction equal full rebuilds; overlays do not chain", async () => {
		await withJoinCache(async (cache) => {
			const { projectRoot, evidence, inventory, events } = await tinyJoinInput(cache, 0.001);
			const run = <A, E>(effect: Parameters<typeof runJoinIn<A, E>>[3]) =>
				runJoinIn(projectRoot, cache, "Generated", effect);
			const input = { projectRoot, target: evidence.target };
			const records = [...packageTextRecordsFromEvents(events)].flatMap((record) =>
				record.event === "text_package_record"
					? [{ ...record, status: "partial" as const }]
					: []
			);
			const baseline = inventory.map((item) => ({
				...item,
				signature: "incremental-baseline"
			}));
			await run(
				refreshPackageTextLayer({
					inventory: baseline,
					read: (paths) =>
						Stream.fromIterable(records.filter((record) => paths.includes(record.path)))
				})
			);
			await run(refreshJoinedTarget(input));
			const original = records.find((record) => record.path.endsWith("/Package0.uasset"));
			if (!original || original.event !== "text_package_record")
				throw new Error("Missing test package");
			let base: string | undefined;
			for (const version of [1, 2]) {
				await run(
					refreshPackageTextLayer({
						inventory: baseline.map((item) =>
							item.path === original.path
								? { ...item, signature: `version:${version}` }
								: item
						),
						read: () =>
							Stream.succeed({
								...original,
								occurrences: original.occurrences.map((item, row) =>
									row === 0
										? { ...item, source: `${item.source} ${version}` }
										: item
								)
							})
					})
				);
				const poPath = resolve(projectRoot, "en.po");
				await writeFile(
					poPath,
					(await readFile(poPath, "utf8")).replace(
						version === 1 ? "mirava" : "wirava",
						version === 1 ? "wirava" : "xirava"
					)
				);
				await expectLocalizationImportMatchesParser({
					projectRoot,
					cacheRoot: cache,
					relativePath: "en.po",
					format: "po",
					poFormat: input.target.poFormat,
					collapseMode: input.target.collapseMode,
					sharedTargetKey: "Generated"
				});
				const refreshed = await run(refreshJoinedTarget(input));
				expect(refreshed, JSON.stringify(refreshed)).toMatchObject({
					rebuilt: true,
					strategy: "incremental"
				});
				const collect = Effect.gen(function* () {
					const joined = yield* openJoinedTarget(),
						values: Record<string, Uint32Array> = {};
					for (const name of new Set([
						...joined.layer.directory.entries.keys(),
						...Object.keys(joined.meta.aliases),
						...Object.keys(joined.meta.patches ?? {})
					]))
						if (name !== "join.meta" && name !== "shared.meta")
							values[name] = yield* u32(joined.layer, name);
					return {
						values,
						base: joined.meta.base,
						join: yield* hydrateJoinedTarget(joined, 0, 10000),
						census: yield* inspectJoinedTarget(joined)
					};
				});
				const incremental = await run(collect);
				base ??= incremental.base;
				expect(incremental.base).toBe(base);
				const corpus = await run(textCorpusFromPackageTextLayer(projectRoot));
				const currentPO = projectPOEvidence(success(parsePO(await readFile(poPath))));
				const currentEvidence = {
					...evidence,
					cultures: evidence.cultures.map((culture) =>
						culture.culture === "en" && culture.po.status === "read"
							? { ...culture, po: { ...culture.po, value: currentPO } }
							: culture
					)
				};
				const objectJoin = joinLocalizationTarget(corpus, currentEvidence);
				const expected = applyLocalizationKeyChanges(
					objectJoin,
					localizationKeyChanges(objectJoin, corpus).pairs
				);
				const equality = compareLocalizationJoins(expected, incremental.join);
				expect(equality, `STOP: ${JSON.stringify(equality)}`).toMatchObject({
					equal: true,
					differenceCount: 0
				});
				if (version === 1) continue;
				await run(refreshJoinedTarget({ ...input, force: true }));
				const full = await run(collect);
				expect(compareLocalizationJoins(full.join, incremental.join)).toMatchObject({
					equal: true,
					differenceCount: 0
				});
				for (const [name, values] of Object.entries(full.values))
					expect(incremental.values[name], name).toEqual(values);
				expect(incremental.census).toEqual(full.census);
			}
			const collect = Effect.gen(function* () {
				return yield* hydrateJoinedTarget(yield* openJoinedTarget(), 0, 10000);
			});
			const beforeCompaction = await run(collect);
			await run(
				Effect.gen(function* () {
					const writer = yield* (yield* SharedIndex).writer();
					expect((yield* writer.compact(true)).compacted).toBe(true);
				})
			);
			await expect(run(openJoinedTarget())).rejects.toThrow("Joined generation changed");
			expect(await run(refreshJoinedTarget(input))).toMatchObject({
				rebuilt: true,
				strategy: "full"
			});
			expect(compareLocalizationJoins(beforeCompaction, await run(collect))).toMatchObject({
				equal: true,
				differenceCount: 0
			});
			expect(await run(refreshJoinedTarget(input))).toMatchObject({ rebuilt: false });
		});
	}, 60000);
	it("key-change tiers, literal table namespaces, keyless, outside, absence and metadata cases", async () => {
		await withJoinCache(async (cache) => {
			const { projectRoot, evidence } = await semanticJoinInput(cache);
			const run = <A, E>(effect: Parameters<typeof runJoinIn<A, E>>[3]) =>
				runJoinIn(projectRoot, cache, "Cases", effect);
			const corpus = await run(textCorpusFromPackageTextLayer(projectRoot)),
				joined = joinLocalizationTarget(corpus, evidence);
			const changes = localizationKeyChanges(joined, corpus);
			const expected = applyLocalizationKeyChanges(joined, changes.pairs);
			await run(refreshJoinedTarget({ projectRoot, target: evidence.target }));
			const actual = await run(
				Effect.gen(function* () {
					return yield* hydrateJoinedTarget(yield* openJoinedTarget(), 0, 10000);
				})
			);
			const equality = compareLocalizationJoins(expected, actual);
			expect(equality, `STOP: ${JSON.stringify(equality)}`).toMatchObject({
				equal: true,
				differenceCount: 0
			});
			expect(changes.pairs.map((pair) => pair.match).sort()).toEqual([
				"same_place",
				"same_text",
				"same_text_in_package"
			]);
			expect(changes.ambiguous).toBe(1);
			expectProblemOracle(
				corpus,
				expected,
				actual,
				await run(
					Effect.gen(function* () {
						return yield* u32((yield* openJoinedTarget()).layer, "line.problems");
					})
				)
			);
			await run(expectFacetOracle(corpus, expected));
		});
	}, 60000);
	it.each([0.0001, 0.001])(
		"seeded tiny target %s equals the Phase 1 join oracle",
		async (scale) => {
			await withJoinCache(async (cache) => {
				const { projectRoot, evidence, inventory, events } = await tinyJoinInput(
					cache,
					scale
				);
				const run = <A, E>(effect: Parameters<typeof runJoinIn<A, E>>[3]) =>
					runJoinIn(projectRoot, cache, "Generated", effect);
				expect(
					await run(comparePackageTextLayerWithEvents({ projectRoot, inventory, events }))
				).toMatchObject({ equal: true, differenceCount: 0 });
				const corpus = await run(textCorpusFromPackageTextLayer(projectRoot));
				const first =
					evidence.manifest.status === "read"
						? evidence.manifest.value.entries[0]
						: undefined;
				if (!first) throw new Error("Missing tiny manifest entry");
				const archive = evidence.cultures.find(
					(culture) => culture.culture === "de"
				)?.archive;
				const translation =
					archive?.status === "read"
						? (archive.value.entries.find((entry) => entry.key === first.key)
								?.translation.Text ?? null)
						: null;
				const review = {
					schemaVersion: 1 as const,
					target: evidence.target.name,
					acceptedFindings: [],
					records: [
						{
							culture: evidence.target.cultures[1]!,
							namespace: first.namespace,
							key: first.key,
							flags: ["reviewed" as const],
							fingerprint: localizationReviewFingerprint(
								first.source.Text,
								translation
							),
							by: "fixture",
							at: "2026-01-01T00:00:00Z"
						}
					]
				};
				for (const reviewFile of [
					undefined,
					review,
					{
						...review,
						records: review.records.map((record) => ({
							...record,
							fingerprint: "0".repeat(64)
						}))
					}
				]) {
					const joined = applyLocalizationReview(
						joinLocalizationTarget(corpus, evidence),
						reviewFile
					);
					const expected = applyLocalizationKeyChanges(
						joined,
						localizationKeyChanges(joined, corpus).pairs
					);
					await run(
						refreshJoinedTarget({
							projectRoot,
							target: evidence.target,
							...(reviewFile ? { review: reviewFile } : undefined)
						})
					);
					const actual = await run(
						Effect.gen(function* () {
							return yield* hydrateJoinedTarget(yield* openJoinedTarget(), 0, 10000);
						})
					);
					const equality = compareLocalizationJoins(expected, actual);
					expect(equality, `STOP: ${JSON.stringify(equality)}`).toMatchObject({
						equal: true,
						differenceCount: 0
					});
					expectProblemOracle(
						corpus,
						expected,
						actual,
						await run(
							Effect.gen(function* () {
								return yield* u32(
									(yield* openJoinedTarget()).layer,
									"line.problems"
								);
							})
						)
					);
					await run(expectFacetOracle(corpus, expected));
				}
				expect(
					await run(
						refreshJoinedTarget({
							projectRoot,
							target: evidence.target,
							review: {
								...review,
								records: review.records.map((record) => ({
									...record,
									fingerprint: "0".repeat(64)
								}))
							}
						})
					)
				).toMatchObject({ rebuilt: false });
				const census = await run(
					Effect.gen(function* () {
						return yield* inspectJoinedTarget(yield* openJoinedTarget());
					})
				);
				expect(census.coveredLines).toBe(census.count);
			});
		},
		60000
	);

	it.each(packageTextFixtureProjects)(
		"committed fixture join oracle: %s",
		async (project) => {
			await withJoinCache(async (cache) => {
				const projectRoot = resolve(project),
					paths = committedPackagePaths(project);
				const scan = await Effect.runPromise(
					scanSavedProject({
						projectRoot,
						paths,
						depth: "header",
						headerData: true,
						inventory: true
					}).pipe(Effect.provide(assetReaderLayer({ executable })))
				);
				expect(scan.failures).toEqual([]);
				const inventory: PackageTextInventoryEntry[] = scan.assets
					.map((asset) => {
						if (asset.depth !== "header" || !asset.header.package.header_data)
							throw new Error("Missing header evidence");
						const signature = scan.inventory?.find(
							(entry) => entry.path === asset.header.path
						);
						if (!signature) throw new Error("Missing signature");
						return {
							path: asset.header.path,
							signature: JSON.stringify([signature.size, signature.modifiedMs]),
							headerData: asset.header.package.header_data
						};
					})
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
				const events = measureNativeText(executable, project, false, paths).events.filter(
					(event) => event.event !== "text_package_record"
				);
				for (const evidence of await fixtureJoinEvidence(projectRoot)) {
					const run = <A, E>(effect: Parameters<typeof runJoinIn<A, E>>[3]) =>
						runJoinIn(projectRoot, cache, evidence.target.name, effect);
					await importJoinEvidence(projectRoot, cache, evidence);
					await run(
						refreshPackageTextLayer({
							inventory,
							read: (selected) =>
								Stream.fromIterable(
									measureNativeText(
										executable,
										project,
										true,
										selected
									).events.filter(
										(event): event is SavedAssetPackageTextEvent =>
											![
												"text_occurrence",
												"text_coverage_gap",
												"text_package"
											].includes(event.event)
									)
								)
						})
					);
					expect(
						await run(
							comparePackageTextLayerWithEvents({ projectRoot, inventory, events })
						)
					).toMatchObject({ equal: true, differenceCount: 0 });
					const corpus = await run(textCorpusFromPackageTextLayer(projectRoot));
					const joined = joinLocalizationTarget(corpus, evidence);
					const expected = applyLocalizationKeyChanges(
						joined,
						localizationKeyChanges(joined, corpus).pairs
					);
					await run(
						refreshJoinedTarget({
							projectRoot,
							target: evidence.target,
							fileErrors: joinFileErrors(evidence)
						})
					);
					const actual = await run(
						Effect.gen(function* () {
							return yield* hydrateJoinedTarget(yield* openJoinedTarget(), 0, 10000);
						})
					);
					const equality = compareLocalizationJoins(expected, actual);
					expect(equality, `STOP: ${JSON.stringify(equality)}`).toMatchObject({
						equal: true,
						differenceCount: 0
					});
					expectProblemOracle(
						corpus,
						expected,
						actual,
						await run(
							Effect.gen(function* () {
								return yield* u32(
									(yield* openJoinedTarget()).layer,
									"line.problems"
								);
							})
						)
					);
					await run(expectFacetOracle(corpus, expected));
				}
			});
		},
		60000
	);
});
