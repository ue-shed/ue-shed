import { describe, expect, it } from "vitest";
import { cultureCell, cultureSummary, lineState } from "./game-text-culture-state.js";
import { clauseParts, hasValue, legacyFilter, toggleValue } from "./game-text-filter-model.js";
import { migratePreferences } from "./game-text-preferences.js";

describe("filter pills", () => {
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
		// "is not" is a separate pill for the same field.
		const excluded = toggleValue(two, { field: "problem", op: "is_not", values: ["finding"] });
		expect(excluded).toHaveLength(2);
		expect(hasValue(excluded, "problem", "finding", "is_not")).toBe(true);
		expect(clauseParts(excluded[1]!).op).toBe("is not");
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
				{ field: "finding", op: "is", values: ["duplicate_source"] },
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
			lens: "all",
			withoutNotes: false,
			where: { files: ["Content/UI/WBP_Menu.uasset"] }
		});
		expect(migrated.filter).toHaveLength(3);
		// Preferences that already have pills are left alone.
		expect(migratePreferences(migrated)).toBe(migrated);
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
			"de missing"
		);
		expect(
			cultureSummary([
				mark("de", "needs_update"),
				mark("fr", "needs_update"),
				mark("ja", "needs_update"),
				mark("ko", "translated")
			])
		).toBe("3 to update");
		expect(cultureSummary([mark("de", "not_translated"), mark("fr", "not_translated")])).toBe(
			"all missing"
		);
		expect(
			cultureSummary([mark("de", "translated", ["not_synced"]), mark("fr", "needs_update")])
		).toBe("de not synced · fr to update");
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
