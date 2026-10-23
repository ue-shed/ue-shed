import { Predicate } from "effect";
import type { Expr, JsonValue, Rule } from "./schema.js";

/** An expression argument. A bare scalar is shorthand for its literal. */
export type Arg = Expr | string | number | boolean | null;
export const asExpr = (value: Arg): Expr => (Predicate.isObject(value) ? value : { lit: value });
const e = asExpr;

/** Construct one rule without evaluating or changing its expressions. */
export const rule = (definition: Rule): Rule => definition;

/** Typed JSON constructors; no computation or policy runs in the builder. */
export const expr = {
	field: (name: string): Expr => ({ field: name }),
	param: (name: string): Expr => ({ param: name }),
	var: (name: string): Expr => ({ var: name }),
	finding: (name: string): Expr => ({ finding: name }),
	lit: (value: JsonValue): Expr => ({ lit: value }),
	list: (...values: readonly Arg[]): Expr => ({ list: values.map(e) }),
	object: (fields: Readonly<Record<string, Arg>>): Expr => ({
		object: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, e(value)]))
	}),
	occurrences: (): Expr => ({ occurrences: [] }),
	not: (value: Arg): Expr => ({ not: e(value) }),
	isNull: (value: Arg): Expr => ({ isNull: e(value) }),
	utf16Length: (value: Arg): Expr => ({ utf16Length: e(value) }),
	codePoints: (value: Arg): Expr => ({ codePoints: e(value) }),
	visibleLength: (value: Arg): Expr => ({ visibleLength: e(value) }),
	visibleWords: (value: Arg): Expr => ({ visibleWords: e(value) }),
	interiorLineBreaks: (value: Arg): Expr => ({ interiorLineBreaks: e(value) }),
	trim: (value: Arg): Expr => ({ trim: e(value) }),
	lower: (value: Arg): Expr => ({ lower: e(value) }),
	normalizeLineEndings: (value: Arg): Expr => ({ normalizeLineEndings: e(value) }),
	count: (value: Arg): Expr => ({ count: e(value) }),
	flatten: (value: Arg): Expr => ({ flatten: e(value) }),
	distinct: (value: Arg): Expr => ({ distinct: e(value) }),
	first: (value: Arg): Expr => ({ first: e(value) }),
	sortByStart: (value: Arg): Expr => ({ sortByStart: e(value) }),
	formatArgumentNames: (value: Arg): Expr => ({ formatArgumentNames: e(value) }),
	formatArgumentOrder: (value: Arg): Expr => ({ formatArgumentOrder: e(value) }),
	formatModifiers: (value: Arg): Expr => ({ formatModifiers: e(value) }),
	formatIssues: (value: Arg): Expr => ({ formatIssues: e(value) }),
	formatCompiled: (value: Arg): Expr => ({ formatCompiled: e(value) }),
	richTextCounts: (value: Arg): Expr => ({ richTextCounts: e(value) }),
	richTextTagBalance: (value: Arg): Expr => ({ richTextTagBalance: e(value) }),
	unrealWhitespace: (value: Arg): Expr => ({ unrealWhitespace: e(value) }),
	unrealUnsafeWhitespace: (value: Arg): Expr => ({ unrealUnsafeWhitespace: e(value) }),
	formatBraceBalance: (value: Arg): Expr => ({ formatBraceBalance: e(value) }),
	get: (a: Arg, b: Arg): Expr => ({ get: [e(a), e(b)] }),
	eq: (a: Arg, b: Arg): Expr => ({ eq: [e(a), e(b)] }),
	ne: (a: Arg, b: Arg): Expr => ({ ne: [e(a), e(b)] }),
	lt: (a: Arg, b: Arg): Expr => ({ lt: [e(a), e(b)] }),
	le: (a: Arg, b: Arg): Expr => ({ le: [e(a), e(b)] }),
	gt: (a: Arg, b: Arg): Expr => ({ gt: [e(a), e(b)] }),
	ge: (a: Arg, b: Arg): Expr => ({ ge: [e(a), e(b)] }),
	in: (a: Arg, b: Arg): Expr => ({ in: [e(a), e(b)] }),
	sub: (a: Arg, b: Arg): Expr => ({ sub: [e(a), e(b)] }),
	div: (a: Arg, b: Arg): Expr => ({ div: [e(a), e(b)] }),
	round: (a: Arg, b: Arg): Expr => ({ round: [e(a), e(b)] }),
	startsWith: (a: Arg, b: Arg): Expr => ({ startsWith: [e(a), e(b)] }),
	endsWith: (a: Arg, b: Arg): Expr => ({ endsWith: [e(a), e(b)] }),
	contains: (a: Arg, b: Arg): Expr => ({ contains: [e(a), e(b)] }),
	countOccurrences: (a: Arg, b: Arg): Expr => ({ countOccurrences: [e(a), e(b)] }),
	findAll: (a: Arg, b: Arg): Expr => ({ findAll: [e(a), e(b)] }),
	anyChar: (a: Arg, b: Arg): Expr => ({ anyChar: [e(a), e(b)] }),
	allChars: (a: Arg, b: Arg): Expr => ({ allChars: [e(a), e(b)] }),
	removeClass: (a: Arg, b: Arg): Expr => ({ removeClass: [e(a), e(b)] }),
	leadingClass: (a: Arg, b: Arg): Expr => ({ leadingClass: [e(a), e(b)] }),
	trailingClass: (a: Arg, b: Arg): Expr => ({ trailingClass: [e(a), e(b)] }),
	take: (a: Arg, b: Arg): Expr => ({ take: [e(a), e(b)] }),
	drop: (a: Arg, b: Arg): Expr => ({ drop: [e(a), e(b)] }),
	minus: (a: Arg, b: Arg): Expr => ({ minus: [e(a), e(b)] }),
	zip: (a: Arg, b: Arg): Expr => ({ zip: [e(a), e(b)] }),
	matchesRole: (a: Arg, b: Arg): Expr => ({ matchesRole: [e(a), e(b)] }),
	pathHasPrefix: (a: Arg, b: Arg): Expr => ({ pathHasPrefix: [e(a), e(b)] }),
	formatPattern: (a: Arg, b: Arg): Expr => ({ formatPattern: [e(a), e(b)] }),
	richTextValid: (a: Arg, b: Arg): Expr => ({ richTextValid: [e(a), e(b)] }),
	compareRichTextTags: (a: Arg, b: Arg): Expr => ({ compareRichTextTags: [e(a), e(b)] }),
	withoutOptionalArgumentTags: (a: Arg, b: Arg): Expr => ({
		withoutOptionalArgumentTags: [e(a), e(b)]
	}),
	findingField: (rule: string, path: string): Expr => ({ findingField: [rule, path] }),
	if: (a: Arg, b: Arg, c: Arg): Expr => ({ if: [e(a), e(b), e(c)] }),
	slice: (a: Arg, b: Arg, c: Arg): Expr => ({ slice: [e(a), e(b), e(c)] }),
	trimClass: (a: Arg, b: Arg, c: Arg): Expr => ({ trimClass: [e(a), e(b), e(c)] }),
	runs: (a: Arg, b: Arg, c: Arg): Expr => ({ runs: [e(a), e(b), e(c)] }),
	regexMatches: (a: Arg, b: Arg, c: Arg): Expr => ({ regexMatches: [e(a), e(b), e(c)] }),
	regexTest: (a: Arg, b: Arg, c: Arg): Expr => ({ regexTest: [e(a), e(b), e(c)] }),
	termMatches: (a: Arg, b: Arg, c: Arg): Expr => ({ termMatches: [e(a), e(b), e(c)] }),
	and: (...values: readonly Arg[]): Expr => ({ and: values.map(e) }),
	or: (...values: readonly Arg[]): Expr => ({ or: values.map(e) }),
	coalesce: (...values: readonly Arg[]): Expr => ({ coalesce: values.map(e) }),
	add: (...values: readonly Arg[]): Expr => ({ add: values.map(e) }),
	mul: (...values: readonly Arg[]): Expr => ({ mul: values.map(e) }),
	min: (...values: readonly Arg[]): Expr => ({ min: values.map(e) }),
	max: (...values: readonly Arg[]): Expr => ({ max: values.map(e) }),
	concat: (...values: readonly Arg[]): Expr => ({ concat: values.map(e) }),
	concatLists: (...values: readonly Arg[]): Expr => ({ concatLists: values.map(e) }),
	filter: (list: Arg, body: Arg, name?: string): Expr => ({
		filter: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
	}),
	map: (list: Arg, body: Arg, name?: string): Expr => ({
		map: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
	}),
	flatMap: (list: Arg, body: Arg, name?: string): Expr => ({
		flatMap: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
	}),
	any: (list: Arg, body: Arg, name?: string): Expr => ({
		any: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
	}),
	all: (list: Arg, body: Arg, name?: string): Expr => ({
		all: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
	}),
	sortCodeUnit: (list: Arg, by?: Arg): Expr => ({
		sortCodeUnit: by === undefined ? [e(list)] : [e(list), e(by)]
	}),
	sortLocale: (list: Arg, by?: Arg): Expr => ({
		sortLocale: by === undefined ? [e(list)] : [e(list), e(by)]
	}),
	termListMatches: (a: Arg, b: Arg, c: Arg, d: Arg): Expr => ({
		termListMatches: [e(a), e(b), e(c), e(d)]
	}),
	formatRenameArgument: (a: Arg, b: Arg, c: Arg, d: Arg): Expr => ({
		formatRenameArgument: [e(a), e(b), e(c), e(d)]
	})
};
