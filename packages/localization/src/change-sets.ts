import { Result, Schema } from "effect";
import {
	CultureCode,
	FileProvenance,
	LocalizationIdentity,
	LocalizationTargetName
} from "./schema.js";

/** A proposal only. Applying it requires fresh source/translation validation by a future writer. */
export const LocalizationChange = Schema.Struct({
	target: LocalizationTargetName,
	culture: CultureCode,
	...LocalizationIdentity.fields,
	source: Schema.String,
	previousTranslation: Schema.NullOr(Schema.String),
	translation: Schema.String
});
export type LocalizationChange = typeof LocalizationChange.Type;

export const LocalizationChangeSet = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	provenance: Schema.Struct({
		producer: Schema.NonEmptyString,
		files: Schema.Array(FileProvenance)
	}),
	changes: Schema.Array(LocalizationChange)
});
export type LocalizationChangeSet = typeof LocalizationChangeSet.Type;

export class LocalizationChangeSetError extends Schema.TaggedErrorClass<LocalizationChangeSetError>()(
	"LocalizationChangeSetError",
	{
		code: Schema.Literals(["invalid_change_set", "duplicate_change"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

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
					"Provide valid JSON with provenance and complete identity, source and replacement fields."
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
					"Keep exactly one proposed replacement per target, culture, namespace and key."
			})
		);
	return Result.succeed(result.success);
}
