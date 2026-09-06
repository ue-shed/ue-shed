import { decodeTextQualityRuleDocument } from "./quality-schema.js";
import { Effect, Schema } from "effect";
import {
	InvestigationSource,
	InvestigationFailure,
	InvestigationCancelled,
	InvestigationError,
	investigationTable
} from "@ue-shed/unreal-assets/investigation";
import { TextCorpus, TextCorpusSearchRequest } from "./schema.js";
import { TextQualityRuleDocument, TextQualityReport } from "./quality-schema.js";
import { textCorpusQuery } from "./query.js";
import { textQualityQuery, TextQualityFilter } from "./quality-query.js";
import { evaluateTextQuality } from "./quality.js";

export const GameTextInvestigationQuery = Schema.Struct({
	mode: Schema.Literals(["corpus", "quality"]),
	query: TextCorpusSearchRequest.fields.query,
	capability: TextCorpusSearchRequest.fields.capability,
	lens: TextCorpusSearchRequest.fields.lens,
	qualityFilter: TextQualityFilter
});
export type GameTextInvestigationQuery = Schema.Schema.Type<typeof GameTextInvestigationQuery>;
export const GameTextInvestigationPreset = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("game_text"),
	sort: Schema.Literal("domain_order"),
	query: GameTextInvestigationQuery,
	rules: Schema.optionalKey(TextQualityRuleDocument)
}).check(
	Schema.makeFilter((preset) => preset.query.mode !== "quality" || preset.rules !== undefined)
);
export type GameTextInvestigationPreset = Schema.Schema.Type<typeof GameTextInvestigationPreset>;
export const GameTextInvestigationPresetResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("opened"),
		path: Schema.String,
		preset: GameTextInvestigationPreset
	}),
	InvestigationFailure,
	InvestigationCancelled
]);
export type GameTextInvestigationPresetResult = Schema.Schema.Type<
	typeof GameTextInvestigationPresetResult
>;
export const GameTextInvestigationExport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("game_text_export"),
	source: InvestigationSource,
	preset: GameTextInvestigationPreset,
	coverageScope: Schema.Literal("whole_scan"),
	result: Schema.Union([
		Schema.Struct({ mode: Schema.Literal("corpus"), corpus: TextCorpus }),
		Schema.Struct({ mode: Schema.Literal("quality"), report: TextQualityReport })
	])
});
export type GameTextInvestigationExport = Schema.Schema.Type<typeof GameTextInvestigationExport>;

export function exportGameTextInvestigation(
	corpus: TextCorpus,
	preset: GameTextInvestigationPreset,
	source: InvestigationSource
): Effect.Effect<GameTextInvestigationExport, InvestigationError> {
	return Effect.gen(function* () {
		if (preset.query.mode === "quality" && preset.rules === undefined)
			return yield* Effect.fail(
				new InvestigationError({
					message: "Quality exports require a rule document.",
					recovery: "Load quality rules before exporting findings."
				})
			);
		const rules =
			preset.rules === undefined
				? undefined
				: yield* decodeTextQualityRuleDocument(preset.rules).pipe(
						Effect.mapError(
							(error) =>
								new InvestigationError({
									message: error.message,
									recovery: error.recovery
								})
						)
					);
		return {
			schemaVersion: 1,
			kind: "game_text_export",
			source,
			preset,
			coverageScope: "whole_scan",
			result:
				preset.query.mode === "quality" && rules !== undefined
					? {
							mode: "quality",
							report: textQualityQuery(evaluateTextQuality(corpus, rules)).export(
								preset.query.qualityFilter
							)
						}
					: { mode: "corpus", corpus: textCorpusQuery(corpus).export(preset.query) }
		} satisfies GameTextInvestigationExport;
	});
}

export function gameTextInvestigationCsv(document: GameTextInvestigationExport): string {
	const base = {
		schemaVersion: document.schemaVersion,
		kind: document.kind,
		source: document.source,
		preset: document.preset,
		coverageScope: document.coverageScope
	};
	if (document.result.mode === "corpus") {
		const { units, ...scan } = document.result.corpus;
		return investigationTable(
			{ ...base, scan },
			["text_unit_id", "source", "identity_json", "occurrence_count", "occurrences_json"],
			units.map((unit) => [
				unit.id,
				unit.source.status === "consistent"
					? unit.source.value
					: JSON.stringify(unit.source.values),
				JSON.stringify(unit.identity),
				unit.occurrences.length,
				JSON.stringify(unit.occurrences)
			])
		);
	}
	const { findings, ...scan } = document.result.report;
	return investigationTable(
		{ ...base, scan },
		[
			"text_unit_id",
			"rule_id",
			"role",
			"kind",
			"actual_json",
			"expectation_json",
			"recovery",
			"occurrences_json"
		],
		findings.map((finding) => [
			finding.textUnitId,
			finding.ruleId,
			finding.role,
			finding.kind,
			JSON.stringify(finding.actual),
			JSON.stringify(finding.expectation),
			finding.recovery,
			JSON.stringify(finding.affectedOccurrences)
		])
	);
}

export type {
	InvestigationFileResult,
	InvestigationFormat
} from "@ue-shed/unreal-assets/investigation";
