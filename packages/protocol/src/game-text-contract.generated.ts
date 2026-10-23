// Generated from crates/game-text-index/src/contract.rs, rules/ir.rs and rules/replies.rs by
// `UE_SHED_UPDATE_GENERATED=1 cargo test -p game-text-index --lib contract`. Do not edit.

/** The engine build and contract this host was built against. */
export const gameTextEngineContract = {
	buildId: "0.21.0",
	contractHash: "c3c2d719e0515f7738caaf05e13ac06c7ed1ad1c36d4d359c8880935adbdd5bf"
} as const;

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue };

/** One finding's fields; `places` names its place set. */
export type Finding = {
	readonly places: number;
	readonly id: string;
	readonly [key: string]: JsonValue;
};

export type RuleDocumentV4 = { schemaVersion: 4, roles: ReadonlyArray<Role>, rules: ReadonlyArray<Rule>, };

export type Rule = { id: string, ruleId?: string, kind: string, label: string, subject: Subject, family: Family, enabled?: boolean, severity: Severity, params?: { [key: string]: JsonValue }, scope?: Scope, role?: string, 
/**
 * Named expressions, inlined where `var` reads them.
 */
let?: { [key: string]: Expr }, each?: Expr, eachAs?: string, when: Expr, actual: Expr, expectation: Expr, fix?: Expr, affected?: Expr, translationOrigin?: Expr, extra?: Expr, recovery: Expr, counts?: boolean, };

export type Expr = { "lit": JsonValue } | { "list": ReadonlyArray<Expr> } | { "object": { [key: string]: Expr } } | { "field": string } | { "param": string } | { "var": string } | { "finding": string } | { "findingField": readonly [string, string] } | { "occurrences": readonly [] } | { "not": Expr } | { "isNull": Expr } | { "utf16Length": Expr } | { "codePoints": Expr } | { "visibleLength": Expr } | { "visibleWords": Expr } | { "interiorLineBreaks": Expr } | { "trim": Expr } | { "lower": Expr } | { "normalizeLineEndings": Expr } | { "count": Expr } | { "flatten": Expr } | { "distinct": Expr } | { "first": Expr } | { "sortByStart": Expr } | { "formatArgumentNames": Expr } | { "formatArgumentOrder": Expr } | { "formatModifiers": Expr } | { "formatIssues": Expr } | { "formatCompiled": Expr } | { "richTextCounts": Expr } | { "richTextTagBalance": Expr } | { "unrealWhitespace": Expr } | { "unrealUnsafeWhitespace": Expr } | { "formatBraceBalance": Expr } | { "get": readonly [Expr, Expr] } | { "eq": readonly [Expr, Expr] } | { "ne": readonly [Expr, Expr] } | { "lt": readonly [Expr, Expr] } | { "le": readonly [Expr, Expr] } | { "gt": readonly [Expr, Expr] } | { "ge": readonly [Expr, Expr] } | { "in": readonly [Expr, Expr] } | { "sub": readonly [Expr, Expr] } | { "div": readonly [Expr, Expr] } | { "round": readonly [Expr, Expr] } | { "startsWith": readonly [Expr, Expr] } | { "endsWith": readonly [Expr, Expr] } | { "contains": readonly [Expr, Expr] } | { "countOccurrences": readonly [Expr, Expr] } | { "findAll": readonly [Expr, Expr] } | { "anyChar": readonly [Expr, Expr] } | { "allChars": readonly [Expr, Expr] } | { "removeClass": readonly [Expr, Expr] } | { "leadingClass": readonly [Expr, Expr] } | { "trailingClass": readonly [Expr, Expr] } | { "take": readonly [Expr, Expr] } | { "drop": readonly [Expr, Expr] } | { "minus": readonly [Expr, Expr] } | { "zip": readonly [Expr, Expr] } | { "matchesRole": readonly [Expr, Expr] } | { "pathHasPrefix": readonly [Expr, Expr] } | { "formatPattern": readonly [Expr, Expr] } | { "richTextValid": readonly [Expr, Expr] } | { "compareRichTextTags": readonly [Expr, Expr] } | { "withoutOptionalArgumentTags": readonly [Expr, Expr] } | { "if": readonly [Expr, Expr, Expr] } | { "slice": readonly [Expr, Expr, Expr] } | { "trimClass": readonly [Expr, Expr, Expr] } | { "runs": readonly [Expr, Expr, Expr] } | { "regexMatches": readonly [Expr, Expr, Expr] } | { "regexTest": readonly [Expr, Expr, Expr] } | { "termMatches": readonly [Expr, Expr, Expr] } | { "termListMatches": readonly [Expr, Expr, Expr, Expr] } | { "formatRenameArgument": readonly [Expr, Expr, Expr, Expr] } | { "and": ReadonlyArray<Expr> } | { "or": ReadonlyArray<Expr> } | { "coalesce": ReadonlyArray<Expr> } | { "add": ReadonlyArray<Expr> } | { "mul": ReadonlyArray<Expr> } | { "min": ReadonlyArray<Expr> } | { "max": ReadonlyArray<Expr> } | { "concat": ReadonlyArray<Expr> } | { "concatLists": ReadonlyArray<Expr> } | { "filter": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "map": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "flatMap": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "any": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "all": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "sortCodeUnit": readonly [Expr] | readonly [Expr, Expr] } | { "sortLocale": readonly [Expr] | readonly [Expr, Expr] };

