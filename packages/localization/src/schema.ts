import { Schema } from "effect";

const PathComponent = Schema.NonEmptyString.check(
	Schema.makeFilter(
		(value) =>
			!/[\\/:]/u.test(value) && !value.includes("\u0000") && value !== "." && value !== ".."
	)
);
/**
 * Non-empty localization target name safe as one path component. Rejects separators, NUL,
 * colon and dot traversal; it does not prove that the target exists in a project.
 */
export const LocalizationTargetName = PathComponent.pipe(Schema.brand("LocalizationTargetName"));
export type LocalizationTargetName = typeof LocalizationTargetName.Type;
/**
 * Culture label safe as one path component. This validates path safety rather than membership
 * in a hard-coded culture registry; configured project cultures remain authoritative.
 */
export const CultureCode = PathComponent.pipe(Schema.brand("CultureCode"));
export type CultureCode = typeof CultureCode.Type;
/**
 * Branded Unreal localization namespace. Empty namespaces are valid; the namespace and key
 * together identify a gathered line.
 */
export const TextNamespace = Schema.String.pipe(Schema.brand("TextNamespace"));
export type TextNamespace = typeof TextNamespace.Type;
/**
 * Branded Unreal localization key, including empty strings accepted by the underlying format.
 * It is meaningful together with its namespace rather than globally unique.
 */
export const TextKey = Schema.String.pipe(Schema.brand("TextKey"));
export type TextKey = typeof TextKey.Type;

/**
 * Stable evidence parsing, resource-limit, path and file-access failure codes. Match these
 * values rather than parsing the human-readable error message.
 */
export const LocalizationErrorCode = Schema.Literals([
	"invalid_encoding",
	"malformed_json",
	"malformed_manifest",
	"malformed_archive",
	"invalid_schema",
	"unsupported_version",
	"malformed_struct",
	"malformed_ini",
	"malformed_po",
	"malformed_locmeta",
	"malformed_csv",
	"limit_exceeded",
	"file_missing",
	"file_unreadable",
	"directory_unreadable",
	"unsafe_path",
	"target_not_found",
	"ambiguous_config",
	"file_changed",
	"file_unwritable"
]);
/**
 * What a caller can do next after a localization failure. Same codes as `ErrorNextStep` in
 * `@ue-shed/protocol`, which this package does not depend on: `retry` only when `retrySafe` is
 * true, `reconcile` when state changed underneath (re-read first), `escalate` when the caller
 * cannot fix it.
 */
export const LocalizationErrorNextStep = Schema.Literals([
	"fix_input",
	"retry",
	"reconcile",
	"escalate"
]);
export type LocalizationErrorNextStep = typeof LocalizationErrorNextStep.Type;

/** The guidance fields every localization tagged error carries, named as in `@ue-shed/protocol`. */
export const LocalizationErrorGuidanceFields = {
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: LocalizationErrorNextStep
};

/**
 * Sanitized evidence failure carrying a stable code and recovery guidance. Authored text,
 * decoder payloads and host filesystem details are intentionally excluded from this portable
 * evidence contract.
 */
export class LocalizationError extends Schema.TaggedError<LocalizationError>()(
	"LocalizationError",
	{
		code: LocalizationErrorCode,
		...LocalizationErrorGuidanceFields
	}
) {}

/**
 * Evidence reads repeat safely, and writes replace one file atomically behind a content-hash
 * guard, so repeating any failed localization file operation is safe. A changed file needs a
 * fresh read; every other code needs a corrected project, path or file.
 */
export function localizationErrorGuidance(
	code: LocalizationError["code"]
): Pick<LocalizationError, "retrySafe" | "nextStep"> {
	return { retrySafe: true, nextStep: code === "file_changed" ? "reconcile" : "fix_input" };
}
/** Tag guard for localization failures; match by tag, not `instanceof`. */
export const isLocalizationError = Schema.is(LocalizationError);

/**
 * Positive limits for evidence bytes per file, decoded entries, nesting depth and file count.
 * Hosts may override policy explicitly for their project rather than changing the parser.
 */
export const LocalizationLimits = Schema.Struct({
	maxFileBytes: Schema.Int.check(Schema.isGreaterThan(0)),
	maxEntries: Schema.Int.check(Schema.isGreaterThan(0)),
	maxDepth: Schema.Int.check(Schema.isGreaterThan(0)),
	maxFiles: Schema.Int.check(Schema.isGreaterThan(0))
});
export type LocalizationLimits = typeof LocalizationLimits.Type;
/**
 * Default evidence limits: 320 MiB per file, one million entries, nesting depth 64 and 2,560
 * files. These are overridable resource policy, not Unreal format limits.
 */
