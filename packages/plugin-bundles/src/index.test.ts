import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
	PluginBundleManifest,
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
			id: "UEShedCore",
			version: "0.1.0"
		},
		{
			dependencies: ["UEShedCore"],
			descriptorPath: "UEShedAuthoring/UEShedAuthoring.uplugin",
			directory: "UEShedAuthoring",
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

it.effect("accepts a valid graph, artifact, and candidate provenance", () =>
	Effect.gen(function* () {
		const manifest = yield* validatePluginBundleManifest(validManifest);
		expect(manifest).toEqual(validManifest);
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
