import { LocalizationLineId, LocalizationLinePreview } from "@ue-shed/game-text/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { batches, carryEdits, keysText, lineRange, reviewChanges } from "./game-text-bulk.js";

type Encoded = typeof LocalizationLinePreview.Encoded;
const preview = Schema.decodeUnknownSync(LocalizationLinePreview);
const id = Schema.decodeUnknownSync(LocalizationLineId);

const mark = (
	code: string,
	state: string,
	translation: string | null,
	review?: Encoded["cultures"][number]["review"]
) => ({
	culture: code,
	state,
	facts: [],
	unknownReasons: [],
	reducedSourceChecking: false,
	translation,
	...(review === undefined ? undefined : { review })
});

function line(name: string, cultures: readonly unknown[], keyChange?: Encoded["keyChange"]) {
	return preview({
		id: "line:" + name,
		origin: { kind: "corpus", unitIds: [] },
		identity: { namespace: "Menu", key: name },
		source: name + " text",
		manifestLocations: [],
		remainingLocationCount: 0,
		cultures,
		...(keyChange === undefined ? undefined : { keyChange })
	});
}

const change = (sourceChanged: boolean) =>
	({
		direction: "to",
		other: { namespace: "Menu", key: "Old" },
		match: "same_place",
		sourceChanged,
		previousSource: "Old text",
		translations: [{ culture: "de", translation: "Alt" }]
	}) satisfies Encoded["keyChange"];

describe("bulk actions", () => {
	it("marks only reviewable, unreviewed translations in the picked cultures", () => {
		const reviewed = {
			status: "current",
			flags: ["reviewed"],
			by: "a",
			at: "now"
		} satisfies Encoded["cultures"][number]["review"];
		const lines = [
			line("Play", [
				mark("en", "translated", "Play"),
				mark("de", "translated", "Spielen"),
				mark("fr", "not_translated", null),
				mark("ja", "needs_update", "プレイ", reviewed)
			]),
			line("Quit", [mark("en", "translated", "Quit"), mark("de", "not_synced", "Ende")])
		];
		const changes = reviewChanges(lines, [], "en");
		expect(
			changes.map((item) => (item.kind === "set" ? item.key : "") + ":" + item.culture)
		).toEqual(["Play:de", "Quit:de"]);
		expect(reviewChanges(lines, ["fr", "ja"], "en")).toEqual([]);
	});

	it("splits review changes into requests the host accepts", () => {
		expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(batches([], 500)).toEqual([]);
	});

	it("carries translations for key changes whose source stayed the same", () => {
		const lines = [
			line("Same", [mark("de", "not_gathered", null)], change(false)),
			line("Edited", [mark("de", "not_gathered", null)], change(true)),
			line("Plain", [mark("de", "translated", "Ja")])
		];
		expect(carryEdits(lines)).toEqual([
			{
				edit: {
					culture: "de",
					namespace: "Menu",
					key: "Same",
					seenTranslation: null,
					translation: "Alt"
				},
				source: "Same text"
			}
		]);
	});

	it("copies keys as two spreadsheet columns", () => {
		expect(keysText([line("Play", []), line("Quit", [])])).toBe("Menu\tPlay\nMenu\tQuit");
	});

	it("ticks a range from the last line ticked, in either direction", () => {
		const order = ["a", "b", "c", "d"].map((name) => ({ id: id("line:" + name) }));
		const names = (lines: readonly { readonly id: string }[]) => lines.map((item) => item.id);
		expect(names(lineRange(order, id("line:b"), id("line:d")))).toEqual([
			"line:b",
			"line:c",
			"line:d"
		]);
		expect(names(lineRange(order, id("line:c"), id("line:a")))).toEqual([
			"line:a",
			"line:b",
			"line:c"
		]);
		expect(names(lineRange(order, undefined, id("line:c")))).toEqual(["line:c"]);
		expect(lineRange(order, id("line:a"), id("line:z"))).toEqual([]);
	});
});
