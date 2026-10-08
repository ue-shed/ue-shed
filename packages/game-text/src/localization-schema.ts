import {
	ArchiveEntry,
	CultureCode,
	LocalizationIdentity,
	LocalizationReviewFlag,
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
/**
 * Review progress for one line and culture, from the project's review file. `changed` means the
 * source or the shipped translation changed after the flags were set.
 */
export const LocalizationReviewState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_reviewed") }),
	Schema.Struct({
		status: Schema.Literals(["current", "changed"]),
		flags: Schema.Array(LocalizationReviewFlag),
		by: Schema.String,
		at: Schema.String
	})
]);
export type LocalizationReviewState = typeof LocalizationReviewState.Type;
export const LocalizationReviewLens = Schema.Literals([
	"reviewed",
	"not_reviewed",
	"not_proofread",
	"changed_since_review",
	"machine_translated"
]);
export type LocalizationReviewLens = typeof LocalizationReviewLens.Type;
export const LocalizationCultureMark = Schema.Struct({
	culture: CultureCode,
	state: LocalizationState,
	facts: Schema.Array(LocalizationState),
	unknownReasons: Schema.Array(LocalizationUnknownReason),
	reducedSourceChecking: Schema.Boolean,
	review: Schema.optionalKey(LocalizationReviewState)
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
/**
 * How a changed key was paired with its earlier key: the same saved place (asset property or
 * DataTable cell), the same text in the same package, or text unique in the project.
 */
export const LocalizationKeyChangeMatch = Schema.Literals([
	"same_place",
	"same_text_in_package",
	"same_text"
]);
export type LocalizationKeyChangeMatch = typeof LocalizationKeyChangeMatch.Type;
/** The earlier key's translation for one culture, as it shipped before the key changed. */
export const LocalizationCarriedTranslation = Schema.Struct({
	culture: CultureCode,
	translation: Schema.String
});
export type LocalizationCarriedTranslation = typeof LocalizationCarriedTranslation.Type;
/**
 * A line's key changed. On the new key's line `direction` is "to" and `other` is the earlier key,
 * with the translations it shipped; on the earlier key's line `direction` is "from".
 */
export const LocalizationKeyChange = Schema.Struct({
	direction: Schema.Literals(["to", "from"]),
	other: LocalizationIdentity,
	match: LocalizationKeyChangeMatch,
	sourceChanged: Schema.Boolean,
	previousSource: Schema.String,
	translations: Schema.Array(LocalizationCarriedTranslation).check(
		Schema.isMaxLength(MAX_LOCALIZATION_CULTURES)
	)
});
export type LocalizationKeyChange = typeof LocalizationKeyChange.Type;
export const LocalizationLine = Schema.Struct({
	id: LocalizationLineId,
	origin: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("corpus"), unitIds: Schema.Array(TextUnitId) }),
		Schema.Struct({ kind: Schema.Literal("evidence"), id: LocalizationEvidenceLineId })
	]),
	identity: Schema.NullOr(LocalizationIdentity),
	source: Schema.String,
	manifest: Schema.Array(ManifestEntry),
	cultures: Schema.Array(LocalizationCultureState),
	keyChange: Schema.optionalKey(LocalizationKeyChange)
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
	/**
	 * The cultures in scope, such as a saved culture set; every target culture when absent. States,
	 * counts and translation problems consider only these cultures.
	 */
	cultures: Schema.optionalKey(
		Schema.Array(CultureCode).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_LOCALIZATION_CULTURES)
		)
	),
	state: Schema.optionalKey(LocalizationState),
	review: Schema.optionalKey(LocalizationReviewLens),
	/** Only lines whose key changed, listed by their new key. */
	keyChanged: Schema.optionalKey(Schema.Boolean),
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
	keyChange: Schema.optionalKey(LocalizationKeyChange),
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
	/** Present when the project has a review file for the target. */
	reviewCounts: Schema.optionalKey(Schema.Record(LocalizationReviewLens, Count)),
	/** New keys among the matched lines; present when any key changed. */
	keyChanged: Schema.optionalKey(Count),
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
