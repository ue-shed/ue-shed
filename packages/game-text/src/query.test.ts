import { describe, expect, it } from "vitest";
import { textCorpusQuery } from "./query.js";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	type TextCorpus,
	type TextOccurrence
} from "./schema.js";

const identity = { key: "Continue", namespace: "UI", status: "resolved" as const };

function occurrence(index: number): TextOccurrence {
	return {
		editCapability: "source_editable",
		id: makeTextOccurrenceId(`occurrence:${index}`),
		identity,
		location: {
			kind: "data_table_cell",
			objectPath: "/Game/Text/DT_Menu.DT_Menu",
			propertyPath: "Prompt",
			row: `Continue${index}`
		},
		packageFile: "Content/Text/DT_Menu.uasset",
		source: "Continue"
	};
}

const corpus: TextCorpus = {
	coverage: {
		discoveredPackages: 1,
		failedPackages: 0,
		inspectedPackages: 1,
		partialPackages: 0,
		resolvedOccurrences: 4,
		textOccurrences: 4,
		textUnits: 1,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1,
	status: "complete",
	units: [
		{
			id: makeTextUnitId("unreal:UI:Continue"),
			identity,
			occurrences: [occurrence(1), occurrence(2), occurrence(3), occurrence(4)],
			source: { status: "consistent", value: "Continue" }
		}
	]
};

describe("text corpus query context", () => {
	it("carries a bounded location preview and the remaining context count", () => {
		const page = textCorpusQuery(corpus).search({
			capability: "all",
			pageSize: 50,
			query: ""
		});

		expect(page.units[0]?.contexts).toHaveLength(3);
		expect(page.units[0]?.contexts[0]?.location).toEqual(
			corpus.units[0]?.occurrences[0]?.location
		);
		expect(page.units[0]?.remainingContextCount).toBe(1);
	});

	it("classifies review work once for summary, search, and focus", () => {
		const duplicate: TextCorpus = {
			...corpus,
			units: [
				...corpus.units,
				{
					...corpus.units[0]!,
					id: makeTextUnitId("unreal:UI:ContinueAlternate"),
					identity: { key: "ContinueAlternate", namespace: "UI", status: "resolved" },
					occurrences: [occurrence(5)]
				}
			]
		};
		const query = textCorpusQuery(duplicate);

		expect(query.summary().review).toMatchObject({
			all: 2,
			duplicateSource: 2,
			shared: 1
		});
		expect(
			query.search({ capability: "all", lens: "duplicate_source", pageSize: 50, query: "" })
				.units
		).toHaveLength(2);
		expect(
			query.search({ capability: "all", lens: "shared", pageSize: 50, query: "" }).units[0]
				?.reviewSignals
		).toContain("shared");
	});
});

it("exports every filtered unit with full occurrences and whole-scan coverage", () => {
	const units = Array.from({ length: 123 }, (_, index) => ({
		...corpus.units[0]!,
		id: makeTextUnitId("unit:" + String(index).padStart(3, "0")),
		source: {
			status: "consistent" as const,
			value: 'A very long source, with "quotes"\nand every character preserved ' + index
		}
	}));
	const model = textCorpusQuery({ ...corpus, units });
	const query = {
		capability: "source_editable" as const,
		lens: "long" as const,
		query: "source"
	};
	expect(model.search({ ...query, pageSize: 50 }).units).toHaveLength(50);
	const exported = model.export(query);
	expect(exported.units).toHaveLength(123);
	expect(exported.units[122]?.occurrences).toHaveLength(4);
	expect(exported.units[122]?.source).toEqual(units[122]?.source);
	expect(exported.coverage).toEqual(corpus.coverage);
	expect(model.export({ ...query, query: "no such text" }).units).toEqual([]);
	expect(model.export({ ...query, capability: "read_only" }).units).toEqual([]);
});
