import { Schema } from "effect";

export const TextUnitId = Schema.String.pipe(Schema.brand("TextUnitId"));
export type TextUnitId = Schema.Schema.Type<typeof TextUnitId>;

export const TextOccurrenceId = Schema.String.pipe(Schema.brand("TextOccurrenceId"));
export type TextOccurrenceId = Schema.Schema.Type<typeof TextOccurrenceId>;
export const makeTextUnitId = TextUnitId.make;
export const makeTextOccurrenceId = TextOccurrenceId.make;

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

export const TextCapabilityFilter = Schema.Literals(["all", "source_editable", "read_only"]);
export type TextCapabilityFilter = Schema.Schema.Type<typeof TextCapabilityFilter>;

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

/** A bounded authored/gathered location preview carried by corpus search results. */
export const TextUnitContext = Schema.Struct({
	editCapability: TextOccurrence.fields.editCapability,
	location: TextLocation
});
export interface TextUnitContext extends Schema.Schema.Type<typeof TextUnitContext> {}

export const TextUnitSearchResult = Schema.Struct({
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

export const TextCorpusQuerySummary = Schema.Struct({
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
	Schema.Struct({ status: Schema.Literal("completed"), summary: TextCorpusQuerySummary }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type TextCorpusQueryRunResult = Schema.Schema.Type<typeof TextCorpusQueryRunResult>;
export const decodeTextCorpusQueryRunResult = Schema.decodeUnknownEffect(TextCorpusQueryRunResult);

export const TextCorpusSearchRequest = Schema.Struct({
	capability: TextCapabilityFilter,
	cursor: Schema.optional(TextUnitId),
	lens: Schema.optional(TextReviewLens),
	pageSize: TextQueryPageSize,
	query: Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))
});
export type TextCorpusSearchRequest = Schema.Schema.Type<typeof TextCorpusSearchRequest>;

export const TextCorpusSearchPage = Schema.Struct({
	nextCursor: Schema.optional(TextUnitId),
	total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	units: Schema.Array(TextUnitSearchResult)
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
