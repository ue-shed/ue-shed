import { Schema } from "effect";

export const TextUnitId = Schema.String.pipe(Schema.brand("TextUnitId"));
export type TextUnitId = Schema.Schema.Type<typeof TextUnitId>;

export const TextOccurrenceId = Schema.String.pipe(Schema.brand("TextOccurrenceId"));
export type TextOccurrenceId = Schema.Schema.Type<typeof TextOccurrenceId>;
export const decodeTextUnitId = Schema.decodeUnknownSync(TextUnitId);
export const decodeTextOccurrenceId = Schema.decodeUnknownSync(TextOccurrenceId);

export const UnrealTextIdentity = Schema.Struct({
	status: Schema.Literal("resolved"),
	namespace: Schema.String,
	key: Schema.NonEmptyString
});

export const UnresolvedTextIdentity = Schema.Struct({
	status: Schema.Literal("unresolved"),
	reason: Schema.Literal("culture_invariant", "missing_key")
});

export const TextIdentity = Schema.Union(UnrealTextIdentity, UnresolvedTextIdentity);
export type TextIdentity = Schema.Schema.Type<typeof TextIdentity>;

export const TextLocation = Schema.Union(
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
);
export type TextLocation = Schema.Schema.Type<typeof TextLocation>;

export const TextOccurrence = Schema.Struct({
	id: TextOccurrenceId,
	packageFile: Schema.String,
	source: Schema.String,
	identity: TextIdentity,
	location: TextLocation,
	editCapability: Schema.Literal("source_editable", "read_only")
});
export type TextOccurrence = Schema.Schema.Type<typeof TextOccurrence>;

export const TextUnit = Schema.Struct({
	id: TextUnitId,
	source: Schema.Union(
		Schema.Struct({ status: Schema.Literal("consistent"), value: Schema.String }),
		Schema.Struct({
			status: Schema.Literal("conflicting"),
			values: Schema.Array(Schema.String).pipe(Schema.minItems(2))
		})
	),
	identity: TextIdentity,
	occurrences: Schema.Array(TextOccurrence)
});
export type TextUnit = Schema.Schema.Type<typeof TextUnit>;

export const TextCorpusDiagnostic = Schema.Struct({
	code: Schema.Literal(
		"package_inspection_failed",
		"package_partially_decoded",
		"unsupported_text_history"
	),
	message: Schema.String,
	packageFile: Schema.String,
	objectPath: Schema.optional(Schema.String),
	propertyPath: Schema.optional(Schema.String)
});
export type TextCorpusDiagnostic = Schema.Schema.Type<typeof TextCorpusDiagnostic>;

export const TextCorpus = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literal("complete", "partial"),
	coverage: Schema.Struct({
		discoveredPackages: Schema.NonNegativeInt,
		inspectedPackages: Schema.NonNegativeInt,
		partialPackages: Schema.NonNegativeInt,
		failedPackages: Schema.NonNegativeInt,
		textUnits: Schema.NonNegativeInt,
		textOccurrences: Schema.NonNegativeInt,
		resolvedOccurrences: Schema.NonNegativeInt,
		unresolvedOccurrences: Schema.NonNegativeInt,
		unsupportedTextProperties: Schema.NonNegativeInt
	}),
	units: Schema.Array(TextUnit),
	diagnostics: Schema.Array(TextCorpusDiagnostic)
});
export type TextCorpus = Schema.Schema.Type<typeof TextCorpus>;

export const TextCorpusPublicError = Schema.Struct({
	code: Schema.Literal("invalid_project", "scan_limit_exceeded", "contract_failure"),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
});
export type TextCorpusPublicError = Schema.Schema.Type<typeof TextCorpusPublicError>;

export const TextCorpusRunResult = Schema.Union(
	Schema.Struct({ status: Schema.Literal("completed"), corpus: TextCorpus }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
);
export type TextCorpusRunResult = Schema.Schema.Type<typeof TextCorpusRunResult>;

export const decodeTextCorpusRunResult = Schema.decodeUnknownSync(TextCorpusRunResult);
