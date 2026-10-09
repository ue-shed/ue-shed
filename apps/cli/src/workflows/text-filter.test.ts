import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { cultureList, parseTextFilter } from "./text-filter.js";

describe("--filter clauses", () => {
	it.effect("reads fields, is and is-not, and comma-separated values", () =>
		Effect.gen(function* () {
			expect(
				yield* parseTextFilter([
					"problem is key-changed,not-gathered",
					"folder is-not Content/Prototype Maps/",
					"origin is_not cpp",
					"namespace is Menu-UI",
					"asset is Content/Text/DT_Menu-Extra.uasset"
				])
			).toEqual([
				{ field: "problem", op: "is", values: ["key_changed", "not_gathered"] },
				{ field: "folder", op: "is_not", values: ["Content/Prototype Maps/"] },
				{ field: "origin", op: "is_not", values: ["cpp"] },
				// Names keep their spelling; only fixed words accept hyphens.
				{ field: "namespace", op: "is", values: ["Menu-UI"] },
				{ field: "asset", op: "is", values: ["Content/Text/DT_Menu-Extra.uasset"] }
			]);
		})
	);

	it.effect("rejects unknown fields, operators and values with guidance", () =>
		Effect.gen(function* () {
			for (const clause of [
				"problem",
				"problem maybe key-changed",
				"colour is red",
				"problem is late"
			]) {
				const error = yield* Effect.flip(parseTextFilter([clause]));
				expect(error.code).toBe("invalid_selection");
				expect(error.recovery).toContain("is or is-not");
			}
		})
	);

	it("splits a culture list", () => {
		expect(cultureList("de, fr,,ja")).toEqual(["de", "fr", "ja"]);
		expect(cultureList(" , ")).toBeUndefined();
		expect(cultureList(undefined)).toBeUndefined();
	});
});
