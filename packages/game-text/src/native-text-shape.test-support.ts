import { Schema } from "effect";
import { expr } from "./rules/builder.js";
import { Expr, type Rule } from "./rules/schema.js";
import { exampleRules } from "./rules/catalogue.js";
import { nativeEvaluateRule } from "./native-rule-reports.test-support.js";
import {
	localizationCheckDefaults,
	type LengthOutlierParams,
	type PlaceholderTextParams,
	type PlaceholderTranslationParams
} from "./localization-check-catalogue.js";
import type { BuiltInCheckId } from "./localization-check-ids.js";

function value(expression: Expr) {
	return nativeEvaluateRule(
		{
			id: "measure",
			kind: "measure",
			label: "Measure",
			family: "source",
			subject: "unit_source",
			severity: "normal",
			when: true,
			actual: expr.object({ value: expression }),
			expectation: expr.object({}),
			recovery: ""
		},
		{ source: "" }
	)?.actual;
}
function measured<S extends Schema.Codec<unknown, unknown>>(expression: Expr, schema: S) {
	const result = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Unknown }))(
		value(expression)
	);
	return Schema.decodeUnknownSync(schema)(result.value);
}
const definition = (id: BuiltInCheckId) => exampleRules.find((rule) => rule.id === id)!;
function reading(rule: Rule, source: string, latest = "", culture = "de") {
	const line = {
		source,
		comparisonSource: source,
		sourceVariants: null,
		checkable: true,
		comparable: true,
		gathered: true,
		bytecodeOnly: false,
		sourceCulture: "en"
	};
	const fields =
		rule.subject === "line"
			? line
			: {
					...Object.fromEntries(
						Object.entries(line).map(([key, value]) => [`line.${key}`, value])
					),
					culture,
					latest,
					isNative: false
				};
	return nativeEvaluateRule(rule, fields);
}
export const compareRichTextTags = (source: string, translation: string) => {
	const actual = value(expr.compareRichTextTags(source, translation));
	return Schema.decodeUnknownSync(
		Schema.Struct({ value: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) })
	)(actual).value;
};
export const richTextTagBalance = (source: string) =>
	measured(
		expr.richTextTagBalance(source),
		Schema.Struct({
			opening: Schema.Number,
			closing: Schema.Number,
			xmlClosings: Schema.Array(Schema.String)
		})
	);
export const interiorLineBreaks = (source: string) =>
	measured(expr.interiorLineBreaks(source), Schema.Number);
export const numberOnlyText = (source: string) =>
	reading(definition("number_only_text"), source) !== undefined;
export const sourceWhitespace = (source: string) =>
	measured(
		expr.object({
			leading: expr.leadingClass(source, "jsSpace"),
			trailing: expr.trailingClass(source, "jsSpace"),
			repeatedSpaces: expr.runs(expr.trim(source), expr.lit({ chars: " " }), 2)
		}),
		Schema.Struct({
			leading: Schema.String,
			trailing: Schema.String,
			repeatedSpaces: Schema.Number
		})
	);
export function lengthOutlier(
	source: string,
	translation: string,
	_sourceLength?: number,
	minimumRatio?: number,
	params: LengthOutlierParams = localizationCheckDefaults.length_outlier
) {
	const rule = definition("length_outlier");
	const found = reading(
		{
			...rule,
			params: {
				...rule.params,
				...params,
				...(minimumRatio === undefined ? undefined : { minimumRatio })
			}
		},
		source,
		translation
	);
	if (!found) return undefined;
	const actual = Schema.decodeUnknownSync(
		Schema.Struct({ length: Schema.Number, ratio: Schema.Number })
	)(found.actual);
	const expected = Schema.decodeUnknownSync(Schema.Struct({ sourceLength: Schema.Number }))(
		found.expectation
	);
	return { ...actual, sourceLength: expected.sourceLength };
}
export function lengthOutlierMinimumRatio(
	culture: string,
	params: LengthOutlierParams = localizationCheckDefaults.length_outlier
) {
	const rule = definition("length_outlier");
	const raw = Schema.decodeUnknownSync(
		Schema.Struct({
			object: Schema.Struct({
				minimumRatio: Schema.Struct({ round: Schema.Tuple([Expr, Expr]) })
			})
		})
	)(rule.expectation).object.minimumRatio.round[0];
	const actual = reading(
		{ ...rule, params: { ...params }, when: true, actual: expr.object({ value: raw }) },
		"",
		"",
		culture
	)?.actual;
	return Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Number }))(actual).value;
}
export function placeholderTranslation(
	source: string,
	translation: string,
	params: PlaceholderTranslationParams = localizationCheckDefaults.placeholder_translation,
	sourceParams: PlaceholderTextParams = localizationCheckDefaults.placeholder_text
) {
	const rule = definition("placeholder_translation");
	const actual = reading(
		{
			...rule,
			params: {
				...rule.params,
				...params,
				sourceMarkers: sourceParams.markers,
				sourcePhrases: sourceParams.phrases
			}
		},
		source,
		translation
	)?.actual;
	return actual
		? Schema.decodeUnknownSync(Schema.Struct({ translation: Schema.String }))(actual)
				.translation
		: undefined;
}
export function placeholderMatchRanges(
	source: string,
	params: PlaceholderTextParams = localizationCheckDefaults.placeholder_text
) {
	const rule = definition("placeholder_text");
	const ranges = Schema.decodeUnknownSync(
		Schema.Struct({
			object: Schema.Struct({ matches: Schema.Struct({ map: Schema.Array(Expr) }) })
		})
	)(rule.actual).object.matches.map[0]!;
	const actual = reading(
		{
			...rule,
			params: { ...rule.params, ...params },
			when: true,
			actual: expr.object({ ranges })
		},
		source
	)?.actual;
	return Schema.decodeUnknownSync(
		Schema.Struct({
			ranges: Schema.Array(
				Schema.Struct({ match: Schema.String, start: Schema.Number, end: Schema.Number })
			)
		})
	)(actual).ranges;
}
export const placeholderMatches = (
	source: string,
	params: PlaceholderTextParams = localizationCheckDefaults.placeholder_text
) => placeholderMatchRanges(source, params).map((match) => match.match);