export const defaultLocalizationLimits: LocalizationLimits = Object.freeze({
	maxFileBytes: 320 * 1024 * 1024,
	maxEntries: 1_000_000,
	maxDepth: 64,
	maxFiles: 2_560
});

/**
 * JSON-valued extra fields preserved from Unreal localization records. Consumers must not
 * assume an unknown metadata field has a project-specific schema.
 */
export const OpaqueRecord = Schema.Record(Schema.String, Schema.Json);
/**
 * Unreal text object with required Text plus preserved JSON-valued extra fields. This
 * preserves format metadata instead of reducing every source or translation to a bare string.
 */
export const LocalizationText = Schema.StructWithRest(Schema.Struct({ Text: Schema.String }), [
	OpaqueRecord
]);
export type LocalizationText = typeof LocalizationText.Type;
/**
 * Namespace/key pair identifying a gathered localization line. Source text is evidence about
 * the identity and is not part of this pair.
 */
export const LocalizationIdentity = Schema.Struct({ namespace: TextNamespace, key: TextKey });
export type LocalizationIdentity = typeof LocalizationIdentity.Type;
/**
 * Reports repeated namespace/key identities and their count while reading evidence. A
 * diagnostic does not arbitrarily pick one duplicate as authoritative.
 */
export const DuplicateIdentityDiagnostic = Schema.Struct({
	code: Schema.Literal("duplicate_identity"),
	...LocalizationIdentity.fields,
	count: Schema.Int
});
export type DuplicateIdentityDiagnostic = typeof DuplicateIdentityDiagnostic.Type;
/**
 * Gathered namespace/key, source text and source path, with optional Unreal metadata and
 * notes. This is manifest evidence, not a live package handle or an editable translation.
 */
export const ManifestEntry = Schema.Struct({
	...LocalizationIdentity.fields,
	source: LocalizationText,
	path: Schema.String,
	optional: Schema.optionalKey(Schema.Boolean),
	metadata: Schema.optionalKey(OpaqueRecord),
	devNotes: Schema.optionalKey(Schema.String)
});
export type ManifestEntry = typeof ManifestEntry.Type;
/**
 * Culture archive entry with namespace/key, source and current translation. Pending PO edits
 * can override its translation during the next import; use the effective-translation helper
 * when reviewing changes.
 */
export const ArchiveEntry = Schema.Struct({
	...LocalizationIdentity.fields,
	source: LocalizationText,
	translation: LocalizationText,
	optional: Schema.optionalKey(Schema.Boolean),
	metadata: Schema.optionalKey(OpaqueRecord)
});
export type ArchiveEntry = typeof ArchiveEntry.Type;
/**
 * Normalized version-1 manifest projection with flattened entries and duplicate-identity
 * diagnostics. Successful parsing does not imply every identity is unique.
 */
export const LocalizationManifest = Schema.Struct({
	formatVersion: Schema.Literal(1),
	entries: Schema.Array(ManifestEntry),
	diagnostics: Schema.Array(DuplicateIdentityDiagnostic)
});
export type LocalizationManifest = typeof LocalizationManifest.Type;
/**
 * Normalized version-2 archive projection retaining source, translation and
 * duplicate-identity diagnostics. Culture selection comes from the containing target
 * evidence.
 */
export const LocalizationArchive = Schema.Struct({
	formatVersion: Schema.Literal(2),
	entries: Schema.Array(ArchiveEntry),
	diagnostics: Schema.Array(DuplicateIdentityDiagnostic)
});
export type LocalizationArchive = typeof LocalizationArchive.Type;

const OptionalBool = Schema.optionalKey(Schema.Boolean);
const Strings = Schema.Array(Schema.String);
const OptionalStrings = Schema.optionalKey(Strings);
const PathRoot = Schema.optionalKey(Schema.Literals(["Auto", "Project", "Engine"]));
const SearchPath = Schema.Struct({ Path: Schema.String, PathRoot });
const Wildcard = Schema.Struct({ Pattern: Schema.String, PathRoot });
const Extension = Schema.Struct({ Pattern: Schema.String });
/**
 * Dashboard text-file gather configuration, including search roots, exclusions and
 * extensions. Enabled flags describe Unreal's configured gathering policy; reading them does
 * not run gathering.
 */
