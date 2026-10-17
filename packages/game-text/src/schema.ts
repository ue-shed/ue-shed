import { Effect, Schema } from "effect";
import { SavedAssetTextCoverageGap } from "@ue-shed/unreal-assets/text-extraction";
import { TextUnitId, TextOccurrenceId } from "./identifiers.js";
import {
	LocalizationCultureMark,
	LocalizationLine,
	LocalizationLineId,
	LocalizationQueryPage,
	LocalizationSelection
} from "./localization-schema.js";
import { TextAudience, TextAudienceReason } from "./text-audience-schema.js";
import { gameTextResponseParser } from "./response-parser.js";
export * from "./identifiers.js";
export * from "./text-audience-schema.js";

/**
 * Resolved namespace/key identity saved by Unreal. An empty namespace is allowed; a missing key
 * belongs to UnresolvedTextIdentity instead.
 */
export const UnrealTextIdentity = Schema.Struct({
	status: Schema.Literal("resolved"),
	namespace: Schema.String,
	key: Schema.NonEmptyString
});

/**
 * Saved text without a usable localization key, distinguishing culture-invariant text from
 * missing-key evidence. It must not be joined by an invented key.
 */
export const UnresolvedTextIdentity = Schema.Struct({
	status: Schema.Literal("unresolved"),
	reason: Schema.Literals(["culture_invariant", "missing_key"])
});

/**
 * String Table reference by table ID and entry key. Resolving its localization namespace
 * requires table evidence rather than assuming table ID equals namespace.
 */
export const StringTableTextIdentity = Schema.Struct({
	status: Schema.Literal("string_table"),
	tableId: Schema.String,
	key: Schema.NonEmptyString
});

/**
 * Discriminated saved-text identity. Branch on status before accessing namespace/key or String
 * Table fields; unresolved text still belongs in the corpus.
 */
export const TextIdentity = Schema.Union([
	UnrealTextIdentity,
	StringTableTextIdentity,
	UnresolvedTextIdentity
]);
export type TextIdentity = Schema.Schema.Type<typeof TextIdentity>;

/**
 * Authored saved-text place: a DataTable cell, String Table entry or asset property. Location
 * supplies navigation evidence; editCapability separately controls supported mutation.
 */
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

/**
 * Which compiled representation of a Blueprint a copy was saved in: the generated class (`X_C`),
 * a UMG animation instance in it (`Name_INST`), the class default object (`Default__X_C`), or a
 * saved skeleton class (`SKEL_X_C`) or its default object.
 */
export const TextCopyKind = Schema.Literals([
	"generated_class",
	"class_default",
	"skeleton",
	"instance"
]);
export type TextCopyKind = Schema.Schema.Type<typeof TextCopyKind>;

/**
 * A representation copy folded into its place: the raw export path Unreal saved it under, which
 * kind of copy it is, and the text it holds. The game runs the compiled class, so a copy whose
 * text differs from the place's is what players see until the Blueprint is compiled again.
 */
export const TextRepresentationCopy = Schema.Struct({
	objectPath: Schema.String,
	kind: TextCopyKind,
	source: Schema.String
});
export type TextRepresentationCopy = Schema.Schema.Type<typeof TextRepresentationCopy>;

/**
 * One saved text place with source, identity, location and edit capability. Optional audience
 * and representation copies preserve richer reader evidence while accepting older snapshots.
 */
export const TextOccurrence = Schema.Struct({
	devNotes: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
	id: TextOccurrenceId,
	packageFile: Schema.String,
	source: Schema.String,
	identity: TextIdentity,
	location: TextLocation,
	editCapability: Schema.Literals(["source_editable", "read_only"]),
	/**
	 * Who the text is for, why, and the policy row that decided it (see `text-audience.ts`).
	 * Readers always set the audience and reason; occurrences built by older versions omit them.
	 */
	audience: Schema.optionalKey(TextAudience),
	audienceReason: Schema.optionalKey(TextAudienceReason),
	audienceRule: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
	/**
	 * Copies of this place that a Blueprint's compile saved under its generated class, default
	 * object or skeleton class, folded in from the reader's `blueprintClasses`. The place's own
	 * `source` is the authored text; each copy keeps its raw path and text.
	 */
	copies: Schema.optionalKey(Schema.Array(TextRepresentationCopy).check(Schema.isMinLength(1)))
});
export type TextOccurrence = Schema.Schema.Type<typeof TextOccurrence>;

