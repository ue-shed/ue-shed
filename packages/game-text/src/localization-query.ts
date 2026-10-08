import { Schema } from "effect";
import type { CultureCode } from "@ue-shed/localization/browser";
import {
	GameTextLocalizationError,
	type LocalizationCultureMark,
	LocalizationCultureCounts,
	LocalizationStateCounts,
	LocalizationUnknownReason,
	localizationStates,
	type LocalizationJoin,
	type LocalizationLine,
	type LocalizationLinePreview,
	LocalizationQueryPage,
	LocalizationReviewLens,
	type LocalizationSelection,
	type LocalizationState
} from "./localization-schema.js";
import { matchesLocalizationReview } from "./localization-review.js";
import type { TextCorpusSearchRequest } from "./schema.js";

const decodeStateCounts = Schema.decodeUnknownSync(LocalizationStateCounts);
const decodeUnknownReasonCounts = Schema.decodeUnknownSync(
	LocalizationCultureCounts.fields.unknownReasons
);

function words(source: string): number {
	return source.trim() ? source.trim().split(/\s+/u).length : 0;
}

export function localizationLinePreview(line: LocalizationLine): LocalizationLinePreview {
	return {
		id: line.id,
		origin: line.origin,
		identity: line.identity,
		source: line.source,
		manifestLocations: line.manifest.slice(0, 3).map((entry) => entry.path),
		remainingLocationCount: Math.max(0, line.manifest.length - 3),
		...(line.keyChange === undefined ? undefined : { keyChange: line.keyChange }),
		cultures: line.cultures.map(
			({
				culture,
				state,
				facts,
				unknownReasons,
				reducedSourceChecking,
				archive,
				poTranslation,
				review
			}) => ({
				culture,
				state,
				facts,
				unknownReasons,
				reducedSourceChecking,
				...(review === undefined ? undefined : { review }),
				translation: facts.includes("not_synced")
					? poTranslation
					: (archive?.translation.Text ?? null)
			})
		)
	};
}

/** All counts are over the exact matched lines, including the selected state filter. */
export function localizationCounts(
	lines: readonly LocalizationLine[],
	cultures: readonly CultureCode[]
): readonly LocalizationCultureCounts[] {
	// One pass over the lines, tallying every culture at once: a shipping game has tens of
	// thousands of lines and a dozen or more cultures.
	const tallies = new Map(
		cultures.map((culture) => [
			culture,
			{
				states: new Map<LocalizationState, { lines: number; sourceWords: number }>(),
				unknownReasons: new Map<LocalizationUnknownReason, number>(),
				reducedSourceChecking: 0
			}
		])
	);
	for (const line of lines) {
		const sourceWords = words(line.source);
		const seen = new Set<CultureCode>();
		for (const mark of line.cultures) {
			const tally = tallies.get(mark.culture);
			if (!tally || seen.has(mark.culture)) continue;
			seen.add(mark.culture);
			const state = tally.states.get(mark.state) ?? { lines: 0, sourceWords: 0 };
			state.lines++;
			state.sourceWords += sourceWords;
			tally.states.set(mark.state, state);
			for (const reason of mark.unknownReasons)
				tally.unknownReasons.set(reason, (tally.unknownReasons.get(reason) ?? 0) + 1);
			if (mark.reducedSourceChecking) tally.reducedSourceChecking++;
		}
	}
	return cultures.map((culture) => {
		const tally = tallies.get(culture);
		return {
			culture,
			states: decodeStateCounts(
				Object.fromEntries(
					localizationStates.map((state) => [
						state,
						tally?.states.get(state) ?? { lines: 0, sourceWords: 0 }
					])
				)
			),
			unknownReasons: decodeUnknownReasonCounts(
				Object.fromEntries(
					LocalizationUnknownReason.literals.map((reason) => [
						reason,
						tally?.unknownReasons.get(reason) ?? 0
					])
				)
			),
			reducedSourceChecking: tally?.reducedSourceChecking ?? 0
		};
	});
}

/**
 * The marks a selection looks at: the picked culture, else the cultures in scope, else every
 * target culture.
 */
