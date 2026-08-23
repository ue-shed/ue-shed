import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
	EngineBuildId,
	PluginBuildConfiguration,
	PluginBuildTarget,
	Sha256Checksum,
	UnrealArchitecture,
	UnrealPlatform,
	UnrealVersion,
	isCompiledPluginBundleManifest,
	isPluginBundleUnrealVersionSupported,
	type PluginBundleManifest
} from "./manifest.js";

export const PluginVariantIdentity = Schema.String.check(
	Schema.isPattern(/^pv2-[a-f0-9]{64}$/)
).pipe(Schema.brand("PluginVariantIdentity"));
export type PluginVariantIdentity = typeof PluginVariantIdentity.Type;

export const SourcePluginVariantRequest = Schema.Struct({
	kind: Schema.Literal("source"),
	unrealVersion: Schema.optionalKey(UnrealVersion)
});
export type SourcePluginVariantRequest = typeof SourcePluginVariantRequest.Type;

export const CompiledPluginVariantRequest = Schema.Struct({
	architecture: UnrealArchitecture,
	configuration: PluginBuildConfiguration,
	engineBuildId: EngineBuildId,
	kind: Schema.Literal("compiled"),
	platform: UnrealPlatform,
	target: PluginBuildTarget,
	unrealVersion: UnrealVersion
});
export type CompiledPluginVariantRequest = typeof CompiledPluginVariantRequest.Type;

export const PluginVariantRequest = Schema.Union([
	SourcePluginVariantRequest,
	CompiledPluginVariantRequest
]);
export type PluginVariantRequest = typeof PluginVariantRequest.Type;

export const PluginVariantReference = Schema.Struct({
	releaseVersion: Schema.String,
	variantIdentity: PluginVariantIdentity
});
export type PluginVariantReference = typeof PluginVariantReference.Type;

export function pluginBundleKind(manifest: PluginBundleManifest): "source" | "compiled" {
	return isCompiledPluginBundleManifest(manifest) ? "compiled" : "source";
}

export function pluginVariantMatches(
	manifest: PluginBundleManifest,
	request: PluginVariantRequest
): boolean {
	if (request.kind === "source") {
		return (
			!isCompiledPluginBundleManifest(manifest) &&
			(request.unrealVersion === undefined ||
				isPluginBundleUnrealVersionSupported(manifest, request.unrealVersion))
		);
	}
	if (!isCompiledPluginBundleManifest(manifest)) return false;
	const compatibility = manifest.compatibility;
	return (
		compatibility.unrealVersion === request.unrealVersion &&
		compatibility.engineBuildId === request.engineBuildId &&
		compatibility.platform === request.platform &&
		compatibility.architecture === request.architecture &&
		compatibility.target === request.target &&
		compatibility.configuration === request.configuration
	);
}

function compatibilityIdentity(manifest: PluginBundleManifest) {
	if (isCompiledPluginBundleManifest(manifest)) {
		return {
			architecture: manifest.compatibility.architecture,
			configuration: manifest.compatibility.configuration,
			engineBuildId: manifest.compatibility.engineBuildId,
			engineSourceCommit: manifest.compatibility.engineSourceCommit,
			kind: "compiled",
			platform: manifest.compatibility.platform,
			target: manifest.compatibility.target,
			unrealVersion: manifest.compatibility.unrealVersion
		};
	}
	const unrealVersionRange =
		manifest.schemaVersion === 1 ? manifest.unreal : manifest.compatibility.unrealVersionRange;
	return { kind: "source", unrealVersionRange };
}

/**
 * Derives a filesystem-safe immutable identity from validated compatibility and pinned bytes.
 * Object keys are deliberately written in lexical order so the semantic input is canonical.
 */
export function derivePluginVariantIdentity(options: {
	readonly manifest: PluginBundleManifest;
	readonly manifestDigest: Sha256Checksum;
}): PluginVariantIdentity {
	const semanticIdentity = JSON.stringify({
		artifactDigest: options.manifest.artifact.sha256,
		compatibility: compatibilityIdentity(options.manifest),
		manifestDigest: options.manifestDigest,
		releaseVersion: options.manifest.releaseVersion,
		schemaVersion: options.manifest.schemaVersion
	});
	return PluginVariantIdentity.make(
		`pv2-${createHash("sha256").update(semanticIdentity).digest("hex")}`
	);
}
