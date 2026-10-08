import { Effect, Schema } from "effect";
import {
	GameTextInvestigationPreset,
	GameTextInvestigationExport,
	exportGameTextInvestigation
} from "./investigation.js";
import { describe, expect, it } from "vitest";
import { qualityFixture } from "./localization-workspace.test-support.js";
import { cultureCode } from "./localization.test-support.js";
import {
	WorkspaceQualityPage,
	WorkspaceQualityFocusResult,
	WorkspaceChangesResult,
	WorkspaceReportPage,
	localizationReportCsv
} from "./localization-workspace.js";

describe("bounded localization workspace", () => {
	it("combines source, built-in and culture rules through the same culture selection", () => {
		const { workspace, files } = qualityFixture();
		const request = {
			target: files.target.name,
			culture: cultureCode("de"),
			filter: "all"
		} as const;
		const page = workspace.search(request);
		expect(Schema.decodeUnknownSync(WorkspaceQualityPage)(page)).toEqual(page);
		expect(page.counts.all).toBe(page.total);
		expect(page.counts.character_budget).toBe(2);
		expect(page.counts.terminology).toBe(1);
		expect(page.counts.format_arguments).toBe(1);
		expect(
			workspace.search({ ...request, culture: cultureCode("en") }).counts.terminology
		).toBe(0);
		const filtered = workspace.search({ ...request, filter: "format_arguments" });
		expect(filtered.total).toBe(page.counts.format_arguments);
		const id = filtered.findings[0]?.id;
		if (!id) throw new Error("Expected a format argument finding");
		const result = workspace.focus({ ...request, id });
		expect(Schema.decodeUnknownSync(WorkspaceQualityFocusResult)(result)).toEqual(result);
		if (result.status !== "found" || result.focus.kind !== "localization")
			throw new Error("Expected localization detail");
		const focus = result.focus;
		expect(
			focus.sourceRanges.map((range) => focus.source.slice(range.start, range.end))
		).toEqual(["{PlayerName}"]);
		expect(
			focus.translationRanges.map((range) => focus.translation?.slice(range.start, range.end))
		).toEqual(["{Name}"]);
		expect(result.focus.translations.translations.map((mark) => mark.culture)).toEqual(["de"]);
		expect(result.focus.suggestedChange?.translation).toBe("Hallo {PlayerName}");
		expect(workspace.focus({ ...request, culture: cultureCode("en"), id })).toEqual({
			status: "not_found"
		});
	});

	it("bounds pages and copied proposals and omits file authority", () => {
		const { workspace, files } = qualityFixture(105);
		const request = {
			target: files.target.name,
			culture: cultureCode("de"),
			filter: "format_arguments"
		} as const;
		const first = workspace.search(request);
		expect(first.findings).toHaveLength(50);
		expect(first.nextOffset).toBe(50);
		expect(workspace.search({ ...request, offset: 100 }).findings).toHaveLength(5);
		const changes = workspace.changes(request);
		expect(Schema.decodeUnknownSync(WorkspaceChangesResult)(changes)).toEqual(changes);
		if (changes.status !== "ready") throw new Error("Expected proposals");
		expect(changes.document.changes).toHaveLength(100);
		expect(changes.remaining).toBe(5);
		expect(changes.document.provenance.files).toEqual([]);
	});

	it("preserves v2 rules in existing source investigation exports", async () => {
		const { text, document } = qualityFixture();
		const preset = Schema.decodeUnknownSync(GameTextInvestigationPreset)({
			schemaVersion: 1,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "quality",
				query: "",
				capability: "all",
				lens: "all",
				qualityFilter: "all"
			},
			rules: document
		});
		const exported = await Effect.runPromise(
			exportGameTextInvestigation(text, preset, {
				projectRoot: "C:/Project",
				generation: null,
				authority: "project_files"
			})
		);
		expect(Schema.decodeUnknownSync(GameTextInvestigationExport)(exported)).toEqual(exported);
		expect(exported.preset.rules).toEqual(document);
		expect(exported.result).toMatchObject({
			mode: "quality",
			report: { ruleDocumentVersion: 2, findings: [{ kind: "character_budget" }] }
		});
	});

	it("projects native-first report rows, zero baseline deltas and spreadsheet-safe CSV", () => {
		const { page } = qualityFixture();
		expect(Schema.decodeUnknownSync(WorkspaceReportPage)(page)).toEqual(page);
		expect(page.rows.map((row) => row.culture)).toEqual(["en", "de"]);
		expect(page.rows.every((row) => row.newWords === 0 && row.changedWords === 0)).toBe(true);
		expect(JSON.stringify(page)).not.toContain("relativePath");
		const csv = localizationReportCsv(page.rows, true);
		expect(csv.startsWith('\uFEFF"Culture"')).toBe(true);
		expect(csv.endsWith("\r\n")).toBe(true);
		expect(csv.split("\r\n")).toHaveLength(4);
		expect(csv).toContain('"New words","Changed words"');
	});
});
