import { Effect, Schema } from "effect";
import { TextUnitId, TextOccurrenceId } from "./identifiers.js";
import {
	LocalizationCultureMark,
	LocalizationLine,
	LocalizationLineId,
	LocalizationQueryPage,
	LocalizationSelection
} from "./localization-schema.js";
export * from "./identifiers.js";

export const UnrealTextIdentity = Schema.Struct({
	status: Schema.Literal("resolved"),
	namespace: Schema.String,
	key: Schema.NonEmptyString
});

export const UnresolvedTextIdentity = Schema.Struct({
	status: Schema.Literal("unresolved"),
	reason: Schema.Literals(["culture_invariant", "missing_key"])
});

export const StringTableTextIdentity = Schema.Struct({
	status: Schema.Literal("string_table"),
	tableId: Schema.String,
	key: Schema.NonEmptyString
});

export const TextIdentity = Schema.Union([
	UnrealTextIdentity,
	StringTableTextIdentity,
	UnresolvedTextIdentity
]);
export type TextIdentity = Schema.Schema.Type<typeof TextIdentity>;

export const TextLocation = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("data_table_cell"),
		objectPath: Schema.String,
		row: Schema.String,
		propertyPath: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("string_table_entry"),
		objectPath: Schema.String,
		entryKey: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("asset_property"),
		objectPath: Schema.String,
		classPath: Schema.String,
		propertyPath: Schema.String
	})
]);
export type TextLocation = Schema.Schema.Type<typeof TextLocation>;

export const TextOccurrence = Schema.Struct({
	devNotes: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
	id: TextOccurrenceId,
	packageFile: Schema.String,
	source: Schema.String,
	identity: TextIdentity,
	location: TextLocation,
	editCapability: Schema.Literals(["source_editable", "read_only"])
});
export type TextOccurrence = Schema.Schema.Type<typeof TextOccurrence>;

export const TextUnit = Schema.Struct({
	id: TextUnitId,
	source: Schema.Union([
		Schema.Struct({ status: Schema.Literal("consistent"), value: Schema.String }),
		Schema.Struct({
			status: Schema.Literal("conflicting"),
			values: Schema.Array(Schema.String).check(Schema.isMinLength(2))
		})
	]),
	identity: TextIdentity,
	occurrences: Schema.Array(TextOccurrence)
});
export type TextUnit = Schema.Schema.Type<typeof TextUnit>;

export const TextCorpusDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"package_inspection_failed",
		"package_partially_decoded",
		"unsupported_text_history"
	]),
	message: Schema.String,
	packageFile: Schema.String,
	objectPath: Schema.optional(Schema.String),
	propertyPath: Schema.optional(Schema.String)
});
export type TextCorpusDiagnostic = Schema.Schema.Type<typeof TextCorpusDiagnostic>;

/** Package completion is needed to prove absence, including packages with zero text. */
export const TextPackageCoverage = Schema.Struct({
	packageFile: Schema.String,
	status: Schema.Literals(["complete", "partial", "failed"])
});
export type TextPackageCoverage = typeof TextPackageCoverage.Type;

export const TextCorpus = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	coverage: Schema.Struct({
		discoveredPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		inspectedPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		partialPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		failedPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		textUnits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		textOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		resolvedOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		unresolvedOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		unsupportedTextProperties: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	units: Schema.Array(TextUnit),
	packageCoverage: Schema.optionalKey(Schema.Array(TextPackageCoverage)),
	diagnostics: Schema.Array(TextCorpusDiagnostic)
});
export type TextCorpus = Schema.Schema.Type<typeof TextCorpus>;

export const TextCorpusPublicError = Schema.Struct({
	code: Schema.Literals(["invalid_project", "scan_limit_exceeded", "contract_failure"]),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
});
export type TextCorpusPublicError = Schema.Schema.Type<typeof TextCorpusPublicError>;

export const TextCorpusRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), corpus: TextCorpus }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type TextCorpusRunResult = Schema.Schema.Type<typeof TextCorpusRunResult>;

export const decodeTextCorpusRunResult = Schema.decodeUnknownEffect(TextCorpusRunResult);

/** Upper bound applied at the public query boundary, including Workbench IPC. */
export const MAX_TEXT_QUERY_PAGE_SIZE = 50;

const TextQueryPageSize = Schema.Int.pipe(
	Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_TEXT_QUERY_PAGE_SIZE }))
);

/** A changed-file list is bounded: larger changes should be split or filtered first. */
export const MAX_TEXT_SCOPE_FILES = 5000;

