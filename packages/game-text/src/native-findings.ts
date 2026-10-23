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
import { ruleOperationNames, type RuleDocumentV4 } from "./rules/schema.js";
import type { GameTextIndexError } from "./index-error.js";

const Row = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }));
const Evidence = Schema.Record(Schema.String, Schema.Unknown);
const Places = Schema.Array(
	Schema.Struct({ id: Row, occurrences: Schema.Array(TextQualityAffectedOccurrence) })
);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const ProfileSample = Schema.Struct({
	wallMs: Milliseconds,
	busyMs: Milliseconds,
	rows: Count,
	inputs: Count,
	memoHits: Count
});
const StageName = Schema.String.check(
	Schema.isPattern(
		/^(subjects\.(occurrences|columns)|(line|line_culture|unit_source)\.(execute|diagnostics|emission)|layer\.publish)$/
	)
);
const KernelName = Schema.String.check(
	Schema.isPattern(new RegExp(`^(${ruleOperationNames.join("|")})$`))
);
export const FindingsEvaluationProfile = Schema.Union([
	Schema.Struct({ cached: Schema.Literal(true) }),
	Schema.Struct({
		cached: Schema.Literal(false),
		wallMs: Milliseconds,
		rules: Count,
		findings: Count,
		diagnostics: Count,
		stages: Schema.Record(StageName, ProfileSample),
		kernels: Schema.Record(KernelName, ProfileSample)
	})
]);
const FindingsReadProfile = Schema.Struct({
	rowsRequested: Count,
	findingsReturned: Count,
	responseBytes: Count,
	fileFallback: Schema.Boolean
});
/** Profiles contain only bounded operation names and numbers from this call. */
export const annotateFindingsProfile = (
	profile: typeof FindingsEvaluationProfile.Type | typeof FindingsReadProfile.Type
) => {
	const attributes: Record<string, number | boolean> = {};
	const prefix = "game_text.findings.";
	if ("cached" in profile) {
		attributes[`${prefix}cached`] = profile.cached;
		if (!profile.cached) {
			attributes[`${prefix}rules`] = profile.rules;
			attributes[`${prefix}findings`] = profile.findings;
			attributes[`${prefix}diagnostics`] = profile.diagnostics;
			attributes[`${prefix}wall_ms`] = profile.wallMs;
			for (const [stage, sample] of Object.entries(profile.stages)) {
				attributes[`${prefix}stage.${stage}.wall_ms`] = sample.wallMs;
				attributes[`${prefix}stage.${stage}.busy_ms`] = sample.busyMs;
			}
			for (const [op, sample] of Object.entries(profile.kernels)) {
				attributes[`${prefix}kernel.${op}.wall_ms`] = sample.wallMs;
				attributes[`${prefix}kernel.${op}.busy_ms`] = sample.busyMs;
				attributes[`${prefix}kernel.${op}.rows`] = sample.rows;
				attributes[`${prefix}kernel.${op}.inputs`] = sample.inputs;
				attributes[`${prefix}kernel.${op}.memo_hits`] = sample.memoHits;
			}
		}
	} else {
		attributes[`${prefix}rows_requested`] = profile.rowsRequested;
		attributes[`${prefix}findings`] = profile.findingsReturned;
		attributes[`${prefix}response_bytes`] = profile.responseBytes;
		attributes[`${prefix}file_fallback`] = profile.fileFallback;
	}
	return Effect.annotateCurrentSpan(attributes);
};
export const FindingsEvaluation = Schema.Struct({
	key: Schema.NonEmptyString,
	rules: Schema.Array(Evidence),
	counts: Schema.Array(Evidence),
	diagnosticCount: Row,
	collation: Schema.String,
	profile: FindingsEvaluationProfile
});
export const NativeFindingLines = Schema.Struct({
	profile: FindingsReadProfile,
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
	profile: FindingsReadProfile,
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