export type Scope = { roles?: ReadonlyArray<string>, cultures?: ReadonlyArray<string>, pathPrefixes?: ReadonlyArray<string>, };

export type Role = { id: string, description?: string, scopes: ReadonlyArray<RoleScope>, };

export type RoleScope = { matchers: ReadonlyArray<RoleMatcher>, };

export type RoleMatcher = { kind: MatcherKind, operator?: MatchOperator, value: string, };

export type MatcherKind = "location_kind" | "object_path" | "row" | "property_path" | "string_table_entry" | "class_path";

export type MatchOperator = "exact" | "prefix";

export type Subject = "line" | "line_culture" | "unit_source";

export type Family = "builtin" | "policy" | "custom" | "source";

export type Severity = "blocking" | "normal" | "low";

export type FindingsEvaluation = { key: string, rules: ReadonlyArray<RuleMetadata>, counts: ReadonlyArray<RuleCount>, diagnosticCount: number, collation: string, profile: EvaluationProfile, };

export type RuleMetadata = { id: string, ruleId: string, kind: string, label: string, subject: Subject, family: Family, severity: Severity, role: string | null, };

export type RuleCount = { 
/**
 * The rule's position in `rules`.
 */
rule: number, culture: string | null, severity: Severity, count: number, };

export type EvaluationProfile = { readonly cached: true } | ({ readonly cached: false } & RunProfile);

export type RunProfile = { rules: number, findings: number, diagnostics: number, wallMs: number, stages: { [key in string]: StageSample }, subStages: { [key in string]: SubStageSample }, 
/**
 * Bytes held by named owners at named points.
 */
holders: { [point: string]: { [holder: string]: number } }, kernels: { [key in string]: ProfileSample }, };

export type StageSample = { startOffsetMs: number, endOffsetMs: number, memory: Memory, kernels: { [key in string]: ProfileSample }, wallMs: number, busyMs: number, rows: number, inputs: number, memoHits: number, };

export type SubStageSample = { heapBytes?: number, heapPeakBytes?: number, wallMs: number, busyMs: number, rows: number, inputs: number, memoHits: number, };

export type ProfileSample = { wallMs: number, busyMs: number, rows: number, inputs: number, memoHits: number, };

export type Memory = { 
/**
 * Process counters when the stage ended. In a long-lived engine process the peaks are
 * lifetime values, so only a fresh process's peak is one evaluation's peak.
 */
privateBytes: number, peakPrivateBytes: number | null, workingSetBytes: number, peakWorkingSetBytes: number, 
/**
 * With heap counting: live heap at the stage's end, and its peak since the last sample.
 */
heapBytes?: number, heapPeakBytes?: number, arenaBytes: number, sideDictionaryBytes: number, liveNodeColumnsBytes: number, memosBytes: number, occurrenceRelationBytes: number, };

export type FindingLines = { profile: ReadProfile, places: ReadonlyArray<PlaceSet>, lines: ReadonlyArray<FindingLine>, };

export type FindingLine = { row: number, builtIns: ReadonlyArray<Finding>, policy: ReadonlyArray<Finding>, custom: ReadonlyArray<Finding>, diagnostics: ReadonlyArray<LineDiagnostic>, };

export type LineDiagnostic = { lineId: string, culture: string, code: string, };

export type FindingUnits = { profile: ReadProfile, places: ReadonlyArray<PlaceSet>, units: ReadonlyArray<UnitFindings>, };

export type UnitFindings = { unit: number, findings: ReadonlyArray<Finding>, };

export type PlaceSet = { id: number, occurrences: ReadonlyArray<Place>, };

export type Place = { id: string, location: { readonly [key: string]: JsonValue }, packageFile: string, };

export type ReadProfile = { rowsRequested: number, findingsReturned: number, responseBytes: number, fileFallback: boolean, };

export type SpilledReply = { file: string, };
