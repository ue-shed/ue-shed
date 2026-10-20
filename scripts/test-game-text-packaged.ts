// Packaged-release acceptance. The caller owns the machine-wide Unreal lock.
// Usage: node --import tsx scripts/test-game-text-packaged.ts build <engine-root> <evidence-dir>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { OwnedProcessTreeLive } from "../packages/engine/dist/index.js";
import {
	CompiledPluginBuilder,
	compiledPluginBuilderLayer,
	PluginCompilerProvenance,
	SourcePluginBundleManifestV3
} from "../packages/plugin-distribution/dist/index.js";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";

const [mode, engineArgument, outputArgument] = process.argv.slice(2);
assert.equal(mode, "build");
assert.ok(engineArgument && outputArgument);
const engineRoot = resolve(engineArgument);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const record = <A>(name: string, value: A) =>
	writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const digest = (path: string) =>
	`sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const version = Schema.decodeUnknownSync(
	Schema.Struct({
		MajorVersion: Schema.Int,
		MinorVersion: Schema.Int,
		PatchVersion: Schema.Int
	})
)(json(join(engineRoot, "Engine/Build/Build.version")));
const legacy = version.MajorVersion === 4;
const target = legacy ? "UE4Editor" : "UnrealEditor";
const artifact = {
	kind: "compiled",
	unrealVersion: `${version.MajorVersion}.${version.MinorVersion}.${version.PatchVersion}`,
	engineBuildId: Schema.decodeUnknownSync(Schema.Struct({ BuildId: Schema.String }))(
		json(join(engineRoot, `Engine/Binaries/Win64/${target}.modules`))
	).BuildId,
	platform: "Win64",
	architecture: "x64",
	target,
	configuration: "Development"
} as const;
const repository = resolve(import.meta.dirname, "..");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
assert.equal(head.status, 0);
const branch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
	cwd: repository,
	encoding: "utf8"
});
assert.equal(branch.status, 0);
const candidate = join(output, "candidate-manifest.json");
const tarball = process.env.UE_SHED_ACCEPTANCE_PROTOCOL_TARBALL;
assert.ok(tarball, "Set UE_SHED_ACCEPTANCE_PROTOCOL_TARBALL to a freshly packed protocol tarball.");
record("candidate-manifest.json", {
	version: PUBLIC_VERSION,
	source: { commit: head.stdout.trim(), ref: branch.stdout.trim() },
	packages: [
		{
			name: "@ue-shed/protocol",
			version: PUBLIC_VERSION,
			filename: "ue-shed-protocol.tgz",
			bytes: readFileSync(tarball).length,
			sha256: digest(tarball)
		}
	]
});
const preset = legacy ? "game-text" : "full";
const releaseRoot = join(
	repository,
	"out/releases",
	PUBLIC_VERSION,
	legacy ? "plugins-game-text" : "plugins"
);
const manifestPath = join(
	releaseRoot,
	`ue-shed-plugins${legacy ? "-game-text" : ""}-${PUBLIC_VERSION}.manifest.json`
);
if (!existsSync(manifestPath)) {
	const source = spawnSync(
		process.execPath,
		[
			"scripts/release-plugin-bundle.ts",
			preset,
			"--candidate-manifest",
			candidate,
			"--commit",
			head.stdout.trim(),
			"--ref",
			branch.stdout.trim()
		],
		{ cwd: repository, encoding: "utf8", windowsHide: true }
	);
	record("source-release-command.json", {
		status: source.status,
		stdout: source.stdout,
		stderr: source.stderr
	});
	assert.equal(source.status, 0, source.stderr);
}
const manifest = Schema.decodeUnknownSync(SourcePluginBundleManifestV3)(json(manifestPath));
record("source-manifest.json", manifest);
const request = {
	artifact,
	compiler: Schema.decodeUnknownSync(Schema.fromJsonString(PluginCompilerProvenance))(
		process.env.UE_SHED_ACCEPTANCE_COMPILER
	),
	engineRoot,
	expectedSourceArtifactSha256: manifest.artifact.sha256,
	expectedSourceManifestSha256: digest(manifestPath),
	maximumBuildSeconds: 7200,
	outputDirectory: process.env.UE_SHED_ACCEPTANCE_BUILD_OUTPUT ?? join(output, "compiled"),
	pluginIds: manifest.plugins.map((plugin: { id: string }) => plugin.id),
	sourceArtifactPath: join(releaseRoot, manifest.artifact.path),
	sourceManifestPath: manifestPath
};
record("build-request.json", request);
const result = await Effect.runPromise(
	Effect.flatMap(CompiledPluginBuilder, (builder) =>
		builder.build(request, {
			onProgress: (progress) => console.log(new Date().toISOString(), progress.stage)
		})
	).pipe(Effect.provide(compiledPluginBuilderLayer().pipe(Layer.provide(OwnedProcessTreeLive))))
);
record("build-result.json", result);
console.log("Packaged build passed:", result.manifestPath);
