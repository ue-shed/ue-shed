import {
	ArchiveEntry,
	CultureCode,
	LocalizationIdentity,
	LocalizationReviewFlag,
	LocalizationTargetName,
	ManifestEntry,
	POEntry,
	type LocalizationError
} from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { TextUnitId } from "./identifiers.js";
import { TextAudience, TextOutOfScopeReason } from "./text-audience-schema.js";

/**
 * Primary localization state derived from saved corpus and gathered/archive/PO evidence.
 * Unknown remains distinct from a confirmed missing or untranslated line.
 */
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
/**
 * Ordered localization state values used to initialize complete state counters. Persist the
 * string values rather than their positions in this array.
 */
export const localizationStates = LocalizationState.literals;
/**
 * Public bound on cultures carried by selections and localization previews. Larger target sets
 * must be scoped before crossing these host response boundaries.
 */
export const MAX_LOCALIZATION_CULTURES = 256;
export type LocalizationState = typeof LocalizationState.Type;

/**
 * Missing or ambiguous evidence preventing a definite localization judgment. These reasons
 * should accompany unknown state instead of being converted into a clean result.
 */
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
/**
 * Opaque identifier for a gathered-only evidence line, distinct from a saved corpus unit ID. It
 * supports evidence that has no matching decoded package occurrence.
 */
export const LocalizationEvidenceLineId = Schema.String.pipe(
	Schema.brand("LocalizationEvidenceLineId")
);
export type LocalizationEvidenceLineId = typeof LocalizationEvidenceLineId.Type;
/**
 * Opaque joined localization line identifier for query and focus. Keep it with its target and
 * retained join generation.
 */
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
/**
 * Review-file filter for current, missing, changed or machine-translated review evidence.
 * Review status is independent of the translation's Unreal synchronization state.
 */
export const LocalizationReviewLens = Schema.Literals([
	"reviewed",
	"not_reviewed",
	"not_proofread",
	"changed_since_review",
	"machine_translated"
]);
export type LocalizationReviewLens = typeof LocalizationReviewLens.Type;
/**
 * Compact culture state, supporting facts, unknown reasons and optional review state.
 * reducedSourceChecking records when evidence permits only a weaker comparison.
 */
export const LocalizationCultureMark = Schema.Struct({
	culture: CultureCode,
	state: LocalizationState,
	facts: Schema.Array(LocalizationState),
	unknownReasons: Schema.Array(LocalizationUnknownReason),
	reducedSourceChecking: Schema.Boolean,
	review: Schema.optionalKey(LocalizationReviewState)
});
export type LocalizationCultureMark = typeof LocalizationCultureMark.Type;
/**
 * Culture mark expanded with archive and PO evidence. Null fields preserve missing evidence; a
 * present empty translation is different from an absent entry.
 */
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
/**
 * One corpus-backed or gathered-only line joined with manifest and per-culture evidence. Null
 * identity and unknown state preserve unresolved saved text without inventing localization
 * keys.
 */
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
	keyChange: Schema.optionalKey(LocalizationKeyChange),
	/**
	 * Player if any saved place with visible text is player text, else unknown if any is, else
	 * editor; unknown for lines with no saved place. Absent from joins built by older versions.
	 */
	audience: Schema.optionalKey(TextAudience),
	/**
	 * Why the target would not gather this line, when its state is `outside_target`: every saved
	 * place is outside the gather paths, or it is editor text and the target does not gather
	 * editor-only data.
	 */
	outOfScope: Schema.optionalKey(TextOutOfScopeReason)
});
export type LocalizationLine = typeof LocalizationLine.Type;
/**
 * Versioned target join with its native culture, culture list and lines. All line/culture
 * judgments derive from this target's retained evidence.
 */
export const LocalizationJoin = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	nativeCulture: Schema.NullOr(CultureCode),
	cultures: Schema.Array(CultureCode),
	lines: Schema.Array(LocalizationLine)
});
export type LocalizationJoin = typeof LocalizationJoin.Type;
/**
 * Target/culture and state/review scope for a query. Omitted cultures selects all target
 * cultures; an explicit culture set must be nonempty and bounded.
 */
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
/**
 * Nonnegative line and source-word totals for every localization state. Word counts may be
 * limited by available language evidence rather than a whitespace-only guess.
 */
export const LocalizationStateCounts = Schema.Record(
	LocalizationState,
	Schema.Struct({ lines: Count, sourceWords: Count })
);
export type LocalizationStateCounts = typeof LocalizationStateCounts.Type;
/**
 * Per-culture state totals, unknown-reason counts and reduced-source-checking count. Keep the
 * uncertainty totals visible alongside translated counts.
 */
export const LocalizationCultureCounts = Schema.Struct({
	culture: CultureCode,
	states: LocalizationStateCounts,
	unknownReasons: Schema.Record(LocalizationUnknownReason, Count),
	reducedSourceChecking: Count
});
export type LocalizationCultureCounts = typeof LocalizationCultureCounts.Type;
/**
 * Bounded localization line preview with up to three manifest locations and remaining-location
 * count. Full archive/PO objects remain in the retained join, outside the page.
 */
export const LocalizationLinePreview = Schema.Struct({
	id: LocalizationLineId,
	origin: LocalizationLine.fields.origin,
	identity: LocalizationLine.fields.identity,
	source: Schema.String,
	manifestLocations: Schema.Array(Schema.String).check(Schema.isMaxLength(3)),
	remainingLocationCount: Count,
	keyChange: Schema.optionalKey(LocalizationKeyChange),
	audience: LocalizationLine.fields.audience,
	outOfScope: LocalizationLine.fields.outOfScope,
	cultures: Schema.Array(
		LocalizationCultureMark.pipe(
			Schema.fieldsAssign({
				translation: Schema.NullOr(Schema.String)
			})
		)
	).check(Schema.isMaxLength(MAX_LOCALIZATION_CULTURES))
});
export type LocalizationLinePreview = typeof LocalizationLinePreview.Type;
/**
 * Bounded joined-line page with culture/state/review totals and continuation cursor. Counts
 * describe the whole selected scope, not only returned lines.
 */
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
/**
 * Typed target lookup, manifest read or selection failure. Stable code controls recovery; cause
 * preserves reader/decoder evidence for diagnostics.
 */
export class GameTextLocalizationError extends Schema.TaggedError<GameTextLocalizationError>()(
	"GameTextLocalizationError",
	{
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		cause: Schema.optionalKey(Schema.Defect()),
		code: Schema.Literals([
			"target_not_found",
			"missing_manifest",
			"unreadable_manifest",
			"reader_failure",
			"invalid_selection"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

/** Only a missing manifest needs a gather; other failures keep the reader's cause and recovery. */
export function localizationManifestFailure(
	error: LocalizationError,
	relativePath?: string | null
): GameTextLocalizationError {
	return new GameTextLocalizationError(
		error.code === "file_missing"
			? {
					retrySafe: false,
					nextStep: "fix_input",
					code: "missing_manifest",
					cause: error,
					message: relativePath
						? `Not in this working copy: ${relativePath}`
						: "The target has no gathered text file (manifest) in this working copy.",
					recovery:
						"Run the target's Gather step, or get the localization folder from source control."
				}
			: {
					retrySafe: false,
					nextStep: "fix_input",
					code: "unreadable_manifest",
					cause: error,
					message: `The target manifest could not be read (${error.code}): ${error.message}`,
					recovery: error.recovery
				}
	);
}
