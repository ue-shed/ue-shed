import type {
	TextCorpus,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextCorpusSearchCounts,
	TextCorpusSearchRequest,
	TextReviewLens,
	TextReviewSignal,
	TextUnit,
	TextUnitSearchResult
} from "./schema.js";
import { hasSearchableSource, searchableSourceText } from "./search.js";
import type {
	LocalizationJoin,
	LocalizationLine,
	LocalizationLineId
} from "./localization-schema.js";
import { GameTextLocalizationError } from "./localization-schema.js";
import { localizationManifestNotes } from "./localization.js";
import {
	localizationQueryPage,
	matchesLocalizationLine,
	validateLocalizationSelection
} from "./localization-query.js";

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

/**
 * In-memory, query-scoped view of a compact text corpus. It normalizes every unit once at refresh
 * time and emits only bounded pages to callers.
 */
export interface TextCorpusQuery {
	readonly localizationFocus: (id: LocalizationLineId) => LocalizationLine | undefined;
	readonly focus: (request: TextCorpusFocusRequest) => TextCorpusFocus | undefined;
	readonly search: (request: TextCorpusSearchRequest) => TextCorpusSearchPage;
	readonly export: (request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) => TextCorpus;
	readonly summary: () => TextCorpusQuerySummary;
}

export function textCorpusQuery(
	corpus: TextCorpus,
	scannedAt?: string,
	localization?: LocalizationJoin
): TextCorpusQuery {
	const units = [...corpus.units].sort((left, right) => left.id.localeCompare(right.id));
	const sourceFrequency = new Map<string, number>();
	for (const unit of units) {
		if (unit.source.status !== "consistent") continue;
		sourceFrequency.set(unit.source.value, (sourceFrequency.get(unit.source.value) ?? 0) + 1);
	}
	const duplicateSources = new Set(
		[...sourceFrequency].filter(([, count]) => count > 1).map(([source]) => source)
	);
	const indexed = units.filter(hasSearchableSource).map((unit) => ({
		presentation: searchResult(unit, duplicateSources),
		searchable: searchableSourceText(unit),
		hasEditable: unit.occurrences.some(
			(occurrence) => occurrence.editCapability === "source_editable"
		),
		hasReadOnly: unit.occurrences.some(
			(occurrence) => occurrence.editCapability === "read_only"
		),
		withoutNotes: unit.occurrences.every((occurrence) => occurrence.devNotes.trim() === ""),
		unit
	}));
	const byId = new Map(indexed.map((entry) => [entry.unit.id, entry]));
	const localizationByUnit = new Map(
		localization?.lines.flatMap((line) =>
			line.origin.kind === "corpus"
				? line.origin.unitIds.map(
						(id) => [id, line] satisfies [typeof id, LocalizationLine]
					)
				: []
		) ?? []
	);
	const diagnosticsByPackage = new Map<string, typeof corpus.diagnostics>();
	for (const diagnostic of corpus.diagnostics) {
		diagnosticsByPackage.set(diagnostic.packageFile, [
			...(diagnosticsByPackage.get(diagnostic.packageFile) ?? []),
			diagnostic
		]);
	}
	const matching = (request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) => {
		const terms = normalizedTerms(request.query);
		const counts = {
			all: 0,
			shared: 0,
			duplicate_source: 0,
			long: 0,
			unresolved: 0,
			conflicting: 0,
			editable: 0,
			readOnly: 0,
			withoutNotes: 0
		} satisfies TextCorpusSearchCounts;
		const matched: typeof indexed = [];
		for (const entry of indexed) {
			const { presentation, searchable, unit, hasEditable, hasReadOnly } = entry;
			if (!terms.every((term) => searchable.includes(term))) continue;
			const hasCapability =
				request.capability === "all"
					? unit.occurrences.length > 0
					: request.capability === "source_editable"
						? hasEditable
						: hasReadOnly;
			const noNotes = entry.withoutNotes;
			const hasNotesFilter = !request.withoutNotes || noNotes;
			const hasLens = matchesLens(presentation.reviewSignals, request.lens);
			if (hasLens && hasNotesFilter && hasEditable) counts.editable++;
			if (hasLens && hasNotesFilter && hasReadOnly) counts.readOnly++;
			if (hasLens && hasCapability && noNotes) counts.withoutNotes++;
			if (!hasCapability || !hasNotesFilter || !hasLens) continue;
			matched.push(entry);
			counts.all++;
			for (const signal of presentation.reviewSignals) {
				if (signal !== "evidence_only") counts[signal]++;
			}
		}
		return { matched, counts };
	};

	const baseline = matching({ query: "", capability: "all" }).counts;
	const localizedMatching = (request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) => {
		if (!localization || !request.localization)
			throw new GameTextLocalizationError({
				code: "invalid_selection",
				message: "Localization evidence has not been supplied to this query.",
				recovery:
					"Load and join the selected target before querying its localization state."
			});
		validateLocalizationSelection(localization, request.localization);
		const eligible = new Set(
			matching({ ...request, query: "" }).matched.map(({ unit }) => unit.id)
		);
		return localization.lines.filter((line) => {
			if (line.source.trim() === "") return false;
			if (
				line.origin.kind === "corpus" &&
				!line.origin.unitIds.some((id) => eligible.has(id))
			)
				return false;
			if (
				line.origin.kind === "evidence" &&
				(request.capability === "source_editable" ||
					(request.lens !== undefined && request.lens !== "all") ||
					(request.withoutNotes &&
						line.manifest.some((entry) => localizationManifestNotes(entry).length > 0)))
			)
				return false;
			return matchesLocalizationLine(line, request);
		});
	};
	const summary: TextCorpusQuerySummary = {
		counts: baseline,
		...(scannedAt === undefined ? undefined : { scannedAt }),
		searchable: {
			textUnits: baseline.all,
			textOccurrences: indexed.reduce((count, { unit }) => count + unit.occurrences.length, 0)
		},
		schemaVersion: 1,
		status: corpus.status,
		coverage: corpus.coverage,
		diagnosticCount: corpus.diagnostics.length,
		review: {
			all: baseline.all,
			shared: baseline.shared,
			duplicateSource: baseline.duplicate_source,
			long: baseline.long,
			unresolved: baseline.unresolved,
			conflicting: baseline.conflicting
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
		localizationFocus: (id) => localization?.lines.find((line) => line.id === id),
		export: (request) => {
			if (request.localization) {
				const ids = new Set(
					localizedMatching(request).flatMap((line) =>
						line.origin.kind === "corpus" ? line.origin.unitIds : []
					)
				);
				return { ...corpus, units: corpus.units.filter((unit) => ids.has(unit.id)) };
			}
			return { ...corpus, units: matching(request).matched.map(({ unit }) => unit) };
		},
		summary: () => summary,
		search: (request) => {
			if (request.localization) {
				if (!localization)
					throw new GameTextLocalizationError({
						code: "invalid_selection",
						message: "Localization evidence has not been supplied to this query.",
						recovery:
							"Load and join the selected target before querying its localization state."
					});
				const matched = localizedMatching(request);
				const page = localizationQueryPage(localization, matched, request);
				const counts = {
					...matching({ ...request, query: "" }).counts,
					all: matched.length,
					shared: 0,
					duplicate_source: 0,
					long: 0,
					unresolved: 0,
					conflicting: 0,
					editable: 0,
					readOnly: 0,
					withoutNotes: 0
				} satisfies TextCorpusSearchCounts;
				for (const line of matched) {
					if (line.origin.kind === "evidence") {
						counts.readOnly++;
						if (
							line.manifest.every(
								(entry) => localizationManifestNotes(entry).length === 0
							)
						)
							counts.withoutNotes++;
						continue;
					}
					const entries = line.origin.unitIds.flatMap((id) => {
						const entry = byId.get(id);
						return entry ? [entry] : [];
					});
					if (entries.some((entry) => entry.hasEditable)) counts.editable++;
					if (entries.some((entry) => entry.hasReadOnly)) counts.readOnly++;
					if (entries.every((entry) => entry.withoutNotes)) counts.withoutNotes++;
					for (const signal of new Set(
						entries.flatMap((entry) => entry.presentation.reviewSignals)
					))
						if (signal !== "evidence_only") counts[signal]++;
				}
				return {
					counts,
					total: matched.length,
					localization: page,
					units: page.lines.flatMap((line) => {
						if (line.origin.kind === "evidence") return [];
						const entry = line.origin.unitIds
							.flatMap((id) => {
								const item = byId.get(id);
								return item ? [item] : [];
							})
							.at(0);
						return entry
							? [{ ...entry.presentation, localization: line.cultures }]
							: [];
					})
				};
			}
			const { matched, counts } = matching(request);
			const afterCursor = request.cursor
				? matched.findIndex(({ unit }) => unit.id === request.cursor) + 1
				: 0;
			const page = matched.slice(Math.max(0, afterCursor), afterCursor + request.pageSize);
			const final = page.at(-1)?.unit.id;
			return {
				counts,
				total: matched.length,
				units: page.map(({ presentation }) => presentation),
				...(final !== undefined && afterCursor + page.length < matched.length
					? { nextCursor: final }
					: undefined)
			};
		},
		focus: (request) => {
			const entry = byId.get(request.id);
			if (!entry) return undefined;
			const { unit, presentation } = entry;
			const localized = localizationByUnit.get(unit.id);
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
				unit: presentation,
				...(localized === undefined ? undefined : { localization: localized }),
				...(final !== undefined &&
				afterCursor + occurrences.length < unit.occurrences.length
					? { nextOccurrenceCursor: final }
					: undefined)
			};
		}
	};
}