/**
 * Occurrences grouped by text identity with either one consistent source or conflicting source
 * variants. A grouped unit is not proof that all occurrences share one editable owner.
 */
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

/**
 * Nonnegative counts keyed by saved-reader coverage-gap reason. Retain these with partial
 * results so unsupported text is not mistaken for an empty package.
 */
export const TextCoverageGapCounts = Schema.Record(
	SavedAssetTextCoverageGap.fields.reason,
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
);
export type TextCoverageGapCounts = typeof TextCoverageGapCounts.Type;

/**
 * Saved-package inspection or gather-coverage diagnostic with file and optional object/property
 * context. Diagnostics qualify corpus completeness separately from authored quality policy.
 */
export const TextCorpusDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"package_inspection_failed",
		"package_partially_decoded",
		"unsupported_text_history",
		"package_not_gatherable",
		"gatherable_text_not_decoded"
	]),
	message: Schema.String,
	packageFile: Schema.String,
	objectPath: Schema.optional(Schema.String),
	propertyPath: Schema.optional(Schema.String),
	coverageGapCounts: Schema.optionalKey(TextCoverageGapCounts)
});
export type TextCorpusDiagnostic = Schema.Schema.Type<typeof TextCorpusDiagnostic>;

/** Package completion is needed to prove absence, including packages with zero text. */
export const TextPackageCoverage = Schema.Struct({
	packageFile: Schema.String,
	status: Schema.Literals(["complete", "partial", "failed", "not_gatherable"])
});
export type TextPackageCoverage = typeof TextPackageCoverage.Type;

/**
 * Versioned saved-text corpus including grouped units, package coverage and diagnostics.
 * Partial status prevents unread or unsupported packages from proving absence of text.
 */
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
		unsupportedTextProperties: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		/** Runtime entries in partial packages' gather tables that no decoded line matched. */
		missingGatherableText: Schema.optionalKey(
			Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		)
	}),
	units: Schema.Array(TextUnit),
	packageCoverage: Schema.optionalKey(Schema.Array(TextPackageCoverage)),
	diagnostics: Schema.Array(TextCorpusDiagnostic)
});
export type TextCorpus = Schema.Schema.Type<typeof TextCorpus>;

/**
 * Serializable corpus failure for host responses. Branch on code and retrySafe; message and
 * recovery are human guidance and do not expose process-local causes.
 */
export const TextCorpusPublicError = Schema.Struct({
	code: Schema.Literals([
		"invalid_project",
		"invalid_options",
		"scan_limit_exceeded",
		"contract_failure",
		"reader_failed",
		"index_failed"
	]),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
});
export type TextCorpusPublicError = Schema.Schema.Type<typeof TextCorpusPublicError>;

/**
 * Corpus scan outcome distinguishing completion, cancellation, missing configuration and
 * failure. Only completed carries a corpus; partial coverage is recorded inside that corpus.
 */
export const TextCorpusRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), corpus: TextCorpus }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type TextCorpusRunResult = Schema.Schema.Type<typeof TextCorpusRunResult>;

/**
 * Validates an untrusted host scan response and retains response-contract failures as typed
 * Game Text errors. A valid failed outcome remains a successful parse of that outcome.
 */
export const parseTextCorpusRunResult = gameTextResponseParser(
	TextCorpusRunResult,
	"corpus scan result"
);

/** Upper bound applied at the public query boundary, including Workbench IPC. */
export const MAX_TEXT_QUERY_PAGE_SIZE = 50;

const TextQueryPageSize = Schema.Int.pipe(
	Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_TEXT_QUERY_PAGE_SIZE }))
);

/** A changed-file list is bounded: larger changes should be split or filtered first. */
export const MAX_TEXT_SCOPE_FILES = 5000;
/** The most localization lines a request can pick out by id, such as a selection. */
export const MAX_TEXT_PICKED_LINES = 5000;

/**
 * Query scope for all text or occurrences with a supported source edit capability. Read-only is
 * a capability fact, not a source-control permission check.
 */
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

/**
 * Convenience review filter for shared, duplicate, long, unresolved or conflicting text. These
 * review categories do not decide whether Unreal can read the asset.
 */
export const TextReviewLens = Schema.Literals([
	"all",
	"shared",
	"duplicate_source",
	"long",
	"unresolved",
	"conflicting"
]);
export type TextReviewLens = Schema.Schema.Type<typeof TextReviewLens>;

/**
 * Review evidence attached to a text unit, including compiled-copy differences and
 * evidence-only lines. Signals are distinct from the smaller actionable TextFinding subset.
 */
