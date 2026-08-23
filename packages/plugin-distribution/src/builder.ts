import { createHash, randomUUID } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync, type ZlibOptions } from "node:zlib";
import { OwnedProcessTree, type OwnedProcessExit } from "@ue-shed/engine";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { extractPluginArchive, verifyPluginArtifact } from "./archive.js";
import {
	CompiledPluginBundleManifestV2,
	PluginBundlePlugin,
	PluginCompilerProvenance,
	PluginId,
	Sha256Checksum,
	isSourcePluginBundleManifest,
	resolvePluginBundleDependencies,
	validatePluginBundleManifest
} from "./manifest.js";
import { defaultPluginDistributionLimits, type PluginDistributionLimits } from "./model.js";
import { variantPluginReleaseAssetNames } from "./source.js";
import { CompiledPluginVariantRequest } from "./variant.js";

const BoundedPath = Schema.NonEmptyString.check(Schema.isMaxLength(32_767));
const PositiveSeconds = Schema.Int.check(
	Schema.isGreaterThan(0),
	Schema.isLessThanOrEqualTo(86_400)
);

export const CompiledPluginBuildRequest = Schema.Struct({
	artifact: CompiledPluginVariantRequest,
	compiler: PluginCompilerProvenance,
	engineRoot: BoundedPath,
	expectedSourceArtifactSha256: Sha256Checksum,
	expectedSourceManifestSha256: Sha256Checksum,
	maximumBuildSeconds: Schema.optionalKey(PositiveSeconds),
	outputDirectory: BoundedPath,
	pluginIds: Schema.Array(PluginId).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	sourceArtifactPath: BoundedPath,
	sourceManifestPath: BoundedPath
});
export type CompiledPluginBuildRequest = typeof CompiledPluginBuildRequest.Type;

export const CompiledPluginBuildResult = Schema.Struct({
	artifactPath: BoundedPath,
	manifest: CompiledPluginBundleManifestV2,
	manifestDigest: Sha256Checksum,
	manifestPath: BoundedPath,
	outputPath: BoundedPath,
	resolvedPluginIds: Schema.Array(PluginId)
});
export type CompiledPluginBuildResult = typeof CompiledPluginBuildResult.Type;

const BuildErrorFields = {
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	stage: Schema.String
};

export class InvalidCompiledPluginBuild extends Schema.TaggedErrorClass<InvalidCompiledPluginBuild>()(
	"InvalidCompiledPluginBuild",
	BuildErrorFields
) {}

export class CompiledPluginBuildFailed extends Schema.TaggedErrorClass<CompiledPluginBuildFailed>()(
	"CompiledPluginBuildFailed",
	{ ...BuildErrorFields, exitCode: Schema.NullOr(Schema.Int) }
) {}

export class CompiledPluginBuildCancelled extends Schema.TaggedErrorClass<CompiledPluginBuildCancelled>()(
	"CompiledPluginBuildCancelled",
	BuildErrorFields
) {}

export const CompiledPluginBuilderError = Schema.Union([
	InvalidCompiledPluginBuild,
	CompiledPluginBuildFailed,
	CompiledPluginBuildCancelled
]);
export type CompiledPluginBuilderError = typeof CompiledPluginBuilderError.Type;

export interface CompiledPluginBuildOptions {
	readonly limits?: Partial<PluginDistributionLimits>;
	readonly signal?: AbortSignal;
}

export interface CompiledPluginBuilderApi {
	readonly build: (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This hostile public boundary decodes CompiledPluginBuildRequest immediately.
		input: unknown,
		options?: CompiledPluginBuildOptions
	) => Effect.Effect<CompiledPluginBuildResult, CompiledPluginBuilderError>;
}

export class CompiledPluginBuilder extends Context.Service<
	CompiledPluginBuilder,
	CompiledPluginBuilderApi
>()("@ue-shed/plugin-distribution/CompiledPluginBuilder") {}

const UnrealBuildVersion = Schema.Struct({
	BuildId: Schema.optionalKey(Schema.String),
	Changelist: Schema.Int,
	CompatibleChangelist: Schema.Int,
	MajorVersion: Schema.Int,
	MinorVersion: Schema.Int,
	PatchVersion: Schema.Int
});

const ModuleDescriptor = Schema.Struct({ Name: Schema.NonEmptyString });
const UnrealPluginDescriptor = Schema.Struct({
	FileVersion: Schema.Int,
	Modules: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
	Plugins: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
	Version: Schema.optionalKey(Schema.Int),
	VersionName: Schema.optionalKey(Schema.String)
});
const UnrealModules = Schema.Struct({
	BuildId: Schema.String,
	Modules: Schema.Record(Schema.String, Schema.String)
});

