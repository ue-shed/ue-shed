import { Schema } from "effect";

const PathComponent = Schema.NonEmptyString.check(
	Schema.makeFilter(
		(value) =>
			!/[\\/:]/u.test(value) && !value.includes("\u0000") && value !== "." && value !== ".."
	)
);
export const LocalizationTargetName = PathComponent.pipe(Schema.brand("LocalizationTargetName"));
export type LocalizationTargetName = typeof LocalizationTargetName.Type;
export const CultureCode = PathComponent.pipe(Schema.brand("CultureCode"));
export type CultureCode = typeof CultureCode.Type;
export const TextNamespace = Schema.String.pipe(Schema.brand("TextNamespace"));
export type TextNamespace = typeof TextNamespace.Type;
export const TextKey = Schema.String.pipe(Schema.brand("TextKey"));
export type TextKey = typeof TextKey.Type;

export const LocalizationErrorCode = Schema.Literals([
	"invalid_encoding",
	"malformed_json",
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
	"file_changed"
]);
export class LocalizationError extends Schema.TaggedErrorClass<LocalizationError>()(
	"LocalizationError",
	{
		code: LocalizationErrorCode,
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export const LocalizationLimits = Schema.Struct({
	maxFileBytes: Schema.Int.check(Schema.isGreaterThan(0)),
	maxEntries: Schema.Int.check(Schema.isGreaterThan(0)),
	maxDepth: Schema.Int.check(Schema.isGreaterThan(0)),
	maxFiles: Schema.Int.check(Schema.isGreaterThan(0))
});
export type LocalizationLimits = typeof LocalizationLimits.Type;
export const defaultLocalizationLimits: LocalizationLimits = Object.freeze({
	maxFileBytes: 32 * 1024 * 1024,
	maxEntries: 100_000,
	maxDepth: 64,
	maxFiles: 256
});

export const OpaqueRecord = Schema.Record(Schema.String, Schema.Json);
export const LocalizationText = Schema.StructWithRest(Schema.Struct({ Text: Schema.String }), [
	OpaqueRecord
]);
export type LocalizationText = typeof LocalizationText.Type;
export const LocalizationIdentity = Schema.Struct({ namespace: TextNamespace, key: TextKey });
export type LocalizationIdentity = typeof LocalizationIdentity.Type;
export const DuplicateIdentityDiagnostic = Schema.Struct({
	code: Schema.Literal("duplicate_identity"),
	...LocalizationIdentity.fields,
	count: Schema.Int
});
export type DuplicateIdentityDiagnostic = typeof DuplicateIdentityDiagnostic.Type;
export const ManifestEntry = Schema.Struct({
	...LocalizationIdentity.fields,
	source: LocalizationText,
	path: Schema.String,
	optional: Schema.optionalKey(Schema.Boolean),
	metadata: Schema.optionalKey(OpaqueRecord),
	devNotes: Schema.optionalKey(Schema.String)
});
export type ManifestEntry = typeof ManifestEntry.Type;
export const ArchiveEntry = Schema.Struct({
	...LocalizationIdentity.fields,
	source: LocalizationText,
	translation: LocalizationText,
	optional: Schema.optionalKey(Schema.Boolean),
	metadata: Schema.optionalKey(OpaqueRecord)
});
export type ArchiveEntry = typeof ArchiveEntry.Type;
export const LocalizationManifest = Schema.Struct({
	formatVersion: Schema.Literal(1),
	entries: Schema.Array(ManifestEntry),
	diagnostics: Schema.Array(DuplicateIdentityDiagnostic)
});
export type LocalizationManifest = typeof LocalizationManifest.Type;
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
export const GatherFromTextFiles = Schema.Struct({
	IsEnabled: Schema.Boolean,
	SearchDirectories: Schema.Array(SearchPath),
	ExcludePathWildcards: Schema.Array(Wildcard),
	FileExtensions: Schema.Array(Extension),
	ShouldGatherFromEditorOnlyData: OptionalBool
});
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
export const POFormat = Schema.Literals(["Unreal", "Crowdin"]);
export type POFormat = typeof POFormat.Type;
export const LocalizationCollapseMode = Schema.Literals([
	"IdenticalTextIdAndSource",
	"IdenticalNamespaceAndSource",
	"IdenticalPackageIdTextIdAndSource"
]);
export type LocalizationCollapseMode = typeof LocalizationCollapseMode.Type;
export const ExportSettings = Schema.Struct({
	CollapseMode: LocalizationCollapseMode,
	POFormat,
	ShouldPersistCommentsOnExport: Schema.Boolean,
	ShouldAddSourceLocationsAsComments: OptionalBool
});
export const CompileSettings = Schema.Struct({
	SkipSourceCheck: Schema.Boolean,
	ValidateFormatPatterns: Schema.Boolean,
	ValidateSafeWhitespace: Schema.Boolean,
	ValidateRichTextTags: OptionalBool
});
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
export const LocalizationTargetSettings = Schema.Struct({
	name: LocalizationTargetName,
	guid: DashboardSettings.fields.Guid,
	nativeCulture: Schema.NullOr(CultureCode),
	cultures: Schema.Array(CultureCode),
	settings: DashboardSettings
});
export type LocalizationTargetSettings = typeof LocalizationTargetSettings.Type;

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
	ShouldExcludeDerivedClasses: OptionalBool,
	ShouldGatherFromEditorOnlyData: OptionalBool,
	SkipGatherCache: OptionalBool,
	WordCountReportName: Schema.optionalKey(Schema.String),
	ConflictReportName: Schema.optionalKey(Schema.String)
});
export type RecipeFields = typeof RecipeFields.Type;
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
export const LocalizationProjectRequest = Schema.Struct({
	projectRoot: Schema.NonEmptyString,
	limits: Schema.optionalKey(LocalizationLimits)
});
export type LocalizationProjectRequest = typeof LocalizationProjectRequest.Type;
export const LocalizationEvidenceRequest = LocalizationProjectRequest.pipe(
	Schema.fieldsAssign({ target: LocalizationTarget })
);
export type LocalizationEvidenceRequest = typeof LocalizationEvidenceRequest.Type;
export const TargetDiagnostic = Schema.Struct({
	targetIndex: Schema.optionalKey(Schema.Int),
	configIndex: Schema.optionalKey(Schema.Int),
	error: LocalizationError
});
export const LocalizationTargetDiscovery = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	targets: Schema.Array(LocalizationTarget),
	diagnostics: Schema.Array(TargetDiagnostic)
});
export type LocalizationTargetDiscovery = typeof LocalizationTargetDiscovery.Type;