export const GatherFromTextFiles = Schema.Struct({
	IsEnabled: Schema.Boolean,
	SearchDirectories: Schema.Array(SearchPath),
	ExcludePathWildcards: Schema.Array(Wildcard),
	FileExtensions: Schema.Array(Extension),
	ShouldGatherFromEditorOnlyData: OptionalBool
});
/**
 * Dashboard package gather configuration with inclusion/exclusion, collection and class
 * filters. Hosts preserve the project's choices rather than imposing a toolkit-wide gather
 * scope.
 */
export const GatherFromPackages = Schema.Struct({
	IsEnabled: Schema.Boolean,
	IncludePathWildcards: Schema.Array(Wildcard),
	ExcludePathWildcards: Schema.Array(Wildcard),
	FileExtensions: Schema.Array(Extension),
	Collections: OptionalStrings,
	WorldCollections: OptionalStrings,
	ExcludeClasses: OptionalStrings,
	ShouldExcludeDerivedClasses: OptionalBool,
	ShouldGatherFromEditorOnlyData: OptionalBool,
	SkipGatherCache: OptionalBool
});
/**
 * Dashboard reflected-metadata gather configuration with key mappings and owner/type filters.
 * Field names mirror Unreal's serialized configuration for faithful interpretation.
 */
export const GatherFromMetaData = Schema.Struct({
	IsEnabled: Schema.Boolean,
	IncludePathWildcards: Schema.Array(Wildcard),
	ExcludePathWildcards: Schema.Array(Wildcard),
	KeySpecifications: Schema.Array(
		Schema.Struct({
			MetaDataKey: Schema.Struct({ Name: Schema.String }),
			TextNamespace,
			TextKeyPattern: Extension
		})
	),
	FieldTypesToInclude: OptionalStrings,
	FieldTypesToExclude: OptionalStrings,
	FieldOwnerTypesToInclude: OptionalStrings,
	FieldOwnerTypesToExclude: OptionalStrings,
	ShouldGatherFromEditorOnlyData: OptionalBool
});
/**
 * Supported PO export/import dialects: Unreal and Crowdin. Identity interpretation and
 * source-text availability depend on the selected dialect and collapse mode.
 */
export const POFormat = Schema.Literals(["Unreal", "Crowdin"]);
export type POFormat = typeof POFormat.Type;
/**
 * Unreal's configured text-collapse identity policy. Preserve the target's mode when
 * interpreting PO context; text alone is not a reliable localization identity.
 */
export const LocalizationCollapseMode = Schema.Literals([
	"IdenticalTextIdAndSource",
	"IdenticalNamespaceAndSource",
	"IdenticalPackageIdTextIdAndSource"
]);
export type LocalizationCollapseMode = typeof LocalizationCollapseMode.Type;
/**
 * Dashboard PO export policy including dialect, collapse mode and comment preservation. These
 * settings describe project behavior; the toolkit does not silently replace them with
 * defaults.
 */
export const ExportSettings = Schema.Struct({
	CollapseMode: LocalizationCollapseMode,
	POFormat,
	ShouldPersistCommentsOnExport: Schema.Boolean,
	ShouldAddSourceLocationsAsComments: OptionalBool
});
/**
 * Dashboard localization compile validation flags. These configure Unreal's own format,
 * whitespace and optional rich-text checks rather than a separate toolkit quality policy.
 */
export const CompileSettings = Schema.Struct({
	SkipSourceCheck: Schema.Boolean,
	ValidateFormatPatterns: Schema.Boolean,
	ValidateSafeWhitespace: Schema.Boolean,
	ValidateRichTextTags: OptionalBool
});
/**
 * Validated projection of Unreal's serialized localization target settings, including GUID,
 * gather policies and cultures. NativeCultureIndex may be -1 when no native culture is
 * selected.
 */
export const DashboardSettings = Schema.Struct({
	Name: LocalizationTargetName,
	Guid: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/iu)),
	TargetDependencies: OptionalStrings,
	AdditionalManifestDependencies: Schema.optionalKey(
		Schema.Array(Schema.Struct({ FilePath: Schema.String }))
	),
	RequiredModuleNames: OptionalStrings,
	GatherFromTextFiles,
	GatherFromPackages,
	GatherFromMetaData,
	ExportSettings: Schema.optionalKey(ExportSettings),
	CompileSettings: Schema.optionalKey(CompileSettings),
	ImportDialogueSettings: Schema.optionalKey(
		Schema.Struct({
			RawAudioPath: Schema.Struct({ Path: Schema.String }),
			ImportedDialogueFolder: Schema.String,
			bImportNativeAsSource: Schema.Boolean
		})
	),
	NativeCultureIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
	SupportedCulturesStatistics: Schema.Array(Schema.Struct({ CultureName: CultureCode }))
});
export type DashboardSettings = typeof DashboardSettings.Type;
/**
 * Normalized Dashboard target with resolved native/supported cultures and original validated
 * settings. A null native culture remains explicit rather than choosing the first culture.
 */
