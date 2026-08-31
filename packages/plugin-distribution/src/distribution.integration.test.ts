import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	symlink,
	writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { expect, vi } from "vitest";
import {
	ActiveLeasePreventsPrune,
	CompatiblePluginBuildUnavailable,
	CompiledPluginVariantRequest,
	PluginInstallCancelled,
	ArtifactDigestMismatch,
	CorruptCacheEntry,
	IncompatibleUnrealVersion,
	ImmutableVersionConflict,
	ManifestDigestMismatch,
	MalformedOrUnsafeArchive,
	OfflineCacheMiss,
	PluginDistribution,
	PluginDistributionValidationError,
	PluginVariantIdentity,
	type PluginVariantReference,
	type PluginDistributionLimits,
	PluginReleaseSource,
	PluginStore,
	httpPluginReleaseSourceLayer,
	localPluginReleaseSourceLayer,
	pluginDistributionLayer,
	pluginReleaseAssetNames,
	pluginStoreLayer,
	variantPluginReleaseAssetNames
} from "./index.js";

interface TarEntry {
	readonly body?: Uint8Array;
	readonly name: string;
	readonly type?: "0" | "1" | "2";
}

const roots: string[] = [];

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	block.write(encoded, offset, length - 1, "ascii");
	block[offset + length - 1] = 0;
}

function tarArchive(entries: readonly TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body ?? new Uint8Array());
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, body.byteLength);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = (entry.type ?? "0").charCodeAt(0);
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