export const TextReviewSignal = Schema.Literals([
	"shared",
	"duplicate_source",
	"long",
	"unresolved",
	"conflicting",
	"evidence_only",
	/**
	 * A Blueprint was edited since it last compiled: a copy the game runs (the generated class or
	 * class default) of one of the line's places holds other text, which is what the game shows.
	 * A skeleton copy never raises it. Each place lists its copies.
	 */
	"compiled_copy_differs"
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

/**
 * Presentation filter for lines with supported editing or read-only evidence. It does not grant
 * filesystem or editor permissions.
 */
export const TextEditing = Schema.Literals(["editable", "read_only"]);
export type TextEditing = Schema.Schema.Type<typeof TextEditing>;

/**
 * Presentation filter for the presence of developer notes. Missing notes is a policy concern
 * rather than a saved-package parser error.
 */
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
	clause("notes", TextNotes, TextNotes.literals.length),
	/** The line's audience: player if any of its saved places is player text, and so on. */
	clause("audience", TextAudience, TextAudience.literals.length)
]);
export type TextFilterClause = Schema.Schema.Type<typeof TextFilterClause>;
/**
 * Discriminant of a supported TextFilterClause. Each field determines the allowed values and
 * its own facet-count behavior.
 */
export type TextFilterField = TextFilterClause["field"];

/** Every clause must match. */
export const TextFilter = Schema.Array(TextFilterClause).check(Schema.isMaxLength(32));
export type TextFilter = Schema.Schema.Type<typeof TextFilter>;

/**
 * Line counts for each shipping-work category. These are presentation totals over the selected
 * query scope, separate from raw package and occurrence coverage.
 */
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

/**
 * Maximum group/facet entries returned in a page; TextGroupList.more reports omitted groups so
 * a bounded preview is not interpreted as exhaustive.
 */
export const MAX_TEXT_GROUPS = 200;

/**
 * Supported line grouping dimensions. Folder and asset keys use normalized project-relative
 * paths; namespace and audience retain their distinct domain meanings.
 */
export const TextGroupBy = Schema.Literals([
	"problem",
	"folder",
	"asset",
	"origin",
	"namespace",
	"audience"
]);
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
	audiences: Schema.optionalKey(Schema.Boolean),
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

/**
 * Requested facet results with bounded groups and optional culture totals. Each facet excludes
 * its own filter clauses so the host can offer meaningful alternative selections.
 */
export const TextFacets = Schema.Struct({
	folders: Schema.optionalKey(Schema.Struct({ under: Schema.String, ...TextGroupList.fields })),
	assets: Schema.optionalKey(TextGroupList),
	origins: Schema.optionalKey(TextGroupList),
	/** Lines by audience (player, editor, unknown), over the request without its audience clauses. */
	audiences: Schema.optionalKey(TextGroupList),
	cultures: Schema.optionalKey(Schema.Array(TextCultureFacet).check(Schema.isMaxLength(256)))
});
export type TextFacets = Schema.Schema.Type<typeof TextFacets>;

/** A bounded authored/gathered location preview carried by corpus search results. */
export const TextUnitContext = Schema.Struct({
	editCapability: TextOccurrence.fields.editCapability,
	location: TextLocation
});
export interface TextUnitContext extends Schema.Schema.Type<typeof TextUnitContext> {}

/**
 * Bounded unit preview with at most three saved locations, occurrence counts and review
 * evidence. Use focus to page the remaining places instead of treating the preview as the full
 * unit.
 */
export const TextUnitSearchResult = Schema.Struct({
	localization: Schema.optionalKey(
		Schema.Array(
			LocalizationCultureMark.pipe(
				Schema.fieldsAssign({
					translation: Schema.optionalKey(Schema.NullOr(Schema.String))
				})
			)
		)
	),
	contexts: Schema.Array(TextUnitContext).check(Schema.isMaxLength(3)),
	id: TextUnitId,
	source: TextUnit.fields.source,
	identity: TextIdentity,
	locationKinds: Schema.Array(
		Schema.Literals(["data_table_cell", "string_table_entry", "asset_property"])
	),
	/** UTF-16 length of the longest source, also used for `long`; lexical order breaks ties. */
	characterCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	occurrenceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	remainingContextCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	reviewSignals: Schema.Array(TextReviewSignal),
	/** Whitespace-delimited words in that same longest source, never the joined variants. */
	wordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Player if any occurrence is player text, else unknown if any is, else editor. */
	audience: Schema.optionalKey(TextAudience)
});
export type TextUnitSearchResult = Schema.Schema.Type<typeof TextUnitSearchResult>;