export const POLine = Schema.Struct({
	text: Schema.String,
	ending: Schema.Literals(["\r\n", "\n", "\r", ""])
});
export type POLine = typeof POLine.Type;
export const POStringField = Schema.Struct({
	name: Schema.Literals(["msgctxt", "msgid", "msgid_plural", "msgstr"]),
	index: Schema.optionalKey(Schema.Int),
	lineIndices: Schema.Array(Schema.Int),
	value: Schema.String
});
export type POStringField = typeof POStringField.Type;
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
export const POBlock = Schema.Struct({
	kind: Schema.Literals(["header", "entry", "trivia"]),
	lines: Schema.Array(POLine),
	fields: Schema.Array(POStringField),
	entry: Schema.optionalKey(POEntry)
});
export type POBlock = typeof POBlock.Type;
export const PODocument = Schema.Struct({
	bom: Schema.Boolean,
	format: POFormat,
	hasSourceText: Schema.Boolean,
	blocks: Schema.Array(POBlock)
});
export type PODocument = typeof PODocument.Type;
export const POParseOptions = Schema.Struct({
	format: Schema.optionalKey(POFormat),
	collapseMode: Schema.optionalKey(LocalizationCollapseMode),
	limits: Schema.optionalKey(LocalizationLimits)
});
export type POParseOptions = typeof POParseOptions.Type;

export const LocalizationMeta = Schema.Struct({
	version: Schema.Literals([0, 1, 2]),
	nativeCulture: CultureCode,
	nativeLocresPath: Schema.String,
	compiledCultures: Schema.Array(CultureCode),
	isUGC: Schema.Boolean
});
export type LocalizationMeta = typeof LocalizationMeta.Type;
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
export const ManifestFileEvidence = fileEvidence(LocalizationManifest);
export const ArchiveFileEvidence = fileEvidence(LocalizationArchive);
export const POFileEvidence = fileEvidence(PODocument);
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