async function fixture(
	options: {
		readonly entries?: readonly TarEntry[];
		readonly releaseVersion?: string;
	} = {}
) {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-distribution-"));
	roots.push(root);
	const releaseVersion = options.releaseVersion ?? "0.3.1";
	const names = pluginReleaseAssetNames(releaseVersion);
	const archive = tarArchive(
		options.entries ?? [
			{
				body: Buffer.from('{"FileVersion":3}\n'),
				name: "UEShed/Plugins/UEShedCore/UEShedCore.uplugin"
			},
			{
				body: Buffer.from("core source\n"),
				name: "UEShed/Plugins/UEShedCore/Source/Core.cpp"
			},
			{
				body: Buffer.from('{"FileVersion":3}\n'),
				name: "UEShed/Plugins/UEShedCameras/UEShedCameras.uplugin"
			}
		]
	);
	const archivePath = join(root, names.artifact);
	await writeFile(archivePath, archive);
	const manifest = {
		artifact: {
			bytes: archive.byteLength,
			id: `ue-shed-plugin-source-${releaseVersion}`,
			kind: "plugin-source",
			path: names.artifact,
			sha256: digest(archive)
		},
		plugins: [
			{
				dependencies: [],
				descriptorPath: "UEShedCore/UEShedCore.uplugin",
				directory: "UEShedCore",
				engineDependencies: [],
				id: "UEShedCore",
				version: releaseVersion
			},
			{
				dependencies: ["UEShedCore"],
				descriptorPath: "UEShedCameras/UEShedCameras.uplugin",
				directory: "UEShedCameras",
				engineDependencies: [],
				id: "UEShedCameras",
				version: releaseVersion
			}
		],
		provenance: {
			candidateManifest: {
				manifestPath: "candidate-manifest.json",
				sha256: `sha256:${"c".repeat(64)}`,
				version: releaseVersion
			},
			source: {
				commit: "a".repeat(40),
				ref: `refs/tags/v${releaseVersion}`,
				repository: "https://github.com/ue-shed/ue-shed"
			}
		},
		releaseVersion,
		schemaVersion: 1,
		unreal: { maximum: "5.7", minimum: "5.7" }
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
	const manifestPath = join(root, names.manifest);
	await writeFile(manifestPath, manifestBytes);
	return {
		archive,
		archivePath,
		manifest,
		manifestBytes,
		manifestDigest: digest(manifestBytes),
		manifestPath,
		releaseVersion,
		root
	};
}

async function compiledFixture(
	source: Awaited<ReturnType<typeof fixture>>,
	options: {
		readonly buildId: string;
		readonly engineSourceCommit?: string;
		readonly manifestModuleMutation?: "extra" | "missing" | "name" | "path";
		readonly missingModuleProduct?: boolean;
		readonly modulesBuildId?: string;
		readonly omitModules?: boolean;
		readonly schemaVersion?: 2 | 3;
		readonly unrelatedModuleMapping?: boolean;
	}
) {
	const artifactWithoutCommit = {
		architecture: "x64",
		configuration: "Development",
		engineBuildId: options.buildId,
		kind: "compiled",
		platform: "Win64",
		target: "UnrealEditor",
		unrealVersion: "5.7"
	} as const;
	const artifact = Schema.decodeUnknownSync(CompiledPluginVariantRequest)(
		options.engineSourceCommit === undefined
			? artifactWithoutCommit
			: { ...artifactWithoutCommit, engineSourceCommit: options.engineSourceCommit }
	);
	const names = variantPluginReleaseAssetNames(source.releaseVersion, artifact);
	const modulesBuildId = options.modulesBuildId ?? options.buildId;
	const archiveEntries: TarEntry[] = (
		[
			{
				body: Buffer.from('{"FileVersion":3,"Modules":[{"Name":"UEShedCore"}]}\n'),
				name: "UEShed/Plugins/UEShedCore/UEShedCore.uplugin"
			},
			{
				body: Buffer.from(`compiled core ${options.buildId}\n`),
				name: "UEShed/Plugins/UEShedCore/Binaries/Win64/UnrealEditor-UEShedCore.dll"
			},
			options.omitModules
				? undefined
				: {
						body: Buffer.from(
							JSON.stringify({
								BuildId: modulesBuildId,
								Modules: {
									[options.unrelatedModuleMapping
										? "UnrelatedCore"
										: "UEShedCore"]: options.missingModuleProduct
										? "UnrealEditor-UEShedCore-Missing.dll"
										: "UnrealEditor-UEShedCore.dll"
								}
							})
						),
						name: "UEShed/Plugins/UEShedCore/Binaries/Win64/UnrealEditor.modules"
					},
			{
				body: Buffer.from('{"FileVersion":3,"Modules":[{"Name":"UEShedCameras"}]}\n'),
				name: "UEShed/Plugins/UEShedCameras/UEShedCameras.uplugin"
			},
			{
				body: Buffer.from(`compiled cameras ${options.buildId}\n`),
				name: "UEShed/Plugins/UEShedCameras/Binaries/Win64/UnrealEditor-UEShedCameras.dll"
			},
			options.omitModules
				? undefined
				: {
						body: Buffer.from(
							JSON.stringify({
								BuildId: modulesBuildId,
								Modules: { UEShedCameras: "UnrealEditor-UEShedCameras.dll" }
							})
						),
						name: "UEShed/Plugins/UEShedCameras/Binaries/Win64/UnrealEditor.modules"
					}
		] satisfies ReadonlyArray<TarEntry | undefined>
	).filter((entry) => entry !== undefined);
	const archive = tarArchive(archiveEntries);
	const expectedModules = [
		{
			binaryPath: "Plugins/UEShedCore/Binaries/Win64/UnrealEditor-UEShedCore.dll",
			buildId: options.buildId,
			name: "UEShedCore",
			pluginId: "UEShedCore"
		},
		{
			binaryPath: "Plugins/UEShedCameras/Binaries/Win64/UnrealEditor-UEShedCameras.dll",
			buildId: options.buildId,
			name: "UEShedCameras",
			pluginId: "UEShedCameras"
		}
	];
	const manifestModules = expectedModules.map((module) => ({ ...module }));
	switch (options.manifestModuleMutation) {
		case "extra":
			manifestModules.push({
				...expectedModules[0]!,
				name: "SubstitutedCore"
			});
			break;
		case "missing":
			manifestModules.shift();
			break;
		case "name":
			manifestModules[0] = { ...expectedModules[0]!, name: "SubstitutedCore" };
			break;
		case "path":
			manifestModules[0] = {
				...expectedModules[0]!,
				binaryPath: "Plugins/UEShedCore/Binaries/Win64/UnrealEditor.modules"
			};
			break;
		case undefined:
			break;
	}
	const nativeFiles = archiveEntries
		.filter((entry) => /\.(?:dll|dylib|modules|pdb|so|uplugin)$/iu.test(entry.name))
		.map((entry) => ({
			path: entry.name.replace(/^UEShed\//u, ""),
			sha256: digest(entry.body ?? new Uint8Array())
		}));
	const manifest = {
		artifact: {
			bytes: archive.byteLength,
			id: `ue-shed-plugin-compiled-${source.releaseVersion}-${options.buildId}`,
			kind: "unreal-editor-plugin-binary",
			path: names.artifact,
			sha256: digest(archive)
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
			invocationSha256: `sha256:${"e".repeat(64)}`,
			requestedPluginIds: ["UEShedCameras"],
			resolvedPluginIds: ["UEShedCore", "UEShedCameras"],
			sourceArtifactSha256: source.manifest.artifact.sha256,
			sourceManifestSha256: source.manifestDigest
		},
		compatibility: {
			...artifact,
			kind: "compiled"
		},
		plugins: source.manifest.plugins,
		provenance: source.manifest.provenance,
		releaseVersion: source.releaseVersion,
		...(options.schemaVersion === 3
			? {
					buildRecipe: "pnpm ue-shed plugin build --request request.json",
					contracts: [
						{
							name: "ue-shed-review-capture",
							version: { major: 1, minor: 5 }
						}
					],
					modules: manifestModules,
					nativeFiles,
					packages: [
						{
							bytes: 1,
							filename: `ue-shed-cameras-${source.releaseVersion}.tgz`,
							name: "@ue-shed/cameras",
							sha256: `sha256:${"d".repeat(64)}`,
							version: source.releaseVersion
						}
					],
					schemaVersion: 3 as const
				}
			: { schemaVersion: 2 as const })
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
	const archivePath = join(source.root, names.artifact);
	const manifestPath = join(source.root, names.manifest);
	await writeFile(archivePath, archive);
	await writeFile(manifestPath, manifestBytes);
	return { archivePath, artifact, manifest, manifestBytes, manifestPath };
}

function request(releaseVersion: string) {
	return {
		networkPolicy: "online",
		pluginIds: ["UEShedCameras"],
		releaseVersion,
		unrealVersion: "5.7"
	};
}

function liveLayer(
	source: Layer.Layer<PluginReleaseSource>,
	cacheRoot: string,
	limits?: Partial<PluginDistributionLimits>
) {
	const dependencies = Layer.merge(source, pluginStoreLayer({ cacheRoot }));
	return pluginDistributionLayer(limits === undefined ? {} : { limits }).pipe(
		Layer.provide(dependencies)
	);
}

function listeningPort(server: ReturnType<typeof createServer>): number {
	return Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address()).port;
}

it.effect("stores source and multiple exact compiled variants for one release", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const firstCompiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391" })
		);
		const secondCompiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "custom-build-2026-08-23" })
		);
		const cacheRoot = join(source.root, "variant-cache");
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		const sourceResult = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: { kind: "source" },
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(layer));
		const first = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: firstCompiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(layer));
		const second = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: secondCompiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(layer));

		expect(
			new Set([sourceResult.variantIdentity, first.variantIdentity, second.variantIdentity])
				.size
		).toBe(3);
		expect(first.resolvedPluginIds).toEqual(["UEShedCore", "UEShedCameras"]);
		expect(first.artifactKind).toBe("compiled");
		const cached = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.listCached()
		).pipe(Effect.provide(layer));
		expect(cached).toHaveLength(3);
		expect(cached.map(({ artifactKind }) => artifactKind).sort()).toEqual([
			"compiled",
			"compiled",
			"source"
		]);

		const replay = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: firstCompiled.artifact,
					networkPolicy: "cache-only",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(layer));
		expect(replay.variantIdentity).toBe(first.variantIdentity);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("prunes only the matching legacy reference after recoverable content corruption", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const cacheRoot = join(source.root, "legacy-reference-cache");
		const distributionLayer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		const acquired = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: { kind: "source" },
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(distributionLayer));
		const legacyRoot = join(cacheRoot, "releases", source.releaseVersion);
		yield* Effect.promise(async () => {
			await mkdir(join(cacheRoot, "releases"), { recursive: true });
			await rename(acquired.cachePath, legacyRoot);
			const metadataPath = join(legacyRoot, ".ue-shed-distribution.json");
			const metadata = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
				JSON.parse(await readFile(metadataPath, "utf8"))
			);
			const {
				artifactKind: _artifactKind,
				variantIdentity: _variantIdentity,
				...legacy
			} = metadata;
			await writeFile(
				metadataPath,
				`${JSON.stringify({ ...legacy, schemaVersion: 1 }, null, "\t")}\n`
			);
		});

		const exactReference: PluginVariantReference = {
			releaseVersion: acquired.releaseVersion,
			variantIdentity: acquired.variantIdentity
		};
		const verified = yield* Effect.flatMap(PluginStore, (store) =>
			store.verify(exactReference)
		).pipe(Effect.provide(pluginStoreLayer({ cacheRoot })));
		expect(verified.cachePath).toBe(legacyRoot);
		yield* Effect.promise(() =>
			writeFile(
				join(legacyRoot, "content", "Plugins", "UEShedCore", "UEShedCore.uplugin"),
				"corrupt\n"
			)
		);
		const replacement = acquired.variantIdentity.endsWith("0") ? "1" : "0";
		const mismatchedReference: PluginVariantReference = {
			releaseVersion: acquired.releaseVersion,
			variantIdentity: PluginVariantIdentity.make(
				`${acquired.variantIdentity.slice(0, -1)}${replacement}`
			)
		};
		const mismatch = yield* Effect.flatMap(PluginStore, (store) =>
			store.prune(mismatchedReference).pipe(Effect.flip)
		).pipe(Effect.provide(pluginStoreLayer({ cacheRoot })));
		expect(mismatch).toBeInstanceOf(PluginDistributionValidationError);
		expect(yield* Effect.promise(() => readdir(legacyRoot))).toContain(
			".ue-shed-distribution.json"
		);
		yield* Effect.flatMap(PluginStore, (store) => store.prune(exactReference)).pipe(
			Effect.provide(pluginStoreLayer({ cacheRoot }))
		);
		expect(yield* Effect.promise(() => readdir(join(cacheRoot, "releases")))).toEqual([]);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects incompatible compiled identities before extraction and never falls back", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const compiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391" })
		);
		const cacheRoot = join(source.root, "mismatch-cache");
		const layer = liveLayer(
			localPluginReleaseSourceLayer({
				artifactPath: compiled.archivePath,
				manifestPath: compiled.manifestPath
			}),
			cacheRoot
		);
		const mismatch = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution
				.install({
					artifact: { ...compiled.artifact, engineBuildId: "different-build" },
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
				.pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(mismatch).toBeInstanceOf(CompatiblePluginBuildUnavailable);
		for (const incompatibleArtifact of [
			{ ...compiled.artifact, platform: "Linux" },
			{ ...compiled.artifact, architecture: "arm64" },
			{ ...compiled.artifact, target: "OtherTarget" },
			{ ...compiled.artifact, configuration: "Shipping" }
		]) {
			const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({
						artifact: incompatibleArtifact,
						networkPolicy: "online",
						pluginIds: ["UEShedCameras"],
						releaseVersion: source.releaseVersion
					})
					.pipe(Effect.flip)
			).pipe(Effect.provide(layer));
			expect([
				"CompatiblePluginBuildUnavailable",
				"PluginDistributionValidationError"
			]).toContain(error._tag);
		}
		expect(
			yield* Effect.promise(() =>
				readdir(join(cacheRoot, "variants", source.releaseVersion)).catch(() => [])
			)
		).toEqual([]);

		const sourceRequest = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution
				.install({
					artifact: { kind: "source" },
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
				.pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(sourceRequest).toBeInstanceOf(PluginDistributionValidationError);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("an active compiled lease blocks pruning only its exact variant", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const compiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391" })
		);
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "exact-lease-cache")
		);
		let reference: PluginVariantReference | undefined;
		yield* Effect.scoped(
			Effect.gen(function* () {
				const distribution = yield* PluginDistribution;
				const acquired = yield* distribution.install({
					artifact: compiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				});
				const exactReference: PluginVariantReference = {
					releaseVersion: acquired.releaseVersion,
					variantIdentity: acquired.variantIdentity
				};
				reference = exactReference;
				const error = yield* distribution.prune(exactReference).pipe(Effect.flip);
				expect(error).toBeInstanceOf(ActiveLeasePreventsPrune);
			}).pipe(Effect.provide(layer))
		);
		if (reference === undefined) return yield* Effect.die("lease reference was not recorded");
		const releasedReference = reference;
		yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.prune(releasedReference)
		).pipe(Effect.provide(layer));
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects mismatched extracted .modules BuildId evidence", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const compiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391", modulesBuildId: "wrong-build" })
		);
		const layer = liveLayer(
			localPluginReleaseSourceLayer({
				artifactPath: compiled.archivePath,
				manifestPath: compiled.manifestPath
			}),
			join(source.root, "modules-cache")
		);
		const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution
				.install({
					artifact: compiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
				.pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
		expect(error.message).toContain("BuildId");
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("requires schema-v3 module attestations to exactly match extracted .modules", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture({ releaseVersion: "0.5.1" }));
		for (const mutation of ["name", "path", "missing", "extra"] as const) {
			const compiled = yield* Effect.promise(() =>
				compiledFixture(source, {
					buildId: "47537391",
					manifestModuleMutation: mutation,
					schemaVersion: 3
				})
			);
			const layer = liveLayer(
				localPluginReleaseSourceLayer({
					artifactPath: compiled.archivePath,
					manifestPath: compiled.manifestPath
				}),
				join(source.root, `module-attestation-${mutation}-cache`)
			);
			const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({
						artifact: compiled.artifact,
						networkPolicy: "online",
						pluginIds: ["UEShedCameras"],
						releaseVersion: source.releaseVersion
					})
					.pipe(Effect.flip)
			).pipe(Effect.provide(layer));
			expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
			expect(error.message.toLowerCase()).toContain("module");
		}
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects compiled bundles with missing .modules evidence", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const compiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391", omitModules: true })
		);
		const layer = liveLayer(
			localPluginReleaseSourceLayer({
				artifactPath: compiled.archivePath,
				manifestPath: compiled.manifestPath
			}),
			join(source.root, "missing-modules-cache")
		);
		const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution
				.install({
					artifact: compiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
				.pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
		expect(error.message).toContain(".modules");
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects a .modules product that is absent despite an unrelated DLL", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const compiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391", missingModuleProduct: true })
		);
		const layer = liveLayer(
			localPluginReleaseSourceLayer({
				artifactPath: compiled.archivePath,
				manifestPath: compiled.manifestPath
			}),
			join(source.root, "missing-module-product-cache")
		);
		const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution
				.install({
					artifact: compiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
				.pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
		expect(error.message).toContain("UnrealEditor-UEShedCore-Missing.dll");
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects unrelated .modules keys that do not prove descriptor modules", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const compiled = yield* Effect.promise(() =>
			compiledFixture(source, {
				buildId: "47537391",
				unrelatedModuleMapping: true
			})
		);
		const layer = liveLayer(
			localPluginReleaseSourceLayer({
				artifactPath: compiled.archivePath,
				manifestPath: compiled.manifestPath
			}),
			join(source.root, "unrelated-module-key-cache")
		);
		const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution
				.install({
					artifact: compiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
				.pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
		expect(error.message).toContain("UEShedCore");
		expect(error.message).toContain("descriptor module");
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect(
	"installs locally, resolves dependencies, reuses offline, and prunes after lease release",
	() =>
		Effect.gen(function* () {
			const source = yield* Effect.promise(() => fixture());
			const cacheRoot = join(source.root, "cache");
			const progressPhases: string[] = [];
			const layer = liveLayer(
				localPluginReleaseSourceLayer({ directory: source.root }),
				cacheRoot
			);

			const first = yield* Effect.scoped(
				Effect.flatMap(PluginDistribution, (distribution) =>
					distribution.install(request(source.releaseVersion), {
						onProgress: (progress) => progressPhases.push(progress.phase)
					})
				)
			).pipe(Effect.provide(layer));
			expect(first.cacheHit).toBe(false);
			expect(first.resolvedPluginIds).toEqual(["UEShedCore", "UEShedCameras"]);
			expect(first.descriptorPaths.every((path) => path.includes(cacheRoot))).toBe(true);
			expect(progressPhases).toEqual(
				expect.arrayContaining([
					"resolving",
					"downloading",
					"verifying",
					"extracting",
					"publishing",
					"ready"
				])
			);
			expect(progressPhases.at(-1)).toBe("ready");

			const offline = yield* Effect.scoped(
				Effect.flatMap(PluginDistribution, (distribution) =>
					distribution.install({
						...request(source.releaseVersion),
						networkPolicy: "cache-only"
					})
				)
			).pipe(Effect.provide(layer));
			expect(offline.cacheHit).toBe(true);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const distribution = yield* PluginDistribution;
					yield* distribution.install({
						...request(source.releaseVersion),
						networkPolicy: "cache-only"
					});
					const error = yield* distribution
						.prune(source.releaseVersion)
						.pipe(Effect.flip);
					expect(error).toBeInstanceOf(ActiveLeasePreventsPrune);
				}).pipe(Effect.provide(layer))
			);

			yield* Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.prune(source.releaseVersion)
			).pipe(Effect.provide(layer));
			const miss = yield* Effect.scoped(
				Effect.flatMap(PluginDistribution, (distribution) =>
					distribution
						.install({ ...request(source.releaseVersion), networkPolicy: "cache-only" })
						.pipe(Effect.flip)
				)
			).pipe(Effect.provide(layer));
			expect(miss).toBeInstanceOf(OfflineCacheMiss);
		}).pipe(
			Effect.ensuring(
				Effect.promise(async () => {
					while (roots.length > 0)
						await rm(roots.pop()!, { force: true, recursive: true });
				})
			)
		)
);

