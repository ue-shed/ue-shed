import { describe, expect, it } from "vitest";
import { cultureCell, cultureSummary, lineState } from "./game-text-culture-state.js";
import type { TextFilter } from "@ue-shed/game-text/schema";
import {
	clauseParts,
	fieldOp,
	flipClause,
	hasValue,
	legacyFilter,
	toggleValue
} from "./game-text-filter-model.js";
import { migratePreferences } from "./game-text-preferences.js";

describe("filter pills", () => {
	it("reads translation keys as namespace and key, the key alone in the empty namespace", () => {
		const keys = [JSON.stringify(["", "Title"]), JSON.stringify(["UI", "Menu, Back"])];
		expect(clauseParts({ field: "translation_key", op: "is", values: keys })).toEqual({
			field: "Translation key",
			op: "is any of",
			values: "Title, UI, Menu, Back"
		});
	});

	it("reads asset types by their labels and keeps class paths as values", () => {
		const types = ["/Script/UMGEditor.WidgetBlueprint", "/Script/Engine.World"];
		expect(clauseParts({ field: "asset_type", op: "is_not", values: types })).toEqual({
			field: "Asset type",
			op: "is none of",
			values: "Widget blueprint, Level"
		});
		const filter = toggleValue([], { field: "asset_type", op: "is", values: [types[0]!] });
		expect(toggleValue(filter, { field: "asset_type", op: "is", values: [types[1]!] })).toEqual(
			[{ field: "asset_type", op: "is", values: types }]
		);
	});

	it("reads source texts as written, findings by their rules and facts by their labels", () => {
		expect(clauseParts({ field: "source", op: "is", values: ["Mushroom", " cap "] })).toEqual({
			field: "Source text",
			op: "is any of",
			values: "Mushroom,  cap "
		});
		// A finding reads as its rule's label, or its ID when the page has none.
		expect(
			clauseParts(
				{ field: "finding", op: "is_not", values: ["custom.exclaim", "length_outlier"] },
				new Map([["custom.exclaim", "Exclamation mark"]])
			)
		).toEqual({
			field: "Finding",
			op: "is none of",
			values: "Exclamation mark, length_outlier"
		});
		expect(clauseParts({ field: "fact", op: "is", values: ["conflicting"] })).toEqual({
			field: "Fact",
			op: "is",
			values: "Same key, different text"
		});
		// A host-set fact stays in the pill when another value joins it.
		const held = toggleValue([{ field: "fact", op: "is", values: ["evidence_only"] }], {
			field: "fact",
			op: "is",
			values: ["unresolved"]
		});
		expect(held).toEqual([
			{ field: "fact", op: "is", values: ["evidence_only", "unresolved"] }
		]);
	});

	it("keeps one pill per field: values leave or join it under its operator", () => {
		const excluded: TextFilter = [
			{ field: "translation", op: "is_not", values: ["missing", "to_update"] }
		];
		// Picking an excluded value takes it out of the exclusion instead of adding "is".
		const result = toggleValue(excluded, {
			field: "translation",
			op: "is",
			values: ["missing"]
		});
		expect(result).toEqual([{ field: "translation", op: "is_not", values: ["to_update"] }]);
		// A new value joins the existing pill with its operator.
		expect(
			toggleValue(result, { field: "translation", op: "is", values: ["not_synced"] })
		).toEqual([{ field: "translation", op: "is_not", values: ["to_update", "not_synced"] }]);
		expect(fieldOp(result, "translation")).toBe("is_not");
		expect(fieldOp(result, "problem")).toBeUndefined();
	});
	it("merges saved pills with both operators when one is switched", () => {
		const saved: TextFilter = [
			{ field: "origin", op: "is", values: ["asset"] },
			{ field: "origin", op: "is_not", values: ["cpp"] },
			{ field: "editing", op: "is", values: ["editable"] }
		];
		expect(flipClause(saved, 1)).toEqual([
			{ field: "origin", op: "is", values: ["asset", "cpp"] },
			{ field: "editing", op: "is", values: ["editable"] }
		]);
		expect(flipClause(saved, 2)).toEqual([
			saved[0],
			saved[1],
			{ field: "editing", op: "is_not", values: ["editable"] }
		]);
	});
	it("joins values of one field into one pill and drops it when empty", () => {
		const one = toggleValue([], { field: "problem", op: "is", values: ["key_changed"] });
		const two = toggleValue(one, { field: "problem", op: "is", values: ["not_gathered"] });
		expect(two).toEqual([
			{ field: "problem", op: "is", values: ["key_changed", "not_gathered"] }
		]);
		expect(clauseParts(two[0]!)).toEqual({
			field: "Problem",
			op: "is any of",
			values: "Key changed, Not gathered yet"
		});
		// Switching the pill excludes every value in it at once.
		const excluded = flipClause(two, 0);
		expect(excluded).toHaveLength(1);
		expect(hasValue(excluded, "problem", "not_gathered", "is_not")).toBe(true);
		expect(clauseParts(excluded[0]!).op).toBe("is none of");
		const back = toggleValue(
			toggleValue(two, { field: "problem", op: "is", values: ["key_changed"] }),
			{ field: "problem", op: "is", values: ["not_gathered"] }
		);
		expect(back).toEqual([]);
	});

	it("turns 0.10 toggles, lenses and state chips into pills", () => {
		expect(
			legacyFilter({
				capability: "read_only",
				lens: "duplicate_source",
				withoutNotes: true,
				where: { kinds: ["cpp"], pathPrefix: "Source/" },
				localizationState: "needs_update",
				localizationKeyChanged: true
			})
		).toEqual({
			filter: [
				{ field: "problem", op: "is", values: ["key_changed"] },
				{ field: "translation", op: "is", values: ["to_update"] },
				{ field: "finding", op: "is", values: ["localization.duplicate_source"] },
				{ field: "editing", op: "is", values: ["read_only"] },
				{ field: "notes", op: "is", values: ["missing"] },
				{ field: "origin", op: "is", values: ["cpp"] },
				{ field: "folder", op: "is", values: ["Source/"] }
			],
			remainingState: undefined
		});
		// Line facts have no pill yet and stay on the selection.
		expect(legacyFilter({ localizationState: "gathered_only" })).toEqual({
			filter: [],
			remainingState: "gathered_only"
		});
		const migrated = migratePreferences({
			query: "",
			capability: "source_editable",
			lens: "long",
			selectedId: undefined,
			where: { kinds: ["asset"], files: ["Content/UI/WBP_Menu.uasset"] }
		});
		expect(migrated).toMatchObject({
			capability: "all",
			withoutNotes: false,
			where: { files: ["Content/UI/WBP_Menu.uasset"] }
		});
		expect(migrated.filter).toHaveLength(3);
		expect(migrated.lens).toBeUndefined();
		// Preferences that already have pills are left alone.
		expect(migratePreferences(migrated)).toEqual(migrated);
	});
});

