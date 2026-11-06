import { type Brand, Schema } from "effect";

/**
 * What a caller can do next after an expected failure. Mirrors `ErrorNextStep` in
 * `@ue-shed/protocol` without the runtime dependency. `fix_input`: change the request; `retry`:
 * may succeed unchanged later (only when `retrySafe`); `reconcile`: state changed, re-read it
 * first; `escalate`: the caller cannot fix it, so report it with the error's context.
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

export class ReleaseUnavailable extends Schema.TaggedError<
	ReleaseUnavailable,
	Brand.Brand<"packages/plugin-distribution/src/errors/ReleaseUnavailable">
>()("ReleaseUnavailable", {
	...PluginErrorGuidanceFields,
	releaseVersion: Schema.String,
	...CauseFields
}) {}

export class OfflineCacheMiss extends Schema.TaggedError<
	OfflineCacheMiss,
	Brand.Brand<"packages/plugin-distribution/src/errors/OfflineCacheMiss">
>()("OfflineCacheMiss", {
	...PluginErrorGuidanceFields,
	releaseVersion: Schema.String
}) {}

export class UnsupportedManifestVersion extends Schema.TaggedError<
	UnsupportedManifestVersion,
	Brand.Brand<"packages/plugin-distribution/src/errors/UnsupportedManifestVersion">
>()("UnsupportedManifestVersion", {
	...PluginErrorGuidanceFields,
	releaseVersion: Schema.String,
	...CauseFields
}) {}

export class IncompatibleUnrealVersion extends Schema.TaggedError<
	IncompatibleUnrealVersion,
	Brand.Brand<"packages/plugin-distribution/src/errors/IncompatibleUnrealVersion">
>()("IncompatibleUnrealVersion", {
	...PluginErrorGuidanceFields,
	releaseVersion: Schema.String,
	unrealVersion: Schema.String,
	...CauseFields
}) {}

export class CompatiblePluginBuildUnavailable extends Schema.TaggedError<
	CompatiblePluginBuildUnavailable,
	Brand.Brand<"packages/plugin-distribution/src/errors/CompatiblePluginBuildUnavailable">
>()("CompatiblePluginBuildUnavailable", {
	...PluginErrorGuidanceFields,
	architecture: Schema.String,
	configuration: Schema.String,
	engineBuildId: Schema.String,
	platform: Schema.String,
	releaseVersion: Schema.String,
	target: Schema.String,
	unrealVersion: Schema.String
}) {}

export class ManifestDigestMismatch extends Schema.TaggedError<
	ManifestDigestMismatch,
	Brand.Brand<"packages/plugin-distribution/src/errors/ManifestDigestMismatch">
>()("ManifestDigestMismatch", {
	...PluginErrorGuidanceFields,
	actual: Schema.String,
	expected: Schema.String,
	releaseVersion: Schema.String
}) {}

export class ArtifactDigestMismatch extends Schema.TaggedError<
	ArtifactDigestMismatch,
	Brand.Brand<"packages/plugin-distribution/src/errors/ArtifactDigestMismatch">
>()("ArtifactDigestMismatch", {
	...PluginErrorGuidanceFields,
	actual: Schema.String,
	expected: Schema.String,
	releaseVersion: Schema.String
}) {}

export class MalformedOrUnsafeArchive extends Schema.TaggedError<
	MalformedOrUnsafeArchive,
	Brand.Brand<"packages/plugin-distribution/src/errors/MalformedOrUnsafeArchive">
>()("MalformedOrUnsafeArchive", {
	...CauseFields,
	...PluginErrorGuidanceFields,
	entry: Schema.optional(Schema.String),
	releaseVersion: Schema.String
}) {}

export class CorruptCacheEntry extends Schema.TaggedError<
	CorruptCacheEntry,
	Brand.Brand<"packages/plugin-distribution/src/errors/CorruptCacheEntry">
>()("CorruptCacheEntry", {
	...PluginErrorGuidanceFields,
	cachePath: Schema.String,
	releaseVersion: Schema.String,
	...CauseFields
}) {}

export class ImmutableVersionConflict extends Schema.TaggedError<
	ImmutableVersionConflict,
	Brand.Brand<"packages/plugin-distribution/src/errors/ImmutableVersionConflict">
>()("ImmutableVersionConflict", {
	...PluginErrorGuidanceFields,
	cachePath: Schema.String,
	releaseVersion: Schema.String
}) {}

export class PluginInstallCancelled extends Schema.TaggedError<
	PluginInstallCancelled,
	Brand.Brand<"packages/plugin-distribution/src/errors/PluginInstallCancelled">
>()("PluginInstallCancelled", {
	...PluginErrorGuidanceFields,
	releaseVersion: Schema.String,
	stage: Schema.String
}) {}

export class ActiveLeasePreventsPrune extends Schema.TaggedError<
	ActiveLeasePreventsPrune,
	Brand.Brand<"packages/plugin-distribution/src/errors/ActiveLeasePreventsPrune">
>()("ActiveLeasePreventsPrune", {
	...PluginErrorGuidanceFields,
	activeLeases: Schema.Int,
	releaseVersion: Schema.String
}) {}

export class TransportFailure extends Schema.TaggedError<
	TransportFailure,
	Brand.Brand<"packages/plugin-distribution/src/errors/TransportFailure">
>()("TransportFailure", {
	...PluginErrorGuidanceFields,
	operation: Schema.String,
	releaseVersion: Schema.String,
	...CauseFields
}) {}

export class PluginStorageFailure extends Schema.TaggedError<
	PluginStorageFailure,
	Brand.Brand<"packages/plugin-distribution/src/errors/PluginStorageFailure">
>()("PluginStorageFailure", {
	...PluginErrorGuidanceFields,
	operation: Schema.String,
	releaseVersion: Schema.String,
	...CauseFields
}) {}

export class PluginDistributionValidationError extends Schema.TaggedError<
	PluginDistributionValidationError,
	Brand.Brand<"packages/plugin-distribution/src/errors/PluginDistributionValidationError">
>()("PluginDistributionValidationError", {
	...PluginErrorGuidanceFields,
	field: Schema.String,
	...CauseFields
}) {}

export class InternalInvariantFailure extends Schema.TaggedError<
	InternalInvariantFailure,
	Brand.Brand<"packages/plugin-distribution/src/errors/InternalInvariantFailure">
>()("InternalInvariantFailure", { ...PluginErrorGuidanceFields, operation: Schema.String }) {}

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
