import { Schema } from "effect";

/**
 * What a caller can do next after an expected failure. Same names and literal set as
 * `ErrorNextStep` in `@ue-shed/protocol`, defined locally to keep protocol outside this package's
 * runtime dependency boundary:
 *
 * - `fix_input`: the request, configuration or release is wrong; change it and try again.
 * - `retry`: the same request may succeed later without changes. Only valid when `retrySafe` is true.
 * - `reconcile`: state changed underneath the caller; re-read it, then decide whether to retry.
 * - `escalate`: the caller cannot fix this; report it with the error's context.
 */
export const PluginErrorNextStep = Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]);
export type PluginErrorNextStep = typeof PluginErrorNextStep.Type;

/**
 * Guidance fields every plugin-distribution tagged error carries, matching `ErrorGuidanceFields`
 * in `@ue-shed/protocol`. `retrySafe` states whether repeating the same operation is idempotent;
 * it must be true whenever `nextStep` is `retry`.
 */
export const PluginErrorGuidanceFields = {
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: PluginErrorNextStep
};

/** The original failure behind a classified error; diagnostic evidence, not text to branch on. */
const CauseFields = { cause: Schema.optionalKey(Schema.Defect()) };

export class ReleaseUnavailable extends Schema.TaggedError<ReleaseUnavailable>()(
	"ReleaseUnavailable",
	{ ...PluginErrorGuidanceFields, releaseVersion: Schema.String, ...CauseFields }
) {}

export class OfflineCacheMiss extends Schema.TaggedError<OfflineCacheMiss>()("OfflineCacheMiss", {
	...PluginErrorGuidanceFields,
	releaseVersion: Schema.String
}) {}

export class UnsupportedManifestVersion extends Schema.TaggedError<UnsupportedManifestVersion>()(
	"UnsupportedManifestVersion",
	{ ...PluginErrorGuidanceFields, releaseVersion: Schema.String, ...CauseFields }
) {}

export class IncompatibleUnrealVersion extends Schema.TaggedError<IncompatibleUnrealVersion>()(
	"IncompatibleUnrealVersion",
	{
		...PluginErrorGuidanceFields,
		releaseVersion: Schema.String,
		unrealVersion: Schema.String,
		...CauseFields
	}
) {}

export class CompatiblePluginBuildUnavailable extends Schema.TaggedError<CompatiblePluginBuildUnavailable>()(
	"CompatiblePluginBuildUnavailable",
	{
		...PluginErrorGuidanceFields,
		architecture: Schema.String,
		configuration: Schema.String,
		engineBuildId: Schema.String,
		platform: Schema.String,
		releaseVersion: Schema.String,
		target: Schema.String,
		unrealVersion: Schema.String
	}
) {}

export class ManifestDigestMismatch extends Schema.TaggedError<ManifestDigestMismatch>()(
	"ManifestDigestMismatch",
	{
		...PluginErrorGuidanceFields,
		actual: Schema.String,
		expected: Schema.String,
		releaseVersion: Schema.String
	}
) {}

export class ArtifactDigestMismatch extends Schema.TaggedError<ArtifactDigestMismatch>()(
	"ArtifactDigestMismatch",
	{
		...PluginErrorGuidanceFields,
		actual: Schema.String,
		expected: Schema.String,
		releaseVersion: Schema.String
	}
) {}

export class MalformedOrUnsafeArchive extends Schema.TaggedError<MalformedOrUnsafeArchive>()(
	"MalformedOrUnsafeArchive",
	{
		...CauseFields,
		...PluginErrorGuidanceFields,
		entry: Schema.optional(Schema.String),
		releaseVersion: Schema.String
	}
) {}

export class CorruptCacheEntry extends Schema.TaggedError<CorruptCacheEntry>()(
	"CorruptCacheEntry",
	{
		...PluginErrorGuidanceFields,
		cachePath: Schema.String,
		releaseVersion: Schema.String,
		...CauseFields
	}
) {}

export class ImmutableVersionConflict extends Schema.TaggedError<ImmutableVersionConflict>()(
	"ImmutableVersionConflict",
	{ ...PluginErrorGuidanceFields, cachePath: Schema.String, releaseVersion: Schema.String }
) {}

export class PluginInstallCancelled extends Schema.TaggedError<PluginInstallCancelled>()(
	"PluginInstallCancelled",
	{ ...PluginErrorGuidanceFields, releaseVersion: Schema.String, stage: Schema.String }
) {}

export class ActiveLeasePreventsPrune extends Schema.TaggedError<ActiveLeasePreventsPrune>()(
	"ActiveLeasePreventsPrune",
	{ ...PluginErrorGuidanceFields, activeLeases: Schema.Int, releaseVersion: Schema.String }
) {}

export class TransportFailure extends Schema.TaggedError<TransportFailure>()("TransportFailure", {
	...PluginErrorGuidanceFields,
	operation: Schema.String,
	releaseVersion: Schema.String,
	...CauseFields
}) {}

export class PluginStorageFailure extends Schema.TaggedError<PluginStorageFailure>()(
	"PluginStorageFailure",
	{
		...PluginErrorGuidanceFields,
		operation: Schema.String,
		releaseVersion: Schema.String,
		...CauseFields
	}
) {}

export class PluginDistributionValidationError extends Schema.TaggedError<PluginDistributionValidationError>()(
	"PluginDistributionValidationError",
	{ ...PluginErrorGuidanceFields, field: Schema.String, ...CauseFields }
) {}

export class InternalInvariantFailure extends Schema.TaggedError<InternalInvariantFailure>()(
	"InternalInvariantFailure",
	{ ...PluginErrorGuidanceFields, operation: Schema.String }
) {}

export const PluginDistributionError = Schema.Union([
	ReleaseUnavailable,
	OfflineCacheMiss,
	UnsupportedManifestVersion,
	IncompatibleUnrealVersion,
	CompatiblePluginBuildUnavailable,
	ManifestDigestMismatch,
	ArtifactDigestMismatch,
	MalformedOrUnsafeArchive,
	CorruptCacheEntry,
	ImmutableVersionConflict,
	PluginInstallCancelled,
	ActiveLeasePreventsPrune,
	TransportFailure,
	PluginStorageFailure,
	PluginDistributionValidationError,
	InternalInvariantFailure
]);
export type PluginDistributionError = typeof PluginDistributionError.Type;
