import { describe, expect, it } from "vitest";
import { textQualityQuery } from "./quality-query.js";
import type { TextQualityReport } from "./quality-schema.js";
import { makeTextOccurrenceId, makeTextUnitId } from "./schema.js";

const occurrence = {
	id: makeTextOccurrenceId("occurrence:menu"),
	location: {
		kind: "data_table_cell" as const,
		objectPath: "/Game/Fixture/Text/DT_Menu.DT_Menu",
		propertyPath: "Label",
		row: "Confirm"
	},
	packageFile: "Content/Fixture/Text/DT_Menu.uasset"
};

const report: TextQualityReport = {
	coverage: {
		discoveredPackages: 3,
		failedPackages: 1,
		inspectedPackages: 2,
		partialPackages: 1,
		resolvedOccurrences: 1,
		textOccurrences: 1,
		textUnits: 1,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 2
	},
	diagnostics: [
		{
			code: "package_partially_decoded",
			message: "Some evidence was not decoded.",
			packageFile: "Content/Fixture/Text/DT_Menu.uasset"
		}
	],
	findings: [
		{
			actual: {
				characterCount: 24,
				kind: "character_count",
				source: "Press the old button now"
			},
			affectedOccurrences: [occurrence],
			expectation: { kind: "maximum_characters", maximumCharacters: 10 },
			kind: "character_budget",
			recovery: "Shorten this prompt.",
			role: "ui.prompt" as never,
			ruleId: "ui.prompt.characters" as never,
			textUnitId: makeTextUnitId("text:menu")
		},
		{
			actual: {
				end: 13,
				kind: "terminology_match",
				source: "Press the old button now",
				start: 10,
				term: "old"
			},
			affectedOccurrences: [occurrence],
			expectation: { kind: "forbidden_term", term: "old" },
			kind: "terminology",
			recovery: "Remove the deprecated term.",
			role: "ui.prompt" as never,
			ruleId: "ui.prompt.terms" as never,
			textUnitId: makeTextUnitId("text:menu")
		}
	],
	roles: [{ matchedOccurrences: 1, matchedTextUnits: 1, role: "ui.prompt" as never }],
	ruleDocumentVersion: 1,
	rules: [
		{ findingCount: 1, ruleId: "ui.prompt.characters" as never },
		{ findingCount: 1, ruleId: "ui.prompt.terms" as never }
	],
	schemaVersion: 1,
	status: "partial"
};

describe("text quality query", () => {
	it("keeps partial coverage visible while returning bounded finding summaries", () => {
		const query = textQualityQuery(report);
		expect(query.summary()).toMatchObject({
			diagnosticCount: 1,
			findingCount: 2,
			status: "partial",
			coverage: { failedPackages: 1, partialPackages: 1, unsupportedTextProperties: 2 }
		});
		const page = query.search({ filter: "all", pageSize: 1 });
		expect(page.findings).toHaveLength(1);
		expect(page.nextCursor).toBe("quality-finding:1");
		expect(page.findings[0]).toMatchObject({
			actual: "24 characters",
			expectation: "Maximum 10 characters",
			role: "ui.prompt",
			ruleId: "ui.prompt.characters",
			textUnitId: "text:menu"
		});
	});

	it("filters by finding kind and pages occurrence evidence only on focus", () => {
		const query = textQualityQuery(report);
		const page = query.search({ filter: "terminology", pageSize: 50 });
		expect(page.total).toBe(1);
		const finding = page.findings[0];
		expect(finding).toBeDefined();
		if (!finding) return;
		const focus = query.focus({ id: finding.id, pageSize: 1 });
		expect(focus).toMatchObject({
			actual: { kind: "terminology_match", start: 10, term: "old" },
			affectedOccurrences: [{ id: "occurrence:menu" }],
			expectation: { kind: "forbidden_term", term: "old" },
			totalOccurrences: 1
		});
	});
});
