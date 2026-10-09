import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { textCorpusQuery } from "./query.js";
import { LocalizationStatusReport, localizationStatusReport } from "./localization-status.js";
import { localizationProgressReport, LocalizationProgressReport } from "./localization-reports.js";
import { checkLocalizationTarget } from "./localization-checks.js";
import { textQualityQuery } from "./quality-query.js";
import { evaluateTextQuality } from "./quality.js";
import { joinLocalizationTarget } from "./localization.js";
import { corpus, evidence } from "./localization.test-support.js";
import { TextCorpusDiagnostic, TextPackageCoverage } from "./schema.js";
import { TextCorpusDiagnosticSummary, textCorpusDiagnosticSummary } from "./corpus-summary.js";
import {
	GameTextInvestigationExport,
	GameTextInvestigationPreset,
	exportGameTextInvestigation
} from "./investigation.js";

const diagnostics = Array.from({ length: 1_000 }, (_, index) =>
	TextCorpusDiagnostic.make({
		code: TextCorpusDiagnostic.fields.code.literals[index % 3] ?? "package_inspection_failed",
		message: "Synthetic reader diagnostic.",
		packageFile: `Content/Text/Package${index}.uasset`
	})
);
const packageCoverage = Array.from({ length: 1_200 }, (_, index) =>
	TextPackageCoverage.make({
		packageFile: `Content/Text/Package${index}.uasset`,
		status: TextPackageCoverage.fields.status.literals[index % 3] ?? "complete"
	})
);
const text = { ...corpus(), diagnostics, packageCoverage };

describe("bounded corpus reports", () => {
	it("keeps total diagnostics by code and bounds status and progress package evidence", () => {
		const files = evidence();
		const join = joinLocalizationTarget(text, files);
		const page = textCorpusQuery(text, undefined, join).search({
			capability: "all",
			pageSize: 5,
			query: ""
		});
		const reports = [
			localizationStatusReport(text, files, page),
			localizationProgressReport(text, join, files)
		];
		for (const report of reports) {
			expect(report.diagnostics).toEqual(diagnostics.slice(0, 200));
			expect(report.diagnosticCount).toBe(1_000);
			expect(report.diagnosticsOmitted).toBe(800);
			expect(report.diagnosticCounts).toEqual({
				package_inspection_failed: 334,
				package_partially_decoded: 333,
				unsupported_text_history: 333
			});
			expect(report.packageCoverage?.counts).toEqual({
				complete: 400,
				partial: 400,
				failed: 400
			});
			expect(report.packageCoverage?.packages).toHaveLength(200);
			expect(report.packageCoverage?.omitted).toBe(600);
			expect(
				report.packageCoverage?.packages.every((item) =>
					["partial", "failed"].includes(item.status)
				)
			).toBe(true);
		}
		expect(Schema.decodeUnknownSync(LocalizationStatusReport)(reports[0])).toEqual(reports[0]);
		expect(Schema.decodeUnknownSync(LocalizationProgressReport)(reports[1])).toEqual(
			reports[1]
		);
	});

	it("bounds quality reports used by checks and investigations", () => {
		const report = evaluateTextQuality(text, { schemaVersion: 1, roles: [], rules: [] });
		expect(report.diagnostics).toHaveLength(200);
		expect(report.diagnosticCount).toBe(1_000);
		expect(report.diagnosticsOmitted).toBe(800);
		expect(textQualityQuery(report).summary().diagnosticCount).toBe(1_000);
		expect(textQualityQuery(report).export("all").diagnosticCount).toBe(1_000);
		const files = evidence();
		const checked = checkLocalizationTarget(text, joinLocalizationTarget(text, files), files);
		expect(checked.diagnostics).toHaveLength(200);
		expect(checked.diagnosticCount).toBe(1_000);
		expect(checked.diagnosticsOmitted).toBe(800);
	});

	it("bounds corpus diagnostics and package evidence in investigation exports", async () => {
		const preset = GameTextInvestigationPreset.make({
			schemaVersion: 1,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "corpus",
				query: "",
				capability: "all",
				lens: "all",
				qualityFilter: "all"
			}
		});
		const exported = await Effect.runPromise(
			exportGameTextInvestigation(text, preset, {
				projectRoot: "C:/Fixture",
				generation: null,
				authority: "project_files"
			})
		);
		if (exported.result.mode !== "corpus") throw new Error("Expected a corpus export.");
		expect(exported.result.corpus.diagnostics).toHaveLength(200);
		expect(exported.result.corpus.diagnosticCount).toBe(1_000);
		expect(exported.result.corpus.packageCoverage?.packages).toHaveLength(200);
		expect(exported.result.corpus.packageCoverage?.omitted).toBe(600);
		expect(exported.result.corpus.units).toEqual(text.units);
		expect(Schema.decodeUnknownSync(GameTextInvestigationExport)(exported)).toEqual(exported);
	});

	it("handles absent package evidence and rejects oversized diagnostic payloads", () => {
		const files = evidence();
		const { packageCoverage: availablePackages, ...withoutPackages } = corpus();
		expect(availablePackages).toBeDefined();
		const page = textCorpusQuery(withoutPackages).search({
			capability: "all",
			pageSize: 5,
			query: ""
		});
		expect(
			localizationStatusReport(withoutPackages, files, page).packageCoverage
		).toBeUndefined();
		expect(textCorpusDiagnosticSummary([])).toMatchObject({
			diagnosticCount: 0,
			diagnosticsOmitted: 0
		});
		expect(() =>
			Schema.decodeUnknownSync(TextCorpusDiagnosticSummary)({
				...textCorpusDiagnosticSummary(diagnostics),
				diagnostics: diagnostics.slice(0, 201)
			})
		).toThrow();
	});
});