export function scopedLocalizationMarks<Mark extends Pick<LocalizationCultureMark, "culture">>(
	line: { readonly cultures: readonly Mark[] },
	selection: LocalizationSelection | undefined
): readonly Mark[] {
	const culture = selection?.culture;
	const scope = selection?.cultures;
	if (culture !== undefined) return line.cultures.filter((mark) => mark.culture === culture);
	if (scope === undefined) return line.cultures;
	return line.cultures.filter((mark) => scope.includes(mark.culture));
}

export function validateLocalizationSelection(
	join: LocalizationJoin,
	selection: LocalizationSelection
): void {
	if (
		selection.target !== join.target ||
		(selection.culture !== undefined && !join.cultures.includes(selection.culture)) ||
		selection.cultures?.some((culture) => !join.cultures.includes(culture))
	) {
		throw new GameTextLocalizationError({
			code: "invalid_selection",
			message: "The localization selection is not available in this target.",
			recovery: "List the target's cultures and select an available target and culture."
		});
	}
}

export function matchesLocalizationLine(
	line: LocalizationLine,
	request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
): boolean {
	const selection = request.localization;
	if (!selection) return false;
	const selected = scopedLocalizationMarks(line, selection);
	const lens = selection.review;
	if (lens !== undefined && !selected.some((mark) => matchesLocalizationReview(mark, lens)))
		return false;
	if (selection.keyChanged && line.keyChange?.direction !== "to") return false;
	if (
		selection.state !== undefined &&
		!selected.some((mark) =>
			selection.state === "not_synced"
				? mark.facts.includes("not_synced")
				: mark.state === selection.state
		)
	)
		return false;
	const translation =
		selection.searchTranslations && selection.culture !== undefined
			? selected
					.flatMap((mark) => [
						mark.archive?.translation.Text ?? "",
						mark.poTranslation ?? ""
					])
					.join(" ")
			: "";
	const searchable = `${line.source} ${translation}`.toLocaleLowerCase();
	return request.query
		.toLocaleLowerCase()
		.trim()
		.split(/\s+/u)
		.filter(Boolean)
		.every((term) => searchable.includes(term));
}

/**
 * Counts cover every matched line; the page lists `listed`, which is the matched lines or one
 * open group of them.
 */
export function localizationQueryPage(
	join: LocalizationJoin,
	matched: readonly LocalizationLine[],
	request: TextCorpusSearchRequest,
	listed: readonly LocalizationLine[] = matched
): LocalizationQueryPage {
	const after = request.localizationCursor
		? listed.findIndex((line) => line.id === request.localizationCursor) + 1
		: 0;
	const page = listed.slice(after, after + request.pageSize);
	const stateCounts = Schema.decodeUnknownSync(LocalizationQueryPage.fields.stateCounts)(
		Object.fromEntries(localizationStates.map((state) => [state, 0]))
	);
	let notSynced = 0;
	let keyChanged = 0;
	const reviewed = matched.some((line) => line.cultures.some((mark) => mark.review));
	const reviewCounts = new Map(LocalizationReviewLens.literals.map((lens) => [lens, 0]));
	for (const line of matched) {
		const marks = scopedLocalizationMarks(line, request.localization);
		for (const state of localizationStates) {
			if (
				marks.some((mark) =>
					state === "not_synced" ? mark.facts.includes(state) : mark.state === state
				)
			)
				Object.assign(stateCounts, { [state]: stateCounts[state] + 1 });
		}
		notSynced += marks.filter((mark) => mark.facts.includes("not_synced")).length;
		if (line.keyChange?.direction === "to") keyChanged++;
		for (const lens of LocalizationReviewLens.literals)
			if (marks.some((mark) => matchesLocalizationReview(mark, lens)))
				reviewCounts.set(lens, (reviewCounts.get(lens) ?? 0) + 1);
	}
	const result: LocalizationQueryPage = {
		target: join.target,
		counts: localizationCounts(matched, request.localization?.cultures ?? join.cultures),
		stateCounts,
		notSynced,
		lines: page.map(localizationLinePreview)
	};
	if (reviewed)
		Object.assign(result, {
			reviewCounts: Schema.decodeUnknownSync(LocalizationQueryPage.fields.reviewCounts)(
				Object.fromEntries(reviewCounts)
			)
		});
	if (keyChanged > 0 || request.localization?.keyChanged) Object.assign(result, { keyChanged });
	const last = page.at(-1);
	if (last && after + page.length < listed.length) Object.assign(result, { nextCursor: last.id });
	return result;
}
