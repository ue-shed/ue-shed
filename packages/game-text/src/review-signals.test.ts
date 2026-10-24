import type { TextCorpusSearchPage } from "./schema.js";
import type { GameTextIndexError } from "./index-contract.js";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { textCorpusQuery } from "./query.test-support.js";
import { u32 } from "./joined-target-input.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
for (const mixed of [false, true])
	it.live(
		`matches a full rebuild after same-place and shared-source overlays (mixed=${mixed})`,
		() =>
			Effect.gen(function* () {
				const fixture = yield* makeIndexRegressionFixture();
				const a = "A".repeat(40),
					b = "B".repeat(40),
					c = "C".repeat(40);
				const rows = (source: string, other: string) => [
					occurrence("New", source, "Label"),
					occurrence("K", a, "Label"),
					occurrence("Other", other, "OtherLabel"),
					{
						...occurrence("Missing", a),
						identity: { status: "unresolved" as const, reason: "missing_key" as const }
					},
					...(mixed ? [occurrence("New", c, "ExtraLabel"), occurrence("Clean", c)] : [])
				];
				yield* Effect.gen(function* () {
					const index = yield* GameTextIndexRefresh;
					for (const [step, [source, other, expected]] of (
						[
							[a, a, mixed ? 4 : 3],
							[a, b, mixed ? 2 : 0],
							[b, b, mixed ? 3 : 2],
							[a, "D".repeat(40), mixed ? 2 : 0]
						] as const
					).entries()) {
						fixture.update(rows(source, other));
						const indexed = yield* index.refresh(fixture.request);
						expect(indexed.join.strategy).toBe(step === 0 ? "full" : "incremental");
						const oracle = textCorpusQuery(
							fixture.raw(),
							undefined,
							joinLocalizationTarget(fixture.raw(), indexed.evidence)
						);
						for (const localization of [undefined, { target: fixture.target.name }]) {
							const request = {
								query: "",
								capability: "all" as const,
								pageSize: 50,
								...(localization ? { localization } : undefined)
							};
							const page = yield* indexed.query.search(request);
							expect(page.counts.duplicate_source).toBe(expected);
							expect(page.counts.unresolved).toBe(1);
							expect(
								page.units.map(({ localization: _marks, ...unit }) => unit)
							).toEqual(
								oracle
									.search(request)
									.units.map(({ localization: _marks, ...unit }) => unit)
							);
						}
						// Keep consecutive overlays so the persisted occurrence patches must flatten.
						if (step !== 3) continue;
						const fields = [
							"query.raw.signals",
							"query.slice.signals",
							"query.occurrence.sources"
						];
						const overlay = [];
						for (const field of fields)
							overlay.push(yield* u32(indexed.joined.layer, field));
						const requests = [
							{ query: "", capability: "all" as const, pageSize: 50 },
							{
								query: "",
								capability: "all" as const,
								pageSize: 50,
								localization: { target: fixture.target.name }
							}
						];
						const pages = yield* Effect.all(
							requests.map((request) => indexed.query.search(request))
						);
						yield* index.invalidate(fixture.request);
						const full = yield* index.refresh(fixture.request);
						expect(full.join.strategy).toBe("full");
						for (const [i, field] of fields.entries())
							expect(yield* u32(full.joined.layer, field)).toEqual(overlay[i]);
						expect(
							yield* Effect.all(requests.map((request) => full.query.search(request)))
						).toEqual(pages);
					}
				}).pipe(Effect.provide(fixture.layer()));
			}).pipe(Effect.scoped)
	);
