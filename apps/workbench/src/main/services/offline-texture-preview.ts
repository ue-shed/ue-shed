import { decodeTexturePreviewResult, type TexturePreviewResult } from "@ue-shed/asset-audits";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ElectronApp } from "../adapters/electron-app.js";
import {
	OfflineTexturePreviewHost,
	type OfflineTexturePreviewHostApi
} from "../adapters/offline-texture-preview-host.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

const maximumPreviewResultBytes = 5_700_000;
const ProjectDescriptor = Schema.Struct({
	EngineAssociation: Schema.optional(Schema.String)
});
const EngineBuildVersion = Schema.Struct({
	MajorVersion: Schema.Number,
	MinorVersion: Schema.Number
});

const PreviewRequest = Schema.Struct({
	maxDimension: Schema.Int,
	objectPath: Schema.String,
	packageFile: Schema.String,
	projectRoot: Schema.String,
	sourceBytes: Schema.Number,
	sourceModifiedMs: Schema.Number
});
type PreviewRequest = Schema.Schema.Type<typeof PreviewRequest>;
const decodePreviewRequest = Schema.decodeUnknownEffect(PreviewRequest);

export class OfflineTexturePreviewError extends Schema.TaggedErrorClass<OfflineTexturePreviewError>()(
	"Workbench.OfflineTexturePreviewError",
	{
		code: Schema.Literals([
			"cache_failure",
			"commandlet_failed",
			"contract_failure",
			"engine_unavailable",
			"project_unavailable"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface OfflineTexturePreviewInput {
	readonly maxDimension?: number;
	readonly objectPath: string;
	readonly packageFile: string;
	readonly projectRoot: string;
}

export interface OfflineTexturePreviewApi {
	readonly preview: (
		input: OfflineTexturePreviewInput
	) => Effect.Effect<TexturePreviewResult, OfflineTexturePreviewError>;
	readonly previewBatch: (
		inputs: ReadonlyArray<OfflineTexturePreviewInput>
	) => Effect.Effect<OfflineTexturePreviewBatch, OfflineTexturePreviewError>;
}

export interface OfflineTexturePreviewBatch {
	readonly cached: number;
	readonly generated: number;
	readonly previews: ReadonlyArray<TexturePreviewResult>;
}

export class OfflineTexturePreview extends Context.Service<
	OfflineTexturePreview,
	OfflineTexturePreviewApi
>()("@ue-shed/workbench/OfflineTexturePreview") {}

function previewError(
	code: OfflineTexturePreviewError["code"],
	message: string,
	recovery: string,
	retrySafe: boolean
): OfflineTexturePreviewError {
	return new OfflineTexturePreviewError({ code, message, recovery, retrySafe });
}

function commandletExecutable(engineRoot: string): string {
	if (process.platform === "win32") {
		return join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe");
	}
	if (process.platform === "linux") {
		return join(engineRoot, "Engine", "Binaries", "Linux", "UnrealEditor-Cmd");
	}
	return join(engineRoot, "Engine", "Binaries", "Mac", "UnrealEditor-Cmd");
}

function projectFile(
	host: OfflineTexturePreviewHostApi,
	projectRoot: string
): Effect.Effect<string, Error> {
	return host.listProjectFiles(projectRoot).pipe(
		Effect.mapError((cause) => new Error(cause.message)),
		Effect.flatMap((projects) => {
			const selected = projects[0];
			return projects.length === 1 && selected
				? Effect.succeed(selected)
				: Effect.fail(
						new Error(
							projects.length === 0
								? `No .uproject file exists in ${projectRoot}.`
								: `More than one .uproject file exists in ${projectRoot}.`
						)
					);
		})
	);
}

interface EngineCandidate {
	readonly major: number;
	readonly minor: number;
	readonly root: string;
	readonly version: string;
}

function engineCandidate(
	host: OfflineTexturePreviewHostApi,
	root: string
): Effect.Effect<EngineCandidate | undefined> {
	const executable = commandletExecutable(root);
	return Effect.gen(function* () {
		if (!(yield* host.exists(executable))) return undefined;
		const bytes = yield* host
			.readFile(join(root, "Engine", "Build", "Build.version"), 256 * 1_024)
			.pipe(Effect.option);
		if (Option.isNone(bytes)) return undefined;
		const decoded = yield* Effect.try(() =>
			JSON.parse(new TextDecoder().decode(bytes.value))
		).pipe(Effect.flatMap(Schema.decodeUnknownEffect(EngineBuildVersion)), Effect.option);
		if (Option.isNone(decoded)) return undefined;
		const version = decoded.value;
		return {
			major: version.MajorVersion,
			minor: version.MinorVersion,
			root,
			version: `${version.MajorVersion}.${version.MinorVersion}`
		};
	});
}

function projectEngineAssociation(
	host: OfflineTexturePreviewHostApi,
	path: string
): Effect.Effect<string | undefined> {
	return host.readFile(path, 1_024 * 1_024).pipe(
		Effect.flatMap((bytes) =>
			Effect.try(() => JSON.parse(new TextDecoder().decode(bytes))).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ProjectDescriptor))
			)
		),
		Effect.map((descriptor) => descriptor.EngineAssociation),
		Effect.orElseSucceed(() => undefined)
	);
}

function discoverEngineRoot(
	host: OfflineTexturePreviewHostApi,
	options: {
		readonly configuredRoot?: string;
		readonly projectFile: string;
	}
): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		if (options.configuredRoot) {
			const root = resolve(options.configuredRoot);
			if (yield* host.exists(commandletExecutable(root))) return root;
			return yield* Effect.fail(
				new Error(`No UnrealEditor-Cmd executable exists under ${root}.`)
			);
		}
		if (process.platform !== "win32") {
			return yield* Effect.fail(
				new Error("Set UE_SHED_UNREAL_ENGINE_ROOT for offline previews on this platform.")
			);
		}

		const epicRoot = join(host.programFiles, "Epic Games");
		const entries = yield* host.listDirectories(epicRoot).pipe(Effect.orElseSucceed(() => []));
		const candidates = yield* Effect.forEach(
			entries.filter((entry) => basename(entry).startsWith("UE_")),
			(entry) => engineCandidate(host, entry),
			{ concurrency: "unbounded" }
		);
		const available = candidates.filter(
			(candidate): candidate is EngineCandidate => candidate !== undefined
		);
		const association = yield* projectEngineAssociation(host, options.projectFile);
		const exact = association
			? available.filter((candidate) => candidate.version === association)
			: available;
		const selected = exact.toSorted(
			(left, right) => right.major - left.major || right.minor - left.minor
		)[0];
		return selected
			? selected.root
			: yield* Effect.fail(
					new Error(
						association
							? `No installed Unreal ${association} commandlet was discovered.`
							: "No installed Unreal commandlet was discovered."
					)
				);
	});
}

