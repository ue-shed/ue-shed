import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { LocalizationLineId, LocalizationState } from "./localization-schema.js";
import { LocalizationStatusReport, localizationStatusReport } from "./localization-status.js";
import { TextCorpusFocus, TextCorpusSearchPage } from "./schema.js";
import {
	LocalizationFocus,
	LocalizationFocusRequest,
	localizationFocusPage
} from "./localization-view.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	target,
	unit
} from "./localization.test-support.js";

describe("localization presentation", () => {
	it.live(
		"counts and filters pending PO translations even when the source changed since gather",
		() =>
			withIndexedCorpus(
				corpus([unit("K", "New source")]),
				{
					files: evidence(
						[manifestEntry()],
						[archiveEntry()],
						poDocument("Pending translation")
					)
				},
				({ query }) =>
					Effect.gen(function* () {
						const page = yield* query.search({
							query: "",
							capability: "all",
							pageSize: 50,
							localization: {
								target: target.name,
								state: "not_synced",
								culture: cultureCode("de")
							}
						});
						expect(page.total).toBe(1);
						expect(page.counts.all).toBe(1);
						expect(page.localization?.stateCounts.not_synced).toBe(1);
						expect(page.localization?.stateCounts.changed_since_gather).toBe(1);
						expect(page.localization?.notSynced).toBe(1);
						expect(
							page.localization?.counts.find((item) => item.culture === "de")?.states
								.not_synced.lines
						).toBe(0);
						expect(
							page.localization?.lines[0]?.cultures.find(
								(mark) => mark.culture === "de"
							)?.translation
						).toBe("Pending translation");
						const noHits = yield* query.search({
							query: "absent",
							capability: "all",
							pageSize: 50,
							localization: { target: target.name, state: "not_synced" }
						});
						expect(noHits.localization?.notSynced).toBe(0);
						expect(noHits.localization?.stateCounts.not_synced).toBe(0);
					})
			)
	);
	it("presents the native culture first and omits raw file, metadata and PO blocks", () => {
		const joined = joinLocalizationTarget(
			corpus(),
			evidence(
				[manifestEntry()],
				[archiveEntry("K", "Old source")],
				poDocument("Pending translation")
			)
		);
		const line = joined.lines[0];
		if (!line) throw new Error("Missing line");
		const request = LocalizationFocusRequest.make({
			target: target.name,
			selection: { kind: "line", id: line.id }
		});
		const focus = localizationFocusPage(
			{ ...joined, cultures: [...joined.cultures].reverse() },
			{ ...line, cultures: [...line.cultures].reverse() },
			request
		);
		Schema.decodeUnknownSync(LocalizationFocus)(focus);
		expect(focus.translations.map((mark) => mark.culture)).toEqual(["en", "de"]);
		expect(focus.translations[1]).toMatchObject({
			gameTranslation: "Source",
			gameTextKind: "source_outdated",
			archiveTranslation: "Translation",
			poTranslation: "Pending translation",
			translationSource: "Old source",
			translatorComments: ["translator"],
			flags: ["fuzzy"]
		});
		expect(focus.locations).toEqual(["/Game/Text/Table.Table"]);
		expect(JSON.stringify(focus)).not.toContain("provenance");
		expect(JSON.stringify(focus)).not.toContain("blocks");
		expect(JSON.stringify(focus)).not.toContain("msgstr");
	});
	it("projects source fallbacks separately from stale and pending translations", () => {
		for (const example of [
			{
				recordedSource: "Source",
				archive: "Translation",
				po: "Translation",
				state: "translated",
				game: "Translation",
				kind: "translation"
			},
			{
				recordedSource: "Old source",
				archive: "Old translation",
				po: "",
				state: "needs_update",
				game: "Source",
				kind: "source_outdated"
			},
			{
				recordedSource: "Source",
				archive: "",
				po: "",
				state: "not_translated",
				game: "Source",
				kind: "source_untranslated"
			},
			{
				recordedSource: "Source",
				archive: null,
				po: "",
				state: "not_translated",
				game: "Source",
				kind: "source_untranslated"
			},
			{
				recordedSource: "Source",
				archive: "Translation",
				po: "Pending",
				state: "not_synced",
				game: "Translation",
				kind: "translation"
			},
			{
				recordedSource: "Old source",
				archive: "Old translation",
				po: "Pending",
				state: "not_synced",
				game: "Source",
				kind: "source_outdated"
			},
			{
				recordedSource: "Source",
				archive: "",
				po: "Pending",
				state: "not_synced",
				game: "Source",
				kind: "source_untranslated"
			}
		]) {
			const joined = joinLocalizationTarget(
				corpus(),
				evidence(
					[manifestEntry()],
					example.archive === null
						? []
						: [archiveEntry("K", example.recordedSource, example.archive)],
					poDocument(example.po),
					[archiveEntry("K", "Source", "Source")]
				)
			);
			const line = joined.lines[0];
			if (!line) throw new Error("Missing line");
			const focus = localizationFocusPage(joined, line, {
				target: target.name,
				selection: { kind: "line", id: line.id }
			});
			Schema.decodeUnknownSync(LocalizationFocus)(focus);
			expect(focus.translations[1]).toMatchObject({
				state: example.state,
				gameTranslation: example.game,
				gameTextKind: example.kind,
				archiveTranslation: example.archive,
				poTranslation: example.state === "not_synced" ? "Pending" : null
			});
		}
	});
	it.live(
		"does not call empty PO exports pending edits or invent runtime text for unknown states",
		() => {
			const files = evidence(
				[manifestEntry()],
				[archiveEntry("K", "Old source", "Old translation")],
				poDocument("")
			);
			const joined = joinLocalizationTarget(corpus(), files);
			const line = joined.lines[0];
			if (!line) throw new Error("Missing line");
			expect(
				line.cultures.every(
					(mark) => mark.poTranslation === null && !mark.facts.includes("not_synced")
				)
			).toBe(true);
			const uncertain = {
				...line,
				cultures: line.cultures.map((mark) => ({
					...mark,
					state: LocalizationState.make("unknown")
				}))
			};
			const focus = localizationFocusPage(joined, uncertain, {
				target: target.name,
				selection: { kind: "line", id: line.id }
			});
			expect(
				focus.translations.every(
					(mark) => mark.gameTranslation === null && mark.gameTextKind === "unavailable"
				)
			).toBe(true);
			return withIndexedCorpus(corpus(), { files }, ({ query }) =>
				Effect.map(
					query.search({
						query: "",
						capability: "all",
						pageSize: 50,
						localization: { target: target.name, state: "not_synced" }
					}),
					(page) => expect(page.total).toBe(0)
				)
			);
		}
	);
	it("summarizes culture-independent scope states once while preserving pending evidence", () => {
		for (const state of [
			"outside_target",
			"not_gathered",
			"changed_since_gather",
			"not_found",
			"gathered_only"
		] as const) {
			const joined = joinLocalizationTarget(
				corpus(),
				evidence([manifestEntry()], [archiveEntry()], poDocument("Pending"))
			);
			const line = joined.lines[0];
			if (!line) throw new Error("Missing line");
			const scoped = { ...line, cultures: line.cultures.map((mark) => ({ ...mark, state })) };
			const focus = localizationFocusPage(joined, scoped, {
				target: target.name,
				selection: { kind: "line", id: line.id }
			});
			expect(focus.scopeSummary?.state).toBe(state);
			expect(focus.scopeSummary?.message).toMatch(/gather|fully read|source code/u);
			expect(focus.translations.every((mark) => mark.gameTextKind === "unavailable")).toBe(
				true
			);
			expect(focus.translations.every((mark) => mark.poTranslation === "Pending")).toBe(true);
		}
	});
	it("pages gathered locations and bounds comments and flags", () => {
		const files = evidence(
			Array.from({ length: 57 }, (_, index) =>
				manifestEntry("K", "Source", "Source/Text.cpp(" + index + ")")
			)
		);
		const joined = joinLocalizationTarget(corpus(), files);
		const line = joined.lines[0];
		if (!line) throw new Error("Missing line");
		const request = LocalizationFocusRequest.make({
			target: target.name,
			selection: { kind: "line", id: line.id }
		});
		const detailed = {
			...line,
			cultures: line.cultures.map((mark) => ({
				...mark,
				po: mark.po
					? {
							...mark.po,
							translatorComments: Array.from(
								{ length: 57 },
								(_, index) => "Comment " + index
							),
							flags: Array.from({ length: 53 }, (_, index) => "flag-" + index)
						}
					: null
			}))
		};
		const first = localizationFocusPage(joined, detailed, request);
		expect(first.locations).toHaveLength(50);
		expect(first.totalLocations).toBe(57);
		expect(first.nextLocationOffset).toBe(50);
		const german = first.translations.find((mark) => mark.culture === "de");
		expect(german?.translatorComments).toHaveLength(50);
		expect(german?.flags).toHaveLength(50);
		expect(german?.nextContextOffset).toBe(50);
		const context = localizationFocusPage(joined, detailed, {
			...request,
			poContextOffset: 50
		});
		const nextGerman = context.translations.find((mark) => mark.culture === "de");
		expect(nextGerman?.translatorComments).toHaveLength(7);
		expect(nextGerman?.flags).toHaveLength(3);
		expect(nextGerman?.nextContextOffset).toBeUndefined();
		const next = localizationFocusPage(joined, line, { ...request, locationOffset: 50 });
		expect(next.locations).toHaveLength(7);
		expect(next.nextLocationOffset).toBeUndefined();
	});

	it("pages cultures with the native one first and keeps manifest translator notes", () => {
		const joined = joinLocalizationTarget(
			corpus([]),
			evidence([
				{
					...manifestEntry("K", "Source", "Source/Text.cpp(1)"),
					metadata: { Info: { Comment: "Use this on the start screen." } }
				}
			])
		);
		const line = joined.lines[0];
		const original = line?.cultures[0];
		if (!line || !original) throw new Error("Missing evidence line");
		const cultures = Array.from({ length: 53 }, (_, index) => ({
			...original,
			culture: cultureCode("culture-" + index)
		}));
		cultures[52] = { ...original, culture: cultureCode("en") };
		const expanded = { ...line, cultures };
		const request = LocalizationFocusRequest.make({
			target: target.name,
			selection: { kind: "line", id: line.id }
		});
		const first = localizationFocusPage(joined, expanded, request);
		Schema.decodeUnknownSync(LocalizationFocus)(first);
		expect(first.translations).toHaveLength(50);
		expect(first.translations[0]?.culture).toBe("en");
		expect(first.nextCultureOffset).toBe(50);
		expect(first.translatorNotes).toEqual(["Use this on the start screen."]);
		const next = localizationFocusPage(joined, expanded, { ...request, cultureOffset: 50 });
		expect(next.translations).toHaveLength(3);
		expect(next.nextCultureOffset).toBeUndefined();
	});
});

