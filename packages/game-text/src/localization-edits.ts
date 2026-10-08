import { Schema } from "effect";
import {
	CultureCode,
	LocalizationChange,
	LocalizationChangeOutcome,
	LocalizationChangeSet,
	LocalizationTargetName,
	TextKey,
	TextNamespace,
	type LocalizationChangeSetReview,
	type LocalizationTargetEvidence
} from "@ue-shed/localization/browser";

export const MAX_LOCALIZATION_EDITS = 500;

/**
 * A translation edit staged in a host. `seenTranslation` is what the person saw shipping when
 * they staged it; the writer rejects the edit if that has changed since.
 */
export const LocalizationEdit = Schema.Struct({
	culture: CultureCode,
	namespace: TextNamespace,
	key: TextKey,
	seenTranslation: Schema.NullOr(Schema.String),
	translation: Schema.String.check(Schema.isMaxLength(64 * 1024))
});
export type LocalizationEdit = typeof LocalizationEdit.Type;

export const LocalizationEditRequest = Schema.Struct({
	target: LocalizationTargetName,
	mode: Schema.Literals(["review", "write"]),
	edits: Schema.Array(LocalizationEdit).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_LOCALIZATION_EDITS)
	)
});
export type LocalizationEditRequest = typeof LocalizationEditRequest.Type;

export const LocalizationEditOutcome = Schema.Struct({
	culture: CultureCode,
	namespace: TextNamespace,
	key: TextKey,
	outcome: LocalizationChangeOutcome,
	currentTranslation: Schema.NullOr(Schema.String),
	translation: Schema.String
});
export type LocalizationEditOutcome = typeof LocalizationEditOutcome.Type;

export const LocalizationEditResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({
		status: Schema.Literals(["reviewed", "written", "partially_written", "rejected"]),
		edits: Schema.Array(LocalizationEditOutcome).check(
			Schema.isMaxLength(MAX_LOCALIZATION_EDITS)
		),
		/** Project-relative PO files a write replaces (review) or replaced (write). */
		files: Schema.Array(
			Schema.Struct({
				culture: CultureCode,
				relativePath: Schema.String,
				changes: Schema.Int,
				written: Schema.Boolean
			})
		),
		notSynced: Schema.Int
	}),
	Schema.Struct({
		status: Schema.Literal("failed"),
		code: Schema.String,
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type LocalizationEditResult = typeof LocalizationEditResult.Type;

/** Builds a change set whose sources come from the manifest the edits are checked against. */
export function localizationEditChangeSet(
	evidence: LocalizationTargetEvidence,
	edits: readonly LocalizationEdit[],
	producer: string
): LocalizationChangeSet {
	const manifest = evidence.manifest.status === "read" ? evidence.manifest.value.entries : [];
	return LocalizationChangeSet.make({
		schemaVersion: 1,
		provenance: { producer, files: [] },
		changes: edits.map((edit) =>
			LocalizationChange.make({
				target: evidence.target.name,
				culture: edit.culture,
				namespace: edit.namespace,
				key: edit.key,
				// An unknown identity keeps an empty source; review reports it as not in the manifest.
				source:
					manifest.find(
						(entry) => entry.namespace === edit.namespace && entry.key === edit.key
					)?.source.Text ?? "",
				previousTranslation: edit.seenTranslation,
				translation: edit.translation
			})
		)
	});
}

export function localizationEditOutcomes(
	review: LocalizationChangeSetReview
): LocalizationEditOutcome[] {
	return review.changes.map(({ change, outcome, currentTranslation }) => ({
		culture: change.culture,
		namespace: change.namespace,
		key: change.key,
		outcome,
		currentTranslation,
		translation: change.translation
	}));
}
