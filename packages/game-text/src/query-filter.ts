/**
 * Filters as the query takes them: the rule IR's query grammar with facet marks, and converters
 * from a host's pills. Counting by a field drops the tests marked with it. Browser-safe.
 */
import { Option, Schema } from "effect";
import { type GameTextContract, queryFields } from "@ue-shed/protocol";
import type { LocalizationSelection } from "./localization-schema.js";
import type { TextCapabilityFilter, TextFilterClause, TextOriginKind } from "./schema.js";

type JsonValue = GameTextContract.JsonValue;

/** A query field: what a `where` tests, a facet mark names, and rows group and count by. */
export type QueryField = GameTextContract.QueryField;

/** The query grammar of the rule IR: what a `where` is built of. The engine checks the rest. */
export type QueryExpr =
	| { readonly lit: JsonValue }
	| { readonly field: string }
	| { readonly var: string }
	| { readonly and: readonly QueryExpr[] }
	| { readonly or: readonly QueryExpr[] }
	| { readonly not: QueryExpr }
	| { readonly in: readonly [QueryExpr, QueryExpr] }
	| { readonly eq: readonly [QueryExpr, QueryExpr] }
	| { readonly pathHasPrefix: readonly [QueryExpr, QueryExpr] }
	| { readonly any: readonly [QueryExpr, QueryExpr] | readonly [QueryExpr, QueryExpr, string] }
	| { readonly anyCulture: QueryExpr }
	| { readonly everyCulture: QueryExpr }
	| { readonly anyPlace: QueryExpr }
	| { readonly row: QueryExpr }
	| { readonly facet: readonly [QueryField, QueryExpr] };

const MAX_TEXT = 32767;
/** The engine's bound on one `where`'s expressions. */
const MAX_NODES = 1024;

const Json: Schema.Codec<JsonValue> = Schema.suspend(
	(): Schema.Codec<JsonValue> =>
		Schema.Union([
			Schema.Null,
			Schema.Boolean,
			Schema.Finite,
			Schema.String,
			Schema.Array(Json),
			Schema.Record(Schema.String, Json)
		])
);

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TEXT));
const Expr: Schema.Codec<QueryExpr> = Schema.suspend((): Schema.Codec<QueryExpr> => {
	const pair = Schema.Tuple([Expr, Expr]);
	const list = Schema.Array(Expr).check(Schema.isMaxLength(MAX_NODES));
	return Schema.Union([
		Schema.Struct({ lit: Json }),
		Schema.Struct({ field: Name }),
		Schema.Struct({ var: Name }),
		Schema.Struct({ and: list }),
		Schema.Struct({ or: list }),
		Schema.Struct({ not: Expr }),
		Schema.Struct({ in: pair }),
		Schema.Struct({ eq: pair }),
		Schema.Struct({ pathHasPrefix: pair }),
		Schema.Struct({ any: Schema.Union([pair, Schema.Tuple([Expr, Expr, Name])]) }),
		Schema.Struct({ anyCulture: Expr }),
		Schema.Struct({ everyCulture: Expr }),
		Schema.Struct({ anyPlace: Expr }),
		Schema.Struct({ row: Expr }),
		Schema.Struct({ facet: Schema.Tuple([QueryFieldName, Expr]) })
	]);
});
/**
 * A `where`, as hosts check it at their own boundary: its shape and bounds. The engine checks
 * its fields and values again.
 */
export const QueryExpr = Expr.annotate({ identifier: "QueryExpr" });
/** A query field's name. */
export const QueryFieldName = Schema.Literals(queryFields);

/** A count of the rows by one field, over the rows the marks naming it don't narrow. */
export const QueryFacet = Schema.Struct({
	by: QueryFieldName,
	/** `paths` only: the folders directly under this one; empty for the top folders. */
	under: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512)))
});
export type QueryFacet = typeof QueryFacet.Type;

/** A query's facets, each field at most once. */
export const QueryFacets = Schema.Array(QueryFacet).check(
	Schema.isMaxLength(queryFields.length),
	Schema.makeFilter((facets) =>
		new Set(facets.map(({ by }) => by)).size === facets.length
			? undefined
			: "A query counts by each field once."
	)
);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * One field's counts: each value with its rows, as the Text tab's groups list them. A finding
 * field's entries have no `needWork` or `worst`.
 */