export const LocalizationTargetSettings = Schema.Struct({
	name: LocalizationTargetName,
	guid: DashboardSettings.fields.Guid,
	nativeCulture: Schema.NullOr(CultureCode),
	cultures: Schema.Array(CultureCode),
	settings: DashboardSettings
});
export type LocalizationTargetSettings = typeof LocalizationTargetSettings.Type;

/**
 * Recognized common or step-level GatherText recipe fields. Optional values preserve absence
 * so planning can distinguish inherited configuration from explicit per-step policy.
 */
export const RecipeFields = Schema.Struct({
	SourcePath: Schema.optionalKey(Schema.String),
	DestinationPath: Schema.optionalKey(Schema.String),
	ManifestName: Schema.optionalKey(Schema.String),
	ArchiveName: Schema.optionalKey(Schema.String),
	PortableObjectName: Schema.optionalKey(Schema.String),
	ResourceName: Schema.optionalKey(Schema.String),
	NativeCulture: Schema.optionalKey(CultureCode),
	CulturesToGenerate: Schema.Array(CultureCode),
	SearchDirectoryPaths: Strings,
	IncludePathFilters: Strings,
	ExcludePathFilters: Strings,
	FileNameFilters: Strings,
	PackageFileNameFilters: Strings,
	ExcludeClasses: Strings,
	POFormat: Schema.optionalKey(POFormat),
	LocalizedTextCollapseMode: Schema.optionalKey(LocalizationCollapseMode),
	bUseCultureDirectory: OptionalBool,
	bImportLoc: OptionalBool,
	bExportLoc: OptionalBool,
	bWordCountReport: OptionalBool,
	bConflictReport: OptionalBool,
	PlatformSplitMode: Schema.optionalKey(Schema.String),
	FixMissingGatherCache: OptionalBool,
	FixPackageLocalizationIdConflict: OptionalBool,
	FixStaleGatherCache: OptionalBool,
	ReportStaleGatherCache: OptionalBool,
	ShouldExcludeDerivedClasses: OptionalBool,
	ShouldGatherFromEditorOnlyData: OptionalBool,
	SkipGatherCache: OptionalBool,
	WordCountReportName: Schema.optionalKey(Schema.String),
	ConflictReportName: Schema.optionalKey(Schema.String)
});
export type RecipeFields = typeof RecipeFields.Type;
/**
 * Project-relative GatherText config with common fields and indexed commandlet steps. Parsing
 * describes the recipe; supported-operation planning must still validate its write behavior.
 */
export const LocalizationRecipe = Schema.Struct({
	relativePath: Schema.String,
	common: RecipeFields,
	steps: Schema.Array(
		Schema.Struct({
			index: Schema.Int,
			commandletClass: Schema.NonEmptyString,
			fields: RecipeFields
		})
	)
});
export type LocalizationRecipe = typeof LocalizationRecipe.Type;
/**
 * Resolved target output paths for manifest, culture archives/PO/resources and reports.
 * Missing optional outputs are null; culture maps contain only configured destinations.
 */
export const LocalizationOutputPaths = Schema.Struct({
	manifest: Schema.NullOr(Schema.String),
	archives: Schema.Record(CultureCode, Schema.String),
	portableObjects: Schema.Record(CultureCode, Schema.String),
	resources: Schema.Record(CultureCode, Schema.String),
	locmeta: Schema.NullOr(Schema.String),
	wordCount: Schema.NullOr(Schema.String),
	conflicts: Schema.NullOr(Schema.String)
});
export type LocalizationOutputPaths = typeof LocalizationOutputPaths.Type;
/**
 * Discovered target combining Dashboard/config evidence, culture policy and output paths.
 * Config-only targets are supported; target discovery does not generate missing evidence.
 */
