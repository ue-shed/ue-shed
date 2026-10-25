import { Schema } from "effect";
import {
	TextCorpus,
	TextCorpusSearchRequest,
	TextOriginKind,
	TextProblem,
	TextReviewSignal
} from "./schema.js";
import {
	LocalizationCultureMark,
	LocalizationLine,
	LocalizationLineId
} from "./localization-schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * What an aggregate groups the matching rows by. `culture` fans a line out over the cultures in
 * scope; the culture-mark dimensions (`state`, `fact`, `unknown_reason`, `review`, `review_flag`)
 * follow it and read that culture's mark: `review` lenses, `review_status` (`not_reviewed`,
 * `current`, `changed`) and the flags of a current review (`review_flag`). A row counts once under each of a multi-valued
 * dimension's values (`fact`, `unknown_reason`, `review`, `review_flag`, `origin`, `problem`,
 * `finding`, `review_signal`, `asset`) and not at all when it has none. `finding` is the rules of
 * the search's findings layer with a finding on the row, and `review_signal` its facts. `translation_key` is
 * `JSON.stringify([namespace, key])`, or `""` for a line with no key; `gathered` is `"true"` when
 * Unreal's manifest lists the line. Culture, culture-mark, translation key and gathered
 * dimensions need a localization target.
 */
export const TextAggregateDimension = Schema.Literals([
	"culture",
	"state",
	"fact",
	"unknown_reason",
	"review",
	"review_status",
	"review_flag",
	"translation_key",
	"source",
	"namespace",
	"audience",
	"origin",
	"problem",
	"finding",
	"review_signal",
	"asset",
	"gathered"
]);
export type TextAggregateDimension = typeof TextAggregateDimension.Type;

const PER_CULTURE: ReadonlySet<TextAggregateDimension> = new Set([
	"state",
	"fact",
	"unknown_reason",
	"review",
	"review_status",
	"review_flag"
]);
const NEEDS_TARGET: ReadonlySet<TextAggregateDimension> = new Set([
	...PER_CULTURE,
	"culture",
	"translation_key",
	"gathered"
]);

/**
 * What each group measures besides its line count: `sourceWords` are whitespace-separated words
 * of the line's source (as in localization state counts); `lineBreakWords` are Unreal's word
 * count (`unicode-line-break-v1`, the localization report's) of the text Unreal gathers for the
 * line: its first required manifest entry's source, else its saved source. Text in scripts that
 * need dictionary breaking has no such count; `unknownWords` counts those lines instead.
 */
export const TextAggregateMeasure = Schema.Literals(["lines", "sourceWords", "lineBreakWords"]);
export type TextAggregateMeasure = typeof TextAggregateMeasure.Type;

const { cursor: _cursor, pageSize: _pageSize, ...searchFields } = TextCorpusSearchRequest.fields;
const {
	group: _group,
	minGroupSize: _minGroupSize,
	openGroup: _openGroup,
	facets: _facets,
	localizationCursor: _localizationCursor,
	...matchingFields
} = searchFields;

/**
 * Grouped counts of every row a search request matches: the search fields select the rows (lines
 * with a target, units without), `by` names one to four dimensions and `measures` what to sum.
 * Every group is listed, in each dimension's own order from left to right.
 */
export const TextAggregateRequest = Schema.Struct({
	...matchingFields,
	by: Schema.Array(TextAggregateDimension).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
	measures: Schema.optionalKey(Schema.Array(TextAggregateMeasure).check(Schema.isMaxLength(3)))
}).check(
	Schema.makeFilter((request) => {
		if (new Set(request.by).size !== request.by.length)
			return "Aggregate dimensions must be distinct.";
		if (request.measures && new Set(request.measures).size !== request.measures.length)
			return "Aggregate measures must be distinct.";
		if (!request.localization && request.by.some((dimension) => NEEDS_TARGET.has(dimension)))
			return "Culture, translation key and gathered dimensions need a localization target.";
		const culture = request.by.indexOf("culture");
		return request.by.some(
			(dimension, index) => PER_CULTURE.has(dimension) && (culture < 0 || culture > index)
		)
			? "A culture-mark dimension needs culture before it."
			: undefined;
	})
);
export type TextAggregateRequest = typeof TextAggregateRequest.Type;