export const QueryFacetCounts = Schema.Struct({
	entries: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			label: Schema.String,
			count: Count,
			needWork: Schema.optionalKey(Count),
			worst: Schema.optionalKey(Schema.String)
		})
	),
	more: Count,
	/** `paths`: the folder whose folders are counted. */
	under: Schema.optionalKey(Schema.String)
});
export type QueryFacetCounts = typeof QueryFacetCounts.Type;

const field = (name: string): QueryExpr => ({ field: name });
const item: QueryExpr = { var: "item" };
/** A scalar field is one of the values. */
const oneOf = (name: string, values: readonly JsonValue[]): QueryExpr => ({
	in: [field(name), { lit: values }]
});
/** A finding's rule is one of these; none when the list is empty, which `in` refuses. */
export const ruleIn = (rules: readonly string[]): QueryExpr =>
	rules.length === 0 ? { lit: false } : oneOf("rule", rules);
/** A list field holds one of the values. */
const holds = (name: string, values: readonly JsonValue[]): QueryExpr => ({
	any: [field(name), { in: [item, { lit: values }] }]
});
const is = (name: string, value: boolean): QueryExpr => ({ eq: [field(name), { lit: value }] });
/** A test that counting by `name` drops. */
export const marked = (name: QueryField, test: QueryExpr): QueryExpr => ({ facet: [name, test] });
/** Every test holds; `undefined` for none. */
export const allOf = (tests: readonly QueryExpr[]): QueryExpr | undefined =>
	tests.length === 0 ? undefined : tests.length === 1 ? tests[0] : { and: tests };
const some = (tests: readonly QueryExpr[]): QueryExpr =>
	tests.length === 1 ? tests[0]! : { or: tests };
