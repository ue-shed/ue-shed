import type { GameTextContract } from "@ue-shed/protocol";

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

/** Finite operation names shared with native profile decoding. */
export const ruleOperationNames = [
	...unary,
	...binary,
	...ternary,
	...variadic,
	...binding,
	"lit",
	"list",
	"object",
	"field",
	"param",
	"var",
	"finding",
	"occurrences",
	"sortCodeUnit",
	"sortLocale",
	"termListMatches",
	"formatRenameArgument"
] as const;

/**
 * The internal v4 rule program. The engine owns these types; they are generated from its Rust
 * contract, so the host's documents are checked against the engine at build time.
 */
export type Expr = GameTextContract.Expr;
export type Rule = GameTextContract.Rule;
export type RuleDocumentV4 = GameTextContract.RuleDocumentV4;
export type JsonValue = GameTextContract.JsonValue;