it.effect("downloads concurrent identical HTTP acquisitions once", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		let artifactRequests = 0;
		const server = createServer((incoming, response) => {
			const path = incoming.url?.slice(1) ?? "";
			if (path === pluginReleaseAssetNames(source.releaseVersion).artifact)
				artifactRequests += 1;
			const body = path.endsWith(".json") ? source.manifestBytes : source.archive;
			response.writeHead(200, { "content-length": body.byteLength });
			response.end(body);
		});
		yield* Effect.acquireRelease(
			Effect.callback<number>((resume) => {
				server.listen(0, "127.0.0.1", () => {
					resume(Effect.succeed(listeningPort(server)));
				});
				return Effect.sync(() => {
					server.close();
				});
			}),
			() =>
				Effect.callback<void>((resume) => {
					server.close(() => resume(Effect.void));
				})
		).pipe(
			Effect.flatMap((port) => {
				const layer = liveLayer(
					httpPluginReleaseSourceLayer({ baseUrl: `http://127.0.0.1:${port}/` }),
					join(source.root, "http-cache")
				);
				return Effect.gen(function* () {
					const distribution = yield* PluginDistribution;
					const [left, right] = yield* Effect.all(
						[
							distribution.install(request(source.releaseVersion)),
							distribution.install(request(source.releaseVersion))
						],
						{ concurrency: "unbounded" }
					);
					expect(left.artifactDigest).toBe(right.artifactDigest);
					expect(artifactRequests).toBe(1);
					const cached = yield* distribution.install({
						...request(source.releaseVersion),
						networkPolicy: "cache-only"
					});
					expect(cached.cacheHit).toBe(true);
					expect(artifactRequests).toBe(1);
				}).pipe(Effect.provide(layer), Effect.scoped);
			})
		);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("addresses engine-commit-distinct compiled variants over HTTP", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const first = yield* Effect.promise(() =>
			compiledFixture(source, {
				buildId: "47537391",
				engineSourceCommit: "1".repeat(40)
			})
		);
		const second = yield* Effect.promise(() =>
			compiledFixture(source, {
				buildId: "47537391",
				engineSourceCommit: "2".repeat(40)
			})
		);
		const firstNames = variantPluginReleaseAssetNames(source.releaseVersion, first.artifact);
		const secondNames = variantPluginReleaseAssetNames(source.releaseVersion, second.artifact);
		expect(firstNames).not.toEqual(secondNames);
		const assets = yield* Effect.promise(
			async () =>
				new Map<string, Buffer>([
					[firstNames.artifact, await readFile(first.archivePath)],
					[firstNames.manifest, first.manifestBytes],
					[secondNames.artifact, await readFile(second.archivePath)],
					[secondNames.manifest, second.manifestBytes]
				])
		);
		const requested: string[] = [];
		const server = createServer((incoming, response) => {
			const path = incoming.url?.slice(1) ?? "";
			requested.push(path);
			const body = assets.get(path);
			if (body === undefined) {
				response.writeHead(404);
				response.end();
				return;
			}
			response.writeHead(200, { "content-length": body.byteLength });
			response.end(body);
		});
		yield* Effect.acquireRelease(
			Effect.callback<number>((resume) => {
				server.listen(0, "127.0.0.1", () => resume(Effect.succeed(listeningPort(server))));
				return Effect.sync(() => server.close());
			}),
			() =>
				Effect.callback<void>((resume) => {
					server.close(() => resume(Effect.void));
				})
		).pipe(
			Effect.flatMap((port) =>
				Effect.gen(function* () {
					const distribution = yield* PluginDistribution;
					const installedFirst = yield* distribution.install({
						artifact: first.artifact,
						networkPolicy: "online",
						pluginIds: ["UEShedCameras"],
						releaseVersion: source.releaseVersion
					});
					const installedSecond = yield* distribution.install({
						artifact: second.artifact,
						networkPolicy: "online",
						pluginIds: ["UEShedCameras"],
						releaseVersion: source.releaseVersion
					});
					expect(installedFirst.variantIdentity).not.toBe(
						installedSecond.variantIdentity
					);
				}).pipe(
					Effect.provide(
						liveLayer(
							httpPluginReleaseSourceLayer({
								baseUrl: `http://127.0.0.1:${port}/`
							}),
							join(source.root, "commit-distinct-http-cache")
						)
					),
					Effect.scoped
				)
			)
		);
		expect(requested.sort()).toEqual(
			[
				firstNames.artifact,
				firstNames.manifest,
				secondNames.artifact,
				secondNames.manifest
			].sort()
		);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("cancelling the lookup owner does not cancel another identical waiter", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const artifactRequested = yield* Deferred.make<void>();
		const releaseArtifact = yield* Deferred.make<void>();
		let artifactRequests = 0;
		const server = createServer((incoming, response) => {
			const path = incoming.url?.slice(1) ?? "";
			if (path.endsWith(".json")) {
				response.writeHead(200, { "content-length": source.manifestBytes.byteLength });
				response.end(source.manifestBytes);
				return;
			}
			artifactRequests += 1;
			response.writeHead(200, { "content-length": source.archive.byteLength });
			Effect.runFork(Deferred.succeed(artifactRequested, undefined));
			void Effect.runPromise(Deferred.await(releaseArtifact)).then(() => {
				response.end(source.archive);
			});
		});
		yield* Effect.acquireRelease(
			Effect.callback<number>((resume) => {
				server.listen(0, "127.0.0.1", () => resume(Effect.succeed(listeningPort(server))));
				return Effect.sync(() => server.close());
			}),
			() =>
				Deferred.succeed(releaseArtifact, undefined).pipe(
					Effect.andThen(
						Effect.callback<void>((resume) => {
							server.close(() => resume(Effect.void));
						})
					)
				)
		).pipe(
			Effect.flatMap((port) => {
				const layer = liveLayer(
					httpPluginReleaseSourceLayer({ baseUrl: `http://127.0.0.1:${port}/` }),
					join(source.root, "cancelled-owner-cache")
				);
				return Effect.scoped(
					Effect.gen(function* () {
						const distribution = yield* PluginDistribution;
						const ownerController = new AbortController();
						const owner = yield* distribution
							.install(request(source.releaseVersion), {
								signal: ownerController.signal
							})
							.pipe(Effect.forkChild);
						yield* Deferred.await(artifactRequested);
						const waiter = yield* distribution
							.install(request(source.releaseVersion), {
								onProgress: (progress) => {
									if (progress.phase === "downloading") ownerController.abort();
								}
							})
							.pipe(Effect.forkChild);
						yield* Effect.yieldNow;
						yield* Deferred.succeed(releaseArtifact, undefined);
						const ownerError = yield* Fiber.join(owner).pipe(Effect.flip);
						const installed = yield* Fiber.join(waiter);
						expect(ownerError).toBeInstanceOf(PluginInstallCancelled);
						expect(installed.cacheHit).toBe(false);
						expect(artifactRequests).toBe(1);
					}).pipe(Effect.provide(layer))
				);
			})
		);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("revalidates Unreal compatibility when reusing a cached release", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "compatibility-cache")
		);
		yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({
						...request(source.releaseVersion),
						networkPolicy: "cache-only",
						unrealVersion: "5.8"
					})
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(IncompatibleUnrealVersion);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects traversal-like release versions before any cache filesystem operation", () =>
	Effect.gen(function* () {
		const cacheRoot = yield* Effect.promise(async () => {
			const root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-prune-boundary-"));
			roots.push(root);
			return root;
		});
		const sentinel = join(cacheRoot, "sentinel.txt");
		yield* Effect.promise(() => writeFile(sentinel, "preserve me\n"));
		for (const releaseVersion of ["..", "0.4.0/../.."]) {
			const [pruneError, verifyError] = yield* Effect.flatMap(PluginStore, (store) =>
				Effect.all([
					store.prune(releaseVersion).pipe(Effect.flip),
					store.verify(releaseVersion).pipe(Effect.flip)
				])
			).pipe(Effect.provide(pluginStoreLayer({ cacheRoot })));
			expect(pruneError).toBeInstanceOf(PluginDistributionValidationError);
			expect(verifyError).toBeInstanceOf(PluginDistributionValidationError);
		}
		expect(yield* Effect.promise(() => readFile(sentinel, "utf8"))).toBe("preserve me\n");
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("preserves a lease when process liveness is indeterminate", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const cacheRoot = join(source.root, "indeterminate-lease-cache");
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		const foreignPid = 2_147_483_000;
		yield* Effect.promise(async () => {
			const leases = join(cacheRoot, "leases", source.releaseVersion);
			await mkdir(leases, { recursive: true });
			await writeFile(
				join(leases, "foreign.json"),
				JSON.stringify({
					createdAt: new Date(0).toISOString(),
					identity: "foreign",
					pid: foreignPid,
					releaseVersion: source.releaseVersion,
					schemaVersion: 1
				})
			);
		});
		const originalKill = process.kill;
		const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid === foreignPid) {
				const error = new Error("Operation not permitted");
				Object.defineProperty(error, "code", { value: "EPERM" });
				throw error;
			}
			return originalKill(pid, 0);
		});
		const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.prune(source.releaseVersion).pipe(Effect.flip)
		).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => kill.mockRestore())));
		expect(error).toBeInstanceOf(ActiveLeasePreventsPrune);
		const verified = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.verifyCached(source.releaseVersion)
		).pipe(Effect.provide(layer));
		expect(verified.releaseVersion).toBe(source.releaseVersion);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects a pinned artifact digest mismatch", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "digest-cache")
		);
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({
						...request(source.releaseVersion),
						expectedArtifactSha256: `sha256:${"b".repeat(64)}`
					})
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(ArtifactDigestMismatch);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects a pinned manifest digest mismatch", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "manifest-digest-cache")
		);
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({
						...request(source.releaseVersion),
						expectedManifestSha256: `sha256:${"b".repeat(64)}`
					})
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(ManifestDigestMismatch);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects a corrupt cached descriptor instead of repairing it", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "corrupt-cache")
		);
		const acquired = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		yield* Effect.promise(() => writeFile(acquired.descriptorPaths[0]!, "corrupt\n"));
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({ ...request(source.releaseVersion), networkPolicy: "cache-only" })
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(CorruptCacheEntry);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("prunes an exact corrupt variant so it can be reacquired", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const cacheRoot = join(source.root, "prunable-corrupt-cache");
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		const acquired = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		yield* Effect.promise(() => writeFile(acquired.descriptorPaths[0]!, "corrupt\n"));
		const exactReference: PluginVariantReference = {
			releaseVersion: acquired.releaseVersion,
			variantIdentity: acquired.variantIdentity
		};
		yield* Effect.flatMap(PluginStore, (store) => store.prune(exactReference)).pipe(
			Effect.provide(pluginStoreLayer({ cacheRoot }))
		);
		expect(
			yield* Effect.promise(() => readdir(join(cacheRoot, "variants", source.releaseVersion)))
		).toEqual([]);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("isolates exact verify, lease, and prune from a corrupt sibling", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const firstCompiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "47537391" })
		);
		const secondCompiled = yield* Effect.promise(() =>
			compiledFixture(source, { buildId: "custom-build-2026-08-23" })
		);
		const cacheRoot = join(source.root, "corrupt-sibling-cache");
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		const first = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: firstCompiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(layer));
		const second = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install({
					artifact: secondCompiled.artifact,
					networkPolicy: "online",
					pluginIds: ["UEShedCameras"],
					releaseVersion: source.releaseVersion
				})
			)
		).pipe(Effect.provide(layer));
		yield* Effect.promise(() => writeFile(first.descriptorPaths[0]!, "corrupt\n"));

		const firstReference: PluginVariantReference = {
			releaseVersion: first.releaseVersion,
			variantIdentity: first.variantIdentity
		};
		const secondReference: PluginVariantReference = {
			releaseVersion: second.releaseVersion,
			variantIdentity: second.variantIdentity
		};
		const storeLayer = pluginStoreLayer({ cacheRoot });
		const verified = yield* Effect.flatMap(PluginStore, (store) =>
			store.verify(secondReference)
		).pipe(Effect.provide(storeLayer));
		expect(verified.variantIdentity).toBe(second.variantIdentity);
		yield* Effect.scoped(Effect.flatMap(PluginStore, (store) => store.lease(verified))).pipe(
			Effect.provide(storeLayer)
		);
		yield* Effect.flatMap(PluginStore, (store) => store.prune(secondReference)).pipe(
			Effect.provide(storeLayer)
		);
		yield* Effect.flatMap(PluginStore, (store) => store.prune(firstReference)).pipe(
			Effect.provide(storeLayer)
		);
		expect(
			yield* Effect.promise(() => readdir(join(cacheRoot, "variants", source.releaseVersion)))
		).toEqual([]);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects a Windows junction introduced into a cached release", () =>
	Effect.gen(function* () {
		if (process.platform !== "win32") return;
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "junction-cache")
		);
		const acquired = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		const outside = join(source.root, "outside");
		yield* Effect.promise(async () => {
			await mkdir(outside);
			await symlink(
				outside,
				join(acquired.cachePath, "content", "Plugins", "junction-escape"),
				"junction"
			);
		});
		const error = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.verifyCached(source.releaseVersion).pipe(Effect.flip)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(CorruptCacheEntry);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("cancels during extraction and removes staging", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() =>
			fixture({
				entries: [
					{
						body: Buffer.from('{"FileVersion":3}\n'),
						name: "UEShed/Plugins/UEShedCore/UEShedCore.uplugin"
					},
					{
						body: Buffer.from('{"FileVersion":3}\n'),
						name: "UEShed/Plugins/UEShedCameras/UEShedCameras.uplugin"
					},
					{
						body: randomBytes(2 * 1024 * 1024),
						name: "UEShed/Plugins/UEShedCameras/Content.bin"
					}
				]
			})
		);
		const cacheRoot = join(source.root, "cancel-cache");
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		const controller = new AbortController();
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install(request(source.releaseVersion), {
						onProgress: (progress) => {
							if (progress.phase === "extracting") controller.abort();
						},
						signal: controller.signal
					})
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(PluginInstallCancelled);
		const entries = yield* Effect.promise(() => readdir(cacheRoot));
		expect(entries.some((entry) => entry.startsWith(".publish-"))).toBe(false);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("cancels during download and removes the partial artifact", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() =>
			fixture({
				entries: [
					{
						body: Buffer.from('{"FileVersion":3}\n'),
						name: "UEShed/Plugins/UEShedCore/UEShedCore.uplugin"
					},
					{
						body: Buffer.from('{"FileVersion":3}\n'),
						name: "UEShed/Plugins/UEShedCameras/UEShedCameras.uplugin"
					},
					{
						body: randomBytes(4 * 1024 * 1024),
						name: "UEShed/Plugins/UEShedCameras/Content.bin"
					}
				]
			})
		);
		const cacheRoot = join(source.root, "download-cancel-cache");
		const controller = new AbortController();
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			cacheRoot
		);
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install(request(source.releaseVersion), {
						onProgress: (progress) => {
							if (progress.phase === "downloading") controller.abort();
						},
						signal: controller.signal
					})
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(PluginInstallCancelled);
		const entries = yield* Effect.promise(() => readdir(cacheRoot));
		expect(entries.some((entry) => entry.startsWith(".download-"))).toBe(false);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects a truncated HTTP artifact", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const truncated = source.archive.subarray(0, source.archive.byteLength - 128);
		const server = createServer((incoming, response) => {
			const body = incoming.url?.endsWith(".json") ? source.manifestBytes : truncated;
			response.writeHead(200, { "content-length": body.byteLength });
			response.end(body);
		});
		yield* Effect.acquireRelease(
			Effect.callback<number>((resume) => {
				server.listen(0, "127.0.0.1", () => {
					resume(Effect.succeed(listeningPort(server)));
				});
				return Effect.sync(() => server.close());
			}),
			() =>
				Effect.callback<void>((resume) => {
					server.close(() => resume(Effect.void));
				})
		).pipe(
			Effect.flatMap((port) => {
				const layer = liveLayer(
					httpPluginReleaseSourceLayer({ baseUrl: `http://127.0.0.1:${port}/` }),
					join(source.root, "truncated-cache")
				);
				return Effect.scoped(
					Effect.flatMap(PluginDistribution, (distribution) =>
						distribution.install(request(source.releaseVersion)).pipe(Effect.flip)
					)
				).pipe(
					Effect.provide(layer),
					Effect.tap((error) =>
						Effect.sync(() => expect(error).toBeInstanceOf(ArtifactDigestMismatch))
					)
				);
			})
		);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("enforces extraction file-count limits", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "bounded-cache"),
			{ maximumFileCount: 2 }
		);
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion)).pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("enforces extracted byte and per-file limits", () =>
	Effect.gen(function* () {
		for (const limits of [{ maximumExtractedBytes: 20 }, { maximumFileBytes: 12 }]) {
			const source = yield* Effect.promise(() => fixture());
			const layer = liveLayer(
				localPluginReleaseSourceLayer({ directory: source.root }),
				join(source.root, "byte-bounded-cache"),
				limits
			);
			const error = yield* Effect.scoped(
				Effect.flatMap(PluginDistribution, (distribution) =>
					distribution.install(request(source.releaseVersion)).pipe(Effect.flip)
				)
			).pipe(Effect.provide(layer));
			expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
		}
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects release-version disagreement before downloading", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const wrongManifest = { ...source.manifest, releaseVersion: "0.3.2" };
		yield* Effect.promise(() =>
			writeFile(source.manifestPath, `${JSON.stringify(wrongManifest)}\n`)
		);
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "version-mismatch-cache")
		);
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion)).pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(PluginDistributionValidationError);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("keeps different releases side by side and deterministically replays a release", () =>
	Effect.gen(function* () {
		const firstSource = yield* Effect.promise(() => fixture({ releaseVersion: "0.3.1" }));
		const secondSource = yield* Effect.promise(() => fixture({ releaseVersion: "0.3.2" }));
		yield* Effect.promise(async () => {
			const secondNames = pluginReleaseAssetNames(secondSource.releaseVersion);
			await copyFile(secondSource.archivePath, join(firstSource.root, secondNames.artifact));
			await copyFile(secondSource.manifestPath, join(firstSource.root, secondNames.manifest));
		});
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: firstSource.root }),
			join(firstSource.root, "coexisting-cache")
		);
		const first = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(firstSource.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(secondSource.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		const releases = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.listCached()
		).pipe(Effect.provide(layer));
		expect(releases.map(({ releaseVersion }) => releaseVersion)).toEqual(["0.3.1", "0.3.2"]);
		yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.prune(firstSource.releaseVersion)
		).pipe(Effect.provide(layer));
		const replay = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(firstSource.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		expect(replay.cacheIdentity).toBe(first.cacheIdentity);
		expect(replay.artifactDigest).toBe(first.artifactDigest);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("never replaces an existing immutable version", () =>
	Effect.gen(function* () {
		const source = yield* Effect.promise(() => fixture());
		const layer = liveLayer(
			localPluginReleaseSourceLayer({ directory: source.root }),
			join(source.root, "immutable-cache")
		);
		const acquired = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.install(request(source.releaseVersion))
			)
		).pipe(Effect.provide(layer));
		const error = yield* Effect.scoped(
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution
					.install({
						...request(source.releaseVersion),
						expectedArtifactSha256: `sha256:${"d".repeat(64)}`
					})
					.pipe(Effect.flip)
			)
		).pipe(Effect.provide(layer));
		expect(error).toBeInstanceOf(ImmutableVersionConflict);
		const verified = yield* Effect.flatMap(PluginDistribution, (distribution) =>
			distribution.verifyCached(source.releaseVersion)
		).pipe(Effect.provide(layer));
		expect(verified.cacheIdentity).toBe(acquired.cacheIdentity);
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);

