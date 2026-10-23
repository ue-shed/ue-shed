import { Effect, Schema } from "effect";
import {
	LocalizationQualityFinding,
	LocalizationPolicyFinding,
	LocalizationCustomFinding,
	LocalizationCheckDiagnostic
} from "./localization-quality-schema.js";
import { TextQualityAffectedOccurrence, TextQualityFinding } from "./quality-schema.js";
import { snapshotCheck } from "./snapshot-format.js";
import { localizationFindingHash, localizationFindingId } from "./localization-workspace.js";
import { textQualityFindingId } from "./quality-query.js";
import type { RuleDocumentV4 } from "./rules/schema.js";
import type { GameTextIndexError } from "./index-error.js";

const Row = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }));
const Evidence = Schema.Record(Schema.String, Schema.Unknown);
const Places = Schema.Array(
	Schema.Struct({ id: Row, occurrences: Schema.Array(TextQualityAffectedOccurrence) })
);
export const FindingsEvaluation = Schema.Struct({
	key: Schema.NonEmptyString,
	rules: Schema.Array(Evidence),
	counts: Schema.Array(Evidence),
	diagnosticCount: Row,
	collation: Schema.String
});
export const NativeFindingLines = Schema.Struct({
	places: Places,
	lines: Schema.Array(
		Schema.Struct({
			row: Row,
			builtIns: Schema.Array(Evidence),
			policy: Schema.Array(Evidence),
			custom: Schema.Array(Evidence),
			diagnostics: Schema.Array(LocalizationCheckDiagnostic)
		})
	)
});
export const NativeFindingUnits = Schema.Struct({
	places: Places,
	units: Schema.Array(Schema.Struct({ unit: Row, findings: Schema.Array(Evidence) }))
});

function inflate<S extends Schema.Codec<unknown, unknown>>(
	places: typeof Places.Type,
	values: readonly (typeof Evidence.Type)[],
	schema: S,
	identity: (finding: S["Type"]) => string
) {
	const byId = new Map(places.map((place) => [place.id, place.occurrences]));
	return Effect.forEach(values, (value) =>
		Effect.gen(function* () {
			const occurrences = byId.get(Schema.decodeUnknownSync(Row)(value.places));
			snapshotCheck(
				occurrences !== undefined,
				"quality.findings",
				"A finding's saved places are missing"
			);
			const { places: _places, id: _id, ...evidence } = value;
			const candidate = { ...evidence, affectedOccurrences: occurrences };
			// Keep evidence member order: reported sorting and source identities use JSON.stringify.
			const finding = Schema.is(schema)(candidate)
				? candidate
				: yield* Schema.decodeUnknownEffect(schema)(candidate);
			snapshotCheck(
				identity(finding) === value.id,
				"quality.findings",
				"Native and host finding identities differ"
			);
			return finding;
		})
	);
}
const localizationIdentity = (
	finding: LocalizationQualityFinding | LocalizationPolicyFinding | LocalizationCustomFinding
) => localizationFindingId(localizationFindingHash(finding));
export const inflateFindingLines = (result: typeof NativeFindingLines.Type) =>
	Effect.forEach(result.lines, (line) =>
		Effect.gen(function* () {
			return {
				row: line.row,
				builtIns: yield* inflate(
					result.places,
					line.builtIns,
					LocalizationQualityFinding,
					localizationIdentity
				),
				policy: yield* inflate(
					result.places,
					line.policy,
					LocalizationPolicyFinding,
					localizationIdentity
				),
				custom: yield* inflate(
					result.places,
					line.custom,
					LocalizationCustomFinding,
					localizationIdentity
				),
				diagnostics: line.diagnostics
			};
		})
	);
export const inflateFindingUnits = (result: typeof NativeFindingUnits.Type) =>
	Effect.forEach(result.units, (unit) =>
		Effect.gen(function* () {
			return {
				unit: unit.unit,
				findings: yield* inflate(
					result.places,
					unit.findings,
					TextQualityFinding,
					textQualityFindingId
				)
			};
		})
	);

/** A reader's native findings; coordinates belong to its pinned joined snapshot. */
export interface NativeFindings {
	readonly findingsEvaluate: (
		document: RuleDocumentV4
	) => Effect.Effect<typeof FindingsEvaluation.Type, GameTextIndexError>;
	readonly findingsLines: (
		key: string,
		rows: readonly number[]
	) => Effect.Effect<Effect.Success<ReturnType<typeof inflateFindingLines>>, GameTextIndexError>;
	readonly findingsUnits: (
		key: string,
		units: readonly number[]
	) => Effect.Effect<Effect.Success<ReturnType<typeof inflateFindingUnits>>, GameTextIndexError>;
}