function sha256(bytes: Uint8Array) {
	return Sha256Checksum.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function invalid(stage: string, message: string, recovery: string) {
	return new InvalidCompiledPluginBuild({ message, recovery, retrySafe: false, stage });
}

function within(parent: string, child: string) {
	const fromParent = relative(resolve(parent), resolve(child));
	return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

async function regularFile(path: string, label: string) {
	const details = await lstat(path);
	if (!details.isFile() || details.isSymbolicLink())
		throw new Error(`${label} is not a regular file.`);
}

function decodeJson(bytes: Uint8Array) {
	return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function canonicalInvocation(
	request: CompiledPluginBuildRequest,
	resolvedPluginIds: readonly PluginId[]
) {
	return JSON.stringify({
		artifact: request.artifact,
		compiler: request.compiler,
		expectedSourceArtifactSha256: request.expectedSourceArtifactSha256,
		expectedSourceManifestSha256: request.expectedSourceManifestSha256,
		pluginIds: [...request.pluginIds],
		resolvedPluginIds
	});
}

function writeOctal(block: Buffer, offset: number, length: number, value: number) {
	const encoded = value.toString(8).padStart(length - 1, "0");
	block.write(encoded, offset, length - 1, "ascii");
	block[offset + length - 1] = 0;
}

async function walkFiles(root: string, directory = root): Promise<string[]> {
	const files: string[] = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name)
	)) {
		const path = join(directory, entry.name);
		const details = await lstat(path);
		if (details.isSymbolicLink()) throw new Error(`Build output contains a link: ${path}`);
		if (details.isDirectory()) files.push(...(await walkFiles(root, path)));
		else if (details.isFile()) files.push(relative(root, path).replaceAll(sep, "/"));
		else throw new Error(`Build output contains an unsupported filesystem entry: ${path}`);
	}
	return files;
}

