import { Schema } from "effect";
import type { CultureCode } from "@ue-shed/localization/browser";
import {
	GameTextLocalizationError,
	LocalizationCultureCounts,
	LocalizationStateCounts,
	LocalizationUnknownReason,
	localizationStates,
	type LocalizationJoin,
	type LocalizationLine,
	type LocalizationLinePreview,
	LocalizationQueryPage,
	LocalizationReviewLens,
	type LocalizationSelection
} from "./localization-schema.js";
import { matchesLocalizationReview } from "./localization-review.js";
import type { TextCorpusSearchRequest } from "./schema.js";

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
	return cultures.map((culture) => {
		const states = Schema.decodeUnknownSync(LocalizationStateCounts)(
			Object.fromEntries(
				localizationStates.map((state) => [state, { lines: 0, sourceWords: 0 }])
			)
		);
		const unknownReasons = Schema.decodeUnknownSync(
			LocalizationCultureCounts.fields.unknownReasons
		)(Object.fromEntries(LocalizationUnknownReason.literals.map((reason) => [reason, 0])));
		let reducedSourceChecking = 0;
		for (const line of lines) {
			const mark = line.cultures.find((item) => item.culture === culture);
			if (!mark) continue;
			// Schema outputs are readonly. Replacing a count preserves its validated contract.
			Object.assign(states, {
				[mark.state]: {
					lines: states[mark.state].lines + 1,
					sourceWords: states[mark.state].sourceWords + words(line.source)
				}
			});
			for (const reason of mark.unknownReasons)
				Object.assign(unknownReasons, {
					[reason]: unknownReasons[reason] + 1
				});
			if (mark.reducedSourceChecking) reducedSourceChecking++;
		}
		return { culture, states, unknownReasons, reducedSourceChecking };
	});
}

export function validateLocalizationSelection(
	join: LocalizationJoin,
	selection: LocalizationSelection
): void {
	if (
		selection.target !== join.target ||
		(selection.culture !== undefined && !join.cultures.includes(selection.culture))
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
	const selected = line.cultures.filter(
		(mark) => selection.culture === undefined || mark.culture === selection.culture
	);
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

export function localizationQueryPage(
	join: LocalizationJoin,
	matched: readonly LocalizationLine[],
	request: TextCorpusSearchRequest
): LocalizationQueryPage {
	const after = request.localizationCursor
		? matched.findIndex((line) => line.id === request.localizationCursor) + 1
		: 0;
	const page = matched.slice(after, after + request.pageSize);
	const stateCounts = Schema.decodeUnknownSync(LocalizationQueryPage.fields.stateCounts)(
		Object.fromEntries(localizationStates.map((state) => [state, 0]))
	);
	let notSynced = 0;
	let keyChanged = 0;
	const reviewed = matched.some((line) => line.cultures.some((mark) => mark.review));
	const reviewCounts = new Map(LocalizationReviewLens.literals.map((lens) => [lens, 0]));
	for (const line of matched) {
		const marks = line.cultures.filter(
			(mark) =>
				!request.localization?.culture || mark.culture === request.localization.culture
		);
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
		counts: localizationCounts(matched, join.cultures),
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
	if (last && after + page.length < matched.length)
		Object.assign(result, { nextCursor: last.id });
	return result;
}
