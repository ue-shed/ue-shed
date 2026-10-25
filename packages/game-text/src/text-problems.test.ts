import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import type { NativeTextQuery } from "./native-query-contract.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	target,
	unit
} from "./localization.test-support.js";
import { TextProblem, type TextFilter } from "./schema.js";
import { matchesTextFilter, textProblems, type TextFacts } from "./text-problems.js";
import { textGroupOf, textGroups } from "./text-groups.js";

const facts: TextFacts = {
	problems: ["not_gathered", "finding"],
	findings: ["length_outlier"],
	translation: [],
	origins: ["data_table"],
	paths: ["content/ui/dt_menu.uasset", "/game/ui/dt_menu.dt_menu"],
	files: ["Content/UI/DT_Menu"],
	namespace: "Menu",
	editing: ["editable"],
	notes: "missing",
	audience: "player"
};

describe("text problems", () => {
	it("lists every problem worst first, and up to date alone when there is none", () => {
		expect(textProblems({ signals: [], keyChanged: false })).toEqual(["up_to_date"]);
		expect(
			textProblems({
				signals: ["unresolved", "conflicting"],
				keyChanged: true,
				finding: true
			})
		).toEqual(["key_changed", "conflicting_source", "finding"]);
		// Facts other than `conflicting` raise nothing; findings come from the rules that count.
		expect(textProblems({ signals: ["unresolved"], keyChanged: false })).toEqual([
			"up_to_date"
		]);
		// Evidence only is a fact about where text lives, not a problem.
		expect(textProblems({ signals: ["evidence_only"], keyChanged: false })).toEqual([
			"up_to_date"
		]);
	});

	it("matches clauses as any-of, negates them, and can leave one field out", () => {
		const is = (filter: TextFilter) => matchesTextFilter(facts, filter);
		expect(is([{ field: "problem", op: "is", values: ["key_changed", "not_gathered"] }])).toBe(
			true
		);
		expect(is([{ field: "problem", op: "is_not", values: ["not_gathered"] }])).toBe(false);
		expect(is([{ field: "folder", op: "is", values: ["Content\\UI\\"] }])).toBe(true);
		expect(is([{ field: "folder", op: "is_not", values: ["/Game/UI/"] }])).toBe(false);
		expect(is([{ field: "notes", op: "is", values: ["missing"] }])).toBe(true);
		expect(is([{ field: "audience", op: "is", values: ["player", "unknown"] }])).toBe(true);
		expect(is([{ field: "audience", op: "is_not", values: ["player"] }])).toBe(false);
		expect(is([{ field: "audience", op: "is", values: ["editor"] }])).toBe(false);
		const both: TextFilter = [
			{ field: "origin", op: "is", values: ["data_table"] },
			{ field: "problem", op: "is", values: ["translation"] }
		];
		expect(is(both)).toBe(false);
		expect(matchesTextFilter(facts, both, "problem")).toBe(true);
	});

	it("matches exact sources, facts and findings, and groups by source with a minimum", () => {
		const sourced: TextFacts = {
			...facts,
			reviewSignals: ["unresolved", "conflicting"],
			sources: ["Blue cap", "Red cap"]
		};
		const is = (filter: TextFilter, item = sourced) => matchesTextFilter(item, filter);
		expect(is([{ field: "source", op: "is", values: ["Red cap"] }])).toBe(true);
		expect(is([{ field: "source", op: "is", values: ["red cap", "Red cap "] }])).toBe(false);
		expect(is([{ field: "source", op: "is_not", values: ["Blue cap"] }])).toBe(false);
		expect(is([{ field: "fact", op: "is", values: ["conflicting"] }])).toBe(true);
		// Without facts a fact clause matches none; finding clauses name the rules with findings.
		expect(is([{ field: "fact", op: "is", values: ["conflicting"] }], facts)).toBe(false);
		expect(is([{ field: "finding", op: "is", values: ["length_outlier"] }], facts)).toBe(true);
		expect(is([{ field: "finding", op: "is", values: ["conflicting"] }], facts)).toBe(false);
		expect(is([{ field: "source", op: "is", values: ["Red cap"] }], facts)).toBe(false);
		const lines = ["Mushroom", "Mushroom", "Stem", "Mushroom", "Cap"].map(
			(source): TextFacts => ({ ...facts, sources: [source] })
		);
		expect(textGroups(lines, "source")).toMatchObject({
			entries: [
				{ key: "Mushroom", label: "Mushroom", count: 3 },
				{ key: "Cap" },
				{ key: "Stem" }
			],
			more: 0
		});
		expect(textGroups(lines, "source", 2)).toMatchObject({
			entries: [{ key: "Mushroom", count: 3 }],
			more: 0
		});
		expect(textGroupOf(sourced, "source")).toEqual({ key: "Blue cap", label: "Blue cap" });
	});
});

