import {
	GameTextRuleDocument,
	decodeGameTextRuleDocumentJson,
	evaluateGameTextSourceQuality
} from "./game-text-rules.js";
import { Effect, Schema } from "effect";
import {
	InvestigationSource,
	InvestigationFailure,
	InvestigationCancelled,
	InvestigationError,
	investigationTable
} from "@ue-shed/unreal-assets/investigation";
import { TextCorpus, TextCorpusSearchRequest } from "./schema.js";
import { TextCorpusReport, textCorpusReport } from "./corpus-summary.js";
import { WorkspaceQualityFilter, WorkspaceQualityReport } from "./localization-workspace.js";
import { TextQualityReport } from "./quality-schema.js";
import { textCorpusQuery, type TextCorpusQuery } from "./query.js";
import { textQualityQuery, TextQualityFilter } from "./quality-query.js";

/**
 * Serializable corpus or quality query for a reusable investigation. Localization quality
 * filters require quality mode and a selected localization target.
 */
export const GameTextInvestigationQuery = Schema.Struct({
	withoutNotes: TextCorpusSearchRequest.fields.withoutNotes,
	mode: Schema.Literals(["corpus", "quality"]),
	query: TextCorpusSearchRequest.fields.query,
	capability: TextCorpusSearchRequest.fields.capability,
	lens: TextCorpusSearchRequest.fields.lens,
	where: TextCorpusSearchRequest.fields.where,
	/** Filter pills; presets saved before them use the fields above. */
	filter: TextCorpusSearchRequest.fields.filter,
	group: TextCorpusSearchRequest.fields.group,
	/**
	 * The localization target and cultures the pills were chosen against. Problem and translation
	 * pills need it, so the export joins the target's files as the list does.
	 */
	localization: TextCorpusSearchRequest.fields.localization,
	qualityFilter: TextQualityFilter,
	/** The localization quality list's filter; only a quality query over a target has one. */
	workspaceFilter: Schema.optionalKey(WorkspaceQualityFilter)
}).check(
	Schema.makeFilter((query) =>
		query.workspaceFilter === undefined ||
		(query.mode === "quality" && query.localization !== undefined)
			? undefined
			: "A localization quality filter needs quality mode and a localization target."
	)
);
export type GameTextInvestigationQuery = Schema.Schema.Type<typeof GameTextInvestigationQuery>;
/**
 * Versioned reusable query with domain ordering and optional embedded rules. Source quality
 * needs rules; localization quality requires schema version 2.
 */
export const GameTextInvestigationPreset = Schema.Struct({
	schemaVersion: Schema.Literals([1, 2]),
	kind: Schema.Literal("game_text"),
	sort: Schema.Literal("domain_order"),
	query: GameTextInvestigationQuery,
	rules: Schema.optionalKey(GameTextRuleDocument)
}).check(
	Schema.makeFilter((preset) => {
		if (preset.schemaVersion === 1 && preset.query.workspaceFilter !== undefined)
			return "Localization quality presets require schemaVersion 2.";
		return preset.query.mode !== "quality" ||
			preset.rules !== undefined ||
			preset.query.workspaceFilter !== undefined
			? undefined
			: "Source quality presets require a rule document.";
	})
);
export type GameTextInvestigationPreset = Schema.Schema.Type<typeof GameTextInvestigationPreset>;
/**
 * Preset-open outcome with validated document/path, cancellation or investigation failure.
 * Opening a preset must not change the shell's selected project.
 */
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
/**
 * Version-matched preset and exported corpus/source-quality/localization-quality result.
 * coverageScope records whole-scan provenance even when the query filters presentation rows.
 */
export const GameTextInvestigationExport = Schema.Struct({
	schemaVersion: GameTextInvestigationPreset.fields.schemaVersion,
	kind: Schema.Literal("game_text_export"),
	source: InvestigationSource,
	preset: GameTextInvestigationPreset,
	coverageScope: Schema.Literal("whole_scan"),
	result: Schema.Union([
		Schema.Struct({ mode: Schema.Literal("corpus"), corpus: TextCorpusReport }),
		Schema.Struct({ mode: Schema.Literal("quality"), report: TextQualityReport }),
		Schema.Struct({
			mode: Schema.Literal("localization_quality"),
			report: WorkspaceQualityReport
		})
	])
}).check(
	Schema.makeFilter((document) => {
		if (document.schemaVersion !== document.preset.schemaVersion)
			return "An investigation export and its preset must use the same schemaVersion.";
		return document.schemaVersion === 1 && document.result.mode === "localization_quality"
			? "Localization quality exports require schemaVersion 2."
			: undefined;
	})
);
export type GameTextInvestigationExport = Schema.Schema.Type<typeof GameTextInvestigationExport>;

