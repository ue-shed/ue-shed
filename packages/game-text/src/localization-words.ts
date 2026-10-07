import LineBreaker from "linebreak";
import { Schema } from "effect";

export const LocalizationWordCount = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("counted"),
		words: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	Schema.Struct({
		status: Schema.Literal("unknown"),
		reason: Schema.Literal("dictionary_line_breaking_unavailable")
	})
]);
export type LocalizationWordCount = typeof LocalizationWordCount.Type;

/** Unreal counts non-empty ICU line-break spans, including punctuation/format syntax. */
export function localizationWordCount(source: string): LocalizationWordCount {
	// ICU uses dictionaries for these scripts; UAX #14 alone cannot establish those boundaries.
	if (/[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(source))
		return { status: "unknown", reason: "dictionary_line_breaking_unavailable" };
	const iterator = new LineBreaker(source);
	let previous = 0;
	let words = 0;
	for (let boundary = iterator.nextBreak(); boundary !== null; boundary = iterator.nextBreak()) {
		if (boundary.position > previous) words++;
		previous = boundary.position;
	}
	return { status: "counted", words };
}