describe("localization in the query", () => {
	const request = {
		query: "",
		capability: "all" as const,
		pageSize: 50,
		localization: { target: target.name }
	};

	it.live("adds compact state marks, culture focus and manifest locations", () =>
		withIndexedCorpus(
			corpus(),
			{
				files: evidence(
					[manifestEntry()],
					[archiveEntry()],
					poDocument("Changed translation")
				)
			},
			({ query }) =>
				Effect.gen(function* () {
					const page = yield* query.search(request);
					Schema.decodeUnknownSync(TextCorpusSearchPage)(page);
					expect(page.units[0]?.localization?.[0]?.state).toBe("not_synced");
					const first = page.localization?.lines[0];
					if (!first) throw new Error("Missing query line.");
					const focus = yield* query.localizationFocus(first.id);
					expect(focus?.cultures[0]?.archive?.translation.Text).toBe("Translation");
					expect(focus?.cultures[0]?.poTranslation).toBe("Changed translation");
					expect(focus?.cultures[0]?.po).toMatchObject({
						translatorComments: ["translator"],
						extractedComments: ["extracted"],
						referenceComments: ["reference"],
						flags: ["fuzzy"]
					});
					expect(focus?.manifest[0]?.path).toBe("/Game/Text/Table.Table");
					const corpusFocus = yield* query.focus({ id: page.units[0]!.id, pageSize: 50 });
					Schema.decodeUnknownSync(TextCorpusFocus)(corpusFocus);
					expect(corpusFocus?.localization?.cultures).toHaveLength(2);
				})
		)
	);

	it.live("searches translations only when asked, and only in the selected culture", () =>
		Effect.gen(function* () {
			yield* withIndexedCorpus(corpus(), { files: evidence() }, ({ query }) =>
				Effect.gen(function* () {
					const translation = { ...request, query: "Translation" };
					expect((yield* query.search(translation)).total).toBe(0);
					expect(
						(yield* query.search({
							...translation,
							localization: {
								target: target.name,
								culture: cultureCode("de"),
								searchTranslations: true
							}
						})).total
					).toBe(1);
					expect(
						(yield* query.search({
							...translation,
							localization: { target: target.name, searchTranslations: true }
						})).total
					).toBe(0);
				})
			);
			// Without the target's files a localization selection is refused.
			const refused = yield* withIndexedCorpus(corpus(), {}, ({ query }) =>
				Effect.flip(query.search(request))
			);
			expect(refused._tag).toBe("GameTextIndexError");
		})
	);

	it.live(
		"counts lines and words of the search and state filters, whatever the page size",
		() => {
			const text = corpus([unit("K"), unit("Other", "Other source")]);
			const files = evidence();
			return withIndexedCorpus(text, { files }, ({ query }) =>
				Effect.gen(function* () {
					const page = yield* query.search({
						...request,
						pageSize: 1,
						localization: {
							target: target.name,
							culture: cultureCode("de"),
							state: "not_gathered"
						}
					});
					expect(page.total).toBe(1);
					expect(page.localization?.counts[0]?.states.not_gathered).toEqual({
						lines: 1,
						sourceWords: 2
					});
					expect(page.localization?.counts[0]?.states.translated.lines).toBe(0);
					const noHits = yield* query.search({ ...request, query: "absent" });
					expect(noHits.localization?.counts).toHaveLength(2);
					expect(
						noHits.localization?.counts.every(
							(count) => count.states.not_synced.lines === 0
						)
					).toBe(true);
					Schema.decodeUnknownSync(LocalizationStatusReport)(
						localizationStatusReport(text, files, page)
					);
				})
			);
		}
	);

	it.live("pages gathered-only lines with their own cursor", () =>
		withIndexedCorpus(
			{ units: [] },
			{
				files: evidence(
					[
						manifestEntry("A", "A source", "Source/A.cpp(1)"),
						manifestEntry("B", "B source", "Config/B.ini(2)")
					],
					[],
					poDocument("")
				)
			},
			({ query }) =>
				Effect.gen(function* () {
					const page = yield* query.search({ ...request, pageSize: 1 });
					expect(page.total).toBe(2);
					expect(page.units).toEqual([]);
					expect(page.localization?.lines.map((line) => line.identity?.key)).toEqual([
						"A"
					]);
					const cursor = page.localization?.nextCursor;
					if (!cursor) throw new Error("Expected localization cursor.");
					const next = yield* query.search({
						...request,
						pageSize: 1,
						localizationCursor: cursor
					});
					expect(next.localization?.lines.map((line) => line.identity?.key)).toEqual([
						"B"
					]);
					expect(next.localization?.nextCursor).toBeUndefined();
					expect(
						yield* query.localizationFocus(LocalizationLineId.make("missing"))
					).toBeUndefined();
				})
		)
	);

	it.live("counts 5.7 manifest Comment metadata as translator notes", () => {
		const entry = {
			...manifestEntry("K", "Source", "Source/Text.cpp(1)"),
			metadata: { Info: { Comment: "Translator guidance" } }
		};
		return withIndexedCorpus({ units: [] }, { files: evidence([entry]) }, ({ query }) =>
			Effect.gen(function* () {
				expect((yield* query.search({ ...request, withoutNotes: true })).total).toBe(0);
				expect((yield* query.search(request)).total).toBe(1);
			})
		);
	});
});