const under = (prefixes: readonly string[]): QueryExpr => ({
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
 * One pill: `is` holds when the row has one of the values, `is_not` when it has none. A pill of
 * a field the Text tab counts carries that field's mark.
 */
export const pillWhere = (clause: TextFilterClause): QueryExpr => {
	const test = (expr: QueryExpr): QueryExpr => (clause.op === "is" ? expr : { not: expr });
	switch (clause.field) {
		case "problem":
			return marked("problems", test(holds("problems", clause.values)));
		case "finding":
			return marked("findings", test(holds("findings", clause.values)));
		case "fact":
			return marked("facts", test(holds("facts", clause.values)));
		case "origin":
			return marked("origins", test(holds("origins", clause.values)));
		case "folder":
			return marked("paths", test(under(clause.values)));
		case "asset":
			return marked("files", test(holds("files", clause.values)));
		case "audience":
			return marked("audience", test(oneOf("audience", clause.values)));
		case "asset_type":
			return marked("assetTypes", test(holds("assetTypes", clause.values)));
		case "namespace":
			return marked("namespace", test(oneOf("namespace", clause.values)));
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

/** What the Text tab's controls choose, as it shows them. */
export interface TextFilterInput {
	/** Filter pills. */
	readonly filter?: readonly TextFilterClause[] | undefined;
	/** Only these localization lines, such as a selection. */
	readonly lines?: readonly string[] | undefined;
	/** The localization lens: a state, a review flag, or changed keys. */
	readonly lens?: Pick<LocalizationSelection, "state" | "review" | "keyChanged"> | undefined;
	/** A place that can be edited, or read only, rather than any. */
	readonly capability?: TextCapabilityFilter | undefined;
	/** A place without translator notes. */
	readonly withoutNotes?: boolean | undefined;
	/** A place of these origins, under this path, in these files. */
	readonly kinds?: readonly TextOriginKind[] | undefined;
	readonly pathPrefix?: string | undefined;
	readonly files?: readonly string[] | undefined;
}

/**
 * The Text tab's controls as a `where`. The capability, translator-notes and location tests must
 * hold on one place together; the counts' tabs drop the marks on `editing`, `notes` and
 * `origins`.
 */
export const textWhere = (input: TextFilterInput): QueryExpr | undefined => {
	const tests: QueryExpr[] = (input.filter ?? []).map(pillWhere);
	if (input.lines !== undefined) tests.push(oneOf("id", input.lines));
	const lens = input.lens;
	if (lens?.state)
		tests.push({
			anyCulture:
				lens.state === "not_synced" ? is("notSynced", true) : oneOf("state", [lens.state])
		});
	if (lens?.review) tests.push({ anyCulture: holds("review", [lens.review]) });
	if (lens?.keyChanged === true) tests.push(is("keyChanged", true));
	const place: QueryExpr[] = [];
	if (input.capability !== undefined && input.capability !== "all")
		place.push(
			marked(
				"editing",
				holds("editing", [
					input.capability === "source_editable" ? "editable" : "read_only"
				])
			)
		);
	if (input.withoutNotes === true) place.push(marked("notes", is("notes", false)));
	if (input.kinds) place.push(marked("origins", holds("origins", input.kinds)));
	if (input.pathPrefix) place.push(under([input.pathPrefix]));
	if (input.files) place.push(holds("files", input.files));
	const placed = allOf(place);
	if (placed !== undefined) tests.push({ anyPlace: placed });
	return allOf(tests);
};

/** Quality's own pills: findings of these severities, with or without a suggested fix. */
export interface QualityFilterInput {
	readonly severities?: readonly ("blocking" | "normal" | "low")[] | undefined;
	readonly fixable?: boolean | undefined;
	/** The rules of the check chosen, by ID. */
	readonly rules?: readonly string[] | undefined;
}

/** Quality's pills, each marked with its field so its count follows every other filter. */
export const qualityWhere = (input: QualityFilterInput): QueryExpr | undefined =>
	allOf([
		...(input.rules ? [marked("rule", ruleIn(input.rules))] : []),
		...(input.severities ? [marked("severity", oneOf("severity", input.severities))] : []),
		...(input.fixable !== undefined
			? [marked("fixable", oneOf("fixable", [input.fixable]))]
			: [])
	]);

/** A finding's text row passes the test: the Text tab's filter, on Quality. */
export const rowWhere = (test: QueryExpr): QueryExpr => ({ row: test });

/** One of Quality's pills as `qualityWhere` writes it: a marked test of its own field. */
const pillOf = <const Name extends string, Value extends Schema.Top>(name: Name, value: Value) =>
	Schema.Struct({
		facet: Schema.Tuple([
			Schema.Literal(name),
			Schema.Struct({
				in: Schema.Tuple([
					Schema.Struct({ field: Schema.Literal(name) }),
					Schema.Struct({ lit: Schema.Array(value).check(Schema.isMinLength(1)) })
				])
			})
		])
	});
const decodeRules = Schema.decodeUnknownOption(pillOf("rule", Schema.String));
const decodeSeverities = Schema.decodeUnknownOption(
	pillOf("severity", Schema.Literals(["blocking", "normal", "low"]))
);
const decodeFixable = Schema.decodeUnknownOption(pillOf("fixable", Schema.Boolean));

/**
 * Quality's pills back from a `where` that `qualityWhere` built: the rules, severities and
 * suggested-fix filter. `undefined` when the filter holds anything else.
 */
export const qualityPillsOf = (where: QueryExpr | undefined): QualityFilterInput | undefined => {
	if (where === undefined) return {};
	const pills: { -readonly [K in keyof QualityFilterInput]: QualityFilterInput[K] } = {};
	for (const test of "and" in where ? where.and : [where]) {
		const rules = Option.getOrUndefined(decodeRules(test));
		const severities = Option.getOrUndefined(decodeSeverities(test));
		const fixable = Option.getOrUndefined(decodeFixable(test));
		if (rules) pills.rules = rules.facet[1].in[1].lit;
		else if (severities) pills.severities = severities.facet[1].in[1].lit;
		else if (fixable?.facet[1].in[1].lit.length === 1)
			pills.fixable = fixable.facet[1].in[1].lit[0];
		else return undefined;
	}
	return pills;
};