describe("problems in the query", () => {
	// One line per problem.
	const units = [
		unit("Done"),
		unit("New", "Not gathered yet"),
		unit("Changed", "Changed text"),
		unit("Untranslated", "Untranslated"),
		unit("Long", "A line long enough to count as long text in review")
	];
	const archives = [
		archiveEntry("Done"),
		archiveEntry("Changed", "Earlier text"),
		archiveEntry("Untranslated", "Untranslated", ""),
		archiveEntry("Long", "A line long enough to count as long text in review"),
		archiveEntry("Code", "From code")
	];
	// Only de lacks the translation; en has every line.
	const files = evidence(
		[
			manifestEntry("Done"),
			manifestEntry("Changed", "Earlier text"),
			manifestEntry("Untranslated", "Untranslated"),
			manifestEntry("Long", "A line long enough to count as long text in review"),
			manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)")
		],
		archives,
		undefined,
		archives.map((entry) => ({ ...entry, translation: entry.source }))
	);
	const request = {
		query: "",
		capability: "all" as const,
		pageSize: 50,
		localization: { target: target.name }
	};
	const indexed = <A, E>(use: (query: NativeTextQuery) => Effect.Effect<A, E>) =>
		withIndexedCorpus(corpus(units), { files }, (model) => use(model.query));
	const keys = (query: NativeTextQuery, filter: TextFilter, cultures?: readonly string[]) =>
		query
			.search({
				...request,
				localization: {
					...request.localization,
					...(cultures === undefined
						? undefined
						: { cultures: cultures.map((culture) => cultureCode(culture)) })
				},
				filter
			})
			.pipe(Effect.map((page) => page.localization?.lines.map((line) => line.identity?.key)));

	it.live("counts each problem as the total its filter returns", () =>
		indexed((query) =>
			Effect.gen(function* () {
				const all = yield* query.search(request);
				expect(all.problems).toEqual({
					key_changed: 0,
					conflicting_source: 0,
					not_gathered: 1,
					changed_since_gather: 1,
					translation: 1,
					finding: 0,
					unchecked: 0,
					up_to_date: 3
				});
				for (const problem of TextProblem.literals) {
					const filtered = yield* query.search({
						...request,
						filter: [{ field: "problem", op: "is", values: [problem] }]
					});
					expect(filtered.total).toBe(all.problems?.[problem]);
					// The problem clause never narrows the problem counts.
					expect(filtered.problems).toEqual(all.problems);
				}
				expect(
					yield* keys(query, [{ field: "problem", op: "is", values: ["not_gathered"] }])
				).toEqual(["New"]);
				expect(
					yield* keys(query, [{ field: "problem", op: "is", values: ["up_to_date"] }])
				).toEqual(["Code", "Done", "Long"]);
				// A finding clause names rules; without a findings layer it selects no line.
				const rule: TextFilter = [
					{ field: "finding", op: "is", values: ["length_outlier"] }
				];
				const named = yield* query.search({ ...request, filter: rule });
				expect(named.total).toBe(0);
				expect(named.problems?.finding).toBe(0);
				expect(
					yield* keys(query, [{ field: "problem", op: "is", values: ["finding"] }])
				).toEqual([]);
			})
		)
	);

	it.live("combines clauses and narrows problem counts by the other clauses", () =>
		indexed((query) =>
			Effect.gen(function* () {
				const filter: TextFilter = [
					{ field: "origin", op: "is_not", values: ["cpp"] },
					{ field: "problem", op: "is", values: ["up_to_date"] }
				];
				expect(yield* keys(query, filter)).toEqual(["Done", "Long"]);
				const page = yield* query.search({ ...request, filter });
				expect(page.problems?.up_to_date).toBe(2);
				expect(page.problems?.not_gathered).toBe(1);
				expect(
					yield* keys(query, [{ field: "translation", op: "is", values: ["missing"] }])
				).toEqual(["Untranslated"]);
				expect(
					yield* keys(query, [{ field: "editing", op: "is", values: ["read_only"] }])
				).toEqual(["Code"]);
			})
		)
	);

	it.live("looks only at the cultures in scope", () =>
		indexed((query) =>
			Effect.gen(function* () {
				const translation: TextFilter = [
					{ field: "problem", op: "is", values: ["translation"] }
				];
				expect(yield* keys(query, translation, ["de"])).toEqual(["Untranslated"]);
				expect(yield* keys(query, translation, ["en"])).toEqual([]);
				expect(yield* keys(query, translation, ["en", "de"])).toEqual(["Untranslated"]);
				const scoped = yield* query.search({
					...request,
					localization: { ...request.localization, cultures: [cultureCode("en")] }
				});
				expect(scoped.localization?.counts.map((counts) => counts.culture)).toEqual(["en"]);
				const unknown = yield* Effect.flip(
					query.search({
						...request,
						localization: { ...request.localization, cultures: [cultureCode("fr")] }
					})
				);
				expect(unknown).toMatchObject({
					_tag: "GameTextIndexError",
					cause: {
						code: "invalid_input",
						message: "The selected localization culture is not available."
					}
				});
			})
		)
	);

	it.live("refuses translation filters without a target", () =>
		indexed((query) =>
			Effect.gen(function* () {
				const refused = yield* Effect.flip(
					query.search({
						query: "",
						capability: "all",
						pageSize: 50,
						filter: [{ field: "translation", op: "is", values: ["missing"] }]
					})
				);
				expect(refused).toMatchObject({
					_tag: "GameTextIndexError",
					cause: { code: "invalid_input" }
				});
				const corpusOnly = yield* query.search({
					query: "",
					capability: "all",
					pageSize: 50
				});
				expect(corpusOnly.problems?.finding).toBe(0);
				expect(corpusOnly.problems?.up_to_date).toBe(5);
			})
		)
	);
});
