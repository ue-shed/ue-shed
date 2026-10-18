import { Effect, Schema } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalizationTarget } from "@ue-shed/localization";
import { localizationFocusPage, LocalizationFocusRequest } from "./localization-view.js";
import { describe, expect, it } from "vitest";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { GameTextIndexRefresh } from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { textCorpusQuery } from "./query.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import type { LocalizationCultureMark, LocalizationLinePreview } from "./localization-schema.js";
import type { TextCorpusFocus, TextCorpusSearchPage, TextUnitSearchResult } from "./schema.js";
import { TextCorpusFocusRequest } from "./schema.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!executable)("production native Game Text queries", () => {
	it("pages large manifest, culture and PO context evidence in Rust and exports full provenance explicitly", async () => {
		if (!executable) throw new Error("Native reader required");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					const cultures = [
						...Array.from({ length: 54 }, (_, index) => `x-${index}`),
						"en"
					];
					const target = Schema.decodeUnknownSync(LocalizationTarget)({
						...fixture.target,
						cultures,
						nativeCulture: "en",
						outputPaths: {
							...fixture.target.outputPaths,
							archives: Object.fromEntries(
								cultures.map((culture) => [culture, `${culture}.archive`])
							),
							portableObjects: Object.fromEntries(
								cultures.map((culture) => [culture, `${culture}.po`])
							)
						}
					});
					fixture.setTargets([target]);
					yield* Effect.promise(async () => {
						await writeFile(
							join(fixture.projectRoot, "Review.manifest"),
							JSON.stringify({
								FormatVersion: 1,
								Namespace: "UI",
								Children: [
									{
										Source: { Text: "Source" },
										Keys: Array.from({ length: 10051 }, (_, index) => ({
											Key: "K",
											Path: `Source/File${index}.cpp:1`,
											DevNotes: `Note ${index}`,
											MetaData: { Info: { Comment: `Comment ${index}` } }
										}))
									}
								]
							})
						);
						const comments = Array.from(
							{ length: 121 },
							(_, index) => `# Translator ${index}`
						).join("\n");
						const flags = Array.from(
							{ length: 121 },
							(_, index) => `flag-${index}`
						).join(", ");
						for (const culture of cultures) {
							await writeFile(
								join(fixture.projectRoot, `${culture}.archive`),
								fixture.contents.archive
							);
							await writeFile(
								join(fixture.projectRoot, `${culture}.po`),
								`${comments}\n#, ${flags}\nmsgctxt "UI,K"\nmsgid "Source"\nmsgstr "Edited"\n`
							);
						}
					});
					yield* Effect.gen(function* () {
						const index = yield* GameTextIndexRefresh;
						const model = yield* index.refresh(fixture.request);
						const selected = {
							query: "",
							capability: "all" as const,
							localization: { target: target.name }
						};
						const lines = yield* model.query.localizationLines(selected);
						expect(lines).toHaveLength(1);
						const line = lines[0]!;
						expect(line.manifest).toHaveLength(10051);
						expect(line.cultures).toHaveLength(55);
						expect(yield* model.query.localizationFocus(line.id)).toEqual(line);
						const unit = fixture.raw().units[0]!;
						for (const selection of [
							{ kind: "line", id: line.id },
							{ kind: "unit", id: unit.id }
						] as const) {
							for (const offsets of [
								{},
								{ cultureOffset: 50, locationOffset: 10000, poContextOffset: 50 },
								{ cultureOffset: 99, locationOffset: 10100, poContextOffset: 150 }
							]) {
								const request = Schema.decodeUnknownSync(LocalizationFocusRequest)({
									target: target.name,
									selection,
									...offsets
								});
								const actual = yield* model.query.localizationDetail(request);
								const expected = localizationFocusPage(
									{
										target: target.name,
										nativeCulture: target.nativeCulture,
										cultures: target.cultures
									},
									line,
									request
								);
								expect(
									actual && {
										...actual,
										translations: actual.translations.map(normalizeMark)
									}
								).toEqual({
									...expected,
									translations: expected.translations.map(normalizeMark)
								});
								expect(JSON.stringify(actual).length).toBeLessThan(100000);
							}
						}
						const focused = yield* model.query.focus({ id: unit.id, pageSize: 1 });
						expect(focused?.localization?.remainingLocationCount).toBe(10048);
						expect(focused?.localization).not.toHaveProperty("manifest");
					}).pipe(
						Effect.provide(
							fixture.layer(
								false,
								fixture.source,
								false,
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30000,
									catalogTimeoutMs: 120000
								})
							)
						)
					);
				})
			)
		);
	}, 120000);
	it("keeps mixed reference edits incremental, preserves pinned readers and matches a fresh join", async () => {
		if (!executable) throw new Error("Native reader required");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					const source =
						"An original source long enough to exercise incremental updates.";
					const changed =
						"A changed source long enough to exercise incremental updates. 😀";
					const third =
						"A third source long enough to exercise incremental updates. \ud800";
					const occurrence = (key: string, value: string, property: string) => ({
						source: value,
						dev_notes: "",
						identity: { status: "resolved" as const, namespace: "UI", key },
						location: {
							kind: "asset_property" as const,
							object_path: "/Game/Text/Table.Table",
							class_path: "/Script/Engine.DataAsset",
							property_path: property
						},
						edit_capability: "read_only" as const
					});
					const update = (a: string, b: string) =>
						fixture.update([
							{
								...occurrence("K", a, "Label"),
								location: {
									kind: "string_table_entry",
									object_path: "/Game/Text/Table.Table",
									entry_key: "K"
								}
							},
							occurrence("K", b, "SecondLabel"),
							{
								...occurrence("K", source, "Reference"),
								identity: {
									status: "string_table",
									table_id: "/Game/Text/Table.Table",
									key: "K"
								}
							},
							// Unchanged text outside the edited identity must lose/regain duplicate-source signals.
							occurrence("Other", source, "OtherLabel"),
							occurrence("Blank", "  ", "BlankLabel")
						]);
					update(source, source);
					yield* Effect.gen(function* () {
						const index = yield* GameTextIndexRefresh;
						const first = yield* index.refresh(fixture.request);
						const request = { query: "", capability: "all" as const, pageSize: 50 };
						const original = yield* first.query.search(request);
						expect(yield* first.corpus).toEqual(fixture.raw());
						for (const [a, b] of [
							[changed, source],
							[third, changed],
							[third, third],
							["Short", "Short"],
							["Yes", "No"],
							[source, changed]
						]) {
							update(a!, b!);
							yield* Effect.promise(() =>
								writeFile(
									join(fixture.projectRoot, "de.po"),
									`msgctxt "UI,K"\nmsgid "Source"\nmsgstr ${JSON.stringify(a)}\n`
								)
							);
							const model = yield* index.refresh(fixture.request);
							// Restoring the original content key intentionally republishes the full immutable base.
							if (a !== source || b !== source)
								expect(model.join.strategy).toBe("incremental");
							const raw = fixture.raw();
							const oracle = textCorpusQuery(
								raw,
								undefined,
								joinLocalizationTarget(raw, model.evidence)
							);
							for (const localization of [
								undefined,
								{ target: fixture.target.name }
							]) {
								const selected = {
									...request,
									...(localization ? { localization } : undefined)
								};
								const page = yield* model.query.search(selected);
								expect(normalizePage(page)).toEqual(
									normalizePage(oracle.search(selected))
								);
								for (const [position, unit] of page.units.entries()) {
									const line = page.localization?.lines[position];
									const focus = Schema.decodeUnknownSync(TextCorpusFocusRequest)({
										id: unit.id,
										pageSize: 1,
										...(line
											? {
													localization: {
														target: fixture.target.name,
														id: line.id
													}
												}
											: undefined)
									});
									expect(normalizeFocus(yield* model.query.focus(focus))).toEqual(
										normalizeFocus(oracle.focus(focus))
									);
								}
							}
							// Native handles retain unopened frames even after later publications.
							expect(yield* first.query.search(request)).toEqual(original);
						}
						const beforeRebuild = yield* (yield* index.refresh(
							fixture.request
						)).query.search(request);
						yield* index.invalidate(fixture.request);
						const full = yield* index.refresh(fixture.request);
						expect(full.join.strategy).toBe("full");
						expect(yield* full.query.search(request)).toEqual(beforeRebuild);
						expect(yield* first.query.search(request)).toEqual(original);
					}).pipe(
						Effect.provide(
							fixture.layer(
								false,
								fixture.source,
								false,
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 120_000
								})
							)
						)
					);
				})
			)
		);
	}, 120_000);
});

