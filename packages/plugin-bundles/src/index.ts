import { Effect, Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SafeIdentifier = NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SafeRelativePath = NonEmptyString.check(
	Schema.isPattern(
		/^(?![A-Za-z]:)(?![\\/])(?!\.\.?(?:[\\/]|$))(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/
	)
);

const SemVerPattern =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UnrealVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const Sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const CommitPattern = /^[a-f0-9]{40}$/;
const RepositoryPattern = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/;

/** A stable plugin identity, normally the name from a `.uplugin` descriptor. */
export const PluginId = SafeIdentifier.pipe(Schema.brand("PluginId"));
export type PluginId = Schema.Schema.Type<typeof PluginId>;

/** A semantic version used by a plugin descriptor. */
export const PluginVersion = NonEmptyString.check(Schema.isPattern(SemVerPattern)).pipe(
	Schema.brand("PluginVersion")
);
export type PluginVersion = Schema.Schema.Type<typeof PluginVersion>;

/** The exact release/candidate version that owns a plugin bundle. */
export const ReleaseVersion = NonEmptyString.check(Schema.isPattern(SemVerPattern)).pipe(
	Schema.brand("ReleaseVersion")
);
export type ReleaseVersion = Schema.Schema.Type<typeof ReleaseVersion>;

/** An Unreal Engine major/minor or major/minor/patch version (for example `5.7`). */
export const UnrealVersion = NonEmptyString.check(Schema.isPattern(UnrealVersionPattern)).pipe(
	Schema.brand("UnrealVersion")
);
export type UnrealVersion = Schema.Schema.Type<typeof UnrealVersion>;

/** A SHA-256 digest in the canonical `sha256:<lowercase hex>` form. */
export const Sha256Checksum = NonEmptyString.check(Schema.isPattern(Sha256Pattern)).pipe(
	Schema.brand("Sha256Checksum")
);
export type Sha256Checksum = Schema.Schema.Type<typeof Sha256Checksum>;

export const PluginArtifactId = SafeIdentifier.pipe(Schema.brand("PluginArtifactId"));
export type PluginArtifactId = Schema.Schema.Type<typeof PluginArtifactId>;

export const GitCommit = NonEmptyString.check(Schema.isPattern(CommitPattern)).pipe(
	Schema.brand("GitCommit")
);
export type GitCommit = Schema.Schema.Type<typeof GitCommit>;

export const PluginBundleSchemaVersion = Schema.Literal(1);
export type PluginBundleSchemaVersion = Schema.Schema.Type<typeof PluginBundleSchemaVersion>;

export const UnrealVersionRange = Schema.Struct({
	minimum: UnrealVersion,
	maximum: UnrealVersion
});
export type UnrealVersionRange = Schema.Schema.Type<typeof UnrealVersionRange>;

export const PluginBundlePlugin = Schema.Struct({
	dependencies: Schema.Array(PluginId),
	descriptorPath: SafeRelativePath,
	directory: SafeIdentifier,
	id: PluginId,
	version: PluginVersion
});
export type PluginBundlePlugin = Schema.Schema.Type<typeof PluginBundlePlugin>;

export const PluginBundleArtifactKind = Schema.Literals(["plugin-source", "unreal-plugin-source"]);
export type PluginBundleArtifactKind = Schema.Schema.Type<typeof PluginBundleArtifactKind>;

export const PluginBundleArtifact = Schema.Struct({
	bytes: Schema.Int.check(Schema.isGreaterThan(0)),
	id: PluginArtifactId,
	kind: PluginBundleArtifactKind,
	path: SafeRelativePath,
	sha256: Sha256Checksum
});
export type PluginBundleArtifact = Schema.Schema.Type<typeof PluginBundleArtifact>;

export const CandidateManifestReference = Schema.Struct({
	manifestPath: SafeRelativePath,
	sha256: Sha256Checksum,
	version: ReleaseVersion
});
export type CandidateManifestReference = Schema.Schema.Type<typeof CandidateManifestReference>;

export const PluginBundleSourceProvenance = Schema.Struct({
	commit: GitCommit,
	ref: NonEmptyString,
	repository: NonEmptyString.check(Schema.isPattern(RepositoryPattern))
});
export type PluginBundleSourceProvenance = Schema.Schema.Type<typeof PluginBundleSourceProvenance>;

export const PluginBundleProvenance = Schema.Struct({
	candidateManifest: CandidateManifestReference,
	source: PluginBundleSourceProvenance
});
export type PluginBundleProvenance = Schema.Schema.Type<typeof PluginBundleProvenance>;

export const PluginBundleManifest = Schema.Struct({
	artifact: PluginBundleArtifact,
	plugins: Schema.Array(PluginBundlePlugin).check(Schema.isMinLength(1)),
	provenance: PluginBundleProvenance,
	releaseVersion: ReleaseVersion,
	schemaVersion: PluginBundleSchemaVersion,
	unreal: UnrealVersionRange
});
export type PluginBundleManifest = Schema.Schema.Type<typeof PluginBundleManifest>;

/** Short aliases for consumers that refer to the release manifest as a plugin manifest. */
export const PluginManifest = PluginBundleManifest;
export type PluginManifest = PluginBundleManifest;
export const PluginDescriptor = PluginBundlePlugin;
export type PluginDescriptor = PluginBundlePlugin;
export const UnrealCompatibility = UnrealVersionRange;
export type UnrealCompatibility = UnrealVersionRange;
export const Sha256Digest = Sha256Checksum;
export type Sha256Digest = Sha256Checksum;

export const PluginBundleManifestValidationCode = Schema.Literals([
	"schema_invalid",
	"duplicate_dependency",
	"duplicate_plugin",
	"invalid_descriptor_path",
	"invalid_unreal_range",
	"invalid_checksum",
	"missing_dependency",
	"cyclic_dependency",
	"provenance_mismatch",
	"unsupported_unreal"
]);
export type PluginBundleManifestValidationCode = Schema.Schema.Type<
	typeof PluginBundleManifestValidationCode
>;

/** An expected manifest or artifact failure that a CLI can report with recovery guidance. */
export class PluginBundleManifestValidationError extends Schema.TaggedErrorClass<PluginBundleManifestValidationError>()(
	"PluginBundleManifestValidationError",
	{
		code: PluginBundleManifestValidationCode,
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export { PluginBundleManifestValidationError as PluginManifestValidationError };

export interface PluginBundleManifestValidationOptions {
	readonly actualArtifactSha256?: string;
	readonly expectedCandidateVersion?: string;
	readonly unrealVersion?: string;
}

function validationError(
	code: PluginBundleManifestValidationCode,
	message: string,
	recovery: string
): PluginBundleManifestValidationError {
	return new PluginBundleManifestValidationError({ code, message, recovery });
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
	if (match === null) return undefined;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3] ?? "0");
	if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
	return [major, minor, patch];
}

function compareVersions(left: string, right: string): number | undefined {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	if (leftParts === undefined || rightParts === undefined) return undefined;
	for (const [index, leftPart] of leftParts.entries()) {
		const rightPart = rightParts[index];
		if (rightPart === undefined) return undefined;
		if (leftPart < rightPart) return -1;
		if (leftPart > rightPart) return 1;
	}
	return 0;
}

function isSupportedUnrealVersion(manifest: PluginBundleManifest, engineVersion: string): boolean {
	const minimum = compareVersions(engineVersion, manifest.unreal.minimum);
	const maximum = compareVersions(engineVersion, manifest.unreal.maximum);
	return minimum !== undefined && maximum !== undefined && minimum >= 0 && maximum <= 0;
}

function validateGraph(
	manifest: PluginBundleManifest
): Effect.Effect<void, PluginBundleManifestValidationError> {
	const pluginsById = new Map<PluginId, PluginBundlePlugin>();
	for (const plugin of manifest.plugins) {
		if (pluginsById.has(plugin.id)) {
			return Effect.fail(
				validationError(
					"duplicate_plugin",
					`Plugin graph declares ${plugin.id} more than once.`,
					"Keep one descriptor entry for each plugin ID."
				)
			);
		}
		pluginsById.set(plugin.id, plugin);
	}

	for (const plugin of manifest.plugins) {
		if (!plugin.descriptorPath.startsWith(`${plugin.directory}/`)) {
			return Effect.fail(
				validationError(
					"invalid_descriptor_path",
					`Descriptor ${plugin.descriptorPath} is not inside plugin ${plugin.id}'s directory.`,
					"Set descriptorPath to the `.uplugin` file inside the declared plugin directory."
				)
			);
		}
		const dependencies = new Set<PluginId>();
		for (const dependency of plugin.dependencies) {
			if (dependencies.has(dependency)) {
				return Effect.fail(
					validationError(
						"duplicate_dependency",
						`Plugin ${plugin.id} declares dependency ${dependency} more than once.`,
						"List each plugin dependency once."
					)
				);
			}
			dependencies.add(dependency);
			if (!pluginsById.has(dependency)) {
				return Effect.fail(
					validationError(
						"missing_dependency",
						`Plugin ${plugin.id} depends on undeclared plugin ${dependency}.`,
						"Add the dependency to the manifest graph or remove the dependency from the descriptor."
					)
				);
			}
		}
	}

	const visiting = new Set<PluginId>();
	const visited = new Set<PluginId>();
	const path: PluginId[] = [];

	const visit = (pluginId: PluginId): PluginBundleManifestValidationError | undefined => {
		if (visiting.has(pluginId)) {
			const cycleStart = path.indexOf(pluginId);
			const cycle = [...path.slice(cycleStart), pluginId].join(" -> ");
			return validationError(
				"cyclic_dependency",
				`Plugin graph contains a dependency cycle: ${cycle}.`,
				"Remove one dependency edge so plugin installation has a deterministic order."
			);
		}
		if (visited.has(pluginId)) return undefined;
		const plugin = pluginsById.get(pluginId);
		if (plugin === undefined) return undefined;
		visiting.add(pluginId);
		path.push(pluginId);
		for (const dependency of plugin.dependencies) {
			const error = visit(dependency);
			if (error !== undefined) return error;
		}
		path.pop();
		visiting.delete(pluginId);
		visited.add(pluginId);
		return undefined;
	};

	for (const plugin of manifest.plugins) {
		const error = visit(plugin.id);
		if (error !== undefined) return Effect.fail(error);
	}
	return Effect.succeed(undefined);
}

/** Validates the graph and cross-field invariants of an already decoded manifest. */
export const validatePluginBundleManifestValue = (
	manifest: PluginBundleManifest,
	options: PluginBundleManifestValidationOptions = {}
): Effect.Effect<PluginBundleManifest, PluginBundleManifestValidationError> =>
	Effect.gen(function* () {
		const rangeOrder = compareVersions(manifest.unreal.minimum, manifest.unreal.maximum);
		if (rangeOrder === undefined || rangeOrder > 0) {
			yield* Effect.fail(
				validationError(
					"invalid_unreal_range",
					`Unreal compatibility range ${manifest.unreal.minimum}..${manifest.unreal.maximum} is invalid.`,
					"Set minimum to a version less than or equal to maximum."
				)
			);
		}

		if (manifest.provenance.candidateManifest.version !== manifest.releaseVersion) {
			yield* Effect.fail(
				validationError(
					"provenance_mismatch",
					"The candidate manifest version does not match the plugin bundle release version.",
					"Build the plugin bundle and package artifacts from the same release candidate."
				)
			);
		}

		if (
			options.expectedCandidateVersion !== undefined &&
			options.expectedCandidateVersion !== manifest.provenance.candidateManifest.version
		) {
			yield* Effect.fail(
				validationError(
					"provenance_mismatch",
					`Expected candidate ${options.expectedCandidateVersion}, received ${manifest.provenance.candidateManifest.version}.`,
					"Select the plugin manifest generated for the requested release candidate."
				)
			);
		}

		yield* validateGraph(manifest);

		if (
			options.unrealVersion !== undefined &&
			!isSupportedUnrealVersion(manifest, options.unrealVersion)
		) {
			yield* Effect.fail(
				validationError(
					"unsupported_unreal",
					`Unreal ${options.unrealVersion} is outside the supported range ${manifest.unreal.minimum}..${manifest.unreal.maximum}.`,
					"Use a supported Unreal Engine version or select a compatible plugin release."
				)
			);
		}

		if (options.actualArtifactSha256 !== undefined) {
			yield* verifyPluginBundleArtifactChecksum(manifest, options.actualArtifactSha256);
		}
		return manifest;
	});

/** Decodes and validates an unknown manifest at a CLI or release-artifact boundary. */
export const validatePluginBundleManifest = (
	input: unknown,
	options: PluginBundleManifestValidationOptions = {}
): Effect.Effect<PluginBundleManifest, PluginBundleManifestValidationError> =>
	Schema.decodeUnknownEffect(PluginBundleManifest)(input).pipe(
		Effect.mapError(() =>
			validationError(
				"schema_invalid",
				"Plugin bundle manifest does not match the versioned manifest schema.",
				"Use a manifest produced by the matching UE Shed release and check its JSON fields."
			)
		),
		Effect.flatMap((manifest) => validatePluginBundleManifestValue(manifest, options))
	);

/** Schema-only decoder for callers that need to preserve parse diagnostics separately. */
export const decodePluginBundleManifest = Schema.decodeUnknownEffect(PluginBundleManifest);

/** Validates one artifact digest before any extraction takes place. */
export const verifyPluginBundleArtifactChecksum = (
	manifest: PluginBundleManifest,
	actualSha256: string
): Effect.Effect<void, PluginBundleManifestValidationError> => {
	const normalized = actualSha256.startsWith("sha256:") ? actualSha256 : `sha256:${actualSha256}`;
	if (Sha256Pattern.test(normalized) && normalized === manifest.artifact.sha256) {
		return Effect.succeed(undefined);
	}
	return Effect.fail(
		validationError(
			"invalid_checksum",
			`Artifact checksum mismatch: ${actualSha256} does not match ${manifest.artifact.sha256}.`,
			"Re-download the artifact or select the artifact named by this manifest; do not extract an unverified archive."
		)
	);
};

/** Validates a manifest and checks that the target Unreal version is supported. */
export const validatePluginBundleForUnreal = (
	input: unknown,
	engineVersion: string,
	options: Omit<PluginBundleManifestValidationOptions, "unrealVersion"> = {}
): Effect.Effect<PluginBundleManifest, PluginBundleManifestValidationError> =>
	validatePluginBundleManifest(input, { ...options, unrealVersion: engineVersion });

export const isPluginBundleUnrealVersionSupported = (
	manifest: PluginBundleManifest,
	engineVersion: string
): boolean => isSupportedUnrealVersion(manifest, engineVersion);

export const compareUnrealVersions = (left: string, right: string): number | undefined =>
	compareVersions(left, right);

export const validatePluginManifest = validatePluginBundleManifest;
export const decodePluginManifest = decodePluginBundleManifest;
