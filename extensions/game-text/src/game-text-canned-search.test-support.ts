import {
	makeTextUnitId,
	type LocalizationJoin,
	type LocalizationLine,
	type LocalizationLinePreview,
	type LocalizationQueryPage,
	type LocalizationSelection,
	type TextCorpus,
	type TextCorpusFocus,
	type TextCorpusFocusRequest,
	type TextCorpusQuerySummary,
	type TextCorpusRows,
	type TextCorpusSearchCounts,
	type TextCorpusSearchPage,
	type TextCorpusSearchRequest,
	type TextFacets,
	type TextFileScopeSummary,
	type TextFilter,
	type TextGroup,
	type TextGroupBy,
	type TextGroupList,
	type TextOpenGroupRows,
	type TextProblemCounts,
	type TextUnitSearchResult,
	type TextWhere
} from "@ue-shed/game-text/schema";
import { Effect } from "effect";
import type { GameTextClientApi } from "./game-text-client.js";

/** A row a canned search lists: its unit, its line with a target, and its group by grouping. */
export interface CannedRow {
	readonly unit?: TextUnitSearchResult;
	readonly line?: LocalizationLinePreview;
	readonly groups?: Partial<Record<TextGroupBy, string>>;
}

/** The requests an answer serves: those with this query, filter, files and selection. */
export interface CannedWhen {
	readonly query?: string;
	readonly filter?: TextFilter;
	readonly where?: TextWhere;
	/** The selection fields the requests share; absent for requests without a target. */
	readonly localization?: Partial<LocalizationSelection>;
}

/** One planted answer: the rows in order, and the aggregates every page of it carries. */
export interface CannedAnswer {
	readonly when?: CannedWhen;
	readonly rows: readonly CannedRow[];
	readonly counts: TextCorpusSearchCounts;
	readonly groups?: Partial<Record<TextGroupBy, readonly TextGroup[]>>;
	readonly problems?: TextProblemCounts;
	readonly facets?: TextFacets;
	/** The folder facet, by the folder it lists. */
	readonly folders?: Readonly<Record<string, TextGroupList>>;
	readonly fileScope?: TextFileScopeSummary;
	readonly localization?: Omit<LocalizationQueryPage, "target" | "nextCursor" | "lines">;
}

/**
 * A search row for the editable String Table entry `localization.test-support`'s `unit` plants:
 * the key's entry in /Game/Text/Table.Table, with nothing to do.
 */
export function tableRow(key: string, source: string, namespace = "NS"): TextUnitSearchResult {
	return {
		id: makeTextUnitId(`unit:${key}`),
		identity: { status: "resolved", namespace, key },
		source: { status: "consistent", value: source },
		contexts: [
			{
				editCapability: "source_editable",
				location: {
					kind: "string_table_entry",
					objectPath: "/Game/Text/Table.Table",
					entryKey: key
				}
			}
		],
		locationKinds: ["string_table_entry"],
		characterCount: source.length,
		wordCount: source.split(" ").length,
		occurrenceCount: 1,
		remainingContextCount: 0,
		reviewSignals: [],
		audience: "player",
		problems: ["up_to_date"]
	};
}

/**
 * A joined line as a page lists it: its own identity and culture marks, with the translations,
 * manifest places and problems the test plants.
 */
export function linePreview(
	line: LocalizationLine,
	planted: {
		readonly translations?: Readonly<Record<string, string>>;
		readonly manifestLocations?: readonly string[];
		readonly problems: NonNullable<LocalizationLinePreview["problems"]>;
	}
): LocalizationLinePreview {
	return {
		id: line.id,
		origin: line.origin,
		identity: line.identity,
		source: line.source,
		manifestLocations: planted.manifestLocations ?? [],
		remainingLocationCount: 0,
		...(line.keyChange ? { keyChange: line.keyChange } : undefined),
		...(line.audience ? { audience: line.audience } : undefined),
		cultures: line.cultures.map(
			({ archive: _archive, po: _po, poTranslation: _poTranslation, ...mark }) => ({
				...mark,
				translation: planted.translations?.[mark.culture] ?? null
			})
		),
		problems: planted.problems
	};
}

/** A one-page search listing these rows, with nothing counted beyond them. */
export function pageOf(units: readonly TextUnitSearchResult[]): TextCorpusSearchPage {
	return {
		counts: {
			all: units.length,
			unresolved: 0,
			conflicting: 0,
			editable: 0,
			readOnly: 0,
			withoutNotes: 0,
			origins: { string_table: 0, data_table: 0, asset: 0, cpp: 0, other_source: 0 }
		},
		total: units.length,
		units
	};
}

const same = (
	left: TextFilter | TextWhere | LocalizationSelection | undefined,
	right: TextFilter | TextWhere | LocalizationSelection | undefined
) => JSON.stringify(left) === JSON.stringify(right);

