import { Clock, Context, Effect, Exit, Option } from "effect";
import type { GameTextContract } from "@ue-shed/protocol";
import type {
	LocalizationQualityFinding,
	LocalizationPolicyFinding,
	LocalizationCustomFinding,
	LocalizationCheckDiagnostic
} from "./localization-quality-schema.js";
import type { TextQualityFinding } from "./quality-schema.js";
import { snapshotCheck } from "./snapshot-format.js";
import type { RuleDocumentV4 } from "./rules/schema.js";
import type { GameTextIndexError } from "./index-error.js";

/** Profiles contain only bounded operation names and numbers from this call. */
export const annotateFindingsProfile = (
	profile: GameTextContract.EvaluationProfile | GameTextContract.ReadProfile,
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
				if (value !== null && value !== undefined)
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
/** Resolve each finding's interned places into the host's finding shape. */
function inflate<F>(
	places: GameTextContract.FindingLines["places"],
	values: readonly GameTextContract.Finding[]
): F[] {
	const byId = new Map(places.map((place) => [place.id, place.occurrences]));
	return values.map(({ places: id, id: _id, ...evidence }) => {
		const occurrences = byId.get(id);
		snapshotCheck(
			occurrences !== undefined,
			"quality.findings",
			"A finding's saved places are missing"
		);
		// Spreading keeps evidence member order, which reported sorting relies on.
		// SAFETY: the engine writes each finding in its family's host shape, and the session's
		// handshake checked that host and engine share this contract.
		// Verified by: localization-custom-checks.test.ts and terminology-boundaries.test.ts.
		return { ...evidence, affectedOccurrences: occurrences } as F;
	});
}
export const inflateFindingLines = (result: GameTextContract.FindingLines) =>
	Effect.sync(() =>
		result.lines.map((line) => ({
			row: line.row,
			builtIns: inflate<LocalizationQualityFinding>(result.places, line.builtIns),
			policy: inflate<LocalizationPolicyFinding>(result.places, line.policy),
			custom: inflate<LocalizationCustomFinding>(result.places, line.custom),
			// SAFETY: diagnostic codes are the engine's DIAGNOSTIC_CODES, the host's code union.
			// Verified by: localization-checks.test.ts reads native syntax_limit diagnostics.
			diagnostics: line.diagnostics as readonly LocalizationCheckDiagnostic[]
		}))
	);
export const inflateFindingUnits = (result: GameTextContract.FindingUnits) =>
	Effect.sync(() =>
		result.units.map((unit) => ({
			unit: unit.unit,
			findings: inflate<TextQualityFinding>(result.places, unit.findings)
		}))
	);

/** A reader's native findings; coordinates belong to its pinned joined snapshot. */
export interface NativeFindings {
	readonly findingsEvaluate: (
		document: RuleDocumentV4
	) => Effect.Effect<GameTextContract.FindingsEvaluation, GameTextIndexError>;
	readonly findingsLines: (
		key: string,
		rows: readonly number[]
	) => Effect.Effect<Effect.Success<ReturnType<typeof inflateFindingLines>>, GameTextIndexError>;
	readonly findingsUnits: (
		key: string,
		units: readonly number[]
	) => Effect.Effect<Effect.Success<ReturnType<typeof inflateFindingUnits>>, GameTextIndexError>;
}
