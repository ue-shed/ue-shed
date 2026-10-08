import type {
	LocalizationEdit,
	LocalizationLineId,
	LocalizationLinePreview,
	LocalizationReviewChange,
	LocalizationSelection,
	TextCorpusSearchRequest
} from "@ue-shed/game-text/browser";

/** The most lines a selection holds; exports and reviews pick lines out by id. */
export const MAX_SELECTED_LINES = 5000;

/**
 * Exports the ticked lines whatever the list shows now: only the target and cultures carry over,
 * never the list's state, review or key-change filters, which could drop a ticked line.
 */
export function exportRequest(
	localization: LocalizationSelection,
	lines: readonly LocalizationLinePreview[]
): TextCorpusSearchRequest {
	return {
		query: "",
		capability: "all",
		localization: {
			target: localization.target,
			...(localization.culture === undefined ? undefined : { culture: localization.culture }),
			...(localization.cultures === undefined
				? undefined
				: { cultures: localization.cultures })
		},
		lines: lines.map((line) => line.id),
		pageSize: 50
	};
}
/** The most review changes one request writes. */
export const REVIEW_BATCH = 500;

const REVIEWABLE = new Set(["translated", "not_synced", "needs_update"]);

/** Only the picked cultures' marks; every culture's when none is picked. */
const pickedMarks = (line: LocalizationLinePreview, cultures: readonly string[]) =>
	cultures.length === 0
		? line.cultures
		: line.cultures.filter((mark) => cultures.includes(mark.culture));

/**
 * "Reviewed" for every translation the selection shows that has text to review and is not
 * reviewed already. The native culture is the source, so it is never reviewed.
 */
export function reviewChanges(
	lines: Iterable<LocalizationLinePreview>,
	cultures: readonly string[],
	nativeCulture: string | undefined
) {
	const changes: LocalizationReviewChange[] = [];
	for (const line of lines) {
		if (line.identity === null) continue;
		for (const mark of pickedMarks(line, cultures)) {
			if (mark.culture === nativeCulture || !REVIEWABLE.has(mark.state)) continue;
			if (mark.review?.status === "current" && mark.review.flags.includes("reviewed"))
				continue;
			changes.push({
				kind: "set",
				culture: mark.culture,
				namespace: line.identity.namespace,
				key: line.identity.key,
				flags: ["reviewed"]
			});
		}
	}
	return changes;
}

/** Splits changes into requests of at most `size`. */
export function batches<T>(items: readonly T[], size: number) {
	const result: (readonly T[])[] = [];
	for (let start = 0; start < items.length; start += size)
		result.push(items.slice(start, start + size));
	return result;
}

/**
 * The earlier keys' translations for every selected line saved under a new key, staged like hand
 * edits. A pair whose source text changed is left out: its translation was written for other
 * text, so the line page offers it one line at a time.
 */
export function carryEdits(lines: Iterable<LocalizationLinePreview>) {
	const edits: { readonly edit: LocalizationEdit; readonly source: string }[] = [];
	for (const line of lines) {
		const change = line.keyChange;
		if (change?.direction !== "to" || change.sourceChanged || line.identity === null) continue;
		for (const item of change.translations) {
			const shown = line.cultures.find((mark) => mark.culture === item.culture);
			edits.push({
				edit: {
					culture: item.culture,
					namespace: line.identity.namespace,
					key: line.identity.key,
					seenTranslation: shown?.translation ?? null,
					translation: item.translation
				},
				source: line.source
			});
		}
	}
	return edits;
}

/** Namespace and key per line, tab-separated, so they paste into two spreadsheet columns. */
export function keysText(lines: Iterable<LocalizationLinePreview>) {
	return [...lines]
		.flatMap((line) =>
			line.identity === null ? [] : [line.identity.namespace + "\t" + line.identity.key]
		)
		.join("\n");
}

/**
 * The lines from the last one ticked to this one, in list order, for a shift-click. Without an
 * anchor in the list it is just this line.
 */
export function lineRange<Line extends { readonly id: LocalizationLineId }>(
	order: readonly Line[],
	anchor: LocalizationLineId | undefined,
	target: LocalizationLineId
) {
	const to = order.findIndex((line) => line.id === target);
	const from = anchor === undefined ? -1 : order.findIndex((line) => line.id === anchor);
	if (to < 0) return [];
	if (from < 0) return [order[to]].filter((line) => line !== undefined);
	return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}