/** Whether an answer serves a request: equal narrowing, and the selection fields it names. */
const serves = ({ when = {} }: CannedAnswer, request: TextCorpusSearchRequest) =>
	request.query === (when.query ?? "") &&
	same(request.filter, when.filter) &&
	same(request.where, when.where) &&
	(when.localization === undefined
		? request.localization === undefined
		: request.localization !== undefined &&
			same({ ...request.localization, ...when.localization }, request.localization));

/** The page after a cursor: the rows after the one with that ID, and the cursor past them. */
function pageAfter<T, Id extends string>(
	rows: readonly T[],
	id: (row: T) => Id | undefined,
	cursor: Id | undefined,
	size: number
) {
	const start = cursor === undefined ? 0 : rows.findIndex((row) => id(row) === cursor) + 1;
	const page = rows.slice(start, start + size);
	const last = page.at(-1);
	return {
		page,
		next: last !== undefined && start + page.length < rows.length ? id(last) : undefined
	};
}

/**
 * A search page from the planted answer serving the request: the open group's rows or every
 * row, paged by cursor, with the answer's aggregates. A request no answer serves dies, naming it.
 */
export function cannedPage(
	answers: readonly CannedAnswer[],
	request: TextCorpusSearchRequest
): TextCorpusSearchPage {
	const answer = answers.find((candidate) => serves(candidate, request));
	if (!answer)
		throw new Error(
			"No planted answer for " +
				JSON.stringify({
					query: request.query,
					filter: request.filter,
					where: request.where,
					localization: request.localization
				})
		);
	const listed =
		request.group === undefined || request.openGroup === undefined
			? answer.rows
			: answer.rows.filter((row) => row.groups?.[request.group!] === request.openGroup);
	const groups = request.group === undefined ? undefined : answer.groups?.[request.group];
	const folders = answer.folders?.[request.facets?.folder ?? ""];
	const aggregates = {
		counts: answer.counts,
		total: answer.rows.length,
		...(answer.problems ? { problems: answer.problems } : undefined),
		...(groups && request.group
			? { groups: { by: request.group, entries: groups, more: 0 } }
			: undefined),
		...(request.facets && answer.facets
			? {
					facets: {
						...answer.facets,
						...(folders
							? { folders: { under: request.facets.folder ?? "", ...folders } }
							: undefined)
					}
				}
			: undefined),
		...(request.where && answer.fileScope ? { fileScope: answer.fileScope } : undefined)
	};
	if (request.localization) {
		const lines = listed.filter((row) => row.line !== undefined);
		const { page, next } = pageAfter(
			lines,
			(row) => row.line?.id,
			request.localizationCursor,
			request.pageSize
		);
		return {
			...aggregates,
			units: page.flatMap((row) =>
				row.unit
					? [
							{
								...row.unit,
								localization: row.line!.cultures,
								...(row.line!.problems
									? { problems: row.line!.problems }
									: undefined)
							}
						]
					: []
			),
			localization: {
				...answer.localization!,
				target: request.localization.target,
				lines: page.map((row) => row.line!),
				...(next === undefined ? undefined : { nextCursor: next })
			}
		};
	}
	const { page, next } = pageAfter(
		listed.filter((row) => row.unit !== undefined),
		(row) => row.unit?.id,
		request.cursor,
		request.pageSize
	);
	return {
		...aggregates,
		units: page.map((row) => row.unit!),
		...(next === undefined ? undefined : { nextCursor: next })
	};
}

/** A search page's rows, as a rows read returns them. */
function searchPageRows(page: TextCorpusSearchPage): TextCorpusRows {
	return {
		units: page.units,
		...(page.nextCursor === undefined ? undefined : { nextCursor: page.nextCursor }),
		...(page.localization
			? {
					localization: {
						target: page.localization.target,
						lines: page.localization.lines,
						...(page.localization.nextCursor === undefined
							? undefined
							: { nextCursor: page.localization.nextCursor })
					}
				}
			: undefined)
	};
}

/**
 * Rows reads answered from a client's `search`, as the engine answers them: each open group's
 * first page from an `openGroup` read, within the 500-row budget. A group whose read fails is
 * omitted, so the host reads it alone and shows that failure.
 */
