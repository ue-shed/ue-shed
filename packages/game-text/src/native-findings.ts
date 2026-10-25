import { Clock, Context, Effect, Exit, Option } from "effect";
import type { GameTextContract } from "@ue-shed/protocol";
import type { LocalizationAcceptedFinding } from "@ue-shed/localization/browser";
import type {
	LocalizationQualityFinding,
	LocalizationPolicyFinding,
	LocalizationCustomFinding
} from "./localization-quality-schema.js";
import type { TextQualityFinding } from "./quality-schema.js";
import type { RuleDocumentV4 } from "./rules/schema.js";
import type { GameTextIndexError } from "./index-error.js";
import { completeRulesOf, ruleProblemError, type GameTextRuleDocument } from "./game-text-rules.js";
import { effectiveRuleDocument } from "./rules/effective.js";

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
				[`${prefix}findings`]: profile.findingsReturned
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
/** A line finding as `findings_query` returns it: the host shape and what a list reads of its line. */
export type QueriedLineFinding = (
	| LocalizationQualityFinding
	| LocalizationPolicyFinding
	| LocalizationCustomFinding
) & {
	readonly id: string;
	readonly manifestSource: string | null;
	readonly lineSource: string;
	/** The translation the culture ships next: its PO text when not synced, else its archive's. */
	readonly shippedTranslation: string | null;
	readonly family: "builtin" | "policy" | "custom";
};
/** A source finding as `findings_query` returns it, with its line's key. */
export type QueriedSourceFinding = TextQualityFinding & {
	readonly id: string;
	readonly sourceKey: string | null;
};
export type QueriedFinding = QueriedLineFinding | QueriedSourceFinding;
/** A `findings_query` page with its findings' places resolved. */
export interface FindingsQueryPage extends Omit<GameTextContract.FindingsPage, "profile"> {
	readonly findings: readonly QueriedFinding[];
}
/** A `findings_query` answer: its part, its findings, and the place sets they name by ID. */
export interface FindingsRead {
	readonly page: GameTextContract.FindingsPage;
	readonly findings: ReadonlyArray<GameTextContract.JsonValue | undefined>;
	readonly sets: ReadonlyMap<number, ReadonlyArray<GameTextContract.JsonValue>>;
}
export const inflateFindingsPage = ({ page, findings, sets }: FindingsRead) =>
	Effect.sync((): FindingsQueryPage => {
		const { profile: _profile, ...rest } = page;
		return {
			...rest,
			findings: findings.map((finding) => {
				// SAFETY: the engine writes each finding in its family's host shape, with the
				// fields its query adds and `places` naming its place set; the handshake checked
				// the shared contract.
				// Verified by: findings-query.test.ts compares queried pages with the in-memory
				// workspace's.
				const { places: id, ...evidence } = finding as GameTextContract.Finding;
				const inflated = {
					...evidence,
					// A set with no places, such as a gathered-only line's, sends no rows.
					affectedOccurrences: sets.get(id) ?? []
				};
				// SAFETY: as above; the place sets hold the affected occurrences in host shape.
				// Verified by: findings-query.test.ts compares queried pages with the in-memory
				// workspace's.
				return inflated as QueriedFinding;
			})
		};
	});

/**
 * Registers the accepted findings of the review a read applies, or none. A review without
 * accepted findings hides nothing, so it has no key.
 */
export const acceptReview = (
	native: Pick<NativeFindings, "findingsAccept">,
	key: string,
	review: { readonly acceptedFindings: ReadonlyArray<LocalizationAcceptedFinding> } | undefined
) =>
	review === undefined || review.acceptedFindings.length === 0
		? Effect.succeed(undefined)
		: native.findingsAccept(
				key,
				review.acceptedFindings.map(({ check, culture, namespace, key, fingerprint }) => ({
					check,
					...(culture === null ? undefined : { culture }),
					namespace,
					key,
					fingerprint
				}))
			);

/** A reader's native findings; coordinates belong to its pinned joined snapshot. */
export interface NativeFindings {
	readonly findingsEvaluate: (
		document: RuleDocumentV4
	) => Effect.Effect<GameTextContract.FindingsEvaluation, GameTextIndexError>;
	/** Registers a review's accepted findings for a layer; reads pass the returned key. */
	readonly findingsAccept: (
		key: string,
		accepted: ReadonlyArray<GameTextContract.AcceptedFinding>
	) => Effect.Effect<string, GameTextIndexError>;
	/** One page of a layer's findings, filtered, ordered and counted by the engine. */
	readonly findingsQuery: (
		request: GameTextContract.FindingsQueryRequest
	) => Effect.Effect<FindingsQueryPage, GameTextIndexError>;
	/** The program's first problem as the engine compiles it, with the rule at fault. */
	readonly rulesCheck: (
		document: RuleDocumentV4
	) => Effect.Effect<GameTextContract.RulesCheck, GameTextIndexError>;
}

/**
 * Fails with the rules file error the engine finds in a document's complete rules: an expression
 * it can't run, or rules that read each other's findings in a cycle. Decoding checked the rest.
 */
export const checkCompleteRules = (
	native: Pick<NativeFindings, "rulesCheck">,
	document: GameTextRuleDocument | undefined
) =>
	completeRulesOf(document).length === 0
		? Effect.void
		: native
				.rulesCheck(effectiveRuleDocument(document))
				.pipe(
					Effect.flatMap(({ problem }) =>
						problem ? Effect.fail(ruleProblemError(problem)) : Effect.void
					)
				);