/**
 * Runs a preset over a scan. A preset that names a localization target needs that target's
 * query (`localized`, built over the same corpus and the target's join), so its problem and
 * translation pills select the lines the list showed.
 */
export function exportGameTextInvestigation(
	corpus: TextCorpus,
	preset: GameTextInvestigationPreset,
	source: InvestigationSource,
	localized?: TextCorpusQuery,
	workspace?: WorkspaceQualityReport
): Effect.Effect<GameTextInvestigationExport, InvestigationError> {
	const corpusExport = Effect.gen(function* () {
		const target = preset.query.localization?.target;
		if (target !== undefined && localized === undefined)
			return yield* Effect.fail(
				new InvestigationError({
					message: `This export filters by the localization target ${target}, which is not loaded.`,
					recovery:
						"Select the target in Game Text, or remove its translation and problem filters.",
					retrySafe: true,
					nextStep: "fix_input"
				})
			);
		return yield* Effect.try({
			try: () => (localized ?? textCorpusQuery(corpus)).export(preset.query),
			catch: (error) =>
				new InvestigationError({
					message:
						"This export filters by localization state, which needs a loaded target.",
					recovery: "Select a localization target, or remove its translation filters.",
					cause: error,
					retrySafe: true,
					nextStep: "fix_input"
				})
		});
	});
	return Effect.gen(function* () {
		if (preset.schemaVersion === 1 && preset.query.workspaceFilter !== undefined)
			return yield* Effect.fail(
				new InvestigationError({
					message: "Localization quality presets require schemaVersion 2.",
					recovery: "Save this localization quality selection as a version-2 preset.",
					retrySafe: true,
					nextStep: "fix_input"
				})
			);
		if (
			preset.query.mode === "quality" &&
			preset.rules === undefined &&
			preset.query.workspaceFilter === undefined
		)
			return yield* Effect.fail(
				new InvestigationError({
					message: "Quality exports require a rule document.",
					recovery: "Load quality rules before exporting findings.",
					retrySafe: true,
					nextStep: "fix_input"
				})
			);
		if (preset.query.workspaceFilter !== undefined && !workspace)
			return yield* Effect.fail(
				new InvestigationError({
					message: "The localization quality workspace is unavailable.",
					recovery:
						"Check that the preset's localization target is gathered in the project, then retry the export.",
					retrySafe: true,
					nextStep: "fix_input"
				})
			);
		if (
			workspace &&
			preset.query.workspaceFilter !== undefined &&
			(workspace.filter !== preset.query.workspaceFilter ||
				workspace.target !== preset.query.localization?.target ||
				workspace.culture !== preset.query.localization?.culture)
		)
			return yield* Effect.fail(
				new InvestigationError({
					message: "The quality report does not match this preset's selection.",
					recovery: "Reevaluate the target, culture and finding filter before exporting.",
					retrySafe: true,
					nextStep: "reconcile"
				})
			);
		const rules =
			preset.rules === undefined
				? undefined
				: yield* decodeGameTextRuleDocumentJson(JSON.stringify(preset.rules)).pipe(
						Effect.mapError(
							(error) =>
								new InvestigationError({
									cause: error,
									message: error.message,
									recovery: error.recovery,
									retrySafe: true,
									nextStep: "fix_input"
								})
						)
					);
		return {
			schemaVersion: preset.schemaVersion,
			kind: "game_text_export",
			source,
			preset,
			coverageScope: "whole_scan",
			result:
				preset.query.mode === "quality" &&
				preset.query.workspaceFilter !== undefined &&
				workspace
					? { mode: "localization_quality", report: workspace }
					: preset.query.mode === "quality" && rules !== undefined
						? {
								mode: "quality",
								report: textQualityQuery(
									evaluateGameTextSourceQuality(corpus, rules)
								).export(preset.query.qualityFilter)
							}
						: { mode: "corpus", corpus: textCorpusReport(yield* corpusExport) }
		} satisfies GameTextInvestigationExport;
	});
}

/**
 * Formats an investigation's selected result as spreadsheet-safe CSV. It preserves the
 * domain-specific corpus or quality columns rather than flattening raw snapshot storage.
 */
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
	if (document.result.mode === "localization_quality") {
		const { findings, ...scan } = document.result.report;
		return investigationTable(
			{ ...base, scan },
			["finding_id", "kind", "culture", "source", "problem", "context"],
			findings.map((finding) => [
				finding.id,
				finding.filter,
				finding.culture ?? "",
				finding.source,
				finding.problem,
				finding.context
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
