import {
	ArchiveEntry,
	CultureCode,
	LocalizationIdentity,
	LocalizationTargetName,
	ManifestEntry,
	POEntry
} from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { TextUnitId } from "./identifiers.js";

export const LocalizationState = Schema.Literals([
	"translated",
	"not_translated",
	"needs_update",
	"not_synced",
	"not_gathered",
	"changed_since_gather",
	"not_found",
	"gathered_only",
	"outside_target",
	"unknown"
]);
export const localizationStates = LocalizationState.literals;
export const MAX_LOCALIZATION_CULTURES = 256;
export type LocalizationState = typeof LocalizationState.Type;

export const LocalizationUnknownReason = Schema.Literals([
	"missing_manifest",
	"missing_archive",
	"missing_po",
	"duplicate_manifest_identity",
	"duplicate_archive_identity",
	"duplicate_po_identity",
	"package_partial",
	"package_failed",
	"package_not_scanned",
	"unresolved_identity",
	"string_table_namespace_unavailable",
	"conflicting_source",
	"gather_settings_unavailable",
	"class_hierarchy_unavailable",
	"asset_class_unavailable",
	"path_not_project_relative",
	"ambiguous_po_identity"
]);
export type LocalizationUnknownReason = typeof LocalizationUnknownReason.Type;
export const LocalizationEvidenceLineId = Schema.String.pipe(
	Schema.brand("LocalizationEvidenceLineId")
);
export type LocalizationEvidenceLineId = typeof LocalizationEvidenceLineId.Type;
export const LocalizationLineId = Schema.String.pipe(Schema.brand("LocalizationLineId"));
export type LocalizationLineId = typeof LocalizationLineId.Type;
export const LocalizationCultureMark = Schema.Struct({
	culture: CultureCode,
	state: LocalizationState,
	facts: Schema.Array(LocalizationState),
	unknownReasons: Schema.Array(LocalizationUnknownReason),
	reducedSourceChecking: Schema.Boolean
});
export type LocalizationCultureMark = typeof LocalizationCultureMark.Type;
export const LocalizationCultureState = LocalizationCultureMark.pipe(
	Schema.fieldsAssign({
		archive: Schema.NullOr(ArchiveEntry),
		poTranslation: Schema.NullOr(Schema.String),
		po: Schema.NullOr(POEntry)
	})
);
export type LocalizationCultureState = typeof LocalizationCultureState.Type;
export const LocalizationLine = Schema.Struct({
	id: LocalizationLineId,
	origin: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("corpus"), unitIds: Schema.Array(TextUnitId) }),
		Schema.Struct({ kind: Schema.Literal("evidence"), id: LocalizationEvidenceLineId })
	]),
	identity: Schema.NullOr(LocalizationIdentity),
	source: Schema.String,
	manifest: Schema.Array(ManifestEntry),
	cultures: Schema.Array(LocalizationCultureState)
});
export type LocalizationLine = typeof LocalizationLine.Type;
export const LocalizationJoin = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	nativeCulture: Schema.NullOr(CultureCode),
	cultures: Schema.Array(CultureCode),
	lines: Schema.Array(LocalizationLine)
});
export type LocalizationJoin = typeof LocalizationJoin.Type;
export const LocalizationSelection = Schema.Struct({
	target: LocalizationTargetName,
	culture: Schema.optionalKey(CultureCode),
	state: Schema.optionalKey(LocalizationState),
	searchTranslations: Schema.optionalKey(Schema.Boolean)
});
export type LocalizationSelection = typeof LocalizationSelection.Type;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const LocalizationStateCounts = Schema.Record(
	LocalizationState,
	Schema.Struct({ lines: Count, sourceWords: Count })
);
export type LocalizationStateCounts = typeof LocalizationStateCounts.Type;
export const LocalizationCultureCounts = Schema.Struct({
	culture: CultureCode,
	states: LocalizationStateCounts,
	unknownReasons: Schema.Record(LocalizationUnknownReason, Count),
	reducedSourceChecking: Count
});
export type LocalizationCultureCounts = typeof LocalizationCultureCounts.Type;
export const LocalizationLinePreview = Schema.Struct({
	id: LocalizationLineId,
	origin: LocalizationLine.fields.origin,
	identity: LocalizationLine.fields.identity,
	source: Schema.String,
	manifestLocations: Schema.Array(Schema.String).check(Schema.isMaxLength(3)),
	remainingLocationCount: Count,
	cultures: Schema.Array(
		LocalizationCultureMark.pipe(
			Schema.fieldsAssign({
				translation: Schema.NullOr(Schema.String)
			})
		)
	).check(Schema.isMaxLength(MAX_LOCALIZATION_CULTURES))
});
export type LocalizationLinePreview = typeof LocalizationLinePreview.Type;
export const LocalizationQueryPage = Schema.Struct({
	target: LocalizationTargetName,
	nextCursor: Schema.optionalKey(LocalizationLineId),
	counts: Schema.Array(LocalizationCultureCounts).check(
		Schema.isMaxLength(MAX_LOCALIZATION_CULTURES)
	),
	stateCounts: Schema.Record(LocalizationState, Count),
	notSynced: Count,
	lines: Schema.Array(LocalizationLinePreview).check(Schema.isMaxLength(50))
});
export type LocalizationQueryPage = typeof LocalizationQueryPage.Type;
export class GameTextLocalizationError extends Schema.TaggedErrorClass<GameTextLocalizationError>()(
	"GameTextLocalizationError",
	{
		code: Schema.Literals([
			"target_not_found",
			"missing_manifest",
			"reader_failure",
			"invalid_selection"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
