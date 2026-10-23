/** Text grouping helpers retained until corpus aggregates move into the engine. */
import {
	localizationCheckDefaults,
	type InconsistentTranslationParams
} from "./localization-check-catalogue.js";

/**
 * Opening and self-closing Slate rich-text tags: `<b>`, `<Name attr="x">`, `<img id="x"/>`. As in
 * Slate's markup parser, attributes are `name="value"` pairs, so `<invalid requirement type>` is
 * text, not a tag.
 */
const TAG = /<([A-Za-z_][\w.-]*)(?:\s+[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/gu;
const CLOSING_TAG = /<\/>/gu;

function wide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** Argument modifiers such as `|plural(one=item,other=items)`, quoted forms included. */
const MODIFIER = /\|(?:plural|ordinal|gender|hpp)\((?:"(?:[^"\\]|\\.)*"|[^()"])*\)/gu;

/** JavaScript's `\s`, by code unit. */
function space(code: number): boolean {
	return code <= 0x20
		? code === 0x20 || (code >= 0x09 && code <= 0x0d)
		: code >= 0xa0 &&
				(code === 0xa0 ||
					code === 0x1680 ||
					(code >= 0x2000 && code <= 0x200a) ||
					code === 0x2028 ||
					code === 0x2029 ||
					code === 0x202f ||
					code === 0x205f ||
					code === 0x3000 ||
					code === 0xfeff);
}

/**
 * Length a reader sees: rich-text tags, argument modifiers and `{argument}` placeholders removed,
 * whitespace runs counted as one space, ends trimmed. Each code point counts 1; East Asian wide
 * characters count 2, since one carries about as much as two Latin letters. That keeps the ratio
 * between a Latin source and a Chinese, Japanese or Korean translation near 1. It runs for every
 * translation, so it scans code units and skips the replacements text without markup needs.
 */
export function visibleTextLength(text: string): number {
	let visible = text;
	if (visible.includes("<")) visible = visible.replace(TAG, "").replace(CLOSING_TAG, "");
	if (visible.includes("|")) visible = visible.replace(MODIFIER, "");
	if (visible.includes("{")) visible = visible.replace(/\{[^{}]*\}/gu, "");
	let length = 0,
		pendingSpace = false;
	for (let index = 0; index < visible.length; index++) {
		let code = visible.charCodeAt(index);
		if (space(code)) {
			pendingSpace = length > 0;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < visible.length) {
			code = visible.codePointAt(index)!;
			if (code > 0xffff) index++;
		}
		length += (pendingSpace ? 1 : 0) + (wide(code) ? 2 : 1);
		pendingSpace = false;
	}
	return length;
}

const LETTER = /\p{L}/u;

/** Sources worth grouping as "Same text, different keys": they have letters. */
export function sharedSourceCandidate(text: string): boolean {
	return LETTER.test(text);
}

/** Words in the text a reader sees: runs without whitespace, rich-text tags removed. */
export function visibleWordCount(text: string): number {
	const visible = text.includes("<") ? text.replace(TAG, " ").replace(CLOSING_TAG, " ") : text;
	return visible.match(/\S+/gu)?.length ?? 0;
}

/**
 * Sources whose translations should agree: letters, and a visible length and word count within
 * the parameters. Longer sentences are often translated to fit their scene.
 */
export function consistentTranslationCandidate(
	text: string,
	params: InconsistentTranslationParams = localizationCheckDefaults.inconsistent_translation
): boolean {
	return (
		LETTER.test(text) &&
		visibleTextLength(text) >= params.minimumLength &&
		visibleWordCount(text) <= params.maximumWords
	);
}

/**
 * The form translations are grouped by: lower-cased, without whitespace, punctuation and symbols,
 * so "Danke!" and "danke" count as one translation. Text that is only those keeps its trimmed
 * form.
 */
export function translationGroupKey(text: string): string {
	const key = text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
	return key.length ? key : text.trim();
}
