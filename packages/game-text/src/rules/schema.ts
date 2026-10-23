import { Schema } from "effect";
import { CheckSeverity } from "../localization-check-ids.js";
import { LocalizationCheckScope } from "../localization-check-scope.js";
import { TextRole } from "../quality-schema.js";

const unary = [
	"not",
	"isNull",
	"utf16Length",
	"codePoints",
	"visibleLength",
	"visibleWords",
	"interiorLineBreaks",
	"trim",
	"lower",
	"normalizeLineEndings",
	"count",
	"flatten",
	"distinct",
	"first",
	"sortByStart",
	"formatArgumentNames",
	"formatArgumentOrder",
	"formatModifiers",
	"formatIssues",
	"formatCompiled",
	"richTextCounts",
	"richTextTagBalance",
	"unrealWhitespace",
	"unrealUnsafeWhitespace",
	"formatBraceBalance"
] as const;
const binary = [
	"get",
	"eq",
	"ne",
	"lt",
	"le",
	"gt",
	"ge",
	"in",
	"sub",
	"div",
	"round",
	"startsWith",
	"endsWith",
	"contains",
	"countOccurrences",
	"findAll",
	"anyChar",
	"allChars",
	"removeClass",
	"leadingClass",
	"trailingClass",
	"take",
	"drop",
	"minus",
	"zip",
	"matchesRole",
	"pathHasPrefix",
	"formatPattern",
	"richTextValid",
	"compareRichTextTags",
	"withoutOptionalArgumentTags",
	"findingField"
] as const;
const ternary = [
	"if",
	"slice",
	"trimClass",
	"runs",
	"regexMatches",
	"regexTest",
	"termMatches"
] as const;
const variadic = [
	"and",
	"or",
	"coalesce",
	"add",
	"mul",
	"min",
	"max",
	"concat",
	"concatLists"
] as const;
const binding = ["filter", "map", "flatMap", "any", "all"] as const;

/** JSON rule expression. Operators have explicit arity; the native compiler checks value types. */
export type Expr =
	| null
	| boolean
	| number
	| string
	| { readonly lit: Schema.Json }
	| { readonly list: readonly Expr[] }
	| { readonly object: Readonly<Record<string, Expr>> }
	| { readonly field: string }
	| { readonly param: string }
	| { readonly var: string }
	| { readonly finding: string }
	| { readonly not: Expr }
	| { readonly isNull: Expr }
	| { readonly utf16Length: Expr }
	| { readonly codePoints: Expr }
	| { readonly visibleLength: Expr }
	| { readonly visibleWords: Expr }
	| { readonly interiorLineBreaks: Expr }
	| { readonly trim: Expr }
	| { readonly lower: Expr }
	| { readonly normalizeLineEndings: Expr }
	| { readonly count: Expr }
	| { readonly flatten: Expr }
	| { readonly distinct: Expr }
	| { readonly first: Expr }
	| { readonly sortByStart: Expr }
	| { readonly formatArgumentNames: Expr }
	| { readonly formatArgumentOrder: Expr }
	| { readonly formatModifiers: Expr }
	| { readonly formatIssues: Expr }
	| { readonly formatCompiled: Expr }
	| { readonly richTextCounts: Expr }
	| { readonly richTextTagBalance: Expr }
	| { readonly unrealWhitespace: Expr }
	| { readonly unrealUnsafeWhitespace: Expr }
	| { readonly formatBraceBalance: Expr }
	| { readonly get: readonly [Expr, Expr] }
	| { readonly eq: readonly [Expr, Expr] }
	| { readonly ne: readonly [Expr, Expr] }
	| { readonly lt: readonly [Expr, Expr] }
	| { readonly le: readonly [Expr, Expr] }
	| { readonly gt: readonly [Expr, Expr] }
	| { readonly ge: readonly [Expr, Expr] }
	| { readonly in: readonly [Expr, Expr] }
	| { readonly sub: readonly [Expr, Expr] }
	| { readonly div: readonly [Expr, Expr] }
	| { readonly round: readonly [Expr, Expr] }
	| { readonly startsWith: readonly [Expr, Expr] }
	| { readonly endsWith: readonly [Expr, Expr] }
	| { readonly contains: readonly [Expr, Expr] }
	| { readonly countOccurrences: readonly [Expr, Expr] }
	| { readonly findAll: readonly [Expr, Expr] }
	| { readonly anyChar: readonly [Expr, Expr] }
	| { readonly allChars: readonly [Expr, Expr] }
	| { readonly removeClass: readonly [Expr, Expr] }
	| { readonly leadingClass: readonly [Expr, Expr] }
	| { readonly trailingClass: readonly [Expr, Expr] }
	| { readonly take: readonly [Expr, Expr] }
	| { readonly drop: readonly [Expr, Expr] }
	| { readonly minus: readonly [Expr, Expr] }
	| { readonly zip: readonly [Expr, Expr] }
	| { readonly matchesRole: readonly [Expr, Expr] }
	| { readonly pathHasPrefix: readonly [Expr, Expr] }
	| { readonly formatPattern: readonly [Expr, Expr] }
	| { readonly richTextValid: readonly [Expr, Expr] }
	| { readonly compareRichTextTags: readonly [Expr, Expr] }
	| { readonly withoutOptionalArgumentTags: readonly [Expr, Expr] }
	| { readonly findingField: readonly [Expr, Expr] }
	| { readonly if: readonly [Expr, Expr, Expr] }
	| { readonly slice: readonly [Expr, Expr, Expr] }
	| { readonly trimClass: readonly [Expr, Expr, Expr] }
	| { readonly runs: readonly [Expr, Expr, Expr] }
	| { readonly regexMatches: readonly [Expr, Expr, Expr] }
	| { readonly regexTest: readonly [Expr, Expr, Expr] }
	| { readonly termMatches: readonly [Expr, Expr, Expr] }
	| { readonly and: readonly Expr[] }
	| { readonly or: readonly Expr[] }
	| { readonly coalesce: readonly Expr[] }
	| { readonly add: readonly Expr[] }
	| { readonly mul: readonly Expr[] }
	| { readonly min: readonly Expr[] }
	| { readonly max: readonly Expr[] }
	| { readonly concat: readonly Expr[] }
	| { readonly concatLists: readonly Expr[] }
	| { readonly filter: readonly [Expr, Expr] | readonly [Expr, Expr, string] }
	| { readonly map: readonly [Expr, Expr] | readonly [Expr, Expr, string] }
	| { readonly flatMap: readonly [Expr, Expr] | readonly [Expr, Expr, string] }
	| { readonly any: readonly [Expr, Expr] | readonly [Expr, Expr, string] }
	| { readonly all: readonly [Expr, Expr] | readonly [Expr, Expr, string] }
	| { readonly sortCodeUnit: readonly [Expr] | readonly [Expr, Expr] }
	| { readonly sortLocale: readonly [Expr] | readonly [Expr, Expr] }
	| { readonly occurrences: readonly [] }
	| { readonly termListMatches: readonly [Expr, Expr, Expr, Expr] }
	| { readonly formatRenameArgument: readonly [Expr, Expr, Expr, Expr] };

