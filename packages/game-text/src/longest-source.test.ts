import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";

const occurrence = (key: string, source: string, property = key) => ({
	source,
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

it.live("measures the longest conflicting source through the index and each refresh", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const index = yield* GameTextIndexRefresh;
			// The texts, the unit's sources in order, the longest text with ties broken by the
			// earlier text, and its words.
			for (const [texts, sources, longest, words] of [
				[
					["Halt!", "Just a traveler.", "Hit the dummy", "Come back soon."],
					["Come back soon.", "Halt!", "Hit the dummy", "Just a traveler."],
					"Just a traveler.",
					3
				],
				[
					["A".repeat(40), "B ".repeat(20)],
					["A".repeat(40), "B ".repeat(20)],
					"A".repeat(40),
					1
				],
				[
					["C".repeat(40), "D ".repeat(20)],
					["C".repeat(40), "D ".repeat(20)],
					"C".repeat(40),
					1
				]
			] as const) {
				fixture.update(texts.map((text, i) => occurrence("K", text, `Label${i}`)));
				const indexed = yield* index.refresh(fixture.request);
				for (const localization of [undefined, { target: fixture.target.name }]) {
					const page = yield* indexed.query.search({
						query: "",
						capability: "all",
						pageSize: 50,
						...(localization ? { localization } : undefined)
					});
					expect(page.total).toBe(1);
					expect(page.units).toHaveLength(1);
					const unit = page.units[0]!;
					expect(unit.id).toBe("unreal:UI:K");
					expect(unit.characterCount).toBe(longest.length);
					expect(unit.wordCount).toBe(words);
					expect(unit.reviewSignals).toEqual(["conflicting", "evidence_only"]);
					expect(unit.source).toEqual({ status: "conflicting", values: sources });
					expect(unit.occurrenceCount).toBe(texts.length);
					// With a target, a key with two texts cannot be checked against the gather.
					expect(unit.problems).toEqual(
						localization ? ["conflicting_source", "unchecked"] : ["conflicting_source"]
					);
					expect(page.counts).toMatchObject({ all: 1, conflicting: 1, readOnly: 1 });
				}
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
