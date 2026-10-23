import type { Schema } from "effect";
import type { Expr, Rule } from "./schema.js";

/** Construct one rule without evaluating or changing its expressions. */
export const rule = (definition: Rule): Rule => definition;

/** Typed JSON constructors; no computation or policy runs in the builder. */
export const expr = {
	field: (name: string): Expr => ({ field: name }),
	param: (name: string): Expr => ({ param: name }),
	var: (name: string): Expr => ({ var: name }),
	finding: (name: string): Expr => ({ finding: name }),
	lit: (value: Schema.Json): Expr => ({ lit: value }),
	list: (...values: readonly Expr[]): Expr => ({ list: values }),
	object: (fields: Readonly<Record<string, Expr>>): Expr => ({ object: fields }),
	occurrences: (): Expr => ({ occurrences: [] }),
	not: (value: Expr): Expr => ({ not: value }),
	isNull: (value: Expr): Expr => ({ isNull: value }),
	utf16Length: (value: Expr): Expr => ({ utf16Length: value }),
	codePoints: (value: Expr): Expr => ({ codePoints: value }),
	visibleLength: (value: Expr): Expr => ({ visibleLength: value }),
	visibleWords: (value: Expr): Expr => ({ visibleWords: value }),
	interiorLineBreaks: (value: Expr): Expr => ({ interiorLineBreaks: value }),
	trim: (value: Expr): Expr => ({ trim: value }),
	lower: (value: Expr): Expr => ({ lower: value }),
	normalizeLineEndings: (value: Expr): Expr => ({ normalizeLineEndings: value }),
	count: (value: Expr): Expr => ({ count: value }),
	flatten: (value: Expr): Expr => ({ flatten: value }),
	distinct: (value: Expr): Expr => ({ distinct: value }),
	first: (value: Expr): Expr => ({ first: value }),
	sortByStart: (value: Expr): Expr => ({ sortByStart: value }),
	formatArgumentNames: (value: Expr): Expr => ({ formatArgumentNames: value }),
	formatArgumentOrder: (value: Expr): Expr => ({ formatArgumentOrder: value }),
	formatModifiers: (value: Expr): Expr => ({ formatModifiers: value }),
	formatIssues: (value: Expr): Expr => ({ formatIssues: value }),
	formatCompiled: (value: Expr): Expr => ({ formatCompiled: value }),
	richTextCounts: (value: Expr): Expr => ({ richTextCounts: value }),
	richTextTagBalance: (value: Expr): Expr => ({ richTextTagBalance: value }),
	unrealWhitespace: (value: Expr): Expr => ({ unrealWhitespace: value }),
	unrealUnsafeWhitespace: (value: Expr): Expr => ({ unrealUnsafeWhitespace: value }),
	formatBraceBalance: (value: Expr): Expr => ({ formatBraceBalance: value }),
	get: (a: Expr, b: Expr): Expr => ({ get: [a, b] }),
	eq: (a: Expr, b: Expr): Expr => ({ eq: [a, b] }),
	ne: (a: Expr, b: Expr): Expr => ({ ne: [a, b] }),
	lt: (a: Expr, b: Expr): Expr => ({ lt: [a, b] }),
	le: (a: Expr, b: Expr): Expr => ({ le: [a, b] }),
	gt: (a: Expr, b: Expr): Expr => ({ gt: [a, b] }),
	ge: (a: Expr, b: Expr): Expr => ({ ge: [a, b] }),
	in: (a: Expr, b: Expr): Expr => ({ in: [a, b] }),
	sub: (a: Expr, b: Expr): Expr => ({ sub: [a, b] }),
	div: (a: Expr, b: Expr): Expr => ({ div: [a, b] }),
	round: (a: Expr, b: Expr): Expr => ({ round: [a, b] }),
	startsWith: (a: Expr, b: Expr): Expr => ({ startsWith: [a, b] }),
	endsWith: (a: Expr, b: Expr): Expr => ({ endsWith: [a, b] }),
	contains: (a: Expr, b: Expr): Expr => ({ contains: [a, b] }),
	countOccurrences: (a: Expr, b: Expr): Expr => ({ countOccurrences: [a, b] }),
	findAll: (a: Expr, b: Expr): Expr => ({ findAll: [a, b] }),
	anyChar: (a: Expr, b: Expr): Expr => ({ anyChar: [a, b] }),
	allChars: (a: Expr, b: Expr): Expr => ({ allChars: [a, b] }),
	removeClass: (a: Expr, b: Expr): Expr => ({ removeClass: [a, b] }),
	leadingClass: (a: Expr, b: Expr): Expr => ({ leadingClass: [a, b] }),
	trailingClass: (a: Expr, b: Expr): Expr => ({ trailingClass: [a, b] }),
	take: (a: Expr, b: Expr): Expr => ({ take: [a, b] }),
	drop: (a: Expr, b: Expr): Expr => ({ drop: [a, b] }),
	minus: (a: Expr, b: Expr): Expr => ({ minus: [a, b] }),
	zip: (a: Expr, b: Expr): Expr => ({ zip: [a, b] }),
	matchesRole: (a: Expr, b: Expr): Expr => ({ matchesRole: [a, b] }),
	pathHasPrefix: (a: Expr, b: Expr): Expr => ({ pathHasPrefix: [a, b] }),
	formatPattern: (a: Expr, b: Expr): Expr => ({ formatPattern: [a, b] }),
	richTextValid: (a: Expr, b: Expr): Expr => ({ richTextValid: [a, b] }),
	compareRichTextTags: (a: Expr, b: Expr): Expr => ({ compareRichTextTags: [a, b] }),
	withoutOptionalArgumentTags: (a: Expr, b: Expr): Expr => ({
		withoutOptionalArgumentTags: [a, b]
	}),
	findingField: (a: Expr, b: Expr): Expr => ({ findingField: [a, b] }),
	if: (a: Expr, b: Expr, c: Expr): Expr => ({ if: [a, b, c] }),
	slice: (a: Expr, b: Expr, c: Expr): Expr => ({ slice: [a, b, c] }),
	trimClass: (a: Expr, b: Expr, c: Expr): Expr => ({ trimClass: [a, b, c] }),
	runs: (a: Expr, b: Expr, c: Expr): Expr => ({ runs: [a, b, c] }),
	regexMatches: (a: Expr, b: Expr, c: Expr): Expr => ({ regexMatches: [a, b, c] }),
	regexTest: (a: Expr, b: Expr, c: Expr): Expr => ({ regexTest: [a, b, c] }),
	termMatches: (a: Expr, b: Expr, c: Expr): Expr => ({ termMatches: [a, b, c] }),
	and: (...values: readonly Expr[]): Expr => ({ and: values }),
	or: (...values: readonly Expr[]): Expr => ({ or: values }),
	coalesce: (...values: readonly Expr[]): Expr => ({ coalesce: values }),
	add: (...values: readonly Expr[]): Expr => ({ add: values }),
	mul: (...values: readonly Expr[]): Expr => ({ mul: values }),
	min: (...values: readonly Expr[]): Expr => ({ min: values }),
	max: (...values: readonly Expr[]): Expr => ({ max: values }),
	concat: (...values: readonly Expr[]): Expr => ({ concat: values }),
	concatLists: (...values: readonly Expr[]): Expr => ({ concatLists: values }),
	filter: (list: Expr, body: Expr, name?: string): Expr => ({
		filter: name === undefined ? [list, body] : [list, body, name]
	}),
	map: (list: Expr, body: Expr, name?: string): Expr => ({
		map: name === undefined ? [list, body] : [list, body, name]
	}),
	flatMap: (list: Expr, body: Expr, name?: string): Expr => ({
		flatMap: name === undefined ? [list, body] : [list, body, name]
	}),
	any: (list: Expr, body: Expr, name?: string): Expr => ({
		any: name === undefined ? [list, body] : [list, body, name]
	}),
	all: (list: Expr, body: Expr, name?: string): Expr => ({
		all: name === undefined ? [list, body] : [list, body, name]
	}),
	sortCodeUnit: (list: Expr, by?: Expr): Expr => ({
		sortCodeUnit: by === undefined ? [list] : [list, by]
	}),
	sortLocale: (list: Expr, by?: Expr): Expr => ({
		sortLocale: by === undefined ? [list] : [list, by]
	}),
	termListMatches: (a: Expr, b: Expr, c: Expr, d: Expr): Expr => ({
		termListMatches: [a, b, c, d]
	}),
	formatRenameArgument: (a: Expr, b: Expr, c: Expr, d: Expr): Expr => ({
		formatRenameArgument: [a, b, c, d]
	})
};