export const TextCapabilityFilter = Schema.Literals(["all", "source_editable", "read_only"]);
export type TextCapabilityFilter = Schema.Schema.Type<typeof TextCapabilityFilter>;

/**
 * Where text comes from: a String Table entry, a DataTable cell, another asset property, C++
 * source gathered by Unreal, or another gathered source such as config or text files.
 */
export const TextOriginKind = Schema.Literals([
	"string_table",
	"data_table",
	"asset",
	"cpp",
	"other_source"
]);
export type TextOriginKind = Schema.Schema.Type<typeof TextOriginKind>;

/**
 * Location filters: any of the given origin kinds, a path prefix, and a list of changed files
 * (project-relative package or source files, or `/Game` package paths).
 */
export const TextWhere = Schema.Struct({
	kinds: Schema.optionalKey(
		Schema.Array(TextOriginKind).check(Schema.isMinLength(1), Schema.isMaxLength(5))
	),
	pathPrefix: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
	),
	files: Schema.optionalKey(
		Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_TEXT_SCOPE_FILES)
		)
	)
});
export type TextWhere = Schema.Schema.Type<typeof TextWhere>;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * How a changed-file list relates to the project: how many files it names, how many contain text
 * in the results, how many lie outside the project, and how many saved packages were not scanned
 * (unknown when the corpus predates package coverage).
 */
export const TextFileScopeSummary = Schema.Struct({
	files: Count,
	textFiles: Count,
	outside: Count,
	notScanned: Schema.optionalKey(Count)
});
export type TextFileScopeSummary = Schema.Schema.Type<typeof TextFileScopeSummary>;

export const TextReviewLens = Schema.Literals([
	"all",
	"shared",
	"duplicate_source",
	"long",
	"unresolved",
	"conflicting"
]);
export type TextReviewLens = Schema.Schema.Type<typeof TextReviewLens>;

export const TextReviewSignal = Schema.Literals([
	"shared",
	"duplicate_source",
	"long",
	"unresolved",
	"conflicting",
	"evidence_only"
]);
export type TextReviewSignal = Schema.Schema.Type<typeof TextReviewSignal>;

/**
 * What stands between a line and shipping, worst first. Key problems lose or mix up translations;
 * not gathered and changed since gather wait on Unreal; translation work waits on a culture in
 * scope; findings are worth a look but block nothing. A line with none is up to date.
 */
export const TextProblem = Schema.Literals([
	"key_changed",
	"conflicting_source",
	"not_gathered",
	"changed_since_gather",
	"translation",
	"finding",
	"up_to_date"
]);
export type TextProblem = Schema.Schema.Type<typeof TextProblem>;

/** Findings: reused text, the same text under different keys, long text, unlocalizable text. */
export const TextFinding = Schema.Literals(["shared", "duplicate_source", "long", "unresolved"]);
export type TextFinding = Schema.Schema.Type<typeof TextFinding>;

/** Translation work in one culture: no translation, one written for older text, or not in Unreal. */
export const TextTranslationState = Schema.Literals(["missing", "to_update", "not_synced"]);
export type TextTranslationState = Schema.Schema.Type<typeof TextTranslationState>;

export const TextEditing = Schema.Literals(["editable", "read_only"]);
export type TextEditing = Schema.Schema.Type<typeof TextEditing>;

export const TextNotes = Schema.Literals(["missing", "present"]);
export type TextNotes = Schema.Schema.Type<typeof TextNotes>;

const ClauseOp = Schema.Literals(["is", "is_not"]);
const clause = <const Field extends string, Value extends Schema.Top>(
	field: Field,
	value: Value,
	max: number
) =>
	Schema.Struct({
		field: Schema.Literal(field),
		op: ClauseOp,
		values: Schema.Array(value).check(Schema.isMinLength(1), Schema.isMaxLength(max))
	});

/**
 * One filter pill: a line matches `is` when it has any of the values, and `is_not` when it has
 * none of them. Folders match by path prefix.
 */
export const TextFilterClause = Schema.Union([
	clause("problem", TextProblem, TextProblem.literals.length),
	clause("finding", TextFinding, TextFinding.literals.length),
	clause("translation", TextTranslationState, TextTranslationState.literals.length),
	clause("origin", TextOriginKind, TextOriginKind.literals.length),
	clause("folder", Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)), 50),
	clause("asset", Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)), 200),
	clause("namespace", Schema.String.check(Schema.isMaxLength(1024)), 50),
	clause("editing", TextEditing, TextEditing.literals.length),
	clause("notes", TextNotes, TextNotes.literals.length)
]);
export type TextFilterClause = Schema.Schema.Type<typeof TextFilterClause>;
export type TextFilterField = TextFilterClause["field"];

