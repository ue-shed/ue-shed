import { Result, Schema } from "effect";
import {
	CultureCode,
	FileProvenance,
	LocalizationErrorGuidanceFields as ErrorGuidanceFields,
	LocalizationIdentity,
	LocalizationTargetName
} from "./schema.js";

/**
 * One proposed translation. `source` and `previousTranslation` record what the proposal was made
 * against; `applyLocalizationChangeSet` revalidates both before writing.
 */
export const LocalizationChange = Schema.Struct({
	target: LocalizationTargetName,
	culture: CultureCode,
	...LocalizationIdentity.fields,
	source: Schema.String,
	previousTranslation: Schema.NullOr(Schema.String),
	translation: Schema.String
});
export type LocalizationChange = typeof LocalizationChange.Type;

/**
 * Version-1 proposed translations with producer/file provenance. Applying a set rechecks
 * source, previous translation and file hashes; decoding the proposal does not authorize a
 * write.
 */
export const LocalizationChangeSet = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	provenance: Schema.Struct({
		producer: Schema.NonEmptyString,
		files: Schema.Array(FileProvenance)
	}),
	changes: Schema.Array(LocalizationChange)
});
export type LocalizationChangeSet = typeof LocalizationChangeSet.Type;

/**
 * Invalid, duplicate, multi-target or unwritable translation proposal. Code and guidance
 * identify the correction; optional cause retains a domain failure when available.
 */
export class LocalizationChangeSetError extends Schema.TaggedError<LocalizationChangeSetError>()(
	"LocalizationChangeSetError",
	{
		code: Schema.Literals([
			"invalid_change_set",
			"duplicate_change",
			"multiple_targets",
			"unwritable_change"
		]),
		...ErrorGuidanceFields,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/**
 * Parses a version-1 JSON translation proposal and rejects duplicate
 * target/culture/namespace/key changes. Returns a typed Result without reading current
 * evidence or writing PO files.
 */
export function decodeLocalizationChangeSet(
	input: string
): Result.Result<LocalizationChangeSet, LocalizationChangeSetError> {
	const result = Schema.decodeUnknownResult(Schema.fromJsonString(LocalizationChangeSet))(input);
	if (Result.isFailure(result))
		return Result.fail(
			new LocalizationChangeSetError({
				code: "invalid_change_set",
				message: "The change-set document does not match version 1.",
				recovery:
					"Provide valid JSON with provenance and complete identity, source and replacement fields.",
				retrySafe: true,
				nextStep: "fix_input"
			})
		);
	const identities = result.success.changes.map((change) =>
		JSON.stringify([change.target, change.culture, change.namespace, change.key])
	);
	if (new Set(identities).size !== identities.length)
		return Result.fail(
			new LocalizationChangeSetError({
				code: "duplicate_change",
				message: "The change set contains duplicate translation identities.",
				recovery:
					"Keep exactly one proposed replacement per target, culture, namespace and key.",
				retrySafe: true,
				nextStep: "fix_input"
			})
		);
	return Result.succeed(result.success);
}
