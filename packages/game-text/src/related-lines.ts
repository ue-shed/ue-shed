import { LocalizationTargetName } from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { TextUnitId } from "./identifiers.js";
import {
	LocalizationLine,
	LocalizationLineId,
	LocalizationLinePreview
} from "./localization-schema.js";
import { LocalizationTranslation } from "./localization-view.js";
import { TextCorpusPublicError, TextOccurrence, TextUnitSearchResult } from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A selection's related units and lines. A unit needs no target; a line is a target's. Each unit
 * member lists its first `pageSize` places.
 */
export const RelatedLinesRequest = Schema.Struct({
	target: Schema.optionalKey(LocalizationTargetName),
	selection: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("unit"), id: TextUnitId }),
		Schema.Struct({ kind: Schema.Literal("line"), id: LocalizationLineId })
	]),
	pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
});
export type RelatedLinesRequest = typeof RelatedLinesRequest.Type;

/**
 * A unit, as a search lists it, with its first places, and with a target its line's translations
 * as localization focus lists them. `complete` says every place is listed.
 */
export const RelatedUnit = Schema.Struct({
	kind: Schema.Literal("unit"),
	unit: TextUnitSearchResult,
	occurrences: Schema.Array(TextOccurrence).check(Schema.isMaxLength(50)),
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

/**
 * The selection and its related members.
 * - `sameKey`: a unit's other units with its gathered identity; empty for a line, which holds
 *   them all.
 * - `sameText`: other resolved units with another identity whose one source is the unit's exactly,
 *   or other lines whose source is the line's.
 * - `conflict`, with a target: the units of the line's key whose source differs from the line's.
 * - `keyChange`, with a target: the line its key change pairs with this one.
 */
export const RelatedLines = Schema.Struct({
	self: RelatedMember,
	sameKey: RelatedSection,
	sameText: RelatedSection,
	conflict: Schema.optionalKey(RelatedSection),
	keyChange: Schema.optionalKey(RelatedSection)
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
