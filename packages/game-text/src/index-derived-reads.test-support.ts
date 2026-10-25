import { Schema } from "effect";
import {
	TextCorpus,
	TextOriginKind,
	TextProblem,
	TextReviewSignal,
	type TextCorpusSearchPage,
	type TextCorpusSearchRequest,
	type TextFilterClause
} from "./schema.js";
import type { LocalizationLine } from "./localization-schema.js";
import {
	TextAggregate,
	localizationLineViews,
	type LocalizationLineField,
	type LocalizationLineView,
	type TextAggregateDimension,
	type TextAggregateRequest,
	type TextCorpusHeader
} from "./index-reads.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { matchesLocalizationReview } from "./localization-review.js";
import { localizationWordCount } from "./localization-words.js";
import { textLocationOrigin } from "./text-origin.js";
import { localizationLineUnits } from "./gathered-text.js";
import { canonicalLocalizationJson, localizationFingerprint } from "./localization-fingerprint.js";
import {
	LocalizationReviewLens,
	LocalizationState,
	LocalizationUnknownReason
} from "./localization-schema.js";
import { TextAudience } from "./text-audience-schema.js";

type Matching = Omit<TextCorpusSearchRequest, "cursor" | "pageSize">;

/**
 * Reads the native index answers in Rust, derived here from whole lines, filters and the corpus:
 * the oracle for native aggregates, line fields, the corpus header and fingerprint, and the
 * implementation test doubles use.
 */
export interface DerivedReadsBase {
	readonly lines: (request: Matching) => readonly LocalizationLine[];
	readonly search: (request: TextCorpusSearchRequest) => TextCorpusSearchPage;
	readonly corpus: () => TextCorpus;
	/** The target's cultures, in its order. */
	readonly cultures: readonly string[];
}

const ordinal = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;

const withClause = (request: Matching, clause: TextFilterClause): Matching => ({
	...request,
	filter: [...(request.filter ?? []), clause]
});

/** Line IDs holding each value of a filter field, for the fields an aggregate reads by filter. */
const membership = (
	base: DerivedReadsBase,
	request: Matching,
	field: "problem" | "finding" | "fact" | "origin",
	values: readonly string[]
) =>
	new Map(
		values.map((value) => [
			value,
			new Set(
				base
					.lines(
						// SAFETY: each field's values come from its own literal vocabulary.
						// Verified by: index-reads.test.ts — derived aggregates equal the native ones.
						withClause(request, {
							field,
							op: "is",
							values: [value]
						} as TextFilterClause)
					)
					.map((line) => line.id)
			)
		])
	);

export function derivedAggregate(
	base: DerivedReadsBase,
	request: TextAggregateRequest
): TextAggregate {
	const { by, measures = [], ...matching } = request;
	if (!matching.localization)
		throw new Error("The derived aggregate reads localization lines; select a target.");
	const lines = base.lines(matching);
	const cultures = matching.localization.cultures ?? base.cultures;
	const vocabularies = {
		problem: TextProblem.literals,
		finding: TextReviewSignal.literals,
		origin: TextOriginKind.literals
	} as const;
	// SAFETY: one membership map per filter field the request groups by.
	// Verified by: index-reads.test.ts — derived aggregates equal the native ones.
	const members = Object.fromEntries(
		(["problem", "finding", "origin"] as const)
			.filter((field) => by.includes(field))
			.map((field) => [field, membership(base, matching, field, vocabularies[field])])
	) as Partial<Record<"problem" | "finding" | "origin", Map<string, Set<string>>>>;
	const { filter: _filter, lines: _lines, ...unfiltered } = matching;
	const tracked = base
		.lines(unfiltered)
		.some((line) => line.cultures.some((mark) => mark.review !== undefined));
	const groups = new Map<
		string,
		{
			key: string[];
			lines: number;
			sourceWords: number;
			lineBreakWords: number;
			unknownWords: number;
		}
	>();
	const lineValues = (line: LocalizationLine, dimension: TextAggregateDimension): string[] => {
		switch (dimension) {
			case "translation_key":
				return [
					line.identity
						? JSON.stringify([line.identity.namespace, line.identity.key])
						: ""
				];
			case "source":
				return [line.source];
			case "audience":
				return [line.audience ?? "unknown"];
			case "gathered":
				return [String(line.manifest.length > 0)];
			case "problem":
			case "finding":
			case "origin":
				return vocabularies[dimension].filter((value) =>
					members[dimension]!.get(value)!.has(line.id)
				);
			default:
				throw new Error(`The derived aggregate does not read ${dimension}.`);
		}
	};
	const markValues = (
		mark: LocalizationLine["cultures"][number],
		dimension: TextAggregateDimension
	): string[] => {
		switch (dimension) {
			case "culture":
				return [mark.culture];
			case "state":
				return [mark.state];
			case "fact":
				return [...mark.facts];
			case "unknown_reason":
				return [...mark.unknownReasons];
			case "review":
				return tracked
					? LocalizationReviewLens.literals.filter((lens) =>
							matchesLocalizationReview(mark, lens)
						)
					: [];
			case "review_status":
				return mark.review ? [mark.review.status] : [];
			case "review_flag":
				return mark.review?.status === "current" ? [...new Set(mark.review.flags)] : [];
			default:
				return [];
		}
	};
	const product = (values: readonly string[][]): string[][] =>
		values.reduce<string[][]>(
			(keys, options) => keys.flatMap((key) => options.map((value) => [...key, value])),
			[[]]
		);
	for (const line of lines) {
		const required = line.manifest.find((entry) => entry.optional !== true);
		const count = localizationWordCount(required?.source.Text ?? line.source);
		const add = (key: string[]) => {
			const id = JSON.stringify(key);
			const group = groups.get(id) ?? {
				key,
				lines: 0,
				sourceWords: 0,
				lineBreakWords: 0,
				unknownWords: 0
			};
			group.lines++;
			group.sourceWords += words(line.source);
			if (count.status === "counted") group.lineBreakWords += count.words;
			else group.unknownWords++;
			groups.set(id, group);
		};
		if (!by.includes("culture")) {
			for (const key of product(by.map((dimension) => lineValues(line, dimension)))) add(key);
			continue;
		}
		for (const culture of cultures) {
			const mark = line.cultures.find((item) => item.culture === culture);
			if (!mark) continue;
			const values = by.map((dimension) =>
				dimension === "culture" ||
				dimension === "state" ||
				dimension === "fact" ||
				dimension === "unknown_reason" ||
				dimension === "review" ||
				dimension === "review_status" ||
				dimension === "review_flag"
					? markValues(mark, dimension)
					: lineValues(line, dimension)
			);
			for (const key of product(values)) add(key);
		}
	}
	const orders = new Map<TextAggregateDimension, readonly string[]>([
		["culture", base.cultures],
		["state", LocalizationState.literals],
		["fact", LocalizationState.literals],
		["unknown_reason", LocalizationUnknownReason.literals],
		["review", LocalizationReviewLens.literals],
		["review_status", ["not_reviewed", "current", "changed"]],
		["problem", TextProblem.literals],
		["finding", TextReviewSignal.literals],
		["origin", TextOriginKind.literals],
		["audience", TextAudience.literals],
		["gathered", ["false", "true"]]
	]);
	const translationKey = Schema.decodeUnknownSync(
		Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))
	);
	const rank = (dimension: TextAggregateDimension, value: string): string => {
		const order = orders.get(dimension);
		if (order) return String(order.indexOf(value)).padStart(8, "0");
		if (dimension === "translation_key" && value !== "") {
			const [namespace, key] = translationKey(value);
			return `${namespace}\u0000${key}`;
		}
		return value;
	};
	const sorted = [...groups.values()].sort((left, right) => {
		for (const [index, dimension] of by.entries()) {
			const order = ordinal(
				rank(dimension, left.key[index]!),
				rank(dimension, right.key[index]!)
			);
			if (order !== 0) return order;
		}
		return 0;
	});
	return Schema.decodeUnknownSync(TextAggregate)({
		lines: lines.length,
		groups: sorted.map((group) => ({
			key: group.key,
			lines: group.lines,
			...(measures.includes("sourceWords") ? { sourceWords: group.sourceWords } : undefined),
			...(measures.includes("lineBreakWords")
				? { lineBreakWords: group.lineBreakWords, unknownWords: group.unknownWords }
				: undefined)
		}))
	});
}