async function writeDeterministicArchive(root: string, destination: string) {
	const blocks: Buffer[] = [];
	for (const relativePath of await walkFiles(root)) {
		const archivePath = `UEShed/${relativePath}`;
		const body = await readFile(join(root, ...relativePath.split("/")));
		let name = archivePath;
		let prefix = "";
		if (Buffer.byteLength(name) > 100) {
			const splitAt = archivePath.lastIndexOf("/", archivePath.length - 101);
			if (splitAt <= 0) throw new Error(`Archive path is too long: ${archivePath}`);
			prefix = archivePath.slice(0, splitAt);
			name = archivePath.slice(splitAt + 1);
			if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
				throw new Error(`Archive path is too long: ${archivePath}`);
		}
		const header = Buffer.alloc(512);
		header.write(name, 0, 100, "utf8");
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, body.byteLength);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		header.write(prefix, 345, 155, "utf8");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeOctal(header, 148, 8, checksum);
		blocks.push(header, body);
		const padding = (512 - (body.byteLength % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	const gzipOptions: ZlibOptions & { readonly mtime: number } = { level: 9, mtime: 0 };
	await writeFile(destination, gzipSync(Buffer.concat(blocks), gzipOptions));
}

async function prepareAggregatePlugin(options: {
	readonly plugins: readonly PluginBundlePlugin[];
	readonly pluginsRoot: string;
	readonly root: string;
}) {
	const aggregateRoot = join(options.root, "UEShedCompiledGraph");
	const modules: Array<Record<string, Schema.Json>> = [];
	const enginePlugins = new Map<string, Record<string, Schema.Json>>();
	for (const plugin of options.plugins) {
		const pluginRoot = join(options.pluginsRoot, plugin.directory);
		const descriptor = Schema.decodeUnknownSync(UnrealPluginDescriptor)(
			JSON.parse(await readFile(join(pluginRoot, `${plugin.directory}.uplugin`), "utf8"))
		);
		for (const module of descriptor.Modules ?? []) {
			const decoded = Schema.decodeUnknownSync(ModuleDescriptor)(module);
			const source = join(pluginRoot, "Source", decoded.Name);
			await regularFile(join(source, `${decoded.Name}.Build.cs`), `Module ${decoded.Name}`);
			await cp(source, join(aggregateRoot, "Source", decoded.Name), {
				errorOnExist: true,
				recursive: true
			});
			modules.push(module);
		}
		for (const enginePlugin of descriptor.Plugins ?? []) {
			const reference = Schema.decodeUnknownSync(Schema.Struct({ Name: PluginId }))(
				enginePlugin
			);
			if (plugin.engineDependencies.includes(reference.Name)) {
				enginePlugins.set(reference.Name, enginePlugin);
			}
		}
	}
	if (modules.length === 0)
		throw new Error("Requested plugin graph contains no compiled modules.");
	await mkdir(aggregateRoot, { recursive: true });
	await writeFile(
		join(aggregateRoot, "UEShedCompiledGraph.uplugin"),
		`${JSON.stringify(
			{
				CanContainContent: false,
				FileVersion: 3,
				FriendlyName: "UE Shed compiled dependency graph",
				Modules: modules,
				Plugins: [...enginePlugins.values()],
				Version: 1,
				VersionName: "1"
			},
			null,
			"\t"
		)}\n`
	);
	return { aggregateRoot, modules };
}

async function composeCompiledGraph(options: {
	readonly buildId: string;
	readonly packageRoot: string;
	readonly plugins: readonly PluginBundlePlugin[];
	readonly pluginsRoot: string;
	readonly platform: string;
	readonly root: string;
}) {
	const packageBinaries = join(options.packageRoot, "Binaries", options.platform);
	const moduleFile = (await readdir(packageBinaries)).find((name) => name.endsWith(".modules"));
	if (moduleFile === undefined) throw new Error("RunUAT package has no .modules file.");
	const moduleEvidence = Schema.decodeUnknownSync(UnrealModules)(
		JSON.parse(await readFile(join(packageBinaries, moduleFile), "utf8"))
	);
	if (moduleEvidence.BuildId !== options.buildId) {
		throw new Error(
			`RunUAT BuildId ${moduleEvidence.BuildId} does not match engine ${options.buildId}.`
		);
	}
	const outputPlugins = join(options.root, "Plugins");
	for (const plugin of options.plugins) {
		const source = join(options.pluginsRoot, plugin.directory);
		const destination = join(outputPlugins, plugin.directory);
		await cp(source, destination, { errorOnExist: true, recursive: true });
		await rm(join(destination, "Binaries"), { force: true, recursive: true });
		await rm(join(destination, "Intermediate"), { force: true, recursive: true });
		const descriptor = Schema.decodeUnknownSync(UnrealPluginDescriptor)(
			JSON.parse(await readFile(join(destination, `${plugin.directory}.uplugin`), "utf8"))
		);
		const moduleNames = (descriptor.Modules ?? []).map(
			(module) => Schema.decodeUnknownSync(ModuleDescriptor)(module).Name
		);
		const modules = Object.fromEntries(
			Object.entries(moduleEvidence.Modules).filter(([name]) => moduleNames.includes(name))
		);
		if (Object.keys(modules).length !== moduleNames.length) {
			throw new Error(`RunUAT output is missing modules for ${plugin.id}.`);
		}
		const binaries = join(destination, "Binaries", options.platform);
		await mkdir(binaries, { recursive: true });
		for (const binary of Object.values(modules)) {
			await regularFile(join(packageBinaries, binary), `Compiled module ${binary}`);
			await cp(join(packageBinaries, binary), join(binaries, binary), { errorOnExist: true });
		}
		for (const file of await readdir(packageBinaries)) {
			if (
				moduleNames.some((name) => file.includes(name)) &&
				!Object.values(modules).includes(file)
			) {
				await cp(join(packageBinaries, file), join(binaries, file), { errorOnExist: true });
			}
		}
		await writeFile(
			join(binaries, moduleFile),
			`${JSON.stringify({ BuildId: options.buildId, Modules: modules }, null, "\t")}\n`
		);
	}
}

function abortBuild(signal: AbortSignal) {
	return Effect.callback<never, CompiledPluginBuildCancelled>((resume) => {
		const cancel = () =>
			resume(
				Effect.fail(
					new CompiledPluginBuildCancelled({
						message: "Compiled plugin build was cancelled.",
						recovery: "Retry the exact build; no output was published.",
						retrySafe: true,
						stage: "build"
					})
				)
			);
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", cancel));
	});
}

function validateExit(exit: OwnedProcessExit) {
	if (exit.kind === "exited" && exit.exitCode === 0) return Effect.succeed(undefined);
	return Effect.fail(
		new CompiledPluginBuildFailed({
			exitCode: exit.exitCode,
			message: `AutomationTool BuildPlugin exited without success (${String(exit.exitCode)}).`,
			recovery:
				"Inspect AutomationTool's reported final log, correct the deterministic build input, and retry.",
			retrySafe: false,
			stage: "build"
		})
	);
}

export const compiledPluginBuilderLayer = (): Layer.Layer<
	CompiledPluginBuilder,
	never,
	OwnedProcessTree
> =>
	Layer.effect(
		CompiledPluginBuilder,
		Effect.gen(function* () {
			const processes = yield* OwnedProcessTree;
			const build = Effect.fn("CompiledPluginBuilder.build")(function* (
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The builder decodes CompiledPluginBuildRequest on the next statement.
				input: unknown,
				options: CompiledPluginBuildOptions = {}
			) {
				const request = yield* Schema.decodeUnknownEffect(CompiledPluginBuildRequest)(
					input,
					{
						onExcessProperty: "error"
					}
				).pipe(
					Effect.mapError(() =>
						invalid(
							"validation",
							"Compiled plugin build request is invalid.",
							"Provide exact source digests, engine identity, graph, toolchain, and output settings."
						)
					)
				);
				const limits = { ...defaultPluginDistributionLimits, ...options.limits };
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const outputRoot = resolve(request.outputDirectory);
						const engineRoot = resolve(request.engineRoot);
						if (dirname(outputRoot) === outputRoot || within(engineRoot, outputRoot)) {
							return yield* invalid(
								"validation",
								"Output must be a caller-owned directory outside the engine root.",
								"Choose a bounded output directory outside Unreal Engine."
							);
						}
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
						const buildVersionPath = join(
							engineRoot,
							"Engine",
							"Build",
							"Build.version"
						);
						const editorModulesPath = join(
							engineRoot,
							"Engine",
							"Binaries",
							request.artifact.platform,
							"UnrealEditor.modules"
						);
						const sourceManifestPath = resolve(request.sourceManifestPath);
						const sourceArtifactPath = resolve(request.sourceArtifactPath);
						const validatedFiles = yield* Effect.tryPromise({
							try: async () => {
								await mkdir(outputRoot, { recursive: true });
								const outputDetails = await lstat(outputRoot);
								if (!outputDetails.isDirectory() || outputDetails.isSymbolicLink())
									throw new Error(
										"Output root must be a real directory, not a link."
									);
								const canonicalOutput = await realpath(outputRoot);
								const canonicalEngine = await realpath(engineRoot);
								if (within(canonicalEngine, canonicalOutput))
									throw new Error(
										"Output root resolves beneath the engine root."
									);
								await regularFile(runUat, "RunUAT");
								await regularFile(buildVersionPath, "Engine Build.version");
								await regularFile(editorModulesPath, "UnrealEditor.modules");
								await regularFile(sourceManifestPath, "Source manifest");
								await regularFile(sourceArtifactPath, "Source artifact");
								const manifestBytes = await readFile(sourceManifestPath);
								if (sha256(manifestBytes) !== request.expectedSourceManifestSha256)
									throw new Error(
										"Source manifest digest does not match the pinned digest."
									);
								const buildVersion = Schema.decodeUnknownSync(UnrealBuildVersion)(
									JSON.parse(await readFile(buildVersionPath, "utf8"))
								);
								const engineModules = Schema.decodeUnknownSync(UnrealModules)(
									JSON.parse(await readFile(editorModulesPath, "utf8"))
								);
								const unrealVersion = `${buildVersion.MajorVersion}.${buildVersion.MinorVersion}.${buildVersion.PatchVersion}`;
								if (
									unrealVersion !== request.artifact.unrealVersion ||
									engineModules.BuildId !== request.artifact.engineBuildId
								)
									throw new Error(
										"Requested Unreal version or BuildId does not match the explicit engine root."
									);
								return { manifestInput: decodeJson(manifestBytes) };
							},
							catch: (cause) =>
								invalid(
									"validation",
									`Compiled plugin build validation failed: ${String(cause)}`,
									"Correct the engine root, exact source pins, graph, or output directory before invoking UAT."
								)
						});
						const sourceManifest = yield* validatePluginBundleManifest(
							validatedFiles.manifestInput
						).pipe(
							Effect.mapError((cause) =>
								invalid("validation", cause.message, cause.recovery)
							)
						);
						if (!isSourcePluginBundleManifest(sourceManifest)) {
							return yield* invalid(
								"validation",
								"Builder input must be a source plugin bundle.",
								"Acquire the exact portable source artifact explicitly before building."
							);
						}
						if (
							sourceManifest.artifact.sha256 !== request.expectedSourceArtifactSha256
						) {
							return yield* invalid(
								"validation",
								"Source artifact digest does not match the pinned digest.",
								"Use the archive digest pinned by the exact source manifest."
							);
						}
						const graph = yield* resolvePluginBundleDependencies(
							sourceManifest,
							request.pluginIds
						).pipe(
							Effect.mapError((cause) =>
								invalid("validation", cause.message, cause.recovery)
							)
						);
						const stage = join(outputRoot, `.compiled-plugin-${randomUUID()}`);
						yield* Effect.tryPromise({
							try: () => mkdir(stage),
							catch: (cause) =>
								invalid(
									"validation",
									`Could not create the private build stage: ${String(cause)}`,
									"Choose a writable caller-owned output directory."
								)
						});
						const prepared = { graph, sourceManifest, stage };
						return yield* Effect.acquireUseRelease(
							Effect.succeed(prepared),
							(state) =>
								Effect.gen(function* () {
									const extracted = join(state.stage, "source");
									yield* verifyPluginArtifact({
										artifactPath: sourceArtifactPath,
										expectedBytes: state.sourceManifest.artifact.bytes,
										expectedDigest: state.sourceManifest.artifact.sha256,
										limits,
										releaseVersion: state.sourceManifest.releaseVersion
									}).pipe(
										Effect.mapError((cause) =>
											invalid(
												"source-verification",
												cause.message,
												cause.recovery
											)
										)
									);
									yield* extractPluginArchive({
										archivePath: sourceArtifactPath,
										destination: extracted,
										limits,
										manifest: state.sourceManifest,
										signal: options.signal ?? new AbortController().signal
									}).pipe(
										Effect.mapError((cause) =>
											invalid(
												"source-extraction",
												cause.message,
												cause.recovery
											)
										)
									);
									const aggregate = yield* Effect.tryPromise({
										try: () =>
											prepareAggregatePlugin({
												plugins: state.graph.plugins,
												pluginsRoot: join(extracted, "Plugins"),
												root: join(state.stage, "aggregate")
											}),
										catch: (cause) =>
											invalid(
												"staging",
												`Could not stage the plugin graph: ${String(cause)}`,
												"Fix the portable source bundle and retry."
											)
									});
									const packageRoot = join(state.stage, "uat-package");
									const uatArguments = [
										"BuildPlugin",
										`-Plugin=${join(aggregate.aggregateRoot, "UEShedCompiledGraph.uplugin")}`,
										`-Package=${packageRoot}`,
										`-EngineDir=${engineRoot}`,
										`-HostPlatforms=${request.artifact.platform}`,
										"-NoTargetPlatforms",
										`-Architecture_${request.artifact.platform}=${request.artifact.architecture}`,
										"-UTF8Output",
										"-Unattended"
									];
									const handle = yield* processes
										.launch({
											args: uatArguments,
											cwd: dirname(runUat),
											executable: runUat,
											terminationTimeout: Duration.seconds(30)
										})
										.pipe(
											Effect.mapError((cause) =>
												invalid("build", cause.message, cause.recovery)
											)
										);
									const completed = yield* Effect.acquireUseRelease(
										Effect.succeed(handle),
										(owned) => {
											const awaited =
												options.signal === undefined
													? owned.awaitExit
													: Effect.raceFirst(
															owned.awaitExit,
															abortBuild(options.signal)
														);
											return awaited.pipe(
												Effect.mapError((cause) =>
													cause instanceof CompiledPluginBuildCancelled
														? cause
														: invalid(
																"build",
																cause.message,
																cause.recovery
															)
												),
												Effect.timeoutOption(
													Duration.seconds(
														request.maximumBuildSeconds ?? 7_200
													)
												)
											);
										},
										(owned) => owned.terminate("cancelled").pipe(Effect.ignore)
									);
									if (completed._tag === "None") {
										return yield* new CompiledPluginBuildFailed({
											exitCode: null,
											message:
												"RunUAT BuildPlugin exceeded the configured timeout.",
											recovery:
												"Increase the bounded timeout only after inspecting the build host.",
											retrySafe: true,
											stage: "build"
										});
									}
									yield* validateExit(completed.value);
									const graphRoot = join(state.stage, "compiled-tree");
									yield* Effect.tryPromise({
										try: () =>
											composeCompiledGraph({
												buildId: request.artifact.engineBuildId,
												packageRoot,
												platform: request.artifact.platform,
												plugins: state.graph.plugins,
												pluginsRoot: join(extracted, "Plugins"),
												root: graphRoot
											}),
										catch: (cause) =>
											invalid(
												"validation",
												`RunUAT output is invalid: ${String(cause)}`,
												"Inspect UAT products and rebuild; invalid output is never published."
											)
									});
									const names = variantPluginReleaseAssetNames(
										state.sourceManifest.releaseVersion,
										request.artifact
									);
									const publishStage = join(state.stage, "publish");
									yield* Effect.tryPromise({
										try: () => mkdir(publishStage),
										catch: (cause) =>
											invalid(
												"publication",
												String(cause),
												"Check output permissions."
											)
									});
									const artifactPath = join(publishStage, names.artifact);
									yield* Effect.tryPromise({
										try: () =>
											writeDeterministicArchive(graphRoot, artifactPath),
										catch: (cause) =>
											invalid(
												"archive",
												`Could not create compiled archive: ${String(cause)}`,
												"Check output limits and retry."
											)
									});
									const artifactBytes = yield* Effect.promise(() =>
										readFile(artifactPath)
									);
									const manifest = yield* Schema.decodeUnknownEffect(
										CompiledPluginBundleManifestV2
									)({
										artifact: {
											bytes: artifactBytes.byteLength,
											id: `ue-shed-plugin-compiled-${state.sourceManifest.releaseVersion}`,
											kind: "unreal-editor-plugin-binary",
											path: names.artifact,
											sha256: sha256(artifactBytes)
										},
										build: {
											builder: "@ue-shed/plugin-distribution",
											builderVersion: "1",
											compiler: request.compiler,
											invocationSha256: sha256(
												Buffer.from(
													canonicalInvocation(
														request,
														state.graph.orderedPluginIds
													)
												)
											),
											requestedPluginIds: request.pluginIds,
											resolvedPluginIds: state.graph.orderedPluginIds,
											sourceArtifactSha256:
												request.expectedSourceArtifactSha256,
											sourceManifestSha256:
												request.expectedSourceManifestSha256
										},
										compatibility: { ...request.artifact, kind: "compiled" },
										plugins: state.graph.plugins,
										provenance: state.sourceManifest.provenance,
										releaseVersion: state.sourceManifest.releaseVersion,
										schemaVersion: 2
									}).pipe(
										Effect.mapError(() =>
											invalid(
												"manifest",
												"Generated compiled manifest is invalid.",
												"Inspect the validated build inputs and retry."
											)
										)
									);
									const manifestPath = join(publishStage, names.manifest);
									const manifestBytes = Buffer.from(
										`${JSON.stringify(manifest, null, "\t")}\n`
									);
									yield* Effect.tryPromise({
										try: () =>
											writeFile(manifestPath, manifestBytes, { flag: "wx" }),
										catch: (cause) =>
											invalid(
												"publication",
												String(cause),
												"Check output permissions."
											)
									});
									const validationRoot = join(state.stage, "validation");
									yield* extractPluginArchive({
										archivePath: artifactPath,
										destination: validationRoot,
										limits,
										manifest,
										signal: options.signal ?? new AbortController().signal
									}).pipe(
										Effect.mapError((cause) =>
											invalid("validation", cause.message, cause.recovery)
										)
									);
									const outputPath = join(
										outputRoot,
										names.artifact.replace(/\.tar\.gz$/u, "")
									);
									yield* Effect.tryPromise({
										try: async () => {
											try {
												await stat(outputPath);
												throw new Error(
													`Immutable output already exists: ${outputPath}`
												);
											} catch (cause) {
												if (
													cause instanceof Error &&
													"code" in cause &&
													cause.code === "ENOENT"
												)
													await rename(publishStage, outputPath);
												else throw cause;
											}
										},
										catch: (cause) =>
											invalid(
												"publication",
												String(cause),
												"Choose a new empty immutable output identity."
											)
									});
									return CompiledPluginBuildResult.make({
										artifactPath: join(outputPath, names.artifact),
										manifest,
										manifestDigest: sha256(manifestBytes),
										manifestPath: join(outputPath, names.manifest),
										outputPath,
										resolvedPluginIds: state.graph.orderedPluginIds
									});
								}),
							(state) =>
								Effect.promise(() =>
									rm(state.stage, { force: true, recursive: true })
								)
						);
					})
				);
			});
			return CompiledPluginBuilder.of({ build });
		})
	);
