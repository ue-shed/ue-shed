import { Schema } from "effect";

const ErrorFields = {
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
};

export class ReleaseUnavailable extends Schema.TaggedErrorClass<ReleaseUnavailable>()(
	"ReleaseUnavailable",
	{ ...ErrorFields, releaseVersion: Schema.String }
) {}

export class OfflineCacheMiss extends Schema.TaggedErrorClass<OfflineCacheMiss>()(
	"OfflineCacheMiss",
	{ ...ErrorFields, releaseVersion: Schema.String }
) {}

export class UnsupportedManifestVersion extends Schema.TaggedErrorClass<UnsupportedManifestVersion>()(
	"UnsupportedManifestVersion",
	{ ...ErrorFields, releaseVersion: Schema.String }
) {}

export class IncompatibleUnrealVersion extends Schema.TaggedErrorClass<IncompatibleUnrealVersion>()(
	"IncompatibleUnrealVersion",
	{ ...ErrorFields, releaseVersion: Schema.String, unrealVersion: Schema.String }
) {}

export class ManifestDigestMismatch extends Schema.TaggedErrorClass<ManifestDigestMismatch>()(
	"ManifestDigestMismatch",
	{
		...ErrorFields,
		actual: Schema.String,
		expected: Schema.String,
		releaseVersion: Schema.String
	}
) {}

export class ArtifactDigestMismatch extends Schema.TaggedErrorClass<ArtifactDigestMismatch>()(
	"ArtifactDigestMismatch",
	{
		...ErrorFields,
		actual: Schema.String,
		expected: Schema.String,
		releaseVersion: Schema.String
	}
) {}

export class MalformedOrUnsafeArchive extends Schema.TaggedErrorClass<MalformedOrUnsafeArchive>()(
	"MalformedOrUnsafeArchive",
	{ ...ErrorFields, entry: Schema.optional(Schema.String), releaseVersion: Schema.String }
) {}

export class CorruptCacheEntry extends Schema.TaggedErrorClass<CorruptCacheEntry>()(
	"CorruptCacheEntry",
	{ ...ErrorFields, cachePath: Schema.String, releaseVersion: Schema.String }
) {}

export class ImmutableVersionConflict extends Schema.TaggedErrorClass<ImmutableVersionConflict>()(
	"ImmutableVersionConflict",
	{ ...ErrorFields, cachePath: Schema.String, releaseVersion: Schema.String }
) {}

export class AcquisitionCancelled extends Schema.TaggedErrorClass<AcquisitionCancelled>()(
	"AcquisitionCancelled",
	{ ...ErrorFields, releaseVersion: Schema.String, stage: Schema.String }
) {}

export class ActiveLeasePreventsPrune extends Schema.TaggedErrorClass<ActiveLeasePreventsPrune>()(
	"ActiveLeasePreventsPrune",
	{ ...ErrorFields, activeLeases: Schema.Int, releaseVersion: Schema.String }
) {}

export class TransportFailure extends Schema.TaggedErrorClass<TransportFailure>()(
	"TransportFailure",
	{ ...ErrorFields, operation: Schema.String, releaseVersion: Schema.String }
) {}

export class PluginStorageFailure extends Schema.TaggedErrorClass<PluginStorageFailure>()(
	"PluginStorageFailure",
	{ ...ErrorFields, operation: Schema.String, releaseVersion: Schema.String }
) {}

export class PluginDistributionValidationError extends Schema.TaggedErrorClass<PluginDistributionValidationError>()(
	"PluginDistributionValidationError",
	{ ...ErrorFields, field: Schema.String }
) {}

export class InternalInvariantFailure extends Schema.TaggedErrorClass<InternalInvariantFailure>()(
	"InternalInvariantFailure",
	{ ...ErrorFields, operation: Schema.String }
) {}

export const PluginDistributionError = Schema.Union([
	ReleaseUnavailable,
	OfflineCacheMiss,
	UnsupportedManifestVersion,
	IncompatibleUnrealVersion,
	ManifestDigestMismatch,
	ArtifactDigestMismatch,
	MalformedOrUnsafeArchive,
	CorruptCacheEntry,
	ImmutableVersionConflict,
	AcquisitionCancelled,
	ActiveLeasePreventsPrune,
	TransportFailure,
	PluginStorageFailure,
	PluginDistributionValidationError,
	InternalInvariantFailure
]);
export type PluginDistributionError = typeof PluginDistributionError.Type;
