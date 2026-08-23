import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	makeOwnedProcessTreeTestLayer,
	type OwnedProcessTreeHandle,
	type OwnedProcessTreeLaunchOptions
} from "@ue-shed/engine";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	CompiledPluginBuildCancelled,
	CompiledPluginBuildFailed,
	CompiledPluginBuilder,
	InvalidCompiledPluginBuild,
	compiledPluginBuilderLayer
} from "./builder.js";
import { variantPluginReleaseAssetNames } from "./source.js";

interface TarEntry {
	readonly body: Uint8Array;
	readonly name: string;
}

const roots: string[] = [];

function writeOctal(block: Buffer, offset: number, length: number, value: number) {
	const encoded = value.toString(8).padStart(length - 1, "0");
	block.write(encoded, offset, length - 1, "ascii");
	block[offset + length - 1] = 0;
}

function archive(entries: readonly TarEntry[]) {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body);
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, body.byteLength);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeOctal(header, 148, 8, checksum);
		blocks.push(header, body);
		const padding = (512 - (body.byteLength % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function digest(bytes: Uint8Array) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-compiled-builder-"));
	roots.push(root);
	const engineRoot = join(root, "engine");
	const runUat =
		process.platform === "win32"
			? join(
					engineRoot,
					"Engine",
					"Binaries",
					"DotNET",
					"AutomationTool",
					"AutomationTool.exe"
				)
			: join(engineRoot, "Engine", "Build", "BatchFiles", "RunUAT.sh");
	const buildVersion = join(engineRoot, "Engine", "Build", "Build.version");
	const editorModules = join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.modules");
	await mkdir(dirname(runUat), { recursive: true });
	await mkdir(dirname(buildVersion), { recursive: true });
	await mkdir(dirname(editorModules), { recursive: true });
	await writeFile(runUat, "fixture executable\n");
	await writeFile(
		buildVersion,
		JSON.stringify({
			Changelist: 47537391,
			CompatibleChangelist: 47537391,
			MajorVersion: 5,
			MinorVersion: 7,
			PatchVersion: 4
		})
	);
	await writeFile(
		editorModules,
		JSON.stringify({ BuildId: "47537391", Modules: { UnrealEditor: "UnrealEditor.exe" } })
	);
	const sourceArchive = archive([
		{
			body: Buffer.from(
				JSON.stringify({
					FileVersion: 3,
					Modules: [{ Name: "UEShedCore", Type: "Runtime" }],
					Version: 1,
					VersionName: "0.5.0"
				})
			),
			name: "UEShed/Plugins/UEShedCore/UEShedCore.uplugin"
		},
		{
			body: Buffer.from("using UnrealBuildTool; public class UEShedCore : ModuleRules {}\n"),
			name: "UEShed/Plugins/UEShedCore/Source/UEShedCore/UEShedCore.Build.cs"
		},
		{
			body: Buffer.from("void Core() {}\n"),
			name: "UEShed/Plugins/UEShedCore/Source/UEShedCore/Private/Core.cpp"
		},
		{
			body: Buffer.from(
				JSON.stringify({
					FileVersion: 3,
					Modules: [{ Name: "UEShedCameras", Type: "Runtime" }],
					Plugins: [{ Enabled: true, Name: "UEShedCore" }],
					Version: 1,
					VersionName: "0.5.0"
				})
			),
			name: "UEShed/Plugins/UEShedCameras/UEShedCameras.uplugin"
		},
		{
			body: Buffer.from(
				"using UnrealBuildTool; public class UEShedCameras : ModuleRules {}\n"
			),
			name: "UEShed/Plugins/UEShedCameras/Source/UEShedCameras/UEShedCameras.Build.cs"
		},
		{
			body: Buffer.from("void Cameras() {}\n"),
			name: "UEShed/Plugins/UEShedCameras/Source/UEShedCameras/Private/Cameras.cpp"
		}
	]);
	const sourceArtifactPath = join(root, "source.tar.gz");
	await writeFile(sourceArtifactPath, sourceArchive);
	const manifest = {
		artifact: {
			bytes: sourceArchive.byteLength,
			id: "ue-shed-plugin-source-0.5.0",
			kind: "plugin-source",
			path: "source.tar.gz",
			sha256: digest(sourceArchive)
		},
		plugins: [
			{
				dependencies: [],
				descriptorPath: "UEShedCore/UEShedCore.uplugin",
				directory: "UEShedCore",
				engineDependencies: [],
				id: "UEShedCore",
				version: "0.5.0"
			},
			{
				dependencies: ["UEShedCore"],
				descriptorPath: "UEShedCameras/UEShedCameras.uplugin",
				directory: "UEShedCameras",
				engineDependencies: [],
				id: "UEShedCameras",
				version: "0.5.0"
			}
		],
		provenance: {
			candidateManifest: {
				manifestPath: "candidate-manifest.json",
				sha256: `sha256:${"c".repeat(64)}`,
				version: "0.5.0"
			},
			source: {
				commit: "a".repeat(40),
				ref: "refs/tags/v0.5.0",
				repository: "https://github.com/ue-shed/ue-shed"
			}
		},
		releaseVersion: "0.5.0",
		schemaVersion: 1,
		unreal: { maximum: "5.7", minimum: "5.7" }
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
	const sourceManifestPath = join(root, "source.manifest.json");
	await writeFile(sourceManifestPath, manifestBytes);
	return {
		engineRoot,
		request: {
			artifact: {
				architecture: "x64",
				configuration: "Development",
				engineBuildId: "47537391",
				kind: "compiled",
				platform: "Win64",
				target: "UnrealEditor",
				unrealVersion: "5.7.4"
			},
			compiler: {
				compiler: "MSVC",
				compilerVersion: "19.42",
				toolchain: "Visual Studio",
				toolchainVersion: "2022"
			},
			engineRoot,
			expectedSourceArtifactSha256: digest(sourceArchive),
			expectedSourceManifestSha256: digest(manifestBytes),
			outputDirectory: join(root, "output"),
			pluginIds: ["UEShedCameras"],
			sourceArtifactPath,
			sourceManifestPath
		},
		root
	};
}

async function writeFakeUatProducts(
	options: OwnedProcessTreeLaunchOptions,
	settings: { readonly binaryBytes?: number } = {}
) {
	const packageArgument = options.args.find((argument) => argument.startsWith("-Package="));
	if (packageArgument === undefined) throw new Error("Builder omitted -Package.");
	const binaries = join(packageArgument.slice("-Package=".length), "Binaries", "Win64");
	await mkdir(binaries, { recursive: true });
	const modules = {
		BuildId: "47537391",
		Modules: {
			UEShedCameras: "UnrealEditor-UEShedCameras.dll",
			UEShedCore: "UnrealEditor-UEShedCore.dll"
		}
	};
	await writeFile(join(binaries, "UnrealEditor.modules"), JSON.stringify(modules));
	for (const binary of Object.values(modules.Modules))
		await writeFile(
			join(binaries, binary),
			settings.binaryBytes === undefined
				? `compiled ${binary}\n`
				: Buffer.alloc(settings.binaryBytes, 0x41)
		);
}

function completedHandle(exitCode: number): OwnedProcessTreeHandle {
	return {
		awaitExit: Effect.succeed({ exitCode, kind: "exited", signal: null }),
		pid: 41,
		terminate: (reason) =>
			Effect.succeed({ exitCode: null, kind: "terminated", reason, signal: null })
	};
}

function builderLayer(
	launch: (options: OwnedProcessTreeLaunchOptions) => Effect.Effect<OwnedProcessTreeHandle>
) {
	return compiledPluginBuilderLayer().pipe(Layer.provide(makeOwnedProcessTreeTestLayer(launch)));
}

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("compiled plugin builder", () => {
	it("publishes only a validated dependency-first compiled graph", async () => {
		const source = await fixture();
		const engineSourceCommit = "b".repeat(40);
		const layer = builderLayer((options) =>
			Effect.promise(async () => {
				await writeFakeUatProducts(options);
				return completedHandle(0);
			})
		);
		const result = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder.build({
					...source.request,
					artifact: { ...source.request.artifact, engineSourceCommit }
				})
			).pipe(Effect.provide(layer))
		);
		expect(result.resolvedPluginIds).toEqual(["UEShedCore", "UEShedCameras"]);
		expect(result.manifest.build.requestedPluginIds).toEqual(["UEShedCameras"]);
		expect(result.manifest.compatibility.engineBuildId).toBe("47537391");
		expect(result.manifest.compatibility.engineSourceCommit).toBe(engineSourceCommit);
		expect(result.manifest.artifact.path).toBe(
			variantPluginReleaseAssetNames(
				result.manifest.releaseVersion,
				result.manifest.compatibility
			).artifact
		);
		expect((await readFile(result.artifactPath)).byteLength).toBeGreaterThan(0);
		expect(await readdir(source.request.outputDirectory)).toEqual([
			result.outputPath.split(/[/\\]/u).at(-1)
		]);
	});

	it("does not launch UAT when the exact engine identity is invalid", async () => {
		const source = await fixture();
		let launches = 0;
		const layer = builderLayer(() => {
			launches += 1;
			return Effect.succeed(completedHandle(0));
		});
		const error = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder
					.build({
						...source.request,
						artifact: { ...source.request.artifact, engineBuildId: "different" }
					})
					.pipe(Effect.flip)
			).pipe(Effect.provide(layer))
		);
		expect(error._tag).toBe("InvalidCompiledPluginBuild");
		expect(launches).toBe(0);
	});

	it("rejects malformed engine source provenance before launching UAT", async () => {
		const source = await fixture();
		let launches = 0;
		const layer = builderLayer(() => {
			launches += 1;
			return Effect.succeed(completedHandle(0));
		});
		const error = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder
					.build({
						...source.request,
						artifact: {
							...source.request.artifact,
							engineSourceCommit: "short-commit"
						}
					})
					.pipe(Effect.flip)
			).pipe(Effect.provide(layer))
		);
		expect(error).toBeInstanceOf(InvalidCompiledPluginBuild);
		expect(launches).toBe(0);
	});

	it("leaves no published output after a failed build", async () => {
		const source = await fixture();
		const error = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder.build(source.request).pipe(Effect.flip)
			).pipe(Effect.provide(builderLayer(() => Effect.succeed(completedHandle(6)))))
		);
		expect(error).toBeInstanceOf(CompiledPluginBuildFailed);
		expect(await readdir(source.request.outputDirectory)).toEqual([]);
	});

	it("cancels the owned process tree and leaves no published output", async () => {
		const source = await fixture();
		const launched = await Effect.runPromise(Deferred.make<void>());
		const terminated = await Effect.runPromise(Deferred.make<void>());
		const layer = builderLayer(() =>
			Deferred.succeed(launched, undefined).pipe(
				Effect.as({
					awaitExit: Effect.never,
					pid: 42,
					terminate: (reason: "cancelled" | "failed" | "released") =>
						Deferred.succeed(terminated, undefined).pipe(
							Effect.as({
								exitCode: null,
								kind: "terminated" as const,
								reason,
								signal: null
							})
						)
				})
			)
		);
		const controller = new AbortController();
		const fiber = Effect.runFork(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder.build(source.request, { signal: controller.signal })
			).pipe(Effect.provide(layer))
		);
		await Effect.runPromise(Deferred.await(launched));
		controller.abort();
		const error = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.flip));
		await Effect.runPromise(Deferred.await(terminated));
		expect(error).toBeInstanceOf(CompiledPluginBuildCancelled);
		expect(await readdir(source.request.outputDirectory)).toEqual([]);
	});

	it("preserves cancellation during source extraction and cleans the stage", async () => {
		const source = await fixture();
		const controller = new AbortController();
		let launches = 0;
		const error = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder
					.build(source.request, {
						onProgress: ({ stage }) => {
							if (stage === "source-extraction") controller.abort();
						},
						signal: controller.signal
					})
					.pipe(Effect.flip)
			).pipe(
				Effect.provide(
					builderLayer(() => {
						launches += 1;
						return Effect.succeed(completedHandle(0));
					})
				)
			)
		);
		expect(error).toBeInstanceOf(CompiledPluginBuildCancelled);
		expect(error.stage).toBe("source-extraction");
		expect(launches).toBe(0);
		expect(await readdir(source.request.outputDirectory)).toEqual([]);
	});

	it("preserves cancellation during final validation and publishes nothing", async () => {
		const source = await fixture();
		const controller = new AbortController();
		const layer = builderLayer((options) =>
			Effect.promise(async () => {
				await writeFakeUatProducts(options);
				return completedHandle(0);
			})
		);
		const error = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder
					.build(source.request, {
						onProgress: ({ stage }) => {
							if (stage === "validation") controller.abort();
						},
						signal: controller.signal
					})
					.pipe(Effect.flip)
			).pipe(Effect.provide(layer))
		);
		expect(error).toBeInstanceOf(CompiledPluginBuildCancelled);
		expect(error.stage).toBe("validation");
		expect(await readdir(source.request.outputDirectory)).toEqual([]);
	});

	it("rejects oversized compiled products before allocating archive bodies", async () => {
		const source = await fixture();
		const layer = builderLayer((options) =>
			Effect.promise(async () => {
				await writeFakeUatProducts(options, { binaryBytes: 2_048 });
				return completedHandle(0);
			})
		);
		const error = await Effect.runPromise(
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder
					.build(source.request, {
						limits: { maximumFileBytes: 1_024 }
					})
					.pipe(Effect.flip)
			).pipe(Effect.provide(layer))
		);
		expect(error).toBeInstanceOf(InvalidCompiledPluginBuild);
		expect(error.stage).toBe("archive");
		expect(error.message).toContain("file-size limit");
		expect(await readdir(source.request.outputDirectory)).toEqual([]);
	});
});
