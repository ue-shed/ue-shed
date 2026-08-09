import type {
	TextCorpus,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextCorpusSearchRequest,
	TextOccurrence,
	TextUnit,
	TextUnitSearchResult
} from "./schema.js";
import { hasSearchableSource, searchableSourceText } from "./search.js";

function normalizedTerms(query: string): readonly string[] {
	return query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
}

function searchResult(unit: TextUnit): TextUnitSearchResult {
	const contexts = unit.occurrences.slice(0, 3).map((occurrence) => ({
		editCapability: occurrence.editCapability,
		location: occurrence.location
	}));
	return {
		contexts,
		id: unit.id,
		identity: unit.identity,
		locationKinds: [
			...new Set(unit.occurrences.map((occurrence) => occurrence.location.kind))
		].sort(),
		occurrenceCount: unit.occurrences.length,
		remainingContextCount: Math.max(0, unit.occurrences.length - contexts.length),
		source: unit.source
	};
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
	const indexed = units.map((unit) => ({ searchable: searchableSourceText(unit), unit }));
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
		diagnosticCount: corpus.diagnostics.length
	};

	return {
		summary: () => summary,
		search: (request) => {
			const terms = normalizedTerms(request.query);
			const matched = indexed.filter(({ searchable, unit }) => {
				if (!hasSearchableSource(unit)) return false;
				if (filteredOccurrences(unit, request.capability).length === 0) return false;
				return terms.every((term) => searchable.includes(term));
			});
			const afterCursor = request.cursor
				? matched.findIndex(({ unit }) => unit.id === request.cursor) + 1
				: 0;
			const page = matched.slice(Math.max(0, afterCursor), afterCursor + request.pageSize);
			const final = page.at(-1)?.unit.id;
			return {
				total: matched.length,
				units: page.map(({ unit }) => searchResult(unit)),
				...(final !== undefined && afterCursor + page.length < matched.length
					? { nextCursor: final }
					: {})
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
				unit: searchResult(unit),
				...(final !== undefined &&
				afterCursor + occurrences.length < unit.occurrences.length
					? { nextOccurrenceCursor: final }
					: {})
			};
		}
	};
}
