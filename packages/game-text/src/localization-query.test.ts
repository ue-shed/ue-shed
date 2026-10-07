import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { TextCorpusFocus, TextCorpusSearchPage } from "./schema.js";
import { textCorpusQuery } from "./query.js";
import { joinLocalizationTarget } from "./localization.js";
import { GameTextLocalizationError, LocalizationLineId } from "./localization-schema.js";
import { LocalizationStatusReport, localizationStatusReport } from "./localization-status.js";
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

const request = {
	query: "",
	capability: "all",
	pageSize: 50,
	localization: { target: target.name }
} satisfies Parameters<ReturnType<typeof textCorpusQuery>["search"]>[0];

describe("bounded localization query", () => {
	it("adds compact state marks, culture focus and manifest locations", () => {
		const text = corpus();
		const files = evidence(
			[manifestEntry()],
			[archiveEntry()],
			poDocument("Changed translation")
		);
		const query = textCorpusQuery(text, undefined, joinLocalizationTarget(text, files));
		const page = query.search(request);
		Schema.decodeUnknownSync(TextCorpusSearchPage)(page);
		expect(page.units[0]?.localization?.[0]?.state).toBe("not_synced");
		const first = page.localization?.lines[0];
		if (!first) throw new Error("Missing query line.");
		const focus = query.localizationFocus(first.id);
		expect(focus?.cultures[0]?.archive?.translation.Text).toBe("Translation");
		expect(focus?.cultures[0]?.poTranslation).toBe("Changed translation");
		expect(focus?.cultures[0]?.po).toMatchObject({
			translatorComments: ["translator"],
			extractedComments: ["extracted"],
			referenceComments: ["reference"],
			flags: ["fuzzy"]
		});
		expect(focus?.manifest[0]?.path).toBe("/Game/Text/Table.Table");
		const corpusFocus = query.focus({ id: unit().id, pageSize: 50 });
		Schema.decodeUnknownSync(TextCorpusFocus)(corpusFocus);
		expect(corpusFocus?.localization?.cultures).toHaveLength(2);
	});
	it("translation search is opt-in and restricted to the selected culture", () => {
		const text = corpus();
		const files = evidence();
		const query = textCorpusQuery(text, undefined, joinLocalizationTarget(text, files));
		expect(query.search({ ...request, query: "Translation" }).total).toBe(0);
		expect(
			query.search({
				...request,
				query: "Translation",
				localization: {
					target: target.name,
					culture: cultureCode("de"),
					searchTranslations: true
				}
			}).total
		).toBe(1);
		expect(
			query.search({
				...request,
				query: "Translation",
				localization: {
					target: target.name,
					searchTranslations: true
				}
			}).total
		).toBe(0);
	});
	it("counts and words intersect search and state filters, independent of page size", () => {
		const text = corpus([unit("K"), unit("Other", "Other source")]);
		const files = evidence();
		const query = textCorpusQuery(text, undefined, joinLocalizationTarget(text, files));
		const page = query.search({
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
		const noHits = query.search({ ...request, query: "absent" });
		expect(noHits.localization?.counts).toHaveLength(2);
		expect(
			noHits.localization?.counts.every((count) => count.states.not_synced.lines === 0)
		).toBe(true);
		Schema.decodeUnknownSync(LocalizationStatusReport)(
			localizationStatusReport(text, files, page)
		);
	});
	it("gathered-only rows share pagination without using corpus unit IDs", () => {
		const text = corpus([]);
		const files = evidence(
			[
				manifestEntry("A", "A source", "Source/A.cpp(1)"),
				manifestEntry("B", "B source", "Config/B.ini(2)")
			],
			[],
			poDocument("")
		);
		const query = textCorpusQuery(text, undefined, joinLocalizationTarget(text, files));
		const page = query.search({ ...request, pageSize: 1 });
		expect(page.total).toBe(2);
		expect(page.units).toEqual([]);
		expect(page.localization?.lines).toHaveLength(1);
		const cursor = page.localization?.nextCursor;
		if (!cursor) throw new Error("Expected localization cursor.");
		const next = query.search({ ...request, pageSize: 1, localizationCursor: cursor });
		expect(next.localization?.lines[0]?.id).not.toBe(page.localization?.lines[0]?.id);
		expect(next.localization?.nextCursor).toBeUndefined();
		expect(query.localizationFocus(LocalizationLineId.make("missing"))).toBeUndefined();
	});
	it("rejects unavailable selections with a safe typed failure", () => {
		expect(() => textCorpusQuery(corpus()).search(request)).toThrow(GameTextLocalizationError);
		const query = textCorpusQuery(
			corpus(),
			undefined,
			joinLocalizationTarget(corpus(), evidence())
		);
		expect(() =>
			query.search({
				...request,
				localization: { target: target.name, culture: cultureCode("fr") }
			})
		).toThrow(GameTextLocalizationError);
	});
	it("retains the original result when no localization selection is given", () => {
		const text = corpus();
		const plain = { capability: "all", query: "Source", pageSize: 50 } satisfies Parameters<
			ReturnType<typeof textCorpusQuery>["search"]
		>[0];
		expect(
			textCorpusQuery(text, undefined, joinLocalizationTarget(text, evidence())).search(plain)
		).toEqual(textCorpusQuery(text).search(plain));
	});
	it("keeps 5.7 manifest Comment metadata in the notes filter and focus", () => {
		const text = corpus([]);
		const entry = {
			...manifestEntry("K", "Source", "Source/Text.cpp(1)"),
			metadata: { Info: { Comment: "Translator guidance" } }
		};
		const files = evidence([entry]);
		const query = textCorpusQuery(text, undefined, joinLocalizationTarget(text, files));
		expect(query.search({ ...request, withoutNotes: true }).total).toBe(0);
		const line = query.search(request).localization?.lines[0];
		if (!line) throw new Error("Missing localization evidence line.");
		expect(query.localizationFocus(line.id)?.manifest[0]?.metadata).toEqual({
			Info: { Comment: "Translator guidance" }
		});
	});
});