describe("culture strip", () => {
	type State = Parameters<typeof cultureCell>[0]["state"];
	const mark = (culture: string, state: State, facts: readonly State[] = []) => ({
		culture,
		state,
		facts
	});

	it("names one or two cultures, counts more, and says all when every culture shares it", () => {
		expect(cultureSummary([mark("de", "not_translated"), mark("fr", "translated")])).toBe(
			"de not translated"
		);
		expect(
			cultureSummary([
				mark("de", "needs_update"),
				mark("fr", "needs_update"),
				mark("ja", "needs_update"),
				mark("ko", "translated")
			])
		).toBe("3 need update");
		expect(cultureSummary([mark("de", "not_translated"), mark("fr", "not_translated")])).toBe(
			"all not translated"
		);
		expect(
			cultureSummary([mark("de", "translated", ["not_synced"]), mark("fr", "needs_update")])
		).toBe("de not synced · fr need update");
		expect(cultureSummary([mark("de", "translated")])).toBe("");
	});

	it("says a gather state once for the line instead of per culture", () => {
		expect(lineState([mark("de", "not_gathered"), mark("fr", "not_gathered")])).toBe(
			"not_gathered"
		);
		expect(lineState([mark("de", "not_gathered"), mark("fr", "translated")])).toBeUndefined();
		expect(lineState([mark("de", "needs_update")])).toBeUndefined();
	});
});