/** Facts, reasons, and review flags are sets in the wire contract. */
function normalizeMark<A extends LocalizationCultureMark>(mark: A): A {
	return {
		...mark,
		facts: [...mark.facts].sort(),
		unknownReasons: [...mark.unknownReasons].sort(),
		...(mark.review && mark.review.status !== "not_reviewed"
			? { review: { ...mark.review, flags: [...mark.review.flags].sort() } }
			: undefined)
	};
}
function normalizeUnit(unit: TextUnitSearchResult): TextUnitSearchResult {
	return {
		...unit,
		...(unit.localization ? { localization: unit.localization.map(normalizeMark) } : undefined)
	};
}
function normalizeLine(line: LocalizationLinePreview): LocalizationLinePreview {
	return { ...line, cultures: line.cultures.map(normalizeMark) };
}
function normalizeFocus(focus: TextCorpusFocus | undefined): TextCorpusFocus | undefined {
	return focus
		? {
				...focus,
				unit: normalizeUnit(focus.unit),
				...(focus.localization
					? { localization: normalizeLine(focus.localization) }
					: undefined)
			}
		: undefined;
}
function normalizePage(page: TextCorpusSearchPage): TextCorpusSearchPage {
	return {
		...page,
		units: page.units.map(normalizeUnit),
		...(page.localization
			? {
					localization: {
						...page.localization,
						lines: page.localization.lines.map((line) => ({
							...line,
							cultures: line.cultures.map(normalizeMark)
						}))
					}
				}
			: undefined)
	};
}
