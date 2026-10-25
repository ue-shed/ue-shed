import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalizationTarget } from "@ue-shed/localization";
import { localizationFocusPage, LocalizationFocusRequest } from "./localization-view.js";
import { describe, expect, it } from "vitest";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { GameTextIndexRefresh } from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import type { LocalizationCultureMark } from "./localization-schema.js";
import { TextCorpusFocusRequest, makeTextUnitId } from "./schema.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!executable)("production native Game Text queries", () => {
	it("fails a closed native reader explicitly and opens a fresh model without substituting a JS query", async () => {
		if (!executable) throw new Error("Native reader required");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					let started = Deferred.makeUnsafe<void>();
					let observe = false;
					const queryPids: number[] = [];
					const implementation = nativeIndexBuilderLayer({
						executable,
						timeoutMs: 30000,
						catalogTimeoutMs: 120000,
						protocolObserver: (event) => {
							if (observe && event.kind === "worker_started") {
								queryPids.push(event.pid);
								Deferred.doneUnsafe(started, Effect.void);
							}
						}
					});
					const prepare = Effect.scoped(
						Effect.gen(function* () {
							const index = yield* GameTextIndexRefresh;
							const model = yield* index.refresh(fixture.request);
							started = Deferred.makeUnsafe<void>();
							queryPids.length = 0;
							observe = true;
							const pending = yield* model.query
								.search({ query: "", capability: "all", pageSize: 1 })
								.pipe(Effect.forkChild);
							yield* Deferred.await(started);
							yield* Fiber.interrupt(pending);
							const page = yield* model.query.search({
								query: "",
								capability: "all",
								pageSize: 1
							});
							observe = false;
							expect(new Set(queryPids).size).toBe(1);
							expect(queryPids.length).toBeGreaterThanOrEqual(2);
							return { query: model.query, page };
						})
					).pipe(Effect.provide(fixture.layer(fixture.source, implementation)));
					const closed = yield* prepare;
					const failed = yield* closed.query
						.search({ query: "", capability: "all", pageSize: 1 })
						.pipe(Effect.result);
					expect(Result.isFailure(failed)).toBe(true);
					if (Result.isFailure(failed)) {
						expect(failed.failure.code).toBe("index_failed");
						expect(failed.failure.retrySafe).toBe(false);
					}
					const reopened = yield* prepare;
					expect(reopened.page).toEqual(closed.page);
				})
			)
		);
	}, 120000);
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
									// The engine adds the line's problems, in every culture.
									problems: ["translation", "unchecked"],
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
								fixture.source,
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
	it("retargets equal-text references, resolves late definitions, and keeps later value edits incremental", async () => {
		if (!executable) throw new Error("Native reader required");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					const shared = "The same displayed text belongs to distinct reference targets.";
					const manifest = fixture.target.outputPaths.manifest;
					if (!manifest) throw new Error("The reference fixture requires a manifest.");
					yield* Effect.promise(() =>
						writeFile(
							join(fixture.projectRoot, manifest),
							JSON.stringify({ FormatVersion: 1, Namespace: "", Children: [] })
						)
					);
					const a = "/Game/Text/First.First";
					const b = "/Game/Text/Second.Second";
					const late = "/Game/Text/Late.Late";
					const definition = (object: string, namespace: string, source = shared) => ({
						source,
						dev_notes: "",
						identity: { status: "resolved" as const, namespace, key: "K" },
						location: {
							kind: "string_table_entry" as const,
							object_path: object,
							entry_key: "K"
						},
						edit_capability: "read_only" as const
					});
					const reference = (table: string) => ({
						source: shared,
						dev_notes: "",
						identity: { status: "string_table" as const, table_id: table, key: "K" },
						location: {
							kind: "asset_property" as const,
							object_path: "/Game/Text/Widget.Widget",
							class_path: "/Script/Engine.DataAsset",
							property_path: "Label"
						},
						edit_capability: "read_only" as const
					});
					const update = (table: string, includeLate: boolean, source = shared) =>
						fixture.update([
							definition(a, "First", source),
							definition(b, "Second"),
							...(includeLate ? [definition(late, "Late")] : []),
							reference(table)
						]);
					const edited =
						"An edited definition keeps the reference target and saved reference text.";
					// A definition's unit, and the unit the widget's reference to a table forms.
					const defined = (namespace: string) => `unreal:${namespace}:K`;
					const referenced = (table: string) =>
						`string-table:${encodeURIComponent(table)}:K`;
					const line = (namespace: string) =>
						`Review:${JSON.stringify([namespace, "K"])}`;
					const unresolved = `Review:unresolved:${referenced(late)}`;
					const gathered = ["not_gathered"];
					/** Each line's units and problems, and each source group's lines. */
					interface Expected {
						readonly lines: readonly (readonly [
							string,
							readonly string[],
							readonly string[]
						])[];
						readonly groups: readonly (readonly [string, readonly string[]])[];
					}
					yield* Effect.gen(function* () {
						const index = yield* GameTextIndexRefresh;
						const request = {
							query: "",
							capability: "all" as const,
							pageSize: 50,
							localization: { target: fixture.target.name }
						};
						update(a, false);
						const pinned = yield* index.refresh(fixture.request);
						const original = yield* pinned.query.search(request);
						const verify = Effect.fn("Test.GameText.referenceTargets")(function* (
							model: Effect.Success<ReturnType<typeof index.refresh>>,
							expected: Expected
						) {
							const page = yield* model.query.search(request);
							expect(page.total).toBe(expected.lines.length);
							expect(
								page.localization?.lines.map((item) => [
									item.id,
									item.origin.kind === "corpus" ? item.origin.unitIds : [],
									item.problems
								])
							).toEqual(expected.lines);
							// A line's row shows its first unit.
							const units = expected.lines.map(([, ids]) => ids[0]!);
							expect(page.units.map((unit) => unit.id)).toEqual(units);
							// Open groups list each group's first rows, as an `openGroup` read does.
							const grouped = { ...request, group: "source" as const };
							expect(
								(yield* model.query.search(grouped)).groups?.entries.map(
									(entry) => [entry.key, entry.count]
								)
							).toEqual(expected.groups.map(([key, lines]) => [key, lines.length]));
							const rows = yield* model.query.searchRows({
								...grouped,
								openGroups: [...expected.groups.map(([key]) => key), "Nowhere"],
								firstRows: 1
							});
							expect(
								rows.openGroups?.map((group) => [
									group.key,
									group.page?.localization?.lines.map((item) => item.id)
								])
							).toEqual([
								...expected.groups.map(([key, lines]) => [key, lines.slice(0, 1)]),
								["Nowhere", []]
							]);
							expect(yield* model.corpus).toEqual(fixture.raw());
							for (const [position, id] of units.entries()) {
								const focus = yield* model.query.focus({
									id: makeTextUnitId(id),
									pageSize: 50
								});
								expect([focus?.unit.id, focus?.localization?.id]).toEqual([
									id,
									expected.lines[position]![0]
								]);
							}
							expect(yield* pinned.query.search(request)).toEqual(original);
						});
						// The reference joins its target's line; a reference to a table without the
						// entry is a line of its own whose state is unknown.
						yield* verify(pinned, {
							lines: [
								[line("First"), [referenced(a), defined("First")], gathered],
								[line("Second"), [defined("Second")], gathered]
							],
							groups: [[shared, [line("First"), line("Second")]]]
						});
						for (const stage of [
							{
								table: b,
								late: false,
								lines: [
									[line("First"), [defined("First")], gathered],
									[line("Second"), [referenced(b), defined("Second")], gathered]
								],
								groups: [[shared, [line("First"), line("Second")]]]
							},
							{
								table: late,
								late: false,
								lines: [
									[line("First"), [defined("First")], gathered],
									[line("Second"), [defined("Second")], gathered],
									[unresolved, [referenced(late)], ["unchecked"]]
								],
								groups: [[shared, [line("First"), line("Second"), unresolved]]]
							},
							{
								table: late,
								late: true,
								lines: [
									[line("First"), [defined("First")], gathered],
									[line("Late"), [referenced(late), defined("Late")], gathered],
									[line("Second"), [defined("Second")], gathered]
								],
								groups: [[shared, [line("First"), line("Late"), line("Second")]]]
							},
							{
								table: a,
								late: true,
								lines: [
									[line("First"), [referenced(a), defined("First")], gathered],
									[line("Late"), [defined("Late")], gathered],
									[line("Second"), [defined("Second")], gathered]
								],
								groups: [[shared, [line("First"), line("Late"), line("Second")]]]
							}
						] satisfies (Expected & { table: string; late: boolean })[]) {
							update(stage.table, stage.late);
							const model = yield* index.refresh(fixture.request);
							expect(model.join.strategy).toBe("full");
							yield* verify(model, stage);
						}
						// The line takes the definition's edited text; the reference keeps its own.
						const afterEdit: Expected = {
							lines: [
								[line("First"), [referenced(a), defined("First")], gathered],
								[line("Late"), [defined("Late")], gathered],
								[line("Second"), [defined("Second")], gathered]
							],
							groups: [
								[shared, [line("Late"), line("Second")]],
								[edited, [line("First")]]
							]
						};
						update(a, true, edited);
						fixture.patchRecord({ fileBytes: 1234 });
						const incremental = yield* index.refresh(fixture.request);
						expect(incremental.join.strategy, JSON.stringify(incremental.join)).toBe(
							"incremental"
						);
						yield* verify(incremental, afterEdit);
						expect(
							(yield* incremental.query.focus({
								id: makeTextUnitId(referenced(a)),
								pageSize: 1
							}))?.unit.source
						).toEqual({ status: "consistent", value: shared });
						fixture.patchRecord({ fileBytes: 2 ** 32 + 2048 });
						const provenance = yield* index.refresh(fixture.request);
						expect(provenance.join).toMatchObject({
							strategy: "incremental",
							affectedLines: 0
						});
						yield* verify(provenance, afterEdit);
					}).pipe(
						Effect.provide(
							fixture.layer(
								fixture.source,
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
	it("updates authored sources beside String Table references incrementally and preserves pinned readers", async () => {
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
						yield* Effect.promise(() =>
							advanceModificationTime(join(fixture.projectRoot, "de.po"))
						);
						const provenanceOnly = yield* index.refresh(fixture.request);
						expect(provenanceOnly.join).toMatchObject({
							rebuilt: true,
							strategy: "incremental",
							affectedLines: 0
						});
						expect(
							provenanceOnly.joined.meta.input.fileProvenances?.["de.po"]
								?.modifiedTime
						).not.toBe(
							first.joined.meta.input.fileProvenances?.["de.po"]?.modifiedTime
						);
						expect(yield* provenanceOnly.query.search(request)).toEqual(original);
						const consistent = (value: string) => ({
							status: "consistent" as const,
							value
						});
						const conflicting = (...values: string[]) => ({
							status: "conflicting" as const,
							values
						});
						const keyLine = 'Review:["UI","K"]';
						const otherLine = 'Review:["UI","Other"]';
						const reference = "string-table:%2FGame%2FText%2FTable.Table:K";
						// Each edit, and the sources UI/K's unit holds after it.
						const edits: readonly (readonly [
							string,
							string,
							ReturnType<typeof consistent> | ReturnType<typeof conflicting>
						])[] = [
							[changed, source, conflicting(changed, source)],
							[third, changed, conflicting(changed, third)],
							[third, third, consistent(third)],
							["Short", "Short", consistent("Short")],
							["Yes", "No", conflicting("No", "Yes")],
							[source, changed, conflicting(changed, source)]
						];
						for (const [a, b, held] of edits) {
							update(a, b);
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
							const conflicts = held.status === "conflicting";
							const fullLines = yield* model.query.readLocalizationLines();
							expect(fullLines.map((line) => [line.id, line.source])).toEqual([
								['Review:["UI","Blank"]', "  "],
								[keyLine, conflicts ? `${a} ${b}` : a],
								[otherLine, source]
							]);
							// Blank text is no row; the reference and UI/K share UI/K's problems.
							const keyProblems = conflicts ? ["conflicting_source"] : ["up_to_date"];
							const page = yield* model.query.search(request);
							expect(
								page.units.map((unit) => [unit.id, unit.source, unit.problems])
							).toEqual([
								[reference, consistent(source), keyProblems],
								["unreal:UI:K", held, keyProblems],
								["unreal:UI:Other", consistent(source), ["up_to_date"]]
							]);
							// UI/K's line is unchecked while its texts conflict, else its one text
							// changed since Unreal gathered "Source"; UI/Other was never gathered.
							const scoped = yield* model.query.search({
								...request,
								localization: { target: fixture.target.name }
							});
							expect(
								scoped.localization?.lines.map((line) => [
									line.id,
									line.origin.kind === "corpus" ? line.origin.unitIds : [],
									line.cultures.map((mark) => mark.state),
									line.problems
								])
							).toEqual([
								[
									keyLine,
									[reference, "unreal:UI:K"],
									conflicts
										? ["unknown", "unknown"]
										: ["changed_since_gather", "changed_since_gather"],
									conflicts
										? ["conflicting_source", "translation", "unchecked"]
										: ["changed_since_gather", "translation"]
								],
								[
									otherLine,
									["unreal:UI:Other"],
									["not_gathered", "not_gathered"],
									["not_gathered"]
								]
							]);
							expect(scoped.units.map((unit) => unit.id)).toEqual([
								reference,
								"unreal:UI:Other"
							]);
							for (const selected of [page, scoped])
								for (const [position, unit] of selected.units.entries()) {
									const line = selected.localization?.lines[position];
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
									const focused = yield* model.query.focus(focus);
									expect([
										focused?.unit.id,
										focused?.unit.source,
										focused?.occurrences.length,
										focused?.totalOccurrences,
										focused?.localization?.id
									]).toEqual([
										unit.id,
										unit.source,
										1,
										unit.id === "unreal:UI:K" ? 2 : 1,
										// Without a selected line, the focus shows the unit's line.
										unit.id === "unreal:UI:Other" ? otherLine : keyLine
									]);
								}
							// Native handles retain unopened frames even after later publications.
							expect(yield* first.query.search(request)).toEqual(original);
							if (a === source && b === changed) {
								yield* Effect.promise(() =>
									advanceModificationTime(join(fixture.projectRoot, "de.po"))
								);
								const reobserved = yield* index.refresh(fixture.request);
								expect(reobserved.join).toMatchObject({
									rebuilt: true,
									strategy: "incremental",
									affectedLines: 0
								});
								// A new modification time alone changes no answer.
								expect(yield* reobserved.query.search(request)).toEqual(page);
								expect(
									yield* reobserved.query.search({
										...request,
										localization: { target: fixture.target.name }
									})
								).toEqual(scoped);
							}
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
								fixture.source,
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

async function advanceModificationTime(path: string) {
	const previous = await stat(path);
	await utimes(path, previous.atime, new Date(previous.mtimeMs + 5000));
}

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
