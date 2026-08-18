import type {
	TextCorpus,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextCorpusSearchRequest,
	TextOccurrence,
	TextReviewLens,
	TextReviewSignal,
	TextUnit,
	TextUnitSearchResult
} from "./schema.js";
import { hasSearchableSource, searchableSourceText } from "./search.js";

function normalizedTerms(query: string): readonly string[] {
	return query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
}

const LONG_SOURCE_THRESHOLD = 40;

function sourceValue(unit: TextUnit): string {
	return unit.source.status === "consistent" ? unit.source.value : unit.source.values.join(" ");
}

function wordCount(value: string): number {
	return value.trim() === "" ? 0 : value.trim().split(/\s+/u).length;
}

function searchResult(unit: TextUnit, duplicateSources: ReadonlySet<string>): TextUnitSearchResult {
	const contexts = unit.occurrences.slice(0, 3).map((occurrence) => ({
		editCapability: occurrence.editCapability,
		location: occurrence.location
	}));
	const value = sourceValue(unit);
	const reviewSignals: TextReviewSignal[] = [];
	if (unit.occurrences.length > 1) reviewSignals.push("shared");
	if (unit.source.status === "consistent" && duplicateSources.has(unit.source.value))
		reviewSignals.push("duplicate_source");
	if (value.length >= LONG_SOURCE_THRESHOLD) reviewSignals.push("long");
	if (unit.identity.status === "unresolved") reviewSignals.push("unresolved");
	if (unit.source.status === "conflicting") reviewSignals.push("conflicting");
	if (unit.occurrences.every((occurrence) => occurrence.editCapability === "read_only"))
		reviewSignals.push("evidence_only");
	return {
		characterCount: value.length,
		contexts,
		id: unit.id,
		identity: unit.identity,
		locationKinds: [
			...new Set(unit.occurrences.map((occurrence) => occurrence.location.kind))
		].sort(),
		occurrenceCount: unit.occurrences.length,
		remainingContextCount: Math.max(0, unit.occurrences.length - contexts.length),
		reviewSignals,
		source: unit.source,
		wordCount: wordCount(value)
	};
}

function matchesLens(
	signals: readonly TextReviewSignal[],
	lens: TextReviewLens | undefined
): boolean {
	if (lens === undefined || lens === "all") return true;
	return signals.includes(lens);
}

function filteredOccurrences(
	unit: TextUnit,
	capability: TextCorpusSearchRequest["capability"]
): readonly TextOccurrence[] {
	if (capability === "all") return unit.occurrences;
	return unit.occurrences.filter((occurrence) => occurrence.editCapability === capability);
}

/**
 * In-memory, query-scoped view of a compact text corpus. It normalizes every unit once at refresh
 * time and emits only bounded pages to callers.
 */
export interface TextCorpusQuery {
	readonly focus: (request: TextCorpusFocusRequest) => TextCorpusFocus | undefined;
	readonly search: (request: TextCorpusSearchRequest) => TextCorpusSearchPage;
	readonly summary: () => TextCorpusQuerySummary;
}

export function textCorpusQuery(corpus: TextCorpus): TextCorpusQuery {
	const units = [...corpus.units].sort((left, right) => left.id.localeCompare(right.id));
	const sourceFrequency = new Map<string, number>();
	for (const unit of units) {
		if (unit.source.status !== "consistent") continue;
		sourceFrequency.set(unit.source.value, (sourceFrequency.get(unit.source.value) ?? 0) + 1);
	}
	const duplicateSources = new Set(
		[...sourceFrequency].filter(([, count]) => count > 1).map(([source]) => source)
	);
	const indexed = units.map((unit) => ({
		presentation: searchResult(unit, duplicateSources),
		searchable: searchableSourceText(unit),
		unit
	}));
	const diagnosticsByPackage = new Map<string, typeof corpus.diagnostics>();
	for (const diagnostic of corpus.diagnostics) {
		diagnosticsByPackage.set(diagnostic.packageFile, [
			...(diagnosticsByPackage.get(diagnostic.packageFile) ?? []),
			diagnostic
		]);
	}
	const summary: TextCorpusQuerySummary = {
		schemaVersion: 1,
		status: corpus.status,
		coverage: corpus.coverage,
		diagnosticCount: corpus.diagnostics.length,
		review: {
			all: indexed.length,
			shared: indexed.filter(({ presentation }) =>
				presentation.reviewSignals.includes("shared")
			).length,
			duplicateSource: indexed.filter(({ presentation }) =>
				presentation.reviewSignals.includes("duplicate_source")
			).length,
			long: indexed.filter(({ presentation }) => presentation.reviewSignals.includes("long"))
				.length,
			unresolved: indexed.filter(({ presentation }) =>
				presentation.reviewSignals.includes("unresolved")
			).length,
			conflicting: indexed.filter(({ presentation }) =>
				presentation.reviewSignals.includes("conflicting")
			).length
		},
		sources: {
			assetProperty: indexed.filter(({ presentation }) =>
				presentation.locationKinds.includes("asset_property")
			).length,
			dataTable: indexed.filter(({ presentation }) =>
				presentation.locationKinds.includes("data_table_cell")
			).length,
			mixed: indexed.filter(({ presentation }) => presentation.locationKinds.length > 1)
				.length,
			stringTable: indexed.filter(({ presentation }) =>
				presentation.locationKinds.includes("string_table_entry")
			).length
		}
	};

	return {
		summary: () => summary,
		search: (request) => {
			const terms = normalizedTerms(request.query);
			const matched = indexed.filter(({ presentation, searchable, unit }) => {
				if (!hasSearchableSource(unit)) return false;
				if (filteredOccurrences(unit, request.capability).length === 0) return false;
				if (!matchesLens(presentation.reviewSignals, request.lens)) return false;
				return terms.every((term) => searchable.includes(term));
			});
			const afterCursor = request.cursor
				? matched.findIndex(({ unit }) => unit.id === request.cursor) + 1
				: 0;
			const page = matched.slice(Math.max(0, afterCursor), afterCursor + request.pageSize);
			const final = page.at(-1)?.unit.id;
			return {
				total: matched.length,
				units: page.map(({ presentation }) => presentation),
				...(final !== undefined && afterCursor + page.length < matched.length
					? { nextCursor: final }
					: undefined)
			};
		},
		focus: (request) => {
			const unit = units.find((candidate) => candidate.id === request.id);
			if (!unit) return undefined;
			const afterCursor = request.occurrenceCursor
				? unit.occurrences.findIndex(
						(occurrence) => occurrence.id === request.occurrenceCursor
					) + 1
				: 0;
			const occurrences = unit.occurrences.slice(
				Math.max(0, afterCursor),
				afterCursor + request.pageSize
			);
			const final = occurrences.at(-1)?.id;
			const diagnostics = [
				...new Map(
					unit.occurrences
						.flatMap(
							(occurrence) => diagnosticsByPackage.get(occurrence.packageFile) ?? []
						)
						.map((diagnostic) => [
							`${diagnostic.code}:${diagnostic.packageFile}:${diagnostic.objectPath ?? ""}:${diagnostic.propertyPath ?? ""}`,
							diagnostic
						])
				).values()
			].slice(0, request.pageSize);
			return {
				diagnostics,
				occurrences,
				totalOccurrences: unit.occurrences.length,
				unit: searchResult(unit, duplicateSources),
				...(final !== undefined &&
				afterCursor + occurrences.length < unit.occurrences.length
					? { nextOccurrenceCursor: final }
					: undefined)
			};
		}
	};
}