export function searchRowsFrom(
	search: GameTextClientApi["search"]
): GameTextClientApi["searchRows"] {
	return (request) =>
		Effect.gen(function* () {
			const { openGroups, firstRows, ...base } = request;
			if (openGroups === undefined) {
				const result = yield* search(base);
				return result.status === "ready"
					? { status: "ready" as const, page: searchPageRows(result.page) }
					: result;
			}
			let budget = 500;
			const groups: TextOpenGroupRows[] = [];
			for (const key of openGroups) {
				const result = yield* search({
					...base,
					openGroup: key,
					pageSize: firstRows ?? 50
				});
				const page = result.status === "ready" ? searchPageRows(result.page) : undefined;
				const rows = page ? (page.localization?.lines.length ?? page.units.length) : 0;
				if (!page || rows > budget) {
					if (page) budget = 0;
					groups.push({ key, rowsOmitted: true });
					continue;
				}
				budget -= rows;
				groups.push({ key, page });
			}
			return {
				status: "ready" as const,
				page: {
					units: [],
					...(base.localization
						? { localization: { target: base.localization.target, lines: [] } }
						: undefined),
					openGroups: groups
				}
			};
		});
}

/** A client's `search` and `searchRows`, answered from planted answers. */
export function cannedSearch(
	answers: readonly CannedAnswer[]
): Pick<GameTextClientApi, "search" | "searchRows"> {
	const search: GameTextClientApi["search"] = (request) =>
		Effect.sync(() => ({ status: "ready" as const, page: cannedPage(answers, request) }));
	return { search, searchRows: searchRowsFrom(search) };
}

/**
 * A client's `focus`, answered from planted focuses: the line's focus when the request names a
 * line, else the unit's, its places paged by cursor.
 */
export function cannedFocus(
	focuses: readonly (TextCorpusFocus & { readonly line?: LocalizationLinePreview["id"] })[]
): GameTextClientApi["focus"] {
	return (request: TextCorpusFocusRequest) =>
		Effect.sync(() => {
			const found = focuses.find(
				(focus) =>
					focus.unit.id === request.id &&
					(request.localization === undefined || focus.line === request.localization.id)
			);
			if (!found) return { status: "not_found" as const };
			const { line: _line, ...focus } = found;
			const { page, next } = pageAfter(
				focus.occurrences,
				(occurrence) => occurrence.id,
				request.occurrenceCursor,
				request.pageSize
			);
			return {
				status: "found" as const,
				focus: {
					...focus,
					occurrences: page,
					...(next === undefined ? undefined : { nextOccurrenceCursor: next })
				}
			};
		});
}

/**
 * Text reads for `qualityFixture`'s one line, K0: its German translation needs an update, so the
 * line needs translation work under the target.
 */
export function qualityFixtureText(fixture: {
	readonly text: TextCorpus;
	readonly join: LocalizationJoin;
}): Pick<GameTextClientApi, "search" | "searchRows" | "focus"> & {
	readonly summary: TextCorpusQuerySummary;
} {
	const [line] = fixture.join.lines;
	const [text] = fixture.text.units;
	if (!line || !text) throw new Error("Missing fixture line.");
	const unit = { ...tableRow("K0", "Hello {PlayerName}"), problems: ["translation" as const] };
	const preview = linePreview(line, {
		translations: { en: "Hallo {Name}", de: "Hallo {Name}" },
		manifestLocations: ["/Game/Text/Table.Table"],
		problems: ["translation"]
	});
	const counts = { ...pageOf([unit]).counts, editable: 1, withoutNotes: 1 };
	const group = (key: "translation" | "up_to_date", label: string) => ({
		problem: [{ key, label, count: 1, needWork: key === "up_to_date" ? 0 : 1, worst: key }]
	});
	const focus = { diagnostics: [], occurrences: text.occurrences, totalOccurrences: 1 };
	return {
		summary: {
			counts,
			searchable: { textUnits: 1, textOccurrences: 1 },
			schemaVersion: 1,
			status: "complete",
			coverage: fixture.text.coverage,
			diagnosticCount: 0,
			review: { all: 1, unresolved: 0, conflicting: 0 },
			sources: { assetProperty: 0, dataTable: 0, mixed: 0, stringTable: 1 }
		},
		...cannedSearch([
			{
				when: { localization: {} },
				rows: [{ unit, line: preview, groups: { problem: "translation" } }],
				counts,
				groups: group("translation", "Translation work"),
				localization: {
					counts: [],
					stateCounts: {
						translated: 1,
						not_translated: 0,
						needs_update: 1,
						not_synced: 0,
						not_gathered: 0,
						changed_since_gather: 0,
						not_found: 0,
						gathered_only: 0,
						outside_target: 0,
						unknown: 0
					},
					notSynced: 0
				}
			},
			{
				rows: [
					{
						unit: tableRow("K0", "Hello {PlayerName}"),
						groups: { problem: "up_to_date" }
					}
				],
				counts,
				groups: group("up_to_date", "Up to date")
			}
		]),
		focus: cannedFocus([
			{ ...focus, unit: tableRow("K0", "Hello {PlayerName}") },
			{ ...focus, unit, localization: preview, line: preview.id }
		])
	};
}
