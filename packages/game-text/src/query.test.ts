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
});
