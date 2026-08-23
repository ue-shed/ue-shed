import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
	PluginBundleManifest,
	CompiledPluginVariantRequest,
	PluginId,
	derivePluginVariantIdentity,
	pluginVariantMatches,
	resolvePluginBundleDependencies,
	validatePluginBundleForUnreal,
	validatePluginBundleManifest,
	verifyPluginBundleArtifactChecksum
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}`;

const validManifest = Schema.decodeUnknownSync(PluginBundleManifest)({
	artifact: {
		bytes: 2_048,
		id: "ue-shed-plugins-0.1.0-rc.1",
		kind: "plugin-source",
		path: "ue-shed-plugins-0.1.0-rc.1.tgz",
		sha256: digest
	},
	plugins: [
		{
			dependencies: [],
			descriptorPath: "UEShedCore/UEShedCore.uplugin",
			directory: "UEShedCore",
			engineDependencies: [],
			id: "UEShedCore",
			version: "0.1.0"
		},
		{
			dependencies: ["UEShedCore"],
			descriptorPath: "UEShedAuthoring/UEShedAuthoring.uplugin",
			directory: "UEShedAuthoring",
			engineDependencies: [],
			id: "UEShedAuthoring",
			version: "0.1.0"
		}
	],
	provenance: {
		candidateManifest: {
			manifestPath: "candidate-manifest.json",
			sha256: digest,
			version: "0.1.0-rc.1"
		},
		source: {
			commit: "a".repeat(40),
			ref: "refs/tags/v0.1.0-rc.1",
			repository: "https://github.com/ue-shed/ue-shed"
		}
	},
	releaseVersion: "0.1.0-rc.1",
	schemaVersion: 1,
	unreal: { maximum: "5.7", minimum: "5.6" }
});

const validCompiledManifest = Schema.decodeUnknownSync(PluginBundleManifest)({
	artifact: {
		bytes: 4_096,
		id: "ue-shed-plugins-compiled-0.1.0-rc.1",
		kind: "unreal-editor-plugin-binary",
		path: "ue-shed-plugins-compiled-0.1.0-rc.1.tar.gz",
		sha256: `sha256:${"b".repeat(64)}`
	},
	build: {
		builder: "ue-shed-plugin-builder",
		builderVersion: "1",
		compiler: {
			compiler: "MSVC",
			compilerVersion: "19.44",
			toolchain: "Visual Studio",
			toolchainVersion: "2022"
		},
		invocationSha256: `sha256:${"c".repeat(64)}`,
		requestedPluginIds: ["UEShedAuthoring"],
		resolvedPluginIds: ["UEShedCore", "UEShedAuthoring"],
		sourceArtifactSha256: digest,
		sourceManifestSha256: `sha256:${"d".repeat(64)}`
	},
	compatibility: {
		architecture: "x64",
		configuration: "Development",
		engineBuildId: "47537391",
		kind: "compiled",
		platform: "Win64",
		target: "UnrealEditor",
		unrealVersion: "5.7.4"
	},
	plugins: validManifest.plugins,
	provenance: validManifest.provenance,
	releaseVersion: "0.1.0-rc.1",
	schemaVersion: 2
});

const exactCompiledRequest = Schema.decodeUnknownSync(CompiledPluginVariantRequest)({
	architecture: "x64",
	configuration: "Development",
	engineBuildId: "47537391",
	kind: "compiled",
	platform: "Win64",
	target: "UnrealEditor",
	unrealVersion: "5.7.4"
});

it.effect("accepts a valid graph, artifact, and candidate provenance", () =>
	Effect.gen(function* () {
		const manifest = yield* validatePluginBundleManifest(validManifest);
		expect(manifest).toEqual(validManifest);
	})
);

it.effect("accepts a compiled editor plugin manifest with exact runtime identity", () =>
	Effect.gen(function* () {
		const manifest = yield* validatePluginBundleManifest(validCompiledManifest);
		expect(manifest).toEqual(validCompiledManifest);
		expect(pluginVariantMatches(manifest, exactCompiledRequest)).toBe(true);
		expect(
			derivePluginVariantIdentity({
				manifest,
				manifestDigest: validManifest.artifact.sha256
			})
		).toMatch(/^pv2-[a-f0-9]{64}$/);
	})
);

it.effect("rejects unknown manifest versions and contradictory binary fields", () =>
	Effect.gen(function* () {
		const unknownVersion = yield* validatePluginBundleManifest({
			...validCompiledManifest,
			schemaVersion: 3
		}).pipe(Effect.flip);
		expect(unknownVersion.code).toBe("schema_invalid");

		const contradictory = yield* validatePluginBundleManifest({
			...validManifest,
			compatibility: {
				architecture: "x64",
				configuration: "Development",
				engineBuildId: "47537391",
				kind: "compiled",
				platform: "Win64",
				target: "UnrealEditor",
				unrealVersion: "5.7.4"
			}
		}).pipe(Effect.flip);
		expect(contradictory.code).toBe("schema_invalid");
	})
);

it.effect("resolves an exact plugin and its transitive dependencies deterministically", () =>
	Effect.gen(function* () {
		const resolved = yield* resolvePluginBundleDependencies(validManifest, [
			PluginId.make("UEShedAuthoring")
		]);
		expect(resolved.orderedPluginIds).toEqual(["UEShedCore", "UEShedAuthoring"]);
	})
);

it.effect("rejects an unavailable requested plugin", () =>
	Effect.gen(function* () {
		const error = yield* resolvePluginBundleDependencies(validManifest, [
			PluginId.make("UEShedMissing")
		]).pipe(Effect.flip);
		expect(error.code).toBe("requested_plugin_unavailable");
	})
);

it.effect("rejects an artifact checksum mismatch before installation", () =>
	Effect.gen(function* () {
		const error = yield* validatePluginBundleManifest(validManifest, {
			actualArtifactSha256: "b".repeat(64)
		}).pipe(Effect.flip);
		expect(error.code).toBe("invalid_checksum");
		expect(error.recovery).toContain("unverified archive");
	})
);

it.effect("rejects a malformed manifest checksum at the schema boundary", () =>
	Effect.gen(function* () {
		const invalid = {
			...validManifest,
			artifact: { ...validManifest.artifact, sha256: "not-a-sha256" }
		};
		const error = yield* validatePluginBundleManifest(invalid).pipe(Effect.flip);
		expect(error.code).toBe("schema_invalid");
		expect(error.recovery).toContain("matching UE Shed release");
	})
);

it.effect("rejects a missing plugin dependency", () =>
	Effect.gen(function* () {
		const invalid = {
			...validManifest,
			plugins: validManifest.plugins.map((plugin, index) =>
				index === 1 ? { ...plugin, dependencies: ["UEShedMissing"] } : plugin
			)
		};
		const error = yield* validatePluginBundleManifest(invalid).pipe(Effect.flip);
		expect(error.code).toBe("missing_dependency");
		expect(error.message).toContain("UEShedMissing");
	})
);

it.effect("rejects a cyclic plugin dependency graph", () =>
	Effect.gen(function* () {
		const invalid = {
			...validManifest,
			plugins: validManifest.plugins.map((plugin, index) =>
				index === 0 ? { ...plugin, dependencies: ["UEShedAuthoring"] } : plugin
			)
		};
		const error = yield* validatePluginBundleManifest(invalid).pipe(Effect.flip);
		expect(error.code).toBe("cyclic_dependency");
		expect(error.message).toContain("UEShedCore -> UEShedAuthoring -> UEShedCore");
	})
);

it.effect("rejects an unsupported Unreal Engine version", () =>
	Effect.gen(function* () {
		const error = yield* validatePluginBundleForUnreal(validManifest, "5.8").pipe(Effect.flip);
		expect(error.code).toBe("unsupported_unreal");
		expect(error.recovery).toContain("supported Unreal Engine version");
	})
);

it.effect("verifies an artifact digest independently for extraction callers", () =>
	Effect.gen(function* () {
		yield* verifyPluginBundleArtifactChecksum(validManifest, digest);
		const error = yield* verifyPluginBundleArtifactChecksum(validManifest, "c".repeat(64)).pipe(
			Effect.flip
		);
		expect(error.code).toBe("invalid_checksum");
	})
);