/** Recursive Effect Schema for the serialized expression language. */
// SAFETY: each computed property in the schema has one literal operator name and its declared
// arguments. Verified by: rules/schema.test.ts checks every operator and incorrect arities.
export const Expr: Schema.Codec<Expr> = Schema.suspend(
	() =>
		// SAFETY: computed singleton operator schemas match Expr; the operator arity test checks each.
		// Verified by: rules/schema.test.ts.
		Schema.Union([
			Schema.Null,
			Schema.Boolean,
			Schema.Finite,
			Schema.String,
			Schema.Struct({ lit: Schema.Json }),
			Schema.Struct({ list: Schema.Array(Expr) }),
			Schema.Struct({ object: Schema.Record(Schema.String, Expr) }),
			...(["field", "param", "var", "finding"] as const).map((key) =>
				Schema.Struct({ [key]: Schema.String })
			),
			...unary.map((key) => Schema.Struct({ [key]: Expr })),
			...binary.map((key) => Schema.Struct({ [key]: Schema.Tuple([Expr, Expr]) })),
			...ternary.map((key) => Schema.Struct({ [key]: Schema.Tuple([Expr, Expr, Expr]) })),
			...variadic.map((key) => Schema.Struct({ [key]: Schema.Array(Expr) })),
			...binding.map((key) =>
				Schema.Struct({
					[key]: Schema.Union([
						Schema.Tuple([Expr, Expr]),
						Schema.Tuple([Expr, Expr, Schema.String])
					])
				})
			),
			...(["sortCodeUnit", "sortLocale"] as const).map((key) =>
				Schema.Struct({
					[key]: Schema.Union([Schema.Tuple([Expr]), Schema.Tuple([Expr, Expr])])
				})
			),
			Schema.Struct({ occurrences: Schema.Tuple([]) }),
			Schema.Struct({ termListMatches: Schema.Tuple([Expr, Expr, Expr, Expr]) }),
			Schema.Struct({ formatRenameArgument: Schema.Tuple([Expr, Expr, Expr, Expr]) })
			// SAFETY: each computed property above has one literal operator name and its declared arguments.
			// Verified by: rules/schema.test.ts checks every operator and rejects incorrect arities.
		]) as Schema.Codec<Expr>
).annotate({ identifier: "GameTextExpr" });

/** One named predicate, with expression evidence and the host finding metadata. */
export const Rule = Schema.Struct({
	id: Schema.NonEmptyString,
	ruleId: Schema.optionalKey(Schema.NonEmptyString),
	kind: Schema.NonEmptyString,
	label: Schema.NonEmptyString,
	subject: Schema.Literals(["line", "line_culture", "unit_source"]),
	family: Schema.Literals(["builtin", "policy", "custom", "source"]),
	enabled: Schema.optionalKey(Schema.Boolean),
	severity: CheckSeverity,
	params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	scope: Schema.optionalKey(LocalizationCheckScope),
	role: Schema.optionalKey(Schema.String),
	let: Schema.optionalKey(Schema.Record(Schema.String, Expr)),
	each: Schema.optionalKey(Expr),
	eachAs: Schema.optionalKey(Schema.String),
	when: Expr,
	actual: Expr,
	expectation: Expr,
	fix: Schema.optionalKey(Expr),
	affected: Schema.optionalKey(Expr),
	translationOrigin: Schema.optionalKey(Expr),
	extra: Schema.optionalKey(Expr),
	recovery: Expr,
	counts: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "GameTextRule" });
export type Rule = typeof Rule.Type;

/** Internal v4 rule document; authored files continue to use versions 1–3. */
export const RuleDocumentV4 = Schema.Struct({
	schemaVersion: Schema.Literal(4),
	roles: Schema.Array(TextRole),
	rules: Schema.Array(Rule)
}).annotate({ identifier: "GameTextRuleDocumentV4" });
export type RuleDocumentV4 = typeof RuleDocumentV4.Type;

/** Published JSON Schema generated from the Effect Schema. */
export const ruleDocumentJsonSchema = Schema.toJsonSchemaDocument(RuleDocumentV4);
