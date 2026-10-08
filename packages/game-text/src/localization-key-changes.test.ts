import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	applyLocalizationKeyChanges,
	localizationKeyChanges,
	localizationKeyChangesAcross
} from "./localization-key-changes.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	target,
	unit
} from "./localization.test-support.js";
import { textCorpusQuery } from "./query.js";
import { TextUnit, type TextCorpus } from "./schema.js";

function cell(key: string, source: string, row = "Start"): TextUnit {
	return Schema.decodeUnknownSync(TextUnit)({
		id: `unit:${key}`,
		source: { status: "consistent", value: source },
		identity: { status: "resolved", namespace: "NS", key },
		occurrences: [
			{
				id: `occurrence:${key}`,
				devNotes: "",
				packageFile: "Content/Text/DT_Menu.uasset",
				source,
				identity: { status: "resolved", namespace: "NS", key },
				editCapability: "source_editable",
				location: {
					kind: "data_table_cell",
					objectPath: "/Game/Text/DT_Menu.DT_Menu",
					row,
					propertyPath: "Label"
				}
			}
		]
	});
}

function scanned(units: readonly TextUnit[]): TextCorpus {
	return {
		...corpus(units),
		packageCoverage: [
			{ packageFile: "Content/Text/Table.uasset", status: "complete" },
			{ packageFile: "Content/Text/DT_Menu.uasset", status: "complete" }
		]
	};
}

describe("localization key changes", () => {
	it("pairs a DataTable cell whose key changed by its saved place, even when the text changed", () => {
		const text = scanned([cell("NewKey", "Start the game")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("OldKey", "Start game", "/Game/Text/DT_Menu.DT_Menu.Start.Label")],
				[archiveEntry("OldKey", "Start game", "Spiel starten")]
			)
		);
		const { pairs, ambiguous } = localizationKeyChanges(joined, text);
		expect(ambiguous).toBe(0);
		expect(pairs).toEqual([
			{
				from: { namespace: "NS", key: "OldKey" },
				to: { namespace: "NS", key: "NewKey" },
				match: "same_place",
				sourceChanged: true,
				previousSource: "Start game",
				// The native culture's "translation" is its source and is never carried.
				translations: [{ culture: cultureCode("de"), translation: "Spiel starten" }]
			}
		]);
	});

	it("pairs String Table entries by unchanged text in the same table", () => {
		const text = scanned([unit("Renamed", "Welcome back")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("Welcome", "Welcome back")],
				[archiveEntry("Welcome", "Welcome back", "Willkommen zurück")]
			)
		);
		const [found] = localizationKeyChanges(joined, text).pairs;
		expect(found?.match).toBe("same_text_in_package");
		expect(found?.sourceChanged).toBe(false);
	});

	it("leaves ambiguous candidates unpaired and counts them", () => {
		const text = scanned([unit("First", "OK"), unit("Second", "OK")]);
		const joined = joinLocalizationTarget(
			text,
			evidence([manifestEntry("Old", "OK")], [archiveEntry("Old", "OK", "OK")])
		);
		expect(localizationKeyChanges(joined, text)).toEqual({ pairs: [], ambiguous: 2 });
	});

	it("pairs gathered C++ keys across a gather, carrying translations Unreal trimmed", () => {
		const text = scanned([]);
		const path = "Source/Game/Private/Menu.cpp(12)";
		const before = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("MenuTitle", "Main menu", path)],
				[archiveEntry("MenuTitle", "Main menu", "Hauptmenü")]
			)
		);
		const after = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("MainMenuTitle", "Main menu", path)],
				[archiveEntry("MainMenuTitle", "Main menu", "")]
			)
		);
		const { pairs } = localizationKeyChangesAcross(before, after);
		expect(pairs.map((item) => [item.from.key, item.to.key, item.match])).toEqual([
			["MenuTitle", "MainMenuTitle", "same_place"]
		]);
		expect(pairs[0]?.translations).toEqual([
			{ culture: cultureCode("de"), translation: "Hauptmenü" }
		]);
	});

	it("marks both lines, filters new keys and counts them in the query", () => {
		const text = scanned([cell("NewKey", "Start game"), unit("Other", "Other")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[
					manifestEntry("OldKey", "Start game", "/Game/Text/DT_Menu.DT_Menu.Start.Label"),
					manifestEntry("Other", "Other")
				],
				[
					archiveEntry("OldKey", "Start game", "Spiel starten"),
					archiveEntry("Other", "Other")
				]
			)
		);
		const marked = applyLocalizationKeyChanges(
			joined,
			localizationKeyChanges(joined, text).pairs
		);
		const byKey = (key: string) => marked.lines.find((line) => line.identity?.key === key);
		expect(byKey("NewKey")?.keyChange).toMatchObject({
			direction: "to",
			other: { key: "OldKey" }
		});
		expect(byKey("OldKey")?.keyChange).toMatchObject({
			direction: "from",
			other: { key: "NewKey" }
		});
		const query = textCorpusQuery(text, undefined, marked);
		const request = {
			query: "",
			capability: "all" as const,
			pageSize: 50,
			localization: { target: target.name }
		};
		expect(query.search(request).localization?.keyChanged).toBe(1);
		const changed = query.search({
			...request,
			localization: { ...request.localization, keyChanged: true }
		});
		expect(changed.total).toBe(1);
		expect(changed.localization?.lines[0]?.keyChange?.other.key).toBe("OldKey");
	});
});
