import { describe, expect, it } from "vitest";
import { textCorpusFromExtractionEvents } from "../packages/game-text/dist/index.js";
import { packageTextRecordsFromEvents } from "../packages/game-text/dist/index.js";
import { gameTextScaleEvents, gameTextScaleRecipe } from "./localization-scale-data.ts";
import {
	compareTextCorpora,
	compareTextCandidateCorpora
} from "./package-text-oracle.test-support.ts";
import type { SavedAssetTextExtractionEvent } from "../packages/unreal-assets/dist/index.js";

describe("package text records", () => {
	it("the eligibility oracle rejects lost text, selected coverage gaps and unreported exclusions", () => {
		const full = textCorpusFromExtractionEvents({
			projectRoot: ".",
			events: gameTextScaleEvents(gameTextScaleRecipe(0.0001), 57)
		});
		expect(compareTextCandidateCorpora(full, full, full, []).equal).toBe(true);
		expect(
			compareTextCandidateCorpora(full, full, { ...full, units: full.units.slice(1) }, [])
				.equal
		).toBe(false);
		expect(
			compareTextCandidateCorpora(
				full,
				full,
				{
					...full,
					coverage: {
						...full.coverage,
						unsupportedTextProperties: full.coverage.unsupportedTextProperties - 1
					}
				},
				[]
			).equal
		).toBe(false);
		expect(
			compareTextCandidateCorpora(
				full,
				full,
				{ ...full, packageCoverage: [{ packageFile: "hidden", status: "not_gatherable" }] },
				[]
			).excludedEqual
		).toBe(false);
	});
	it.each([0.0001, 0.001, 0.002])("equals the legacy corpus at scale %s", (scale) => {
		const recipe = gameTextScaleRecipe(scale);
		const events = [...gameTextScaleEvents(recipe, 57)];
		const records = [...packageTextRecordsFromEvents(events)];
		const old = textCorpusFromExtractionEvents({ projectRoot: ".", events });
		const compact = textCorpusFromExtractionEvents({ projectRoot: ".", events: records });
		expect(compareTextCorpora(old, compact)).toMatchObject({ equal: true, differenceCount: 0 });
		const packages = records.filter((event) => event.event === "text_package_record");
		expect(packages).toHaveLength(recipe.packages);
		expect(packages.every((record) => record.gapSamples.length <= 3)).toBe(true);
		expect(compact.coverage.unsupportedTextProperties).toBe(recipe.gaps);
	});

	it("keeps the first sample and prioritizes later unsupported histories", () => {
		const events: SavedAssetTextExtractionEvent[] = [
			...(
				[
					"property_decoder_rejected",
					"feature_unavailable_for_engine_version",
					"legacy_container_element_without_type_information",
					"unsupported_text_history",
					"unsupported_text_history",
					"unsupported_text_history"
				] as const
			).map((reason, index) => ({
				event: "text_coverage_gap" as const,
				path: "Content/A.uasset",
				schema_version: 1 as const,
				coverage_gap: { object_path: "A", property_path: String(index), reason }
			})),
			{
				event: "text_package",
				path: "Content/A.uasset",
				schema_version: 1,
				fileBytes: 1,
				status: "partial",
				diagnostics: [],
				occurrences: 0,
				coverage_gaps: 6
			}
		];
		const [record] = packageTextRecordsFromEvents(events);
		if (record?.event !== "text_package_record") throw new Error("Missing record");
		expect(record.gapSamples.map((gap) => gap.property_path)).toEqual(["0", "3", "4"]);
		expect(record.gapCounts.unsupported_text_history).toBe(3);
		expect(
			compareTextCorpora(
				textCorpusFromExtractionEvents({ projectRoot: ".", events }),
				textCorpusFromExtractionEvents({ projectRoot: ".", events: [record] })
			).equal
		).toBe(true);
	});

	it("preserves empty partial packages, decode-error counts and failures", () => {
		const events: SavedAssetTextExtractionEvent[] = [
			{
				event: "text_package",
				path: "Content/A.uasset",
				schema_version: 1,
				fileBytes: 1,
				status: "partial",
				diagnostics: [
					{
						code: "unsupported_version",
						class_path: "Fixture",
						object_path: "A",
						message: "Unavailable"
					}
				],
				occurrences: 0,
				coverage_gaps: 0
			},
			{
				event: "error",
				path: "Content/B.uasset",
				code: "io",
				message: "Unavailable",
				retrySafe: true
			}
		];
		expect(
			compareTextCorpora(
				textCorpusFromExtractionEvents({ projectRoot: ".", events }),
				textCorpusFromExtractionEvents({
					projectRoot: ".",
					events: packageTextRecordsFromEvents(events)
				})
			).equal
		).toBe(true);
	});

	it("rejects unfinished event packages", () => {
		expect(() => [
			...packageTextRecordsFromEvents([
				{
					event: "text_coverage_gap",
					path: "Content/A.uasset",
					schema_version: 1,
					coverage_gap: {
						object_path: "A",
						property_path: "Label",
						reason: "property_decoder_rejected"
					}
				}
			])
		]).toThrow("unfinished packages");
	});

	it("the oracle detects unit, occurrence, coverage and diagnostic changes with a bounded report", () => {
		const expected = textCorpusFromExtractionEvents({
			projectRoot: ".",
			events: gameTextScaleEvents(gameTextScaleRecipe(0.001), 57)
		});
		const reordered = {
			...expected,
			units: expected.units
				.toReversed()
				.map((unit) => ({ ...unit, occurrences: unit.occurrences.toReversed() })),
			diagnostics: expected.diagnostics.toReversed()
		};
		expect(compareTextCorpora(expected, reordered).equal).toBe(true);
		const actual = {
			...expected,
			coverage: { ...expected.coverage, inspectedPackages: 0 },
			diagnostics: [],
			units: expected.units.slice(1)
		};
		const diff = compareTextCorpora(expected, actual, 1);
		expect(diff.equal).toBe(false);
		expect(diff.differences).toHaveLength(1);
		expect(diff.omittedDifferences).toBeGreaterThan(0);
	});

	it.each([
		"identity",
		"source",
		"notes",
		"location",
		"edit",
		"occurrenceId",
		"multiplicity",
		"gaps",
		"diagnostics",
		"packageCoverage"
	])("the oracle detects a %s change", (field) => {
		const expected = textCorpusFromExtractionEvents({
			projectRoot: ".",
			events: gameTextScaleEvents(gameTextScaleRecipe(0.001), 57)
		});
		const actual = structuredClone(expected);
		const unit = actual.units[0];
		if (!unit || !unit.occurrences[0]) throw new Error("Missing oracle unit");
		const occurrence = unit.occurrences[0];
		if (field === "identity")
			Object.assign(unit, {
				identity: { status: "resolved", namespace: "Changed", key: "Changed" }
			});
		if (field === "source")
			Object.assign(unit, { source: { status: "consistent", value: "Changed" } });
		if (field === "notes") Object.assign(occurrence, { devNotes: "Changed" });
		if (field === "location") Object.assign(occurrence.location, { objectPath: "Changed" });
		if (field === "edit")
			Object.assign(occurrence, {
				editCapability:
					occurrence.editCapability === "source_editable"
						? "read_only"
						: "source_editable"
			});
		if (field === "occurrenceId") Object.assign(occurrence, { id: "Changed" });
		if (field === "multiplicity")
			Object.assign(unit, { occurrences: [...unit.occurrences, occurrence] });
		if (field === "gaps") Object.assign(actual.coverage, { unsupportedTextProperties: 0 });
		if (field === "diagnostics") Object.assign(actual, { diagnostics: [] });
		if (field === "packageCoverage") Object.assign(actual, { packageCoverage: [] });
		expect(compareTextCorpora(expected, actual).equal).toBe(false);
	});
});