function readPreview(
	host: OfflineTexturePreviewHostApi,
	path: string
): Effect.Effect<TexturePreviewResult, OfflineTexturePreviewError> {
	return host.readFile(path, maximumPreviewResultBytes).pipe(
		Effect.mapError((cause) =>
			previewError(
				"cache_failure",
				`Could not read the saved texture preview: ${cause.message}`,
				"Regenerate the saved preview.",
				true
			)
		),
		Effect.flatMap((bytes) =>
			Effect.try({
				try: () => JSON.parse(new TextDecoder().decode(bytes)),
				catch: (cause) =>
					previewError(
						"contract_failure",
						`Saved texture preview was not JSON: ${String(cause)}`,
						"Regenerate the saved preview.",
						true
					)
			})
		),
		Effect.flatMap(decodeTexturePreviewResult),
		Effect.mapError((cause) =>
			cause instanceof OfflineTexturePreviewError
				? cause
				: previewError(
						"contract_failure",
						`Unreal returned an invalid texture preview: ${String(cause)}`,
						"Update UE Shed so Workbench and the Unreal plugin use compatible contracts.",
						false
					)
		)
	);
}

export const OfflineTexturePreviewLive = Layer.effect(
	OfflineTexturePreview,
	Effect.gen(function* () {
		const app = yield* ElectronApp;
		const configuration = yield* WorkbenchConfiguration;
		const host = yield* OfflineTexturePreviewHost;
		const cacheRoot = join(yield* app.getPath("userData"), "texture-previews-v1");

		const prepare = Effect.fn("Workbench.OfflineTexturePreview.prepare")(function* (
			input: OfflineTexturePreviewInput
		) {
			const packageFile = isAbsolute(input.packageFile)
				? input.packageFile
				: resolve(input.projectRoot, input.packageFile);
			const source = yield* host
				.statFile(packageFile)
				.pipe(
					Effect.mapError((cause) =>
						previewError(
							"project_unavailable",
							`Could not inspect ${basename(packageFile)}: ${cause.message}`,
							"Rescan the project and retry the saved preview.",
							true
						)
					)
				);
			const request = yield* decodePreviewRequest({
				maxDimension: input.maxDimension ?? 384,
				objectPath: input.objectPath,
				packageFile,
				projectRoot: input.projectRoot,
				sourceBytes: source.size,
				sourceModifiedMs: source.modifiedMs
			}).pipe(
				Effect.mapError((cause) =>
					previewError(
						"contract_failure",
						`Invalid internal preview request: ${String(cause)}`,
						"Restart Workbench.",
						false
					)
				)
			);
			const key = JSON.stringify(request);
			return {
				key,
				outputPath: join(
					cacheRoot,
					`${createHash("sha256").update(key).digest("hex")}.json`
				),
				request
			};
		});

		const previewBatch = Effect.fn("Workbench.OfflineTexturePreview.previewBatch")(function* (
			inputs: ReadonlyArray<OfflineTexturePreviewInput>
		) {
			if (inputs.length === 0 || inputs.length > 100) {
				return yield* Effect.fail(
					previewError(
						"contract_failure",
						"A saved preview batch must contain between 1 and 100 textures.",
						"Select a bounded texture page and retry.",
						false
					)
				);
			}
			const roots = new Set(inputs.map((input) => resolve(input.projectRoot)));
			if (roots.size !== 1) {
				return yield* Effect.fail(
					previewError(
						"contract_failure",
						"A saved preview batch cannot span multiple Unreal projects.",
						"Generate previews from one active project at a time.",
						false
					)
				);
			}

			const entries = yield* Effect.forEach(inputs, prepare, { concurrency: 16 });
			const cached = yield* Effect.forEach(
				entries,
				(entry) => readPreview(host, entry.outputPath).pipe(Effect.option),
				{ concurrency: 16 }
			);
			const misses = entries.filter((_, index) => {
				const candidate = cached[index];
				return (
					!candidate || Option.isNone(candidate) || candidate.value.status !== "available"
				);
			});

			const generatedByPath = new Map<string, TexturePreviewResult>();
			if (misses.length > 0) {
				const projectRoot = misses[0]?.request.projectRoot;
				if (!projectRoot)
					return yield* Effect.die("A non-empty preview miss set lost its root");
				const descriptor = yield* projectFile(host, projectRoot).pipe(
					Effect.mapError((cause) =>
						previewError(
							"project_unavailable",
							cause.message,
							"Choose a project directory containing exactly one .uproject file.",
							false
						)
					)
				);
				const engineRoot = yield* discoverEngineRoot(host, {
					...(configuration.unrealEngineRoot?.status === "configured"
						? { configuredRoot: configuration.unrealEngineRoot.path }
						: undefined),
					projectFile: descriptor
				}).pipe(
					Effect.mapError((cause) =>
						previewError(
							"engine_unavailable",
							cause.message,
							"Install the project's Unreal version or set UE_SHED_UNREAL_ENGINE_ROOT.",
							false
						)
					)
				);
				yield* host
					.makeDirectory(cacheRoot)
					.pipe(
						Effect.mapError((cause) =>
							previewError(
								"cache_failure",
								`Could not create the texture preview cache: ${cause.message}`,
								"Verify Workbench can write to its user-data directory.",
								true
							)
						)
					);
				const manifestJson = JSON.stringify({
					requests: misses.map((entry) => ({
						maxDimension: entry.request.maxDimension,
						objectPath: entry.request.objectPath,
						outputPath: entry.outputPath
					}))
				});
				const manifestPath = join(
					cacheRoot,
					`batch-${createHash("sha256").update(manifestJson).digest("hex")}.json`
				);
				yield* host
					.writeFile(manifestPath, new TextEncoder().encode(manifestJson))
					.pipe(
						Effect.mapError((cause) =>
							previewError(
								"cache_failure",
								`Could not write the texture preview batch: ${cause.message}`,
								"Verify Workbench can write to its user-data directory.",
								true
							)
						)
					);
				const commandlet = yield* host
					.runCommandlet({
						args: [
							descriptor,
							"-run=UEShedTexturePreview",
							`-Request=${manifestPath}`,
							"-unattended",
							"-nop4",
							"-nosplash",
							"-NullRHI"
						],
						cwd: projectRoot,
						executable: commandletExecutable(engineRoot)
					})
					.pipe(
						Effect.mapError((cause) =>
							previewError(
								"commandlet_failed",
								cause.message,
								"Build or enable UEShedAssetAudits for this project, then retry.",
								true
							)
						),
						Effect.timeoutOrElse({
							duration: "5 minutes",
							orElse: () =>
								Effect.fail(
									previewError(
										"commandlet_failed",
										"Unreal texture preview batch timed out after five minutes.",
										"Check the project's Unreal log, then retry.",
										true
									)
								)
						})
					);

				const generated = yield* Effect.forEach(
					misses,
					(entry) =>
						host.statFile(entry.request.packageFile).pipe(
							Effect.mapError((cause) =>
								previewError(
									"project_unavailable",
									`Could not recheck ${basename(entry.request.packageFile)}: ${cause.message}`,
									"Rescan the project and retry the saved preview.",
									true
								)
							),
							Effect.flatMap((currentSource) =>
								currentSource.size === entry.request.sourceBytes &&
								currentSource.modifiedMs === entry.request.sourceModifiedMs
									? readPreview(host, entry.outputPath).pipe(
											Effect.mapError((cause) =>
												commandlet.exitCode === 0
													? cause
													: previewError(
															"commandlet_failed",
															`Unreal exited with code ${commandlet.exitCode ?? "unknown"} before producing a valid saved preview${commandlet.stderr ? `: ${commandlet.stderr}` : "."}`,
															"Check the project's Unreal log and retry.",
															true
														)
											)
										)
									: Effect.fail(
											previewError(
												"project_unavailable",
												`${basename(entry.request.packageFile)} changed while Unreal generated its preview.`,
												"Retry to preview the latest saved asset.",
												true
											)
										)
							),
							Effect.map((result) => ({ outputPath: entry.outputPath, result }))
						),
					{ concurrency: 16 }
				);
				for (const item of generated) generatedByPath.set(item.outputPath, item.result);
			}

			const previews = entries.map((entry, index) => {
				const candidate = cached[index];
				return candidate &&
					Option.isSome(candidate) &&
					candidate.value.status === "available"
					? candidate.value
					: generatedByPath.get(entry.outputPath);
			});
			if (previews.some((result) => result === undefined)) {
				return yield* Effect.die("A completed preview batch lost a result");
			}
			return {
				cached: entries.length - misses.length,
				generated: misses.length,
				previews: previews.filter(
					(result): result is TexturePreviewResult => result !== undefined
				)
			};
		});

		const preview = Effect.fn("Workbench.OfflineTexturePreview.preview")(function* (
			input: OfflineTexturePreviewInput
		) {
			const batch = yield* previewBatch([input]);
			const result = batch.previews[0];
			if (!result) return yield* Effect.die("A single preview request returned no result");
			return result;
		});

		return OfflineTexturePreview.of({ preview, previewBatch });
	})
);

export const makeOfflineTexturePreviewTestLayer = (
	service: Pick<OfflineTexturePreviewApi, "preview"> &
		Partial<Omit<OfflineTexturePreviewApi, "preview">>
): Layer.Layer<OfflineTexturePreview> =>
	Layer.succeed(
		OfflineTexturePreview,
		OfflineTexturePreview.of({
			previewBatch: (inputs) =>
				service.previewBatch
					? service.previewBatch(inputs)
					: Effect.forEach(inputs, service.preview).pipe(
							Effect.map((previews) => ({
								cached: 0,
								generated: previews.length,
								previews
							}))
						),
			...service
		})
	);
