import type { TextCorpusSearchPage } from "./schema.js";
import type { GameTextIndexError } from "./index-contract.js";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { textCorpusQuery } from "./query.test-support.js";

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

it.live("measures the longest conflicting source across memory, index and refreshed index", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const variants = ["Halt!", "Just a traveler.", "Hit the dummy", "Come back soon."];
		yield* Effect.gen(function* () {
			const index = yield* GameTextIndexRefresh;
			for (const texts of [
				variants,
				["A".repeat(40), "B ".repeat(20)],
				["C".repeat(40), "D ".repeat(20)]
			]) {
				fixture.update(texts.map((text, i) => occurrence("K", text, `Label${i}`)));
				const indexed = yield* index.refresh(fixture.request);
				const corpus = fixture.raw();
				const oracle = textCorpusQuery(
					corpus,
					undefined,
					joinLocalizationTarget(corpus, indexed.evidence)
				);
				const longest = [...texts].sort(
					(a, b) => b.length - a.length || (a < b ? -1 : 1)
				)[0]!;
				for (const localization of [undefined, { target: fixture.target.name }]) {
					const request = {
						query: "",
						capability: "all" as const,
						pageSize: 50,
						...(localization ? { localization } : undefined)
					};
					const expected = oracle.search(request);
					for (const query of [oracle, indexed.query]) {
						const page = yield* readPage(query.search(request));
						expect(page.units[0]?.characterCount).toBe(longest.length);
						expect(page.units[0]?.wordCount).toBe(longest.trim().split(/\s+/u).length);
						expect(page.units[0]?.reviewSignals).toEqual([
							"conflicting",
							"evidence_only"
						]);
						expect(page.units).toEqual(expected.units);
						expect(page.counts).toEqual(expected.counts);
					}
				}
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

/** Accept the independent memory oracle and the asynchronous native-shaped test port. */
function readPage(
	page: TextCorpusSearchPage | Effect.Effect<TextCorpusSearchPage, GameTextIndexError>
) {
	return Effect.isEffect(page) ? page : Effect.succeed(page);
}
