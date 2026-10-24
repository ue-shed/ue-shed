import type { TextCorpusRows, TextCorpusSearchPage } from "@ue-shed/game-text/schema";

/**
 * A further page of rows appended to those loaded. What the loaded page counts stays; the cursors
 * come from the newer page, which holds rows only.
 */
export function mergePages(
	loaded: TextCorpusSearchPage,
	next: TextCorpusRows
): TextCorpusSearchPage;
export function mergePages(loaded: TextCorpusRows, next: TextCorpusRows): TextCorpusRows;
export function mergePages(
	loaded: TextCorpusSearchPage | TextCorpusRows,
	next: TextCorpusRows
): TextCorpusSearchPage | TextCorpusRows {
	const { nextCursor: _cursor, ...kept } = loaded;
	const merged = {
		...kept,
		units: [...loaded.units, ...next.units],
		...(next.nextCursor === undefined ? undefined : { nextCursor: next.nextCursor })
	};
	if (!loaded.localization || !next.localization) return merged;
	const { nextCursor: _lineCursor, ...localization } = loaded.localization;
	return {
		...merged,
		localization: {
			...localization,
			lines: [...loaded.localization.lines, ...next.localization.lines],
			...(next.localization.nextCursor === undefined
				? undefined
				: { nextCursor: next.localization.nextCursor })
		}
	};
}

/** The cursor that loads the page after this one, if there is one. */
export function nextPageCursor(page: TextCorpusRows) {
	return page.localization?.nextCursor
		? { localizationCursor: page.localization.nextCursor }
		: page.nextCursor
			? { cursor: page.nextCursor }
			: undefined;
}

/** How many rows a page holds: its lines with a localization target, else its units. */
export function pageRows(page: TextCorpusRows) {
	return page.localization?.lines.length ?? page.units.length;
}