export const LocalizationTarget = Schema.Struct({
	name: LocalizationTargetName,
	source: Schema.Literals(["dashboard_settings", "config_only"]),
	nativeCulture: Schema.NullOr(CultureCode),
	cultures: Schema.Array(CultureCode),
	dashboard: Schema.optionalKey(LocalizationTargetSettings),
	configs: Schema.Array(LocalizationRecipe),
	outputPaths: LocalizationOutputPaths,
	poFormat: POFormat,
	collapseMode: LocalizationCollapseMode
});
export type LocalizationTarget = typeof LocalizationTarget.Type;
/**
 * Explicit project root and optional evidence limits. All evidence paths are resolved under
 * this root; the request does not change a host's selected project.
 */
export const LocalizationProjectRequest = Schema.Struct({
	projectRoot: Schema.NonEmptyString,
	limits: Schema.optionalKey(LocalizationLimits)
});
export type LocalizationProjectRequest = typeof LocalizationProjectRequest.Type;
/**
 * Project evidence read bound to a previously discovered target. Supplies the target's
 * resolved output paths and optional resource policy; no editor connection is required.
 */
export const LocalizationEvidenceRequest = LocalizationProjectRequest.pipe(
	Schema.fieldsAssign({ target: LocalizationTarget })
);
export type LocalizationEvidenceRequest = typeof LocalizationEvidenceRequest.Type;
/**
 * Target/config discovery failure with optional source indices. Discovery can return valid
 * targets alongside these diagnostics rather than discarding the whole project.
 */
export const TargetDiagnostic = Schema.Struct({
	targetIndex: Schema.optionalKey(Schema.Int),
	configIndex: Schema.optionalKey(Schema.Int),
	error: LocalizationError
});
/**
 * Version-1 target discovery result with valid targets and per-input diagnostics. Consumers
 * should surface diagnostics even when some targets were discovered successfully.
 */
export const LocalizationTargetDiscovery = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	targets: Schema.Array(LocalizationTarget),
	diagnostics: Schema.Array(TargetDiagnostic)
});
export type LocalizationTargetDiscovery = typeof LocalizationTargetDiscovery.Type;

/**
 * Original PO line text with its exact line ending, including no final newline. Retaining
 * endings enables edits without rewriting unrelated document formatting.
 */
export const POLine = Schema.Struct({
	text: Schema.String,
	ending: Schema.Literals(["\r\n", "\n", "\r", ""])
});
export type POLine = typeof POLine.Type;
/**
 * Decoded PO string field with contributing line indices and optional plural index. Line
 * indices refer to its containing block and support targeted, format-preserving replacement.
 */
export const POStringField = Schema.Struct({
	name: Schema.Literals(["msgctxt", "msgid", "msgid_plural", "msgstr"]),
	index: Schema.optionalKey(Schema.Int),
	lineIndices: Schema.Array(Schema.Int),
	value: Schema.String
});
export type POStringField = typeof POStringField.Type;
/**
 * Decoded PO entry including context, source/plurals, translations and comments. Identity is
 * null when the configured Unreal dialect/collapse policy cannot establish a namespace/key
 * pair.
 */
export const POEntry = Schema.Struct({
	msgctxt: Schema.optionalKey(Schema.String),
	msgid: Schema.String,
	msgidPlural: Schema.optionalKey(Schema.String),
	msgstr: Schema.Record(Schema.String, Schema.String),
	translatorComments: Strings,
	extractedComments: Strings,
	referenceComments: Strings,
	flags: Strings,
	previousMsgidLines: Strings,
	identity: Schema.NullOr(LocalizationIdentity)
});
export type POEntry = typeof POEntry.Type;
/**
 * PO header, entry or trivia block retaining original lines and decoded string fields. Only
 * entry blocks carry decoded entry data; trivia is preserved for serialization.
 */
export const POBlock = Schema.Struct({
	kind: Schema.Literals(["header", "entry", "trivia"]),
	lines: Schema.Array(POLine),
	fields: Schema.Array(POStringField),
	entry: Schema.optionalKey(POEntry)
});
export type POBlock = typeof POBlock.Type;
/**
 * Editable PO representation retaining BOM, blocks, line endings and dialect. Use this full
 * document for byte-preserving changes; the smaller evidence projection cannot reconstruct
 * original formatting.
 */
export const PODocument = Schema.Struct({
	bom: Schema.Boolean,
	format: POFormat,
	hasSourceText: Schema.Boolean,
	blocks: Schema.Array(POBlock)
});
export type PODocument = typeof PODocument.Type;
/** Read-only evidence keeps decoded context; byte-exact editing reads a full document separately. */
export const POEvidence = PODocument.mapFields(({ format, hasSourceText }) => ({
	format,
	hasSourceText,
	entries: Schema.Array(POEntry)
}));
export type POEvidence = typeof POEvidence.Type;
/**
 * Explicit PO dialect, Unreal collapse mode and resource-limit overrides. Use the target's
 * settings when known rather than inferring identity from display text.
 */
