// Generated from crates/game-text-index/src/contract.rs, rules/ir.rs and rules/replies.rs by
// `UE_SHED_UPDATE_GENERATED=1 cargo test -p game-text-index --lib contract`. Do not edit.

/** The engine build and contract this host was built against. */
export const gameTextEngineContract = {
	buildId: "0.24.0",
	contractHash: "0078e8eb68a06b957da5e4108dc3009e31f96146d6169b373f4a2d94f3192aa7"
} as const;

/**
 * The Game Text engine's message types: the v4 rule IR, the findings replies and the
* evaluation profile. Hosts build and read engine messages with these types; the session
* handshake checks that the engine was built against the same contract.
 */
export declare namespace GameTextContract {
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

export type LocalizationFormat = "manifest" | "archive" | "po";

export type LocalizationOptions = { format: LocalizationFormat, poFormat?: string | null, collapseMode?: string | null, };

export type LocalizationLimits = { maxFileBytes: number, maxEntries: number, maxDepth: number, maxFiles: number, maxRecordBytes: number, maxIdentityBytes: number, };

export type LocalizationDiagnostic = { code: string, message: string, recovery: string, retrySafe: boolean, nextStep: string, };

export type LocalizationInput = { chunkBytes?: number, projectRoot: string, file: string, relativePath: string, options: LocalizationOptions, limits: LocalizationLimits, };

export type LocalizationImportRequest = { files: ReadonlyArray<LocalizationInput>, maximumInFlightBytes: number, cold: boolean, };

export type LocalizationProvenance = { relativePath: string, size: number, modifiedTime: string, contentHash: string, };

export type LocalizationPreparedFile = { key: string, contentHash: string, provenance: LocalizationProvenance, relativePath: string, format: LocalizationFormat, inputBytes: number, parsed: boolean, snapshotBytes: number, };

export type LocalizationFileResult = { file: LocalizationPreparedFile | null, error: LocalizationDiagnostic | null, };

export type LocalizationImportOutcome = { lookupStrings: number, reusedStrings: number, files: ReadonlyArray<LocalizationFileResult>, workerCount: number, parseMs: number, parseCpuMs: number, publishMs: number, };

export type EngineRequest = { "action": "capabilities" } | { "action": "open", configuration: IndexConfiguration, expectedGeneration: string, expectedJoined: string, policy: EnginePolicy, } | { "action": "close", reader: string, } | { "action": "summary", reader: string, } | { "action": "query", reader: string, request: Query, } | { "action": "corpus", reader: string, } | { "action": "corpus_header", reader: string, } | { "action": "file_coverage", reader: string, files: ReadonlyArray<string>, } | { "action": "corpus_fingerprint", reader: string, } | { "action": "corpus_report_header", reader: string, } | { "action": "aggregate", reader: string, request: unknown, } | { "action": "localization_corpus", reader: string, } | { "action": "export", reader: string, request: unknown, } | { "action": "line", reader: string, request: LineRequest, } | { "action": "localization_export", reader: string, request: unknown, } | { "action": "findings_evaluate", reader: string, 
/**
 * The v4 rule document.
 */
rules: RuleDocumentV4, collationLocale: string, } | { "action": "findings_accept", reader: string, request: FindingsAcceptRequest, } | { "action": "findings_query", reader: string, request: FindingsQueryRequest, } | { "action": "rules_check", 
/**
 * The v4 rule document.
 */
rules: RuleDocumentV4, } | { "action": "code_text", request: CodeTextRequest, } | { "action": "compare_points", configuration: IndexConfiguration, request: ComparePointsRequest, } | { "action": "compare_text_files", request: CompareTextFilesRequest, };

export type CodeTextRequest = { projectRoot: string, 
/**
 * The engine installation root, holding `Engine/`. Without it, the engine's wrappers and
 * `LOCTABLE_FROMFILE_ENGINE` tables are left out, and the result says so.
 */
engineRoot: string | null, engine: EngineLine, targets: ReadonlyArray<CodeTarget>, 
/**
 * Where the engine's wrappers are kept between scans.
 */
cacheRoot: string | null, refreshEngineWrappers: boolean, };

export type CodeTarget = { name: string, steps: ReadonlyArray<GatherStep>, };

export type GatherStep = { searchDirectoryPaths: ReadonlyArray<string>, excludePathFilters: ReadonlyArray<string>, fileNameFilters: ReadonlyArray<string>, gatherEditorOnly: boolean, };

export type EngineLine = "4.27" | "5.7" | "5.8";

export type CodeTextResult = { engine: EngineLine, targets: ReadonlyArray<TargetText>, engineWrappers: EngineWrappers, wrapperCount: number, profile: CodeTextProfile, };

export type TargetText = { name: string, places: ReadonlyArray<CodePlace>, diagnostics: ReadonlyArray<CodeDiagnostic>, files: FileCounts, };

export type FileCounts = { 
/**
 * Files the steps' search folders and name filters found.
 */
listed: number, 
/**
 * Of those, files the exclude filters left out.
 */
excluded: number, 
/**
 * Files that held a descriptor token and went through the line scanner.
 */
scanned: number, 
/**
 * Files with no token, skipped after a substring search.
 */
skipped: number, bytesRead: number, };

export type EngineWrappers = "not-used" | "no-engine-root" | "read" | "cached";

export type CodeTextProfile = { engineWrappersMicros: number, projectWrappersMicros: number, listMicros: number, scanMicros: number, };

export type CodePlace = { 
/**
 * The file as Unreal names it, relative to the gather's base. For a String Table CSV entry,
 * the CSV path as the `LOCTABLE_FROMFILE_*` call wrote it.
 */
file: string, 
/**
 * 1-based; none for an entry imported from a CSV.
 */
line: number | null, 
/**
 * The macro that produced it, such as `LOCTEXT` or `LOCTABLE_SETSTRING`.
 */
macroName: string, 
/**
 * The `#define` wrapper the macro was expanded from, if any.
 */
wrapper: string | null, namespace: string, key: string, source: string, devNotes: string | null, metadata: ReadonlyArray<MetadataField>, 
/**
 * Inside `#if WITH_EDITOR` or `#if WITH_EDITORONLY_DATA` (exactly those spellings).
 */
editorOnly: boolean, 
/**
 * Whether the target gathers it: false for editor-only text in a target that leaves it out.
 */
gathered: boolean, 
/**
 * The split platform whose path holds the file, when the target splits platforms.
 */
platform: string | null, 
/**
 * The String Table ID, for String Table entries.
 */
table: string | null, };

export type MetadataField = { name: string, value: string, };

export type CodeDiagnostic = { file: string, line: number | null, code: DiagnosticCode, message: string, };

export type DiagnosticCode = "argument-count" | "argument-parse" | "unexpected-bracket" | "end-of-file" | "missing-bracket" | "missing-quotes" | "empty-identifier" | "empty-source" | "whitespace-only" | "no-namespace" | "namespace-redefined" | "namespace-not-defined" | "namespace-not-closed" | "region-redefined" | "region-not-defined" | "unterminated-string" | "unterminated-raw-string" | "table-redefined" | "table-entry-redefined" | "table-metadata-redefined" | "table-not-registered" | "table-import-failed" | "wrapper-unsupported" | "wrapper-duplicate" | "crashes-unreal427" | "unreadable";

export type ContractIdentity = { 
/**
 * The UE Shed suite version the engine was built for.
 */
buildId: string, 
/**
 * SHA-256 of the contract sources.
 */
contractHash: string, };

export type IndexConfiguration = { cacheRoot: string, projectKey: string, targetKey: string, sharedProject: boolean, viewPrefix?: string, };

export type EnginePolicy = { 
/**
 * The identities belonging to persisted occurrence audience codes, in producer order.
 * These are caller policy data, never native hard-coded classification constraints.
 */
audienceRules: ReadonlyArray<string>, };

export type OpenReply = { reader: string, generation: string, joinedKey: string, };

export type EngineEnd = { profile: EngineProfile, };

export type EngineFailure = { error: EngineError, profile: EngineProfile, };

export type EngineError = { code: "busy" | "cancelled" | "invalid_input" | "invalid_cache" | "limit_exceeded" | "stale_generation" | "unavailable" | "not_found" | "exists" | "io_error" | "internal", message: string, };

export type EngineProfile = { io: IoMetrics, stageSeconds: { [key in string]: number }, 
/**
 * Batches the request sent, and their bytes.
 */
batches: number, batchBytes: number, 
/**
 * How long the request waited for the host to consume its batches.
 */
creditStallMs: number, };

export type EngineProgress = { stage: string, completed: number, total?: number, 
/**
 * What `completed` and `total` count: `stages` or `rules`.
 */
unit: string, };

export type IoMetrics = { opens: number, sectionLoads: number, storedBytes: number, rawBytes: number, fullVerifies: number, indexBytes: number, writtenBytes: number, };

export type BatchHeader = { 
/**
 * The part of the answer the batch belongs to.
 */
part: string, 
/**
 * The relation its columns describe.
 */
relation: string, rows: number, columns: ReadonlyArray<ColumnHeader>, strings: StringsHeader, };

export type ColumnHeader = { name: string, type: ColumnType, 
/**
 * The values, or a list column's offsets.
 */
offset: number, 
/**
 * A list column's values.
 */
values?: number, 
/**
 * A bitset of the rows that have a value; absent when every row has one.
 */
validity?: number, 
/**
 * What a row without a value holds.
 */
missing: Missing, };

export type ColumnType = "u32" | "i32" | "f64" | "bool" | "str" | "json" | "u32List" | "strList";

export type Missing = "never" | "null" | "omit";

export type StringsHeader = { entries: number, 
/**
 * `u32` offsets, one per entry and one more, into `bytes`.
 */
offsets: number, bytes: number, 
/**
 * A bitset of the entries holding lone surrogates; absent when none does.
 */
loneSurrogates?: number, };

export type RuleDocumentV4 = { schemaVersion: 4, roles: ReadonlyArray<Role>, rules: ReadonlyArray<Rule>, };

export type Rule = { id: string, ruleId?: string, kind: string, label: string, subject: Subject, family: Family, enabled?: boolean, severity: Severity, params?: { [key: string]: JsonValue }, scope?: Scope, role?: string, 
/**
 * Named expressions, inlined where `var` reads them.
 */
let?: { [key: string]: Expr }, each?: Expr, eachAs?: string, when: Expr, actual: Expr, expectation: Expr, fix?: Expr, affected?: Expr, translationOrigin?: Expr, extra?: Expr, 
/**
 * Whether a finding is hidden where source findings list the same text: a bool per finding.
 */
shadowed?: Expr, recovery: Expr, counts?: boolean, };

export type Expr = { "lit": JsonValue } | { "list": ReadonlyArray<Expr> } | { "object": { [key: string]: Expr } } | { "field": string } | { "param": string } | { "var": string } | { "finding": string } | { "findingField": readonly [string, string] } | { "occurrences": readonly [] } | { "anyCulture": Expr } | { "everyCulture": Expr } | { "anyPlace": Expr } | { "facet": readonly [QueryFacet, Expr] } | { "not": Expr } | { "isNull": Expr } | { "utf16Length": Expr } | { "codePoints": Expr } | { "visibleLength": Expr } | { "visibleWords": Expr } | { "interiorLineBreaks": Expr } | { "trim": Expr } | { "lower": Expr } | { "normalizeLineEndings": Expr } | { "count": Expr } | { "flatten": Expr } | { "distinct": Expr } | { "first": Expr } | { "sortByStart": Expr } | { "formatArgumentNames": Expr } | { "formatArgumentOrder": Expr } | { "formatModifiers": Expr } | { "formatIssues": Expr } | { "formatCompiled": Expr } | { "richTextCounts": Expr } | { "richTextTagBalance": Expr } | { "unrealWhitespace": Expr } | { "unrealUnsafeWhitespace": Expr } | { "formatBraceBalance": Expr } | { "maxOf": Expr } | { "get": readonly [Expr, Expr] } | { "eq": readonly [Expr, Expr] } | { "ne": readonly [Expr, Expr] } | { "lt": readonly [Expr, Expr] } | { "le": readonly [Expr, Expr] } | { "gt": readonly [Expr, Expr] } | { "ge": readonly [Expr, Expr] } | { "in": readonly [Expr, Expr] } | { "sub": readonly [Expr, Expr] } | { "div": readonly [Expr, Expr] } | { "round": readonly [Expr, Expr] } | { "startsWith": readonly [Expr, Expr] } | { "endsWith": readonly [Expr, Expr] } | { "contains": readonly [Expr, Expr] } | { "countOccurrences": readonly [Expr, Expr] } | { "findAll": readonly [Expr, Expr] } | { "anyChar": readonly [Expr, Expr] } | { "allChars": readonly [Expr, Expr] } | { "removeClass": readonly [Expr, Expr] } | { "leadingClass": readonly [Expr, Expr] } | { "trailingClass": readonly [Expr, Expr] } | { "take": readonly [Expr, Expr] } | { "drop": readonly [Expr, Expr] } | { "minus": readonly [Expr, Expr] } | { "zip": readonly [Expr, Expr] } | { "matchesRole": readonly [Expr, Expr] } | { "pathHasPrefix": readonly [Expr, Expr] } | { "formatPattern": readonly [Expr, Expr] } | { "richTextValid": readonly [Expr, Expr] } | { "compareRichTextTags": readonly [Expr, Expr] } | { "withoutOptionalArgumentTags": readonly [Expr, Expr] } | { "if": readonly [Expr, Expr, Expr] } | { "slice": readonly [Expr, Expr, Expr] } | { "trimClass": readonly [Expr, Expr, Expr] } | { "runs": readonly [Expr, Expr, Expr] } | { "regexMatches": readonly [Expr, Expr, Expr] } | { "regexTest": readonly [Expr, Expr, Expr] } | { "termMatches": readonly [Expr, Expr, Expr] } | { "regexReplace": readonly [Expr, Expr, Expr] } | { "termListMatches": readonly [Expr, Expr, Expr, Expr] } | { "formatRenameArgument": readonly [Expr, Expr, Expr, Expr] } | { "and": ReadonlyArray<Expr> } | { "or": ReadonlyArray<Expr> } | { "coalesce": ReadonlyArray<Expr> } | { "add": ReadonlyArray<Expr> } | { "mul": ReadonlyArray<Expr> } | { "min": ReadonlyArray<Expr> } | { "max": ReadonlyArray<Expr> } | { "concat": ReadonlyArray<Expr> } | { "concatLists": ReadonlyArray<Expr> } | { "filter": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "map": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "flatMap": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "any": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "all": readonly [Expr, Expr] | readonly [Expr, Expr, string] } | { "sortCodeUnit": readonly [Expr] | readonly [Expr, Expr] } | { "sortLocale": readonly [Expr] | readonly [Expr, Expr] } | { "groupCount": { [argument: string]: Expr } } | { "groupRank": { [argument: string]: Expr } } | { "groupTake": { [argument: string]: Expr } } | { "groupTally": { [argument: string]: Expr } } | { "existsOther": { [argument: string]: Expr } } | { "corpusCount": { [argument: string]: Expr } };

export type Scope = { roles?: ReadonlyArray<string>, cultures?: ReadonlyArray<string>, pathPrefixes?: ReadonlyArray<string>, };

export type Role = { id: string, description?: string, scopes: ReadonlyArray<RoleScope>, };

export type RoleScope = { matchers: ReadonlyArray<RoleMatcher>, };

export type RoleMatcher = { kind: MatcherKind, operator?: MatchOperator, value: string, };

export type MatcherKind = "location_kind" | "object_path" | "row" | "property_path" | "string_table_entry" | "class_path";

export type MatchOperator = "exact" | "prefix";

export type Subject = "line" | "line_culture" | "unit_source";

export type Family = "builtin" | "policy" | "custom" | "source";

export type Severity = "blocking" | "normal" | "low";

export type FindingsEvaluation = { key: string, rules: ReadonlyArray<RuleMetadata>, counts: ReadonlyArray<RuleCount>, diagnosticCount: number, 
/**
 * The document's roles, in its order, with the places each matches.
 */
roles: ReadonlyArray<RoleTotal>, collation: string, profile: EvaluationProfile, };

export type RulesCheck = { problem: RuleProblem | null, };

export type RuleProblem = { ruleId?: string, code: RuleProblemCode, message: string, };

export type RuleProblemCode = "invalid_expression" | "rule_cycle" | "invalid_structure";

export type RuleMetadata = { id: string, ruleId: string, kind: string, label: string, subject: Subject, family: Family, severity: Severity, role: string | null, 
/**
 * Whether the rule's findings raise the `finding` problem.
 */
counts: boolean, };

export type RuleCount = { 
/**
 * The rule's position in `rules`.
 */
rule: number, culture: string | null, severity: Severity, count: number, };

export type RoleTotal = { role: string, matchedOccurrences: number, matchedTextUnits: number, };

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

export type FindingsAcceptRequest = { key: string, previous?: string, accepted: ReadonlyArray<AcceptedFinding>, };

export type AcceptedFinding = { check: string, culture?: string, namespace: string, key: string, fingerprint: string, };

export type FindingsQueryRequest = { key: string, view: FindingsView, culture?: string, rules?: ReadonlyArray<string>, severities?: ReadonlyArray<Severity>, fixable?: boolean, change?: boolean, acceptance?: string, line?: string, id?: string, order: FindingsOrder, after?: string, offset?: number, 
/**
 * The page's size; a sink writes every selected finding unless it is given.
 */
limit?: number, counts?: boolean, diagnostics?: FindingsPageRequest, 
/**
 * Writes the report view's findings as `findingJson` rather than sending them.
 */
sink?: Sink, };

export type Query = { selection: QuerySelection, parts: QueryParts, };

export type QuerySelection = { 
/**
 * The localization target whose lines are the rows.
 */
target?: string, 
/**
 * The culture the list shows: culture tests and problems read only it.
 */
culture?: string, 
/**
 * The list's culture scope and the cultures its tallies list; every culture when absent.
 */
cultures?: ReadonlyArray<string>, 
/**
 * The findings layer the `findings` field, problems, facets and groups read.
 */
findings?: FindingsSelection, 
/**
 * The rows' test: the Browse shapes of the rule IR, with facet marks.
 */
where?: Expr, text?: QueryText, };

export type QueryText = { query: string, translations?: boolean, };

export type FindingsSelection = { key: string, acceptance?: string, 
/**
 * Only the layer's source rules, as Browse without a target lists them.
 */
sourceOnly?: boolean, };

export type QueryFacet = "problem" | "fact" | "finding" | "folder" | "asset" | "origin" | "audience" | "assetType" | "capability" | "withoutNotes" | "kinds";

export type QueryParts = { rows?: RowsPart, openGroups?: OpenGroupsPart, 
/**
 * `counts`, `total`, `problems`, `fileScope` and the localization tallies.
 */
counts?: boolean, facets?: QueryFacets, groups?: GroupsPart, 
/**
 * Files the counts report on: how many hold matching text, lie outside the project or
 * were not scanned.
 */
fileScope?: ReadonlyArray<string>, };

export type RowsPart = { 
/**
 * At most this many rows; over 500 makes the request bulk.
 */
limit: number, 
/**
 * The ID of the row the previous page ended with.
 */
after?: string, 
/**
 * Only one group's rows.
 */
group?: GroupKey, };

export type GroupKey = { by: QueryGroupBy, key: string, };

export type OpenGroupsPart = { by: QueryGroupBy, keys: ReadonlyArray<string>, 
/**
 * Rows each group lists. Past 500 rows in all, a group and every one after it list none.
 */
firstRows: number, };

export type GroupsPart = { by: QueryGroupBy, 
/**
 * Only groups holding at least this many matching rows.
 */
minSize?: number, };

export type QueryGroupBy = "problem" | "folder" | "asset" | "origin" | "namespace" | "audience" | "source" | "finding";

export type QueryFacets = { 
/**
 * The folders under this path.
 */
folder?: string, assets?: boolean, origins?: boolean, audiences?: boolean, cultures?: boolean, assetTypes?: boolean, 
/**
 * Every rule of the findings layer, in program order, with the rows it has a finding on.
 */
findings?: boolean, 
/**
 * The rows with each fact.
 */
facts?: boolean, };

export type QueryAnswer = { counts?: JsonValue, total?: number, problems?: JsonValue, groups?: JsonValue, facets?: JsonValue, fileScope?: JsonValue, 
/**
 * The localization tallies, with a target and counts.
 */
localization?: { readonly [key: string]: JsonValue }, 
/**
 * The ID of the rows part's last row, when more follow.
 */
nextCursor?: string, openGroups?: ReadonlyArray<OpenGroupAnswer>, };

export type OpenGroupAnswer = { key: string, 
/**
 * The ID of its last row listed, when more follow.
 */
nextCursor?: string, 
/**
 * Past the row budget the group, and every one after it, lists none.
 */
rowsOmitted?: boolean, };

export type LineRequest = { selection: RowSelection, 
/**
 * The localization target whose lines and translations the sections read.
 */
target?: string, 
/**
 * The list's culture: the detail's problems read only it.
 */
culture?: string, 
/**
 * The list's culture scope.
 */
cultures?: ReadonlyArray<string>, 
/**
 * The findings layer whose rules the sections list.
 */
findings?: FindingsSelection, places?: PlacesSection, detail?: DetailSection, related?: RelatedSection, 
/**
 * The whole line, as a `lines` batch.
 */
line?: boolean, };

export type RowSelection = { kind: RowKind, id: string, };

export type RowKind = "line" | "unit";

export type PlacesSection = { unit?: string, limit: number, 
/**
 * The ID of the place the previous page ended with.
 */
after?: string, };

export type PackageTextSnapshotRequest = { shards: ReadonlyArray<PackageTextShard>, rules: ReadonlyArray<PackageTextAudienceRule>, recordFiles?: ReadonlyArray<string>, 
/**
 * Serialized stored records are boundary input; workers decode directly into typed records.
 */
records?: ReadonlyArray<string>, 
/**
 * The plan file `plan_packages` wrote: the reader reads the shards `groups` names from it,
 * and reads their selected packages, so the request lists none.
 */
planFile?: string, groups?: ReadonlyArray<number>, };

export type PackageTextPlanRequest = { 
/**
 * The Project Index cache root, project and generation the Catalog holds.
 */
cacheRoot: string, projectId: string, generation: number, 
/**
 * The shard key prefix: the package-text format, then the audience policy's JSON.
 */
format: string, policyJson: string, 
/**
 * Only these project-relative files changed; every other package keeps its stored entry.
 */
changedFiles?: ReadonlyArray<string>, 
/**
 * A new file the reader writes the changed shards' entries to, for staging.
 */
planFile: string, };

export type PackageTextPlan = { 
/**
 * Shards with packages whose key differs from the index's.
 */
changed: ReadonlyArray<PackageTextPlanShard>, 
/**
 * Shards the index holds that no package falls in any more.
 */
removed: ReadonlyArray<string>, packages: number, 
/**
 * Shard 0's key, the marker an empty inventory publishes.
 */
firstKey: string, };

export type CodeLayerRequest = { target: string, 
/**
 * The layer key prefix: the package-text format, then the audience policy's JSON.
 */
format: string, policyJson: string, rules: ReadonlyArray<PackageTextAudienceRule>, 
/**
 * A new file the reader stages the layer in.
 */
stagingFile: string, 
/**
 * One target, named `target`.
 */
scan?: CodeTextRequest, };

export type CodeLayerOutcome = { name: string, 
/**
 * The active key after the request; none when the layer was removed or never existed.
 */
key?: string, 
/**
 * Whether the request changed the active layer.
 */
published: boolean, 
/**
 * Code places in the layer, and of those, the ones the target's gather leaves out.
 */
places: number, leftOut: number, 
/**
 * Files with at least one place.
 */
files: number, counts?: FileCounts, diagnosticCount: number, 
/**
 * The first [`CODE_DIAGNOSTIC_SAMPLES`] diagnostics, in scan order.
 */
diagnostics: ReadonlyArray<CodeDiagnostic>, engineWrappers?: EngineWrappers, profile?: CodeTextProfile, };

export type PointFile = { 
/**
 * Relative to the project folder, as the project spells it.
 */
path: string, 
/**
 * The file holding its bytes at this point; none when the point removes it.
 */
file?: string, };

export type PointCode = { policyJson: string, 
/**
 * One target, as `publish_code` scans it.
 */
scan: CodeTextRequest, };

export type PointRequest = { 
/**
 * The point's id, such as `depot@220368` or `shelved:220258`.
 */
point: string, 
/**
 * The point this one changes, by id; none when it changes the project's index as it is.
 */
base?: string, 
/**
 * The record key prefix: the package-text format, then the saved-text policy's JSON.
 */
format: string, policyJson: string, rules: ReadonlyArray<PackageTextAudienceRule>, files: ReadonlyArray<PointFile>, 
/**
 * How the target reads code; without it, code files are `unread`.
 */
code?: PointCode, };

export type PointEntry = { path: string, 
/**
 * The record's key; none for a removed file or one no record describes.
 */
record?: string, status: PointFileStatus, };

export type PointFileStatus = "complete" | "partial" | "not_gatherable" | "failed" | "removed" | "unread";

export type PointOutcome = { point: string, 
/**
 * Records read from their files now.
 */
read: number, 
/**
 * Records already in the cache.
 */
reused: number, 
/**
 * Bytes of the files read: every file is hashed; only misses are parsed.
 */
bytes: number, entries: ReadonlyArray<PointEntry>, };

export type ComparePointsRequest = { point: string, base: string, 
/**
 * Whether the target gathers editor-only text from packages; when not, such package text is
 * left out of both points. Code text follows each gather step, as the scan marked it.
 */
gatherEditorOnly: boolean, 
/**
 * The target's manifest and archives at the base; without them there are no findings.
 */
localization?: BaseLocalization, changes: PageRequest, findings: PageRequest, };

export type PageRequest = { offset: number, limit: number, };

export type BaseLocalization = { nativeCulture: string, manifest: LocalizationRevision, archives: ReadonlyArray<CultureArchive>, };

export type LocalizationRevision = { path: string, file: string, revision: string, };

export type CultureArchive = { culture: string, archive: LocalizationRevision, };

export type PointChangeKind = "added" | "removed" | "rekeyed" | "edited";

export type PointPlaceKind = "asset_property" | "data_table_cell" | "string_table_entry" | "code";

export type PointPlace = { kind: PointPlaceKind, object: string, 
/**
 * DataTable row or String Table entry key; empty otherwise.
 */
entry: string, 
/**
 * Property chain, or the macro in code.
 */
property: string, line?: number, };

export type PointIdentityStatus = "resolved" | "string_table" | "culture_invariant" | "missing_key";

export type PointText = { status: PointIdentityStatus, namespace: string, key: string, source: string, notes: string, };

export type PointChange = { kind: PointChangeKind, path: string, place: PointPlace, before?: PointText, after?: PointText, sourceChanged: boolean, notesChanged: boolean, };

export type PointChangeCounts = { added: number, removed: number, rekeyed: number, edited: number, unchanged: number, };

export type GateCheck = "key_changed" | "conflicting_source" | "translated_text_changed" | "text_changed" | "not_gathered" | "unresolved_key" | "removed" | "gathered_source" | "partial_read";

export type PointFinding = { check: GateCheck, path: string, 
/**
 * The key the finding is about; none for a file's finding or text with no key.
 */
namespace?: string, key?: string, source: string, 
/**
 * The cultures whose translations the change makes stale or leaves behind.
 */
cultures: ReadonlyArray<string>, 
/**
 * For a key change, the earlier key.
 */
earlier?: PointKey, };

export type PointKey = { namespace: string, key: string, };

export type PointFindingCounts = { keyChanged: number, conflictingSource: number, translatedTextChanged: number, textChanged: number, notGathered: number, unresolvedKey: number, removed: number, gatheredSource: number, partialRead: number, };

export type PointFindings = { counts: PointFindingCounts, total: number, rows: ReadonlyArray<PointFinding>, 
/**
 * Whether the lookup was built from the files now, rather than found.
 */
built: boolean, };

export type PointComparison = { point: string, base: string, counts: PointChangeCounts, complete: boolean, total: number, changes: ReadonlyArray<PointChange>, findings?: PointFindings, stageSeconds: { [key in string]: number }, };

export type CompareTextFilesRequest = { options: LocalizationOptions, before?: TextFileSide, after?: TextFileSide, filter: TextFileFilter, changes: PageRequest, };

export type TextFileSide = { 
/**
 * The file on disk.
 */
file: string, 
/**
 * The name it is reported under, such as its depot path and revision.
 */
path: string, };

export type TextFileFilter = { 
/**
 * Only these groups; every group when empty.
 */
groups: ReadonlyArray<TextFileGroup>, 
/**
 * Only changes whose key, namespace or any field holds this text, ignoring case.
 */
query: string, 
/**
 * At most this many changes of each group, for an overview; every change when 0.
 */
preview: number, 
/**
 * Only changes from this asset, as the rollup names it; every asset when empty.
 */
asset: string, };

export type TextFileGroup = "rekeyed" | "reworded" | "retouched" | "removed" | "added" | "translation" | "carried" | "context";

export type TextFileCounts = { rekeyed: number, reworded: number, retouched: number, removed: number, added: number, translation: number, carried: number, context: number, unchanged: number, };

export type TextFileAsset = { group: TextFileGroup, asset: string, 
/**
 * The asset's name in the older file, when its entries now point at a renamed asset.
 */
previous?: string, count: number, 
/**
 * New keys among them where a key someone wrote became one Unreal generated.
 */
generated: number, };

export type TextFileFieldName = "source" | "source_plural" | "translation" | "path" | "notes" | "comments" | "references" | "flags";

export type TextFileField = { name: TextFileFieldName, 
/**
 * The PO plural form of a translation.
 */
form?: number, before?: string, after?: string, };

export type TextFileKey = { namespace: string, key: string, };

export type TextFileChange = { kind: PointChangeKind, group: TextFileGroup, before?: TextFileKey, after?: TextFileKey, fields: ReadonlyArray<TextFileField>, };

export type TextFileComparison = { format: LocalizationFormat, 
/**
 * The PO dialect read from the newer side, such as "Crowdin".
 */
poFormat?: string, counts: TextFileCounts, 
/**
 * Changes per group that hold the filter's text: `counts` when there is none.
 */
listed: TextFileCounts, 
/**
 * Changes the filter lists, in all pages.
 */
total: number, 
/**
 * Per group, the assets most of its changes come from, most first.
 */
assets: ReadonlyArray<TextFileAsset>, changes: ReadonlyArray<TextFileChange>, 
/**
 * Whether the comparison was kept from the previous request for the same revisions.
 */
kept: boolean, stageSeconds: { [key in string]: number }, };

export type PackageTextPlanShard = { group: number, key: string, packages: number, selected: number, };

export type PackageTextShard = { group: number, expected: ReadonlyArray<PackageTextExpected>, };

export type PackageTextExpected = { path: string, signature: string, selected: boolean, };

export type PackageTextAudienceRule = { code: number, when: ReadonlyArray<PackageTextAudienceMatch>, };

export type PackageTextAudienceMatch = { "kind": "namespace", value: string, } | { "kind": "folder", value: string, } | { "kind": "object", value: string, position: PackageTextObjectPosition, } | { "kind": "module", value: string, suffix?: boolean, } | { "kind": "property", value: string, anywhere?: boolean, } | { "kind": "location", value: string, } | { "kind": "macro", value: string, };

export type PackageTextObjectPosition = "prefix" | "suffix" | "equals";

export type DetailSection = { cultureOffset?: number, locationOffset?: number, poContextOffset?: number, };

export type RelatedSection = { 
/**
 * Places each unit member lists.
 */
limit: number, };

export type LineAnswer = { places?: JsonValue, detail?: JsonValue, related?: JsonValue, };

export type Sink = { format: SinkFormat, 
/**
 * An absolute path. The file is written beside it and moved into place when complete.
 */
file?: string, 
/**
 * Fail with `exists` rather than replace a file already at `file`.
 */
exclusive?: boolean, 
/**
 * For a JSON array format, the document around the array.
 */
envelope?: Envelope, };

export type Envelope = { before: string, after: string, depth: number, };

export type SinkFormat = "corpusCsv" | "corpusJson" | "cultureLinesCsv" | "findingJson";

export type SinkSummary = { 
/**
 * Rows written, not counting a header.
 */
rows: number, bytes: number, };

export type FindingsView = "workspace" | "report";

export type FindingsOrder = "severity" | "report" | "line" | "source";

export type FindingsPageRequest = { offset?: number, limit: number, };

export type FindingsPage = { profile: ReadProfile, 
/**
 * What the request's sink wrote.
 */
sink?: SinkSummary, 
/**
 * Findings every filter selects.
 */
total: number, counts?: FindingCounts, diagnostics?: FindingDiagnostics, 
/**
 * Milliseconds per stage: select, order, page, compose and counts.
 */
stages: { [stage: string]: number }, };

export type FindingCounts = { 
/**
 * Findings in the view and the culture selection, accepted ones left out.
 */
all: number, rules: ReadonlyArray<RuleTotal>, severities: { blocking: number, normal: number, low: number }, 
/**
 * Findings in the view and the culture selection the acceptance key hid.
 */
accepted: number, 
/**
 * Findings every filter selects, and those of them with an acceptable change.
 */
total: number, fixable: number, 
/**
 * Diagnostics in the culture selection by code, in first-seen order.
 */
limits: ReadonlyArray<CodeCount>, };

export type RuleTotal = { ruleId: string, count: number, };

export type CodeCount = { code: string, count: number, };

export type FindingDiagnostics = { total: number, rows: ReadonlyArray<LineDiagnostic>, };

export type LineDiagnostic = { lineId: string, culture: string, code: string, };

export type PlaceSet = { id: number, occurrences: ReadonlyArray<Place>, };

export type Place = { id: string, location: { readonly [key: string]: JsonValue }, packageFile: string, };

export type ReadProfile = { rowsRequested: number, findingsReturned: number, };

/** Each relation's columns: their wire type, and what a row without a value holds. */
export type Relations = {
	readonly group: {
		readonly key: { readonly type: "strList"; readonly missing: "never" };
		readonly lines: { readonly type: "u32"; readonly missing: "never" };
		readonly sourceWords: { readonly type: "f64"; readonly missing: "omit" };
		readonly lineBreakWords: { readonly type: "f64"; readonly missing: "omit" };
		readonly unknownWords: { readonly type: "f64"; readonly missing: "omit" };
	};
	readonly unit: {
		readonly id: { readonly type: "str"; readonly missing: "never" };
		readonly identity: { readonly type: "json"; readonly missing: "never" };
		readonly source: { readonly type: "json"; readonly missing: "never" };
		readonly reviewSignals: { readonly type: "strList"; readonly missing: "never" };
		readonly findings: { readonly type: "strList"; readonly missing: "omit" };
		readonly findingsOmitted: { readonly type: "u32"; readonly missing: "omit" };
	};
	readonly place: {
		readonly parent: { readonly type: "u32"; readonly missing: "never" };
		readonly devNotes: { readonly type: "str"; readonly missing: "omit" };
		readonly id: { readonly type: "str"; readonly missing: "never" };
		readonly packageFile: { readonly type: "str"; readonly missing: "never" };
		readonly objectPath: { readonly type: "str"; readonly missing: "never" };
		readonly origin: { readonly type: "str"; readonly missing: "never" };
		readonly source: { readonly type: "str"; readonly missing: "never" };
		readonly identity: { readonly type: "json"; readonly missing: "never" };
		readonly location: { readonly type: "json"; readonly missing: "never" };
		readonly editCapability: { readonly type: "str"; readonly missing: "never" };
		readonly audience: { readonly type: "str"; readonly missing: "omit" };
		readonly audienceReason: { readonly type: "str"; readonly missing: "omit" };
		readonly audienceRule: { readonly type: "str"; readonly missing: "omit" };
		readonly copies: { readonly type: "json"; readonly missing: "omit" };
	};
	readonly package: {
		readonly packageFile: { readonly type: "str"; readonly missing: "never" };
		readonly status: { readonly type: "str"; readonly missing: "never" };
	};
	readonly diagnostic: {
		readonly code: { readonly type: "str"; readonly missing: "never" };
		readonly message: { readonly type: "str"; readonly missing: "never" };
		readonly packageFile: { readonly type: "str"; readonly missing: "never" };
		readonly objectPath: { readonly type: "str"; readonly missing: "omit" };
		readonly propertyPath: { readonly type: "str"; readonly missing: "omit" };
		readonly coverageGapCounts: { readonly type: "json"; readonly missing: "omit" };
	};
	readonly line: {
		readonly id: { readonly type: "str"; readonly missing: "never" };
		readonly origin: { readonly type: "json"; readonly missing: "never" };
		readonly identity: { readonly type: "json"; readonly missing: "null" };
		readonly source: { readonly type: "str"; readonly missing: "never" };
		readonly manifest: { readonly type: "json"; readonly missing: "never" };
		readonly cultures: { readonly type: "json"; readonly missing: "never" };
		readonly keyChange: { readonly type: "json"; readonly missing: "omit" };
		readonly audience: { readonly type: "str"; readonly missing: "omit" };
		readonly outOfScope: { readonly type: "str"; readonly missing: "omit" };
		readonly marks: { readonly type: "json"; readonly missing: "never" };
		readonly problems: { readonly type: "strList"; readonly missing: "never" };
		readonly signals: { readonly type: "strList"; readonly missing: "never" };
	};
	readonly finding: {
		readonly finding: { readonly type: "json"; readonly missing: "never" };
	};
	readonly browseUnit: {
		readonly parent: { readonly type: "u32"; readonly missing: "omit" };
		readonly id: { readonly type: "str"; readonly missing: "never" };
		readonly identity: { readonly type: "json"; readonly missing: "never" };
		readonly source: { readonly type: "json"; readonly missing: "never" };
		readonly contexts: { readonly type: "json"; readonly missing: "never" };
		readonly occurrenceCount: { readonly type: "u32"; readonly missing: "never" };
		readonly remainingContextCount: { readonly type: "u32"; readonly missing: "never" };
		readonly characterCount: { readonly type: "u32"; readonly missing: "never" };
		readonly wordCount: { readonly type: "u32"; readonly missing: "never" };
		readonly reviewSignals: { readonly type: "strList"; readonly missing: "never" };
		readonly locationKinds: { readonly type: "strList"; readonly missing: "never" };
		readonly audience: { readonly type: "str"; readonly missing: "never" };
		readonly localization: { readonly type: "json"; readonly missing: "omit" };
		readonly problems: { readonly type: "strList"; readonly missing: "never" };
		readonly findings: { readonly type: "strList"; readonly missing: "omit" };
		readonly findingsOmitted: { readonly type: "u32"; readonly missing: "omit" };
	};
	readonly browseLine: {
		readonly parent: { readonly type: "u32"; readonly missing: "omit" };
		readonly id: { readonly type: "str"; readonly missing: "never" };
		readonly source: { readonly type: "str"; readonly missing: "never" };
		readonly identity: { readonly type: "json"; readonly missing: "never" };
		readonly audience: { readonly type: "str"; readonly missing: "never" };
		readonly manifestLocations: { readonly type: "strList"; readonly missing: "never" };
		readonly remainingLocationCount: { readonly type: "u32"; readonly missing: "never" };
		readonly origin: { readonly type: "json"; readonly missing: "never" };
		readonly cultures: { readonly type: "json"; readonly missing: "never" };
		readonly outOfScope: { readonly type: "str"; readonly missing: "omit" };
		readonly keyChange: { readonly type: "json"; readonly missing: "omit" };
		readonly problems: { readonly type: "strList"; readonly missing: "never" };
		readonly findings: { readonly type: "strList"; readonly missing: "omit" };
		readonly findingsOmitted: { readonly type: "u32"; readonly missing: "omit" };
	};
};
}
