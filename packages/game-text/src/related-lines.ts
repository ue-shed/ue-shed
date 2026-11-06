import { LocalizationTargetName } from "@ue-shed/localization/browser";
import type { GameTextContract } from "@ue-shed/protocol";
import { Schema } from "effect";
import { TextUnitId } from "./identifiers.js";
import {
	LocalizationLine,
	LocalizationLineId,
	LocalizationLinePreview
} from "./localization-schema.js";
import { LocalizationTranslation } from "./localization-view.js";
import {
	MAX_TEXT_SECTION_ROWS,
	TextCorpusPublicError,
	TextOccurrence,
	TextSectionRows,
	TextUnitSearchResult
} from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Ratio = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1));

/**
 * The similar keys to read with a target's line: its pair and up to `limit` (0 to 500) near
 * lines. The matcher's policy is the host's: each field is optional and documented, with its
 * default, on the engine's `SimilarKeysSection`. A reader keeps the index of one parameter set.
 */
export const SimilarKeysRequest = Schema.Struct({
	limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_TEXT_SECTION_ROWS })),
	distanceRatio: Schema.optionalKey(Ratio),
	reachRatio: Schema.optionalKey(Ratio),
	maxDistance: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))
	),
	comparisonBudget: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }))
	),
	minLetters: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })))
});
export type SimilarKeysRequest = typeof SimilarKeysRequest.Type;

/**
 * The engine's `similarKeys` answer, as generated from its contract: the selected line's side,
 * its one-to-one pair with the earlier line's translations, its near lines and whether the
 * comparison budget truncated the matcher. It is engine output, so it passes through unchecked.
 */
export const SimilarKeys =
	// SAFETY: only the engine writes this value, as its generated `SimilarKeysAnswer`; the host
	// checked the contract hash at the handshake and validates no message after (ADR 0012).
	// Verified by: `similar-keys.integration.test.ts` (the answer through the native reader) and
	// `contract.rs`'s generated-TypeScript drift test.
	Schema.Any as Schema.Codec<GameTextContract.SimilarKeysAnswer>;
export type SimilarKeys = GameTextContract.SimilarKeysAnswer;

/**
 * A selection's related units and lines. A unit needs no target; a line is a target's. Each unit
 * member lists its first `pageSize` places. `similarKeys`, with a target, also reads the
 * selection's line's similar keys.
 */
export const RelatedLinesRequest = Schema.Struct({
	target: Schema.optionalKey(LocalizationTargetName),
	selection: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("unit"), id: TextUnitId }),
		Schema.Struct({ kind: Schema.Literal("line"), id: LocalizationLineId })
	]),
	pageSize: TextSectionRows,
	similarKeys: Schema.optionalKey(SimilarKeysRequest)
});
export type RelatedLinesRequest = typeof RelatedLinesRequest.Type;

/**
 * A unit, as a search lists it, with its first places, up to the request's `pageSize`, and with a
 * target its line's translations as localization focus lists them. `complete` says every place is
 * listed.
 */
export const RelatedUnit = Schema.Struct({
	kind: Schema.Literal("unit"),
	unit: TextUnitSearchResult,
	occurrences: Schema.Array(TextOccurrence).check(Schema.isMaxLength(MAX_TEXT_SECTION_ROWS)),
	totalOccurrences: Count,
	complete: Schema.Boolean,
	/** With a target, the unit's line, when it has one. */
	line: Schema.optionalKey(
		Schema.Struct({ id: LocalizationLineId, identity: LocalizationLine.fields.identity })
	),
	translations: Schema.optionalKey(
		Schema.Array(LocalizationTranslation).check(Schema.isMaxLength(50))
	),
	translationsComplete: Schema.optionalKey(Schema.Boolean)
});
export type RelatedUnit = typeof RelatedUnit.Type;

/** A target's line, with its first 50 unit IDs and its translations. */
export const RelatedLine = Schema.Struct({
	kind: Schema.Literal("line"),
	line: LocalizationLinePreview,
	unitIds: Schema.Array(TextUnitId).check(Schema.isMaxLength(50)),
	unitsComplete: Schema.Boolean,
	translations: Schema.Array(LocalizationTranslation).check(Schema.isMaxLength(50)),
	translationsComplete: Schema.Boolean
});
export type RelatedLine = typeof RelatedLine.Type;

/** A related member: a unit, or with a target a line. */
export const RelatedMember = Schema.Union([RelatedUnit, RelatedLine]);
export type RelatedMember = typeof RelatedMember.Type;

/** A section's first 50 members; `complete` says they are all of them. */
export const RelatedSection = Schema.Struct({
	members: Schema.Array(RelatedMember).check(Schema.isMaxLength(50)),
	complete: Schema.Boolean
});
export type RelatedSection = typeof RelatedSection.Type;

/** The selection and its related members. */
export const RelatedLines = Schema.Struct({
	self: RelatedMember,
	/** A unit's other units with its gathered identity; empty for a line, which holds them all. */
	sameKey: RelatedSection,
	/**
	 * Other resolved units with another identity whose one source is the unit's exactly, or other
	 * lines whose source is the line's.
	 */
	sameText: RelatedSection,
	/** With a target: the units of the line's key whose source differs from the line's. */
	conflict: Schema.optionalKey(RelatedSection),
	/** With a target: the line its key change pairs with this one. */
	keyChange: Schema.optionalKey(RelatedSection),
	/**
	 * When requested with a target: a key change the exact pairing could not match, whose text is
	 * nearly the same, ranked by the engine.
	 */
	similarKeys: Schema.optionalKey(SimilarKeys)
});
export type RelatedLines = typeof RelatedLines.Type;

/** `workspace.related`'s answer: `not_found` when the selection is not in the index or target. */
export const RelatedLinesResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError }),
	Schema.Struct({ status: Schema.Literal("found"), related: RelatedLines }),
	Schema.Struct({ status: Schema.Literal("not_found") }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type RelatedLinesResult = typeof RelatedLinesResult.Type;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
// The request is validated at the workspace boundary; this fails to compile if it drifts from
// the engine's section.
export type SimilarKeysRequestMatchesEngine = Holds<
	Same<SimilarKeysRequest, GameTextContract.SimilarKeysSection>
>;
