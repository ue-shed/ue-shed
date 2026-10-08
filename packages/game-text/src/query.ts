import type {
	TextCorpus,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextCorpusSearchCounts,
	TextCorpusSearchRequest,
	TextCultureFacet,
	TextEditing,
	TextFacetRequest,
	TextFilter,
	TextFilterField,
	TextReviewLens,
	TextReviewSignal,
	TextUnit,
	TextUnitSearchResult,
	TextWhere
} from "./schema.js";
import {
	textAssetFacet,
	textCultureFacet,
	textFolderFacet,
	textGroupOf,
	textGroups,
	textOriginFacet
} from "./text-groups.js";
import {
	matchesTextFilter,
	textFindings,
	textProblemCounts,
	textProblems,
	translationStates,
	type TextFacts
} from "./text-problems.js";
import { hasSearchableSource, searchableSourceText } from "./search.js";
import {
	emptyTextOriginCounts,
	manifestFileKeys,
	manifestOrigins,
	matchesTextFiles,
	matchesTextKinds,
	matchesTextPathPrefix,
	normalizeTextPath,
	textFileLabel,
	textFileScope,
	textFileScopeSummary,
	unitFileKeys,
	unitOrigins,
	unitPaths,
	type TextFileScope
} from "./text-origin.js";
import type {
	LocalizationJoin,
	LocalizationLine,
	LocalizationLineId,
	LocalizationSelection
} from "./localization-schema.js";
import { GameTextLocalizationError } from "./localization-schema.js";
import { localizationManifestNotes } from "./localization.js";
import {
	localizationQueryPage,
	matchesLocalizationLine,
	scopedLocalizationMarks,
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
	/** Every localization line the request matches, unpaged, for exports. */
	readonly localizationLines: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => readonly LocalizationLine[];
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
	const indexed = units.filter(hasSearchableSource).map((unit) => {
		const presentation = searchResult(unit, duplicateSources);
		const hasEditable = unit.occurrences.some(
			(occurrence) => occurrence.editCapability === "source_editable"
		);
		const hasReadOnly = unit.occurrences.some(
			(occurrence) => occurrence.editCapability === "read_only"
		);
		const withoutNotes = unit.occurrences.every(
			(occurrence) => occurrence.devNotes.trim() === ""
		);
		const origins = unitOrigins(unit);
		const paths = unitPaths(unit);
		const editing: TextEditing[] = [
			...(hasEditable ? ["editable" as const] : []),
			...(hasReadOnly ? ["read_only" as const] : [])
		];
		// Without a localization target a unit's problems come from its own review signals.
		const facts: TextFacts = {
			problems: textProblems({ signals: presentation.reviewSignals, keyChanged: false }),
			findings: textFindings(presentation.reviewSignals),
			translation: [],
			origins,
			paths,
			files: [
				...new Set(
					unit.occurrences.map((occurrence) => textFileLabel(occurrence.packageFile))
				)
			],
			namespace:
				unit.identity.status === "resolved"
					? unit.identity.namespace
					: unit.identity.status === "string_table"
						? unit.identity.tableId
						: undefined,
			editing,
			notes: withoutNotes ? "missing" : "present"
		};
		return {
			presentation,
			searchable: searchableSourceText(unit),
			hasEditable,
			hasReadOnly,
			withoutNotes,
			origins,
			paths,
			editing,
			facts,
			fileKeys: unitFileKeys(unit),
			unit
		};
	});
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
			withoutNotes: 0,
			origins: emptyTextOriginCounts()
		} satisfies TextCorpusSearchCounts;
		const matched: typeof indexed = [];
		const files = textFileScope(request.where?.files);
		for (const entry of indexed) {
			const { presentation, searchable, unit, hasEditable, hasReadOnly } = entry;
			if (!terms.every((term) => searchable.includes(term))) continue;
			if (!matchesTextFilter(entry.facts, request.filter)) continue;
			if (!matchesTextPathPrefix(entry.paths, request.where?.pathPrefix)) continue;
			if (!matchesTextFiles(entry.fileKeys, files)) continue;
			const inKinds = matchesTextKinds(entry.origins, request.where?.kinds);
			const hasCapability =
				request.capability === "all"
					? unit.occurrences.length > 0
					: request.capability === "source_editable"
						? hasEditable
						: hasReadOnly;
			const noNotes = entry.withoutNotes;
			const hasNotesFilter = !request.withoutNotes || noNotes;
			const hasLens = matchesLens(presentation.reviewSignals, request.lens);
			if (hasLens && hasNotesFilter && inKinds && hasEditable) counts.editable++;
			if (hasLens && hasNotesFilter && inKinds && hasReadOnly) counts.readOnly++;
			if (hasLens && hasCapability && inKinds && noNotes) counts.withoutNotes++;
			if (hasLens && hasCapability && hasNotesFilter)
				for (const origin of entry.origins) counts.origins[origin]++;
			if (!hasCapability || !hasNotesFilter || !hasLens || !inKinds) continue;
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
		const selection = request.localization;
		// Filter clauses ask about lines, so units qualify without them.
		const { filter, ...unfiltered } = request;
		const eligible = new Set(
			matching({ ...unfiltered, query: "" }).matched.map(({ unit }) => unit.id)
		);
		const files = textFileScope(request.where?.files);
		return localization.lines.filter((line) => {
			if (filter !== undefined && !matchesTextFilter(lineFacts(line, selection), filter))
				return false;
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
						line.manifest.some(
							(entry) => localizationManifestNotes(entry).length > 0
						)) ||
					!evidenceMatchesWhere(line, request.where, files))
			)
				return false;
			return matchesLocalizationLine(line, request);
		});
	};
	// Evidence-only lines have no saved occurrence; their gathered manifest paths say where they live.
	const evidenceMatchesWhere = (
		line: LocalizationLine,
		where: TextWhere | undefined,
		files: TextFileScope | undefined
	) => {
		if (where === undefined) return true;
		const paths = line.manifest.map((entry) => entry.path);
		return (
			matchesTextKinds(manifestOrigins(paths), where.kinds) &&
			matchesTextPathPrefix(paths.map(normalizeTextPath), where.pathPrefix) &&
			matchesTextFiles(manifestFileKeys(paths), files)
		);
	};
	const lineFileKeys = (line: LocalizationLine) =>
		line.origin.kind === "evidence"
			? manifestFileKeys(line.manifest.map((entry) => entry.path))
			: line.origin.unitIds.flatMap((id) => byId.get(id)?.fileKeys ?? []);
	const scannedPackages = corpus.packageCoverage?.map((coverage) => coverage.packageFile);
	const fileScopeField = (where: TextWhere | undefined, keys: () => Iterable<string>) => {
		const scope = textFileScope(where?.files);
		return scope === undefined
			? undefined
			: { fileScope: textFileScopeSummary(scope, keys(), scannedPackages) };
	};
	const lineOrigins = (line: LocalizationLine) =>
		line.origin.kind === "evidence"
			? manifestOrigins(line.manifest.map((entry) => entry.path))
			: [...new Set(line.origin.unitIds.flatMap((id) => byId.get(id)?.origins ?? []))];
	const lineEntries = (line: LocalizationLine) =>
		line.origin.kind === "evidence"
			? []
			: line.origin.unitIds.flatMap((id) => {
					const entry = byId.get(id);
					return entry ? [entry] : [];
				});
	const lineSignals = (entries: ReturnType<typeof lineEntries>) => [
		...new Set(entries.flatMap((entry) => entry.presentation.reviewSignals))
	];
	// Counting needs only the problems, so it skips the paths, origins and notes a filter reads.
	const lineProblems = (line: LocalizationLine, selection: LocalizationSelection) =>
		textProblems({
			signals: lineSignals(lineEntries(line)),
			keyChanged: line.keyChange?.direction === "to",
			marks: scopedLocalizationMarks(line, selection)
		});
	function lineFacts(line: LocalizationLine, selection: LocalizationSelection): TextFacts {
		const entries = lineEntries(line);
		const signals = lineSignals(entries);
		const marks = scopedLocalizationMarks(line, selection);
		const manifestPaths = line.manifest.map((entry) => normalizeTextPath(entry.path));
		const evidence = line.origin.kind === "evidence";
		return {
			problems: textProblems({
				signals,
				keyChanged: line.keyChange?.direction === "to",
				marks
			}),
			findings: textFindings(signals),
			translation: translationStates(marks),
			origins: lineOrigins(line),
			paths: [...entries.flatMap((entry) => entry.paths), ...manifestPaths],
			files: evidence
				? [...new Set(line.manifest.map((entry) => textFileLabel(entry.path)))]
				: [...new Set(entries.flatMap((entry) => entry.facts.files))],
			namespace: line.identity?.namespace,
			editing: evidence
				? ["read_only"]
				: [...new Set(entries.flatMap((entry) => entry.editing))],
			notes: (
				evidence
					? line.manifest.every((entry) => localizationManifestNotes(entry).length === 0)
					: entries.every((entry) => entry.withoutNotes)
			)
				? "missing"
				: "present"
		};
	}
	const hasClause = (filter: TextFilter | undefined, field: TextFilterField) =>
		filter?.some((clause) => clause.field === field) ?? false;
	/** The request without one field's clauses, so that field's counts do not narrow themselves. */
	const without = (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">,
		field: TextFilterField
	): Omit<TextCorpusSearchRequest, "cursor" | "pageSize"> => {
		const { filter, ...unfiltered } = request;
		const rest = filter?.filter((clause) => clause.field !== field);
		return rest === undefined || rest.length === 0
			? unfiltered
			: { ...unfiltered, filter: rest };
	};
	type Facts = readonly TextFacts[];
	const facetsField = (
		wanted: TextFacetRequest | undefined,
		base: (field: TextFilterField) => Facts,
		cultures?: () => readonly TextCultureFacet[]
	) => {
		if (wanted === undefined) return undefined;
		return {
			facets: {
				...(wanted.folder === undefined
					? undefined
					: {
							folders: {
								under: wanted.folder,
								...textFolderFacet(base("folder"), wanted.folder)
							}
						}),
				...(wanted.assets ? { assets: textAssetFacet(base("asset")) } : undefined),
				...(wanted.origins ? { origins: textOriginFacet(base("origin")) } : undefined),
				...(wanted.cultures && cultures !== undefined
					? { cultures: cultures() }
					: undefined)
			}
		};
	};
	// Translation work only exists against a localization target.
	const requireTarget = (request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) => {
		if (
			!request.localization &&
			request.filter?.some((clause) => clause.field === "translation")
		)
			throw new GameTextLocalizationError({
				code: "invalid_selection",
				message: "Translation filters need a localization target.",
				recovery: "Select a localization target, or remove the translation filter."
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
		localizationLines: (request) => localizedMatching(request),
		export: (request) => {
			requireTarget(request);
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
			requireTarget(request);
			const group = request.group;
			const selection = request.localization;
			if (selection) {
				if (!localization)
					throw new GameTextLocalizationError({
						code: "invalid_selection",
						message: "Localization evidence has not been supplied to this query.",
						recovery:
							"Load and join the selected target before querying its localization state."
					});
				const matched = localizedMatching(request);
				// Without a clause on a field, that field's counts cover exactly the matched lines.
				const baseFor = (field: TextFilterField) =>
					hasClause(request.filter, field)
						? localizedMatching(without(request, field))
						: matched;
				const problems = textProblemCounts(
					baseFor("problem").map((line) => lineProblems(line, selection))
				);
				const known = new Map<LocalizationLine, TextFacts>();
				const factsOf = (line: LocalizationLine) => {
					const cached = known.get(line);
					if (cached !== undefined) return cached;
					const facts = lineFacts(line, selection);
					known.set(line, facts);
					return facts;
				};
				const listed =
					group === undefined || request.openGroup === undefined
						? matched
						: matched.filter(
								(line) =>
									textGroupOf(factsOf(line), group).key === request.openGroup
							);
				// The culture picker counts every culture, so it leaves the culture set out.
				const cultureBase = () => {
					const { cultures: _cultures, ...unscoped } = selection;
					return selection.cultures === undefined
						? matched
						: localizedMatching({ ...request, localization: unscoped });
				};
				const grouping =
					group === undefined
						? undefined
						: { groups: { by: group, ...textGroups(matched.map(factsOf), group) } };
				const faceted = facetsField(
					request.facets,
					(field) => baseFor(field).map(factsOf),
					() =>
						textCultureFacet(
							cultureBase().map((line) => line.cultures),
							localization.cultures
						)
				);
				const page = localizationQueryPage(localization, matched, request, listed);
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
					withoutNotes: 0,
					origins: emptyTextOriginCounts()
				} satisfies TextCorpusSearchCounts;
				const { kinds: _kinds, ...withoutKinds } = request.where ?? {};
				const originBase =
					request.where?.kinds === undefined
						? matched
						: localizedMatching({ ...request, where: withoutKinds });
				for (const line of originBase)
					for (const origin of lineOrigins(line)) counts.origins[origin]++;
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
					problems,
					...grouping,
					...faceted,
					total: matched.length,
					localization: page,
					...fileScopeField(request.where, () => matched.flatMap(lineFileKeys)),
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
			const baseFor = (field: TextFilterField) =>
				hasClause(request.filter, field)
					? matching(without(request, field)).matched
					: matched;
			const listed =
				group === undefined || request.openGroup === undefined
					? matched
					: matched.filter(
							(entry) => textGroupOf(entry.facts, group).key === request.openGroup
						);
			const afterCursor = request.cursor
				? listed.findIndex(({ unit }) => unit.id === request.cursor) + 1
				: 0;
			const page = listed.slice(Math.max(0, afterCursor), afterCursor + request.pageSize);
			const final = page.at(-1)?.unit.id;
			return {
				counts,
				problems: textProblemCounts(
					baseFor("problem").map((entry) => entry.facts.problems)
				),
				...(group === undefined
					? undefined
					: {
							groups: {
								by: group,
								...textGroups(
									matched.map((entry) => entry.facts),
									group
								)
							}
						}),
				...facetsField(request.facets, (field) =>
					baseFor(field).map((entry) => entry.facts)
				),
				total: matched.length,
				units: page.map(({ presentation }) => presentation),
				...fileScopeField(request.where, () => matched.flatMap(({ fileKeys }) => fileKeys)),
				...(final !== undefined && afterCursor + page.length < listed.length
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
