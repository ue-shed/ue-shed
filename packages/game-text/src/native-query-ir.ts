/**
 * Builds the engine's `query` request from a search request: its `where`, the selected lines and
 * the changed files become the selection, and its groups and facets the parts.
 */
import type { GameTextContract } from "@ue-shed/protocol";
import type { TextCorpusSearchRequest, TextFacetRequest, TextGroupBy } from "./schema.js";

type Expr = GameTextContract.Expr;
type JsonValue = GameTextContract.JsonValue;
type QueryField = GameTextContract.QueryField;

/** The fields of a search request that choose its rows. */
export type QuerySelectionFields = Pick<TextCorpusSearchRequest, "query"> &
	Partial<
		Pick<TextCorpusSearchRequest, "where" | "fileScope" | "lines" | "localization" | "findings">
	>;

const field = (name: string): Expr => ({ field: name });
const item: Expr = { var: "item" };
/** A scalar field is one of the values. */
const oneOf = (name: string, values: readonly JsonValue[]): Expr => ({
	in: [field(name), { lit: values }]
});
/** A list field holds one of the values. */
const holds = (name: string, values: readonly JsonValue[]): Expr => ({
	any: [field(name), { in: [item, { lit: values }] }]
});
/**
 * A search request's rows as a query selection: its `where`, its lines, and a place in its
 * changed files.
 */
export const querySelection = (request: QuerySelectionFields): GameTextContract.QuerySelection => {
	const localization = request.localization;
	const conjuncts: Expr[] = [];
	if (request.where) conjuncts.push(request.where);
	if (request.lines) conjuncts.push(oneOf("id", request.lines));
	if (request.fileScope) conjuncts.push({ anyPlace: holds("files", request.fileScope) });
	const all = (tests: readonly Expr[]): Expr => (tests.length === 1 ? tests[0]! : { and: tests });
	return {
		...(localization && {
			target: localization.target,
			...(localization.culture !== undefined && { culture: localization.culture }),
			...(localization.cultures !== undefined && { cultures: localization.cultures })
		}),
		...(request.findings && { findings: request.findings }),
		...(conjuncts.length > 0 && { where: all(conjuncts) }),
		...(request.query.length > 0 && {
			text: {
				query: request.query,
				...(localization?.searchTranslations === true && { translations: true })
			}
		})
	};
};

/** The field each of a search request's groups is. */
const GROUP_FIELDS = {
	problem: "problems",
	folder: "paths",
	asset: "files",
	origin: "origins",
	namespace: "namespace",
	audience: "audience",
	source: "sources",
	finding: "findings"
} as const satisfies Record<TextGroupBy, QueryField>;

/** The field each of a search request's facets counts by, and the page's name for it. */
const FACET_FIELDS = [
	["assets", "files"],
	["origins", "origins"],
	["audiences", "audience"],
	["cultures", "cultures"],
	["assetTypes", "assetTypes"],
	["findings", "findings"],
	["facts", "facts"]
] as const satisfies ReadonlyArray<
	readonly [Exclude<keyof TextFacetRequest, "folder">, QueryField]
>;

/** A search request's facets as the query's list. Cultures are counted for a target's lines. */
const queryFacets = (
	facets: TextFacetRequest,
	localized: boolean
): GameTextContract.QueryFacet[] => [
	...(facets.folder !== undefined ? [{ by: "paths" as const, under: facets.folder }] : []),
	...FACET_FIELDS.filter(
		([name]) => facets[name] === true && (name !== "cultures" || localized)
	).map(([, by]) => ({ by }))
];

/** The query's facets, keyed by field, under a search page's names. */
const pageFacets = (facets: NonNullable<GameTextContract.QueryAnswer["facets"]>) => {
	const page: { [key: string]: JsonValue } = {};
	if (facets.paths !== undefined) page["folders"] = facets.paths;
	for (const [name, by] of FACET_FIELDS) {
		const value = facets[by];
		if (value !== undefined) page[name] = value;
	}
	return page;
};

/** The query's groups under a search page's group name. */
const pageGroups = (groups: NonNullable<GameTextContract.QueryAnswer["groups"]>) => {
	const by = Object.entries(GROUP_FIELDS).find(([, field]) => field === groups.by)?.[0];
	return by === undefined ? groups : { ...groups, by };
};

/**
 * A search request as a query: its rows, or the open groups' first rows, and with `aggregates`
 * the counts, facets and groups.
 */
export const searchQuery = (
	request: TextCorpusSearchRequest,
	aggregates: boolean
): GameTextContract.Query => {
	const after = request.localization ? request.localizationCursor : request.cursor;
	const group = request.group === undefined ? undefined : GROUP_FIELDS[request.group];
	const open = request.openGroups;
	return {
		selection: querySelection(request),
		parts: {
			...(open !== undefined && group !== undefined
				? { openGroups: { by: group, keys: open, firstRows: request.firstRows ?? 50 } }
				: {
						rows: {
							limit: request.pageSize,
							...(after !== undefined && { after }),
							...(group !== undefined &&
								request.openGroup !== undefined && {
									group: { by: group, key: request.openGroup }
								})
						}
					}),
			...(aggregates && {
				counts: true,
				...(request.facets && {
					facets: queryFacets(request.facets, request.localization !== undefined)
				}),
				...(group !== undefined && {
					groups: {
						by: group,
						...(request.minGroupSize !== undefined && { minSize: request.minGroupSize })
					}
				}),
				...(request.fileScope && { fileScope: request.fileScope })
			})
		}
	};
};

type Row = { readonly [key: string]: JsonValue };

/**
 * A query's answer as the page a search returns: the rows part's units and lines, and each open
 * group's rows in its page. With open groups the page's own rows are empty.
 */
export const searchPage = (
	request: TextCorpusSearchRequest,
	head: GameTextContract.QueryAnswer,
	rows: (part: string) => readonly Row[]
) => {
	const target = request.localization?.target;
	const assemble = (
		page: Omit<GameTextContract.QueryAnswer, "openGroups">,
		units: readonly Row[],
		lines: readonly Row[]
	) => {
		const { nextCursor, localization, facets, groups, ...counted } = page;
		const rest = {
			...counted,
			...(facets !== undefined && { facets: pageFacets(facets) }),
			...(groups !== undefined && { groups: pageGroups(groups) })
		};
		const next = nextCursor === undefined ? undefined : { nextCursor };
		return target === undefined
			? { ...rest, ...next, units }
			: { ...rest, localization: { ...(localization ?? { target }), lines, ...next }, units };
	};
	const grouped = (part: string) => {
		const byGroup = new Map<number, Row[]>();
		for (const { parent, ...row } of rows(part)) {
			const listed = byGroup.get(Number(parent));
			if (listed) listed.push(row);
			else byGroup.set(Number(parent), [row]);
		}
		return byGroup;
	};
	const { openGroups, ...page } = head;
	const answer = assemble(page, rows("units"), rows("lines"));
	if (openGroups === undefined) return answer;
	const units = grouped("groupUnits");
	const lines = grouped("groupLines");
	return {
		...answer,
		openGroups: openGroups.map(({ nextCursor, ...group }, index) =>
			group.rowsOmitted
				? group
				: {
						...group,
						page: assemble(
							nextCursor === undefined ? {} : { nextCursor },
							units.get(index) ?? [],
							lines.get(index) ?? []
						)
					}
		)
	};
};
