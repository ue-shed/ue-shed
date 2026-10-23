import { Clock, Context, Effect, Exit, Option, Schema } from "effect";
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
const StageSample = Schema.Struct({
	...ProfileSample.fields,
	startOffsetMs: Milliseconds,
	endOffsetMs: Milliseconds,
	memory: Schema.Struct({
		peakWorkingSetBytes: Count,
		arenaBytes: Count,
		sideDictionaryBytes: Count,
		liveNodeColumnsBytes: Count,
		memosBytes: Count,
		occurrenceRelationBytes: Count
	}),
	kernels: Schema.Record(KernelName, ProfileSample)
});
export const FindingsEvaluationProfile = Schema.Union([
	Schema.Struct({ cached: Schema.Literal(true) }),
	Schema.Struct({
		cached: Schema.Literal(false),
		wallMs: Milliseconds,
		rules: Count,
		findings: Count,
		diagnostics: Count,
		stages: Schema.Record(StageName, StageSample),
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
	profile: typeof FindingsEvaluationProfile.Type | typeof FindingsReadProfile.Type,
	requestStart?: bigint
) =>
	Effect.gen(function* () {
		const prefix = "game_text.findings.";
		if (!("cached" in profile)) {
			yield* Effect.annotateCurrentSpan({
				[`${prefix}rows_requested`]: profile.rowsRequested,
				[`${prefix}findings`]: profile.findingsReturned,
				[`${prefix}response_bytes`]: profile.responseBytes,
				[`${prefix}file_fallback`]: profile.fileFallback
			});
			return;
		}
		yield* Effect.annotateCurrentSpan(`${prefix}cached`, profile.cached);
		if (profile.cached) return;
		yield* Effect.annotateCurrentSpan({
			[`${prefix}rules`]: profile.rules,
			[`${prefix}findings`]: profile.findings,
			[`${prefix}diagnostics`]: profile.diagnostics,
			[`${prefix}wall_ms`]: profile.wallMs
		});
		const parent = yield* Effect.option(Effect.currentSpan);
		if (Option.isNone(parent)) return;
		const tracer = yield* Effect.tracer;
		const origin =
			requestStart ??
			(yield* Clock.currentTimeNanos) - BigInt(Math.round(profile.wallMs * 1_000_000));
		for (const [name, sample] of Object.entries(profile.stages)) {
			const span = tracer.span({
				name: `GameText.native.findingsEvaluate.${name}`,
				parent,
				annotations: Context.empty(),
				links: [],
				startTime: origin + BigInt(Math.round(sample.startOffsetMs * 1_000_000)),
				kind: "internal",
				root: false,
				sampled: parent.value.sampled
			});
			span.attribute(`${prefix}stage.wall_ms`, sample.wallMs);
			span.attribute(`${prefix}stage.busy_ms`, sample.busyMs);
			span.attribute(`${prefix}stage.rows`, sample.rows);
			for (const [field, value] of Object.entries(sample.memory)) {
				span.attribute(`${prefix}memory.${field}`, value);
			}
			const kernels = Object.entries(sample.kernels)
				.sort((a, b) => b[1].busyMs - a[1].busyMs)
				.slice(0, 24);
			for (const [op, kernel] of kernels) {
				span.attribute(`${prefix}kernel.${op}.wall_ms`, kernel.wallMs);
				span.attribute(`${prefix}kernel.${op}.busy_ms`, kernel.busyMs);
				span.attribute(`${prefix}kernel.${op}.rows`, kernel.rows);
				span.attribute(`${prefix}kernel.${op}.inputs`, kernel.inputs);
			}
			span.end(origin + BigInt(Math.round(sample.endOffsetMs * 1_000_000)), Exit.void);
		}
	});
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