export function derivedLineViews<F extends LocalizationLineField>(
	base: DerivedReadsBase,
	request: Matching,
	fields: readonly F[]
): readonly LocalizationLineView<F>[] {
	const lines = base.lines(request);
	const has = (name: LocalizationLineField) => fields.some((field) => field === name);
	const problems = has("problems")
		? membership(base, request, "problem", TextProblem.literals)
		: undefined;
	const signals = has("signals")
		? membership(base, request, "fact", TextReviewSignal.literals)
		: undefined;
	const units = has("places")
		? new Map(base.corpus().units.map((unit) => [unit.id, unit]))
		: undefined;
	const entry = <V>(key: string, value: V): [string, V][] => [[key, value]];
	const valueOf = (line: LocalizationLine, field: LocalizationLineField): [string, unknown][] => {
		switch (field) {
			case "marks":
				return entry(
					field,
					line.cultures.map(
						(
							{ archive: _archive, po: _po, poTranslation: _poTranslation, ...mark },
							index
						) => ({
							...mark,
							translation: localizationShippedTranslation(line.cultures[index]!).value
						})
					)
				);
			case "problems":
				return entry(
					field,
					TextProblem.literals.filter((value) => problems!.get(value)!.has(line.id))
				);
			case "signals":
				return entry(
					field,
					TextReviewSignal.literals.filter((value) => signals!.get(value)!.has(line.id))
				);
			case "places":
				return entry(
					field,
					localizationLineUnits(line, units!).flatMap((unit) =>
						unit.occurrences.map((occurrence) => ({
							packageFile: occurrence.packageFile,
							objectPath: occurrence.location.objectPath,
							origin: textLocationOrigin(occurrence.location)
						}))
					)
				);
			default:
				return line[field] === undefined ? [] : entry(field, line[field]);
		}
	};
	// Decoding keeps each view to its fields, as the native export's decoder does.
	return Schema.decodeUnknownSync(localizationLineViews(fields))(
		lines.map((line) =>
			Object.fromEntries([
				...entry("id", line.id),
				...fields.flatMap((field) => valueOf(line, field))
			])
		)
	);
}

export const derivedCorpusHeader = (corpus: TextCorpus): TextCorpusHeader => {
	const { units: _units, ...header } = corpus;
	return header;
};

/** The baseline corpus generation as createLocalizationBaseline computed it from the corpus. */
export const derivedCorpusFingerprint = (corpus: TextCorpus) =>
	localizationFingerprint(
		canonicalLocalizationJson(
			Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
				Schema.encodeSync(Schema.fromJsonString(TextCorpus))(corpus)
			)
		)
	);
