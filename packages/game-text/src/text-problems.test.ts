import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import { GameTextLocalizationError } from "./localization-schema.js";
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
import { TextProblem, type TextFilter } from "./schema.js";
import { matchesTextFilter, textProblems, type TextFacts } from "./text-problems.js";

const facts: TextFacts = {
	problems: ["not_gathered", "finding"],
	findings: ["long"],
	translation: [],
	origins: ["data_table"],
	paths: ["content/ui/dt_menu.uasset", "/game/ui/dt_menu.dt_menu"],
	files: ["Content/UI/DT_Menu"],
	namespace: "Menu",
	editing: ["editable"],
	notes: "missing"
};

describe("text problems", () => {
	it("lists every problem worst first, and up to date alone when there is none", () => {
		expect(textProblems({ signals: [], keyChanged: false })).toEqual(["up_to_date"]);
		expect(textProblems({ signals: ["long", "conflicting"], keyChanged: true })).toEqual([
			"key_changed",
			"conflicting_source",
			"finding"
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
		const both: TextFilter = [
			{ field: "origin", op: "is", values: ["data_table"] },
			{ field: "problem", op: "is", values: ["translation"] }
		];
		expect(is(both)).toBe(false);
		expect(matchesTextFilter(facts, both, "problem")).toBe(true);
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
	const text = corpus(units);
	const archives = [
		archiveEntry("Done"),
		archiveEntry("Changed", "Earlier text"),
		archiveEntry("Untranslated", "Untranslated", ""),
		archiveEntry("Long", "A line long enough to count as long text in review"),
		archiveEntry("Code", "From code")
	];
	const gathered = evidence(
		[
			manifestEntry("Done"),
			manifestEntry("Changed", "Earlier text"),
			manifestEntry("Untranslated", "Untranslated"),
			manifestEntry("Long", "A line long enough to count as long text in review"),
			manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)")
		],
		archives
	);
	// Only de lacks the translation; en has every line.
	const translated = archives.map((entry) =>
		entry.key === "Untranslated" ? archiveEntry("Untranslated", "Untranslated", "Done") : entry
	);
	const join = joinLocalizationTarget(
		text,
		{
			...gathered,
			cultures: gathered.cultures.map((item) =>
				item.culture === "en" && item.archive.status === "read"
					? {
							...item,
							archive: {
								...item.archive,
								value: { ...item.archive.value, entries: translated }
							}
						}
					: item
			)
		},
		target
	);
	const query = textCorpusQuery(text, undefined, join);
	const request = {
		query: "",
		capability: "all" as const,
		pageSize: 50,
		localization: { target: target.name }
	};
	const keys = (filter: TextFilter, cultures?: readonly string[]) =>
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
			.localization?.lines.map((line) => line.identity?.key);

	it("counts each problem as the total its filter returns", () => {
		const all = query.search(request);
		expect(all.problems).toEqual({
			key_changed: 0,
			conflicting_source: 0,
			not_gathered: 1,
			changed_since_gather: 1,
			translation: 1,
			finding: 1,
			up_to_date: 2
		});
		for (const problem of TextProblem.literals) {
			const filtered = query.search({
				...request,
				filter: [{ field: "problem", op: "is", values: [problem] }]
			});
			expect(filtered.total).toBe(all.problems?.[problem]);
			// The problem clause never narrows the problem counts.
			expect(filtered.problems).toEqual(all.problems);
		}
		expect(keys([{ field: "problem", op: "is", values: ["not_gathered"] }])).toEqual(["New"]);
		expect(keys([{ field: "problem", op: "is", values: ["up_to_date"] }])).toEqual([
			"Code",
			"Done"
		]);
	});

	it("combines clauses and narrows problem counts by the other clauses", () => {
		const filter: TextFilter = [
			{ field: "origin", op: "is_not", values: ["cpp"] },
			{ field: "problem", op: "is", values: ["up_to_date"] }
		];
		expect(keys(filter)).toEqual(["Done"]);
		const page = query.search({ ...request, filter });
		expect(page.problems?.up_to_date).toBe(1);
		expect(page.problems?.not_gathered).toBe(1);
		expect(keys([{ field: "translation", op: "is", values: ["missing"] }])).toEqual([
			"Untranslated"
		]);
		expect(keys([{ field: "editing", op: "is", values: ["read_only"] }])).toEqual(["Code"]);
	});

	it("looks only at the cultures in scope", () => {
		const translation: TextFilter = [{ field: "problem", op: "is", values: ["translation"] }];
		expect(keys(translation, ["de"])).toEqual(["Untranslated"]);
		expect(keys(translation, ["en"])).toEqual([]);
		expect(keys(translation, ["en", "de"])).toEqual(["Untranslated"]);
		const scoped = query.search({
			...request,
			localization: { ...request.localization, cultures: [cultureCode("en")] }
		});
		expect(scoped.localization?.counts.map((counts) => counts.culture)).toEqual(["en"]);
		expect(() =>
			query.search({
				...request,
				localization: { ...request.localization, cultures: [cultureCode("fr")] }
			})
		).toThrow(GameTextLocalizationError);
	});

	it("refuses translation filters without a target", () => {
		expect(() =>
			query.search({
				query: "",
				capability: "all",
				pageSize: 50,
				filter: [{ field: "translation", op: "is", values: ["missing"] }]
			})
		).toThrow(GameTextLocalizationError);
		const corpusOnly = query.search({ query: "", capability: "all", pageSize: 50 });
		expect(corpusOnly.problems?.finding).toBe(1);
		expect(corpusOnly.problems?.up_to_date).toBe(4);
	});
});
