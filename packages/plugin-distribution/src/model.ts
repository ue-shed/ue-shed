import { Schema } from "effect";
import {
	PluginBundlePlugin,
	PluginId,
	ReleaseVersion,
	Sha256Checksum,
	UnrealVersion
} from "./manifest.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const BoundedPath = NonEmptyString.check(Schema.isMaxLength(32_767));
const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const PluginAcquisitionRequest = Schema.Struct({
	expectedArtifactSha256: Schema.optional(Sha256Checksum),
	expectedManifestSha256: Schema.optional(Sha256Checksum),
	networkPolicy: Schema.optional(Schema.Literals(["online", "cache-only"])),
	pluginIds: Schema.Array(PluginId).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	releaseVersion: ReleaseVersion,
	unrealVersion: Schema.optional(UnrealVersion)
});
export type PluginAcquisitionRequest = typeof PluginAcquisitionRequest.Type;

const ProgressBase = {
	releaseVersion: ReleaseVersion
};

export const PluginAcquisitionProgress = Schema.Union([
	Schema.Struct({ ...ProgressBase, phase: Schema.Literal("resolving") }),
	Schema.Struct({
		...ProgressBase,
		bytesCompleted: ByteCount,
		bytesTotal: Schema.optional(ByteCount),
		phase: Schema.Literal("downloading")
	}),
	Schema.Struct({
		...ProgressBase,
		bytesCompleted: ByteCount,
		bytesTotal: ByteCount,
		phase: Schema.Literal("verifying")
	}),
	Schema.Struct({
		...ProgressBase,
		bytesCompleted: ByteCount,
		bytesTotal: ByteCount,
		filesCompleted: ByteCount,
		phase: Schema.Literal("extracting")
	}),
	Schema.Struct({ ...ProgressBase, phase: Schema.Literal("publishing") }),
	Schema.Struct({ ...ProgressBase, cacheHit: Schema.Boolean, phase: Schema.Literal("ready") })
]);
export type PluginAcquisitionProgress = typeof PluginAcquisitionProgress.Type;

export const PluginSourceProvenance = Schema.Struct({
	detail: Schema.String,
	kind: Schema.Literals(["local", "http", "github", "cache"]),
	sourceId: NonEmptyString
});
export type PluginSourceProvenance = typeof PluginSourceProvenance.Type;

export const PluginLease = Schema.Struct({
	cachePath: BoundedPath,
	identity: NonEmptyString,
	releaseVersion: ReleaseVersion
});
export type PluginLease = typeof PluginLease.Type;

export const PluginAcquisitionResult = Schema.Struct({
	artifactDigest: Sha256Checksum,
	cacheHit: Schema.Boolean,
	cacheIdentity: NonEmptyString,
	cachePath: BoundedPath,
	descriptorPaths: Schema.Array(BoundedPath),
	lease: PluginLease,
	manifestDigest: Sha256Checksum,
	releaseIdentity: NonEmptyString,
	releaseVersion: ReleaseVersion,
	resolvedPluginIds: Schema.Array(PluginId),
	resolvedPlugins: Schema.Array(PluginBundlePlugin),
	source: PluginSourceProvenance
});
export type PluginAcquisitionResult = typeof PluginAcquisitionResult.Type;

export const CachedPluginRelease = Schema.Struct({
	artifactDigest: Sha256Checksum,
	cacheIdentity: NonEmptyString,
	cachePath: BoundedPath,
	manifestDigest: Sha256Checksum,
	plugins: Schema.Array(PluginId),
	releaseIdentity: NonEmptyString,
	releaseVersion: ReleaseVersion
});
export type CachedPluginRelease = typeof CachedPluginRelease.Type;

export interface PluginDistributionLimits {
	readonly maximumArtifactBytes: number;
	readonly maximumExtractedBytes: number;
	readonly maximumFileBytes: number;
	readonly maximumFileCount: number;
	readonly maximumManifestBytes: number;
}

export const defaultPluginDistributionLimits: PluginDistributionLimits = {
	maximumArtifactBytes: 512 * 1024 * 1024,
	maximumExtractedBytes: 2 * 1024 * 1024 * 1024,
	maximumFileBytes: 512 * 1024 * 1024,
	maximumFileCount: 100_000,
	maximumManifestBytes: 1024 * 1024
};