it.effect("rejects archive traversal and link entries without publishing", () =>
	Effect.gen(function* () {
		for (const entries of [
			[{ body: Buffer.from("escape"), name: "UEShed/Plugins/../../escape.txt" }],
			[{ body: Buffer.from("escape"), name: "/UEShed/Plugins/escape.txt" }],
			[{ body: Buffer.from("escape"), name: "C:/UEShed/Plugins/escape.txt" }],
			[{ name: "UEShed/Plugins/UEShedCore/link", type: "2" as const }],
			[{ name: "UEShed/Plugins/UEShedCore/link", type: "1" as const }],
			[
				{ body: Buffer.from("left"), name: "UEShed/Plugins/UEShedCore/Case.txt" },
				{ body: Buffer.from("right"), name: "UEShed/Plugins/UEShedCore/case.txt" }
			]
		]) {
			const source = yield* Effect.promise(() => fixture({ entries }));
			const layer = liveLayer(
				localPluginReleaseSourceLayer({ directory: source.root }),
				join(source.root, "unsafe-cache")
			);
			const error = yield* Effect.scoped(
				Effect.flatMap(PluginDistribution, (distribution) =>
					distribution.install(request(source.releaseVersion)).pipe(Effect.flip)
				)
			).pipe(Effect.provide(layer));
			expect(error).toBeInstanceOf(MalformedOrUnsafeArchive);
		}
	}).pipe(
		Effect.ensuring(
			Effect.promise(async () => {
				while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
			})
		)
	)
);