/** One group: its key, one value per dimension, and its measures. */
export const TextAggregateGroup = Schema.Struct({
	key: Schema.Array(Schema.String),
	lines: Count,
	sourceWords: Schema.optionalKey(Count),
	lineBreakWords: Schema.optionalKey(Count),
	unknownWords: Schema.optionalKey(Count)
});
export type TextAggregateGroup = typeof TextAggregateGroup.Type;

/** How many rows matched, and every group of them. */
export const TextAggregate = Schema.Struct({
	lines: Count,
	groups: Schema.Array(TextAggregateGroup)
});
export type TextAggregate = typeof TextAggregate.Type;

/** A saved place of a line's units: its package file, object path and where its text lives. */
export const LocalizationLinePlace = Schema.Struct({
	packageFile: Schema.String,
	objectPath: Schema.String,
	origin: TextOriginKind
});
export type LocalizationLinePlace = typeof LocalizationLinePlace.Type;

/** A culture mark without its archive and PO entries, with the translation that ships. */
export const LocalizationLineMark = LocalizationCultureMark.pipe(
	Schema.fieldsAssign({ translation: Schema.NullOr(Schema.String) })
);
export type LocalizationLineMark = typeof LocalizationLineMark.Type;

/**
 * The fields a line export can name. The `LocalizationLine` fields keep their shape; `marks` are
 * the cultures without archive and PO entries; `problems` are the line's problems in the
 * request's cultures and `signals` its review signals; `places` are its units' saved places, in
 * unit ID and occurrence order.
 */
export const localizationLineFieldSchemas = {
	origin: LocalizationLine.fields.origin,
	identity: LocalizationLine.fields.identity,
	source: LocalizationLine.fields.source,
	manifest: LocalizationLine.fields.manifest,
	cultures: LocalizationLine.fields.cultures,
	keyChange: LocalizationLine.fields.keyChange,
	audience: LocalizationLine.fields.audience,
	outOfScope: LocalizationLine.fields.outOfScope,
	marks: Schema.Array(LocalizationLineMark),
	problems: Schema.Array(TextProblem),
	signals: Schema.Array(TextReviewSignal),
	places: Schema.Array(LocalizationLinePlace)
} as const;
/** A field a line export can name: a `LocalizationLine` field, `marks`, `problems`, `signals` or `places`. */
export type LocalizationLineField = keyof typeof localizationLineFieldSchemas;
/** A field a line export can name: a `LocalizationLine` field, `marks`, `problems`, `signals` or `places`. */
export const LocalizationLineField = Schema.Literals(
	// SAFETY: Object.keys of the literal field table returns exactly its keys, and it has some.
	// Verified by: index-reads.test.ts — every field decodes in the line-view parity check.
	Object.keys(localizationLineFieldSchemas) as [LocalizationLineField, ...LocalizationLineField[]]
);
type FieldTypes = {
	readonly [K in LocalizationLineField]: (typeof localizationLineFieldSchemas)[K]["Type"];
};
/** A line with its ID and the named fields. `keyChange`, `audience` and `outOfScope` stay optional. */
export type LocalizationLineView<F extends LocalizationLineField> = {
	readonly id: LocalizationLineId;
} & Pick<FieldTypes, F>;

/** Decodes lines exported with `fields`, keeping only those fields. */
export const localizationLineViews = <F extends LocalizationLineField>(
	fields: readonly F[]
): Schema.Codec<readonly LocalizationLineView<F>[], unknown> => {
	const views: Schema.Top = Schema.Array(
		Schema.Struct({
			id: LocalizationLineId,
			...Object.fromEntries(
				fields.map((field) => [field, localizationLineFieldSchemas[field]])
			)
		})
	);
	// SAFETY: the struct holds `id` and exactly the schema of each named field.
	// Verified by: index-reads.test.ts — native, columnar and reference line views equal the derived ones.
	return views as Schema.Codec<readonly LocalizationLineView<F>[], unknown>;
};

/** The corpus without its units: status, coverage, package coverage and diagnostics. */
export const TextCorpusHeader = TextCorpus.mapFields(({ units: _units, ...fields }) => fields);
export type TextCorpusHeader = typeof TextCorpusHeader.Type;