it.live("does not pair a re-keyed place with its gathered or saved previous identity", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const index = yield* GameTextIndexRefresh;
			for (const stale of [false, true]) {
				fixture.update([
					occurrence("New", "Source", "Label"),
					...(stale ? [occurrence("K", "Source", "Label")] : [])
				]);
				const indexed = yield* index.refresh(fixture.request);
				const corpus = fixture.raw();
				const join = joinLocalizationTarget(corpus, indexed.evidence);
				const report = yield* indexed.localizationCheck(STARTER_CHECK_RULES, {
					checks: ["duplicate_source"]
				});
				expect(report.findings).toEqual([]);
				const quality = yield* indexed.localizationQuality(STARTER_CHECK_RULES, {
					checks: ["duplicate_source"]
				});
				expect(quality.findings.length).toBe(0);
				for (const query of [textCorpusQuery(corpus, undefined, join), indexed.query]) {
					const request = { query: "", capability: "all" as const, pageSize: 50 };
					expect((yield* readPage(query.search(request))).counts.duplicate_source).toBe(
						0
					);
					expect(
						(yield* readPage(
							query.search({
								...request,
								localization: { target: fixture.target.name }
							})
						)).counts.duplicate_source
					).toBe(0);
				}
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("keeps distinct-place duplicates and excludes old keys through source overlays", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const index = yield* GameTextIndexRefresh;
			for (const [source, otherProperty, expected] of [
				["Source", "OtherLabel", 2],
				["A".repeat(40), "Label", 0],
				["B".repeat(40), "Label", 0]
			] as const) {
				fixture.update([
					occurrence("New", source, "Label"),
					occurrence("K", source, otherProperty)
				]);
				const indexed = yield* index.refresh(fixture.request);
				const corpus = fixture.raw();
				const join = joinLocalizationTarget(corpus, indexed.evidence);
				const oracle = textCorpusQuery(corpus, undefined, join);
				for (const localization of [undefined, { target: fixture.target.name }]) {
					const request = {
						query: "",
						capability: "all" as const,
						pageSize: 50,
						...(localization ? { localization } : undefined)
					};
					expect(
						(yield* indexed.query.search(request)).units.map(
							({ reviewSignals }) => reviewSignals
						)
					).toEqual(
						oracle.search(request).units.map(({ reviewSignals }) => reviewSignals)
					);
					expect((yield* indexed.query.search(request)).counts.duplicate_source).toBe(
						expected
					);
				}
				const options = { checks: ["duplicate_source" as const] };
				const report = yield* indexed.localizationCheck(STARTER_CHECK_RULES, options);
				const quality = yield* indexed.localizationQuality(STARTER_CHECK_RULES, options);
				expect(quality.findings.length).toBe(expected ? 1 : 0);
				expect(report.findings).toHaveLength(quality.findings.length);
				if (source.startsWith("B")) expect(indexed.joined.meta.version).toBe(4);
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
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
it.live("does not transfer duplicate signals between identities sharing an occurrence ID", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		fixture.update([
			occurrence("K", "Other", "Label"),
			occurrence("New", "Source", "Label"),
			occurrence("Third", "Source", "OtherLabel")
		]);
		yield* Effect.gen(function* () {
			const indexed = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const request = { query: "", capability: "all" as const, pageSize: 50 };
			const oracle = textCorpusQuery(fixture.raw()).search(request);
			expect(oracle.counts.duplicate_source).toBe(2);
			expect((yield* indexed.query.search(request)).units).toEqual(oracle.units);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("compares canonical place coordinates consistently in memory and the index", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		fixture.update([
			occurrence("K", "Source", "Label[0]"),
			occurrence("New", "Source", "label(0)")
		]);
		yield* Effect.gen(function* () {
			const indexed = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const request = { query: "", capability: "all" as const, pageSize: 50 };
			const oracle = textCorpusQuery(fixture.raw()).search(request);
			expect(oracle.counts.duplicate_source).toBe(0);
			expect((yield* indexed.query.search(request)).counts).toEqual(oracle.counts);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("keeps case-distinct String Table entries as different places", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		fixture.update(
			["Entry", "entry"].map((key) => ({
				...occurrence(key, "Source"),
				location: {
					kind: "string_table_entry" as const,
					object_path: "/Game/Text/Table.Table",
					entry_key: key
				}
			}))
		);
		yield* Effect.gen(function* () {
			const indexed = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const request = { query: "", capability: "all" as const, pageSize: 50 };
			for (const query of [textCorpusQuery(fixture.raw()), indexed.query])
				expect((yield* readPage(query.search(request))).counts.duplicate_source).toBe(2);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("excludes unresolved text from both sides of duplicate-source matching", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const text = "A".repeat(40);
		fixture.update([
			occurrence("K", text),
			...(["culture_invariant", "missing_key"] as const).map((reason) => ({
				...occurrence(reason, text),
				identity: { status: "unresolved" as const, reason }
			}))
		]);
		yield* Effect.gen(function* () {
			const index = yield* GameTextIndexRefresh;
			for (const source of [text, "B".repeat(40)]) {
				fixture.setSource(source);
				const indexed = yield* index.refresh(fixture.request);
				const corpus = fixture.raw();
				const oracle = textCorpusQuery(
					corpus,
					undefined,
					joinLocalizationTarget(corpus, indexed.evidence)
				);
				for (const localization of [undefined, { target: fixture.target.name }]) {
					const request = {
						query: "",
						capability: "all" as const,
						pageSize: 50,
						...(localization ? { localization } : undefined)
					};
					for (const query of [oracle, indexed.query]) {
						const page = yield* readPage(query.search(request));
						expect(page.counts.duplicate_source).toBe(0);
						expect(page.counts.unresolved).toBe(2);
						expect(page.units.map(({ localization: _marks, ...unit }) => unit)).toEqual(
							oracle
								.search(request)
								.units.map(({ localization: _marks, ...unit }) => unit)
						);
						expect(page.counts).toEqual(oracle.search(request).counts);
					}
				}
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
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
						expect(page.units[0]?.reviewSignals.includes("long")).toBe(
							longest.length >= 40
						);
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
