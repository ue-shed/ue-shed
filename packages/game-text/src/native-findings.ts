import { Clock, Context, Effect, Exit, Option, Schema } from "effect";
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
import type { QueryExpr } from "./query-filter.js";
import { effectiveRuleDocument } from "./rules/effective.js";

/** Profiles contain only bounded operation names and numbers from this call. */
export const annotateFindingsProfile = Effect.fnUntraced(function* (
	profile: GameTextContract.EvaluationProfile | GameTextContract.ReadProfile,
	requestStart?: bigint
) {
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
		[`${prefix}wall_ms`]: profile.wallMs,
		// Steps inside a stage, such as a closure's groups and an aggregate's parts.
		...Object.fromEntries(
			Object.entries(profile.subStages).map(([name, sample]) => [
				`${prefix}stage_ms.${name}`,
				sample.wallMs
			])
		)
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
/** A line finding as finding rows return it: the host shape and what a list reads of its line. */
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
/** A source finding as finding rows return it, with its line's key. */
export type QueriedSourceFinding = TextQualityFinding & {
	readonly id: string;
	readonly sourceKey: string | null;
};
export type QueriedFinding = QueriedLineFinding | QueriedSourceFinding;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Finding rows' counts: what the acceptance hid, the suggested fixes, and the diagnostics. */
const FindingRowCounts = Schema.Struct({
	accepted: Count,
	fixable: Count,
	limits: Schema.Array(Schema.Struct({ code: Schema.String, count: Count }))
});
export type FindingRowCounts = typeof FindingRowCounts.Type;
const decodeFindingRowCounts = Schema.decodeUnknownOption(FindingRowCounts);
/** One value a finding field counts, in its facet. */
export interface FindingFacetEntry {
	readonly key: string;
	readonly label: string;
	readonly count: number;
}
/** A page of finding rows, with its findings' places resolved. */
export interface FindingRowsPage {
	readonly total: number;
	readonly counts?: FindingRowCounts;
	/** Each facet asked for, by field: a finding field's `entries`, or a row field's groups. */
	readonly facets?: GameTextContract.QueryAnswer["facets"];
	readonly nextCursor?: string;
	readonly diagnostics?: GameTextContract.FindingDiagnostics;
	readonly stages: { readonly [stage: string]: number };
	readonly findings: readonly QueriedFinding[];
}
/** A finding facet's counts by key. */
export const facetCounts = (
	page: Pick<FindingRowsPage, "facets">,
	field: GameTextContract.QueryField
): ReadonlyMap<string, number> => {
	// SAFETY: finding rows answer a finding field's facet as `{ entries: FindingFacetEntry[] }`.
	// Verified by: findings_select.rs's parity test reads them as today's rule and severity counts.
	const facet = page.facets?.[field] as { readonly entries?: readonly FindingFacetEntry[] };
	return new Map((facet?.entries ?? []).map(({ key, count }) => [key, count]));
};
/** A finding rows answer: its part, its findings, and the place sets they name by ID. */
export interface FindingsRead {
	readonly page: GameTextContract.QueryAnswer;
	readonly findings: ReadonlyArray<GameTextContract.JsonValue | undefined>;
	readonly sets: ReadonlyMap<number, ReadonlyArray<GameTextContract.JsonValue>>;
}
export const inflateFindingsPage = ({ page, findings, sets }: FindingsRead) =>
	Effect.sync((): FindingRowsPage => {
		return {
			total: page.total ?? 0,
			...Option.match(decodeFindingRowCounts(page.counts), {
				onNone: () => ({}),
				onSome: (counts) => ({ counts })
			}),
			...(page.facets !== undefined && { facets: page.facets }),
			...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
			...(page.diagnostics !== undefined && { diagnostics: page.diagnostics }),
			stages: page.stages ?? {},
			findings: findings.map((finding) => {
				// SAFETY: the engine writes each finding in its family's host shape, with the
				// fields its query adds and `places` naming its place set; the handshake checked
				// the shared contract. Verified by: findings-query.test.ts compares queried pages
				// with the in-memory workspace's.
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
		? Effect.undefined
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
	/** Evaluates a document; `progress` watches the engine's stages and the rules it runs. */
	readonly findingsEvaluate: (
		document: RuleDocumentV4,
		progress?: (progress: GameTextContract.EngineProgress) => void
	) => Effect.Effect<GameTextContract.FindingsEvaluation, GameTextIndexError>;
	/** Registers a review's accepted findings for a layer; reads pass the returned key. */
	readonly findingsAccept: (
		key: string,
		accepted: ReadonlyArray<GameTextContract.AcceptedFinding>
	) => Effect.Effect<string, GameTextIndexError>;
	/** A query over a layer's findings: a page, filtered, ordered and counted by the engine. */
	readonly findingRows: (
		request: GameTextContract.Query
	) => Effect.Effect<FindingRowsPage, GameTextIndexError>;
	/**
	 * Writes the report view's selected findings to `text` as `findingJson`, the elements of the
	 * CLI report's `findings` array, and answers with its counts and what it wrote.
	 */
	readonly findingsWrite: (
		request: GameTextContract.Query,
		text: (chunk: Uint8Array) => Effect.Effect<void>
	) => Effect.Effect<GameTextContract.QueryAnswer, GameTextIndexError>;
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

/** What a finding rows query reads, besides its layer. */
export interface FindingRowsOptions {
	readonly view: GameTextContract.FindingsView;
	/** The layer's target; a source-only layer has none. */
	readonly target?: string | undefined;
	/** That culture's findings and those without one. */
	readonly culture?: string | undefined;
	readonly acceptance?: string | undefined;
	readonly where?: QueryExpr | undefined;
	/** Each word in the finding's line's source or its culture's translation; a source finding's source. */
	readonly text?: string | undefined;
	readonly rows?: GameTextContract.RowsPart | undefined;
	readonly counts?: boolean | undefined;
	readonly facets?: ReadonlyArray<GameTextContract.QueryFacet> | undefined;
	readonly diagnostics?: GameTextContract.DiagnosticsPart | undefined;
	readonly write?: GameTextContract.Sink | undefined;
}

/** A query over a findings layer's findings. */
export const findingRowsQuery = (
	key: string,
	options: FindingRowsOptions
): GameTextContract.Query => ({
	selection: {
		rows: "findings",
		findings: {
			key,
			view: options.view,
			...(options.acceptance !== undefined && { acceptance: options.acceptance })
		},
		...(options.target !== undefined && { target: options.target }),
		...(options.culture !== undefined && { culture: options.culture }),
		...(options.where !== undefined && { where: options.where }),
		...(options.text?.trim() && { text: { query: options.text, translations: true } })
	},
	parts: {
		...(options.rows !== undefined && { rows: options.rows }),
		...(options.counts === true && { counts: true }),
		...(options.facets !== undefined && { facets: options.facets }),
		...(options.diagnostics !== undefined && { diagnostics: options.diagnostics }),
		...(options.write !== undefined && { write: options.write })
	}
});