/**
 * Search and toggle totals. Review counts intersect the request; editing, notes and origin
 * toggles exclude their own filter to show alternative selections.
 */
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

/**
 * Searchable totals and raw scan coverage for a retained corpus query. Blank source
 * presentation filtering does not change underlying package/occurrence provenance.
 */
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
	notGatherablePackages: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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

/**
 * Query preparation outcome with summary only when completed. Cancellation, unavailable state
 * and failure remain explicit rather than presenting an empty successful corpus.
 */
export const TextCorpusQueryRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_scanned") }),
	Schema.Struct({ status: Schema.Literal("completed"), summary: TextCorpusQuerySummary }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type TextCorpusQueryRunResult = Schema.Schema.Type<typeof TextCorpusQueryRunResult>;
/**
 * Validates the host query-preparation response. Contract mismatches fail with typed response
 * guidance while valid domain failure outcomes remain values.
 */
export const parseTextCorpusQueryRunResult = gameTextResponseParser(
	TextCorpusQueryRunResult,
	"corpus refresh result"
);

/**
 * Bounded text search request with cursor, filter, localization selection and optional
 * facets/grouping. Cursors belong to the retained query generation that issued them.
 */
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
	/** Only these localization lines, such as a selection. */
	lines: Schema.optionalKey(
		Schema.Array(LocalizationLineId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_TEXT_PICKED_LINES)
		)
	),
	/** Count the matching lines in groups; the page lists the open group's lines, if any. */
	group: Schema.optionalKey(TextGroupBy),
	openGroup: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
	facets: Schema.optionalKey(TextFacetRequest),
	pageSize: TextQueryPageSize,
	query: Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))
});
export type TextCorpusSearchRequest = Schema.Schema.Type<typeof TextCorpusSearchRequest>;

/**
 * One bounded search page plus counts, optional facets/groups and continuation cursor. Counts
 * cover matches beyond the returned preview rows.
 */
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

/**
 * Host search result separating a ready page from an unavailable query. A not-ready result does
 * not establish that the project has no text.
 */
export const TextCorpusSearchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), page: TextCorpusSearchPage }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type TextCorpusSearchResult = Schema.Schema.Type<typeof TextCorpusSearchResult>;
/**
 * Validates a host search response before presentation. Invalid envelopes fail as typed
 * response-contract errors rather than becoming empty search results.
 */
export const parseTextCorpusSearchResult = gameTextResponseParser(
	TextCorpusSearchResult,
	"text search result"
);

/**
 * Unit focus request with bounded occurrence pagination. Reuse the unit and occurrence
 * identifiers from the same retained query generation.
 */
export const TextCorpusFocusRequest = Schema.Struct({
	id: TextUnitId,
	localization: Schema.optionalKey(
		Schema.Struct({ target: LocalizationSelection.fields.target, id: LocalizationLineId })
	),
	occurrenceCursor: Schema.optional(TextOccurrenceId),
	pageSize: TextQueryPageSize
});
export type TextCorpusFocusRequest = Schema.Schema.Type<typeof TextCorpusFocusRequest>;

/**
 * Focused unit evidence with a bounded occurrence page and continuation cursor.
 * totalOccurrences describes the full unit even when only some places are hydrated.
 */
export const TextCorpusFocus = Schema.Struct({
	localization: Schema.optionalKey(LocalizationLine),
	diagnostics: Schema.Array(TextCorpusDiagnostic),
	nextOccurrenceCursor: Schema.optional(TextOccurrenceId),
	occurrences: Schema.Array(TextOccurrence),
	totalOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	unit: TextUnitSearchResult
});
export type TextCorpusFocus = Schema.Schema.Type<typeof TextCorpusFocus>;

/**
 * Focus outcome distinguishing a found unit, an absent identifier and an unavailable query.
 * Only found carries focused source and occurrence evidence.
 */
export const TextCorpusFocusResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("found"), focus: TextCorpusFocus }),
	Schema.Struct({ status: Schema.Literal("not_found") }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type TextCorpusFocusResult = Schema.Schema.Type<typeof TextCorpusFocusResult>;
/**
 * Validates an untrusted focus response and preserves typed contract guidance. A well-formed
 * not-found result is an ordinary domain outcome.
 */
export const parseTextCorpusFocusResult = gameTextResponseParser(
	TextCorpusFocusResult,
	"text focus result"
);
