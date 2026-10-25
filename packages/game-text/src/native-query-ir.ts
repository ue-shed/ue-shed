/**
 * Builds the engine's `query` request from a search request: filter pills, the location scope
 * and the localization lens become a `where` in the rule IR, with facet marks on the conjuncts a
 * facet's counts drop. Saved documents keep their search requests; this is how they reach the
 * engine.
 */
import type { GameTextContract } from "@ue-shed/protocol";
import type { TextCorpusSearchRequest, TextFilterClause } from "./schema.js";

type Expr = GameTextContract.Expr;
type JsonValue = GameTextContract.JsonValue;
type QueryFacet = GameTextContract.QueryFacet;

/** The fields of a search request that choose its rows. */
export type QuerySelectionFields = Pick<TextCorpusSearchRequest, "query" | "capability"> &
	Partial<
		Pick<
			TextCorpusSearchRequest,
			"withoutNotes" | "where" | "filter" | "lines" | "localization" | "findings"
		>
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
const is = (name: string, value: boolean): Expr => ({ eq: [field(name), { lit: value }] });
const all = (tests: readonly Expr[]): Expr => (tests.length === 1 ? tests[0]! : { and: tests });
const some = (tests: readonly Expr[]): Expr => (tests.length === 1 ? tests[0]! : { or: tests });
const marked = (facet: QueryFacet, test: Expr): Expr => ({ facet: [facet, test] });
const under = (prefixes: readonly string[]): Expr => ({
	any: [
		field("paths"),
		some(prefixes.map((prefix) => ({ pathHasPrefix: [item, { lit: prefix }] })))
	]
});

const STATES = {
	missing: "not_translated",
	to_update: "needs_update",
	not_synced: "not_synced"
} as const;

/**
 * One pill: `is` holds when the row has one of the values, `is_not` when it has none. The facets'
 * own pills carry their mark.
 */
const pill = (clause: TextFilterClause): Expr => {
	const test = (expr: Expr): Expr => (clause.op === "is" ? expr : { not: expr });
	switch (clause.field) {
		case "problem":
			return marked("problem", test(holds("problems", clause.values)));
		case "finding":
			return marked("finding", test(holds("findings", clause.values)));
		case "fact":
			return marked("fact", test(holds("facts", clause.values)));
		case "origin":
			return marked("origin", test(holds("origins", clause.values)));
		case "folder":
			return marked("folder", test(under(clause.values)));
		case "asset":
			return marked("asset", test(holds("files", clause.values)));
		case "audience":
			return marked("audience", test(oneOf("audience", clause.values)));
		case "asset_type":
			return marked("assetType", test(holds("assetTypes", clause.values)));
		case "namespace":
			return test(oneOf("namespace", clause.values));
		case "editing":
			return test(holds("editing", clause.values));
		case "notes":
			return test(
				oneOf(
					"notes",
					clause.values.map((value) => value === "present")
				)
			);
		case "translation_key":
			// Each value is a validated `JSON.stringify([namespace, key])`.
			return test(
				oneOf(
					"translationKey",
					clause.values.map((value): JsonValue => JSON.parse(value))
				)
			);
		case "source":
			return test(holds("sources", clause.values));
		case "translation":
			// A culture of the scope has no translation, an old one, or one not in Unreal.
			return test({
				anyCulture: some([
					oneOf(
						"state",
						clause.values.map((value) => STATES[value])
					),
					...(clause.values.includes("not_synced") ? [is("notSynced", true)] : [])
				])
			});
	}
};

/**
 * A search request's rows as a query selection. The capability, translator-notes and location
 * filters must hold on one place together; the counts' tabs drop their marks.
 */
export const querySelection = (request: QuerySelectionFields): GameTextContract.QuerySelection => {
	const localization = request.localization;
	const conjuncts: Expr[] = (request.filter ?? []).map(pill);
	if (request.lines) conjuncts.push(oneOf("id", request.lines));
	if (localization?.state)
		conjuncts.push({
			anyCulture:
				localization.state === "not_synced"
					? is("notSynced", true)
					: oneOf("state", [localization.state])
		});
	if (localization?.review)
		conjuncts.push({ anyCulture: holds("review", [localization.review]) });
	if (localization?.keyChanged === true) conjuncts.push(is("keyChanged", true));
	const place: Expr[] = [];
	if (request.capability !== "all")
		place.push(
			marked(
				"capability",
				holds("editing", [
					request.capability === "source_editable" ? "editable" : "read_only"
				])
			)
		);
	if (request.withoutNotes === true) place.push(marked("withoutNotes", is("notes", false)));
	const where = request.where;
	if (where?.kinds) place.push(marked("kinds", holds("origins", where.kinds)));
	if (where?.pathPrefix) place.push(under([where.pathPrefix]));
	if (where?.files) place.push(holds("files", where.files));
	if (place.length > 0) conjuncts.push({ anyPlace: all(place) });
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

/**
 * A search request as a query: its rows, or the open groups' first rows, and with `aggregates`
 * the counts, facets and groups.
 */
export const searchQuery = (
	request: TextCorpusSearchRequest,
	aggregates: boolean
): GameTextContract.Query => {
	const after = request.localization ? request.localizationCursor : request.cursor;
	const group = request.group;
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
				...(request.facets && { facets: request.facets }),
				...(group !== undefined && {
					groups: {
						by: group,
						...(request.minGroupSize !== undefined && { minSize: request.minGroupSize })
					}
				}),
				...(request.where?.files && { fileScope: request.where.files })
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
		const { nextCursor, localization, ...rest } = page;
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