export const POParseOptions = Schema.Struct({
	format: Schema.optionalKey(POFormat),
	collapseMode: Schema.optionalKey(LocalizationCollapseMode),
	limits: Schema.optionalKey(LocalizationLimits)
});
export type POParseOptions = typeof POParseOptions.Type;

/**
 * Decoded locmeta versions 0 through 2 with native culture/resource path, compiled cultures
 * and UGC flag. This is compiled-output metadata rather than translation source evidence.
 */
export const LocalizationMeta = Schema.Struct({
	version: Schema.Literals([0, 1, 2]),
	nativeCulture: CultureCode,
	nativeLocresPath: Schema.String,
	compiledCultures: Schema.Array(CultureCode),
	isUGC: Schema.Boolean
});
export type LocalizationMeta = typeof LocalizationMeta.Type;
/**
 * Unreal word-count CSV projection with dated totals and per-culture counts. Counts are
 * non-negative; report history is retained rather than selecting only the newest row.
 */
export const WordCountReport = Schema.Struct({
	cultures: Schema.Array(CultureCode),
	rows: Schema.Array(
		Schema.Struct({
			dateTime: Schema.NonEmptyString,
			wordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			cultureWordCounts: Schema.Record(
				CultureCode,
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
			)
		})
	)
});
export type WordCountReport = typeof WordCountReport.Type;

/**
 * Project-relative evidence path, byte size, modification timestamp and content hash. Writes
 * use the hash to detect stale evidence; timestamps alone do not authorize replacement.
 */
export const FileProvenance = Schema.Struct({
	relativePath: Schema.String,
	size: Schema.Int,
	modifiedTime: Schema.String,
	contentHash: Schema.String
});
export type FileProvenance = typeof FileProvenance.Type;
const fileEvidence = <S extends Schema.Constraint>(schema: S) =>
	Schema.Union([
		Schema.Struct({
			status: Schema.Literal("read"),
			provenance: FileProvenance,
			value: schema
		}),
		Schema.Struct({
			status: Schema.Literal("failed"),
			relativePath: Schema.NullOr(Schema.String),
			provenance: Schema.optionalKey(FileProvenance),
			error: LocalizationError
		})
	]);
/**
 * Manifest read outcome with provenance, or an explicit typed failure. A failed file remains
 * distinguishable from a successfully read empty manifest.
 */
export const ManifestFileEvidence = fileEvidence(LocalizationManifest);
/**
 * Culture archive read outcome with provenance or a sanitized failure. Missing/unreadable
 * archives are not represented as empty successful translations.
 */
export const ArchiveFileEvidence = fileEvidence(LocalizationArchive);
/**
 * Read-only PO evidence with provenance or a typed failure. This projection omits original
 * formatting; obtain a full PODocument before preparing edits.
 */
export const POFileEvidence = fileEvidence(POEvidence);
/**
 * Versioned saved evidence for one target: manifest, per-culture archive/PO and optional
 * compiled reports. Each file has its own read outcome, so partial evidence remains
 * inspectable.
 */
export const LocalizationTargetEvidence = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTarget,
	manifest: ManifestFileEvidence,
	cultures: Schema.Array(
		Schema.Struct({
			culture: CultureCode,
			archive: ArchiveFileEvidence,
			po: POFileEvidence
		})
	),
	locmeta: fileEvidence(LocalizationMeta),
	wordCount: fileEvidence(WordCountReport)
});
export type LocalizationTargetEvidence = typeof LocalizationTargetEvidence.Type;
/**
 * Discovery result augmented with configured evidence presence per target/culture. Presence
 * checks do not parse all translation contents or prove that compiled output is current.
 */
export const LocalizationTargetsReport = Schema.Struct({
	...LocalizationTargetDiscovery.fields,
	presence: Schema.Array(
		Schema.Struct({
			target: LocalizationTargetName,
			manifest: Schema.Boolean,
			cultures: Schema.Array(
				Schema.Struct({
					culture: CultureCode,
					archive: Schema.Boolean,
					po: Schema.Boolean,
					resource: Schema.Boolean,
					diagnostics: Schema.Array(LocalizationError)
				})
			)
		})
	)
});
export type LocalizationTargetsReport = typeof LocalizationTargetsReport.Type;