/** Every clause must match. */
export const TextFilter = Schema.Array(TextFilterClause).check(Schema.isMaxLength(32));
export type TextFilter = Schema.Schema.Type<typeof TextFilter>;

export const TextProblemCounts = Schema.Struct({
	key_changed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	conflicting_source: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	not_gathered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	changed_since_gather: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	translation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	finding: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	up_to_date: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type TextProblemCounts = Schema.Schema.Type<typeof TextProblemCounts>;

export const MAX_TEXT_GROUPS = 200;

export const TextGroupBy = Schema.Literals(["problem", "folder", "asset", "origin", "namespace"]);
export type TextGroupBy = Schema.Schema.Type<typeof TextGroupBy>;

/**
 * One group or facet entry: its key (a problem, a normalized folder or file, an origin, a
 * namespace), how it reads, how many lines it holds, how many need work before they ship, and its
 * worst problem.
 */
export const TextGroup = Schema.Struct({
	key: Schema.String.check(Schema.isMaxLength(1024)),
	label: Schema.String.check(Schema.isMaxLength(1024)),
	count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	needWork: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	worst: TextProblem
});
export type TextGroup = Schema.Schema.Type<typeof TextGroup>;

/** Bounded entries, worst first, with how many more there are. */
export const TextGroupList = Schema.Struct({
	entries: Schema.Array(TextGroup).check(Schema.isMaxLength(MAX_TEXT_GROUPS)),
	more: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type TextGroupList = Schema.Schema.Type<typeof TextGroupList>;

/** Which facets a page should count. Each facet leaves out its own filter clauses. */
export const TextFacetRequest = Schema.Struct({
	/** List the folders directly under this one; empty for the project's top folders. */
	folder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
	assets: Schema.optionalKey(Schema.Boolean),
	origins: Schema.optionalKey(Schema.Boolean),
	cultures: Schema.optionalKey(Schema.Boolean)
});
export type TextFacetRequest = Schema.Schema.Type<typeof TextFacetRequest>;

/** Per-culture translation work for the culture picker, over the request without its culture set. */
export const TextCultureFacet = Schema.Struct({
	culture: Schema.String,
	lines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	shipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	missing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	toUpdate: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	notSynced: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type TextCultureFacet = Schema.Schema.Type<typeof TextCultureFacet>;

export const TextFacets = Schema.Struct({
	folders: Schema.optionalKey(Schema.Struct({ under: Schema.String, ...TextGroupList.fields })),
	assets: Schema.optionalKey(TextGroupList),
	origins: Schema.optionalKey(TextGroupList),
	cultures: Schema.optionalKey(Schema.Array(TextCultureFacet).check(Schema.isMaxLength(256)))
});
export type TextFacets = Schema.Schema.Type<typeof TextFacets>;

/** A bounded authored/gathered location preview carried by corpus search results. */
export const TextUnitContext = Schema.Struct({
	editCapability: TextOccurrence.fields.editCapability,
	location: TextLocation
});
export interface TextUnitContext extends Schema.Schema.Type<typeof TextUnitContext> {}

export const TextUnitSearchResult = Schema.Struct({
	localization: Schema.optionalKey(Schema.Array(LocalizationCultureMark)),
	contexts: Schema.Array(TextUnitContext).check(Schema.isMaxLength(3)),
	id: TextUnitId,
	source: TextUnit.fields.source,
	identity: TextIdentity,
	locationKinds: Schema.Array(
		Schema.Literals(["data_table_cell", "string_table_entry", "asset_property"])
	),
	characterCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	occurrenceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	remainingContextCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	reviewSignals: Schema.Array(TextReviewSignal),
	wordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type TextUnitSearchResult = Schema.Schema.Type<typeof TextUnitSearchResult>;

export const TextCorpusSearchCounts = Schema.Struct({
	// Review counts intersect the whole request. Toggle counts exclude their own toggle.
	all: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	shared: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	duplicate_source: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	long: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	unresolved: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	conflicting: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	editable: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	readOnly: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	withoutNotes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	// Origin counts exclude the origin filter itself, like the toggle counts.
	origins: Schema.Struct({
		string_table: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		data_table: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		asset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		cpp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		other_source: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	})
});
export type TextCorpusSearchCounts = Schema.Schema.Type<typeof TextCorpusSearchCounts>;

export const TextCorpusQuerySummary = Schema.Struct({
	counts: TextCorpusSearchCounts,
	scannedAt: Schema.optional(Schema.String),
	// Scan coverage remains raw provenance; presentation counts exclude blank source lines.
	searchable: Schema.Struct({
		textUnits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		textOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	schemaVersion: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	coverage: TextCorpus.fields.coverage,
	diagnosticCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	review: Schema.Struct({
		all: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		shared: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		duplicateSource: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		long: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		unresolved: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		conflicting: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	sources: Schema.Struct({
		assetProperty: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		dataTable: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		mixed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		stringTable: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	})
});
export type TextCorpusQuerySummary = Schema.Schema.Type<typeof TextCorpusQuerySummary>;

export const TextCorpusQueryRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_scanned") }),
	Schema.Struct({ status: Schema.Literal("completed"), summary: TextCorpusQuerySummary }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type TextCorpusQueryRunResult = Schema.Schema.Type<typeof TextCorpusQueryRunResult>;
export const decodeTextCorpusQueryRunResult = Schema.decodeUnknownEffect(TextCorpusQueryRunResult);

export const TextCorpusSearchRequest = Schema.Struct({
	localization: Schema.optionalKey(LocalizationSelection),
	localizationCursor: Schema.optionalKey(LocalizationLineId),
	withoutNotes: Schema.optional(Schema.Boolean),
	capability: TextCapabilityFilter,
	cursor: Schema.optional(TextUnitId),
	lens: Schema.optional(TextReviewLens),
	where: Schema.optionalKey(TextWhere),
	/** Filter pills, applied on top of the other fields. */
	filter: Schema.optionalKey(TextFilter),
	/** Count the matching lines in groups; the page lists the open group's lines, if any. */
	group: Schema.optionalKey(TextGroupBy),
	openGroup: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
	facets: Schema.optionalKey(TextFacetRequest),
	pageSize: TextQueryPageSize,
	query: Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))
});
export type TextCorpusSearchRequest = Schema.Schema.Type<typeof TextCorpusSearchRequest>;

export const TextCorpusSearchPage = Schema.Struct({
	localization: Schema.optionalKey(LocalizationQueryPage),
	fileScope: Schema.optionalKey(TextFileScopeSummary),
	/** Lines with each problem, over the request without its problem clauses. */
	problems: Schema.optionalKey(TextProblemCounts),
	/** Every group of the matching lines, when the request groups them. */
	groups: Schema.optionalKey(Schema.Struct({ by: TextGroupBy, ...TextGroupList.fields })),
	facets: Schema.optionalKey(TextFacets),
	counts: TextCorpusSearchCounts,
	nextCursor: Schema.optional(TextUnitId),
	total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	units: Schema.Array(TextUnitSearchResult).check(Schema.isMaxLength(MAX_TEXT_QUERY_PAGE_SIZE))
});
export type TextCorpusSearchPage = Schema.Schema.Type<typeof TextCorpusSearchPage>;

export const TextCorpusSearchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), page: TextCorpusSearchPage }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type TextCorpusSearchResult = Schema.Schema.Type<typeof TextCorpusSearchResult>;
export const decodeTextCorpusSearchResult = Schema.decodeUnknownEffect(TextCorpusSearchResult);

export const TextCorpusFocusRequest = Schema.Struct({
	id: TextUnitId,
	occurrenceCursor: Schema.optional(TextOccurrenceId),
	pageSize: TextQueryPageSize
});
export type TextCorpusFocusRequest = Schema.Schema.Type<typeof TextCorpusFocusRequest>;

export const TextCorpusFocus = Schema.Struct({
	localization: Schema.optionalKey(LocalizationLine),
	diagnostics: Schema.Array(TextCorpusDiagnostic),
	nextOccurrenceCursor: Schema.optional(TextOccurrenceId),
	occurrences: Schema.Array(TextOccurrence),
	totalOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	unit: TextUnitSearchResult
});
export type TextCorpusFocus = Schema.Schema.Type<typeof TextCorpusFocus>;

export const TextCorpusFocusResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("found"), focus: TextCorpusFocus }),
	Schema.Struct({ status: Schema.Literal("not_found") }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type TextCorpusFocusResult = Schema.Schema.Type<typeof TextCorpusFocusResult>;
export const decodeTextCorpusFocusResult = Schema.decodeUnknownEffect(TextCorpusFocusResult);
