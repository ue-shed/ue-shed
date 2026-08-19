import { createHash, randomUUID } from "node:crypto";
import {
	access,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryLive,
	OwnedProcessTree,
	OwnedProcessTreeLive,
	unrealEditorCommandletExecutable
} from "@ue-shed/engine";
import { Clock, Context, Duration, Effect, Layer, Schema } from "effect";
import {
	NiagaraPreviewProducerReceipt,
	NiagaraPreviewProducerRequest,
	NiagaraPreviewRunManifest,
	decodeNiagaraPreviewProducerReceipt,
	decodeNiagaraPreviewProducerRequest,
	type NiagaraPreviewDiagnostic,
	type NiagaraPreviewRunManifest as NiagaraPreviewRunManifestValue,
	type NiagaraPreviewSettings
} from "./schema.js";

const MAXIMUM_TOTAL_PIXELS = 268_435_456;
const MAXIMUM_RECEIPT_BYTES = 8 * 1024 * 1024;
const COMMANDLET_TIMEOUT = Duration.minutes(30);

export interface RunNiagaraPreviewOptions {
	readonly explicitEngineRoot?: string;
	readonly outputRoot?: string;
	readonly pluginDescriptor?: string;
	readonly projectDescriptor: string;
	readonly runId?: string;
	readonly settings?: NiagaraPreviewSettings;
	readonly systemObjectPath: string;
}

export interface NiagaraPreviewRunOutcome {
	readonly manifest: NiagaraPreviewRunManifestValue;
	readonly manifestPath: string;
}

export class NiagaraPreviewError extends Schema.TaggedErrorClass<NiagaraPreviewError>()(
	"NiagaraPreviewError",
	{
		code: Schema.Literals([
			"invalid_request",
			"engine_discovery_failed",
			"commandlet_unavailable",
			"plugin_unavailable",
			"process_failed",
			"process_timeout",
			"receipt_missing",
			"receipt_invalid",
			"artifact_invalid",
			"run_exists",
			"publish_failed"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		runId: Schema.optionalKey(Schema.String),
		stage: Schema.Literals(["validation", "capture", "publication"])
	}
) {}

export interface NiagaraPreviewApi {
	readonly run: (
		options: RunNiagaraPreviewOptions
	) => Effect.Effect<NiagaraPreviewRunOutcome, NiagaraPreviewError>;
}

export class NiagaraPreview extends Context.Service<NiagaraPreview, NiagaraPreviewApi>()(
	"@ue-shed/niagara/NiagaraPreview"
) {}

function previewError(
	code: NiagaraPreviewError["code"],
	stage: NiagaraPreviewError["stage"],
	message: string,
	recovery: string,
	retrySafe: boolean,
	runId?: string
): NiagaraPreviewError {
	return new NiagaraPreviewError({
		code,
		message,
		recovery,
		retrySafe,
		stage,
		...(runId === undefined ? undefined : { runId })
	});
}

function safeIo<A>(
	operation: Effect.Effect<A, unknown>,
	error: NiagaraPreviewError
): Effect.Effect<A, NiagaraPreviewError> {
	return operation.pipe(Effect.mapError(() => error));
}

function settingsMatch(left: NiagaraPreviewSettings, right: NiagaraPreviewSettings): boolean {
	return (
		left.captureMode === right.captureMode &&
		left.durationSeconds === right.durationSeconds &&
		left.frameCount === right.frameCount &&
		left.height === right.height &&
		left.simulationFramesPerSecond === right.simulationFramesPerSecond &&
		left.startSeconds === right.startSeconds &&
		left.width === right.width
	);
}

function pathContained(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child !== "" &&
		!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		child !== ".." &&
		!isAbsolute(child)
	);
}

interface PngDimensions {
	readonly height: number;
	readonly width: number;
}

function pngDimensions(bytes: Uint8Array): PngDimensions {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) {
		throw new Error("not a PNG");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function isoTimestamp(milliseconds: number): string {
	return new Date(milliseconds).toISOString();
}

function expectedFramePath(index: number): string {
	return `frames/frame_${String(index).padStart(4, "0")}.png`;
}

function diagnosticsFor(
	frames: NiagaraPreviewProducerReceipt["frames"]
): readonly NiagaraPreviewDiagnostic[] {
	const diagnostics: NiagaraPreviewDiagnostic[] = [];
	if (frames.every((frame) => frame.nonTransparentPixelFraction < 0.0001)) {
		diagnostics.push({
			code: "nearly_empty",
			message: "Every frame contains less than 0.01% non-transparent pixels."
		});
	}
	if (frames.every((frame) => frame.maximumRgb < 0.01)) {
		diagnostics.push({
			code: "nearly_black",
			message: "Every frame has a maximum rendered RGB value below 1%."
		});
	}
	return diagnostics;
}

function validateRenderBudget(
	request: NiagaraPreviewProducerRequest
): Effect.Effect<void, NiagaraPreviewError> {
	const { frameCount, height, width } = request.settings;
	if (
		frameCount !== undefined &&
		height !== undefined &&
		width !== undefined &&
		frameCount * height * width > MAXIMUM_TOTAL_PIXELS
	) {
		return Effect.fail(
			previewError(
				"invalid_request",
				"validation",
				`The requested preview exceeds the v1 budget of ${MAXIMUM_TOTAL_PIXELS} total pixels.`,
				"Reduce dimensions or frame count.",
				false,
				request.runId
			)
		);
	}
	return Effect.void;
}

function validateReceipt(
	receipt: NiagaraPreviewProducerReceipt,
	request: NiagaraPreviewProducerRequest
): Effect.Effect<void, NiagaraPreviewError> {
	if (
		receipt.runId !== request.runId ||
		receipt.systemObjectPath !== request.systemObjectPath ||
		!settingsMatch(receipt.requestedSettings, request.settings)
	) {
		return Effect.fail(
			previewError(
				"receipt_invalid",
				"capture",
				"The producer receipt does not match the requested run identity and settings.",
				"Remove the staged run and retry with a matching UEShedNiagara plugin.",
				false,
				request.runId
			)
		);
	}
	const effective = receipt.effectiveSettings;
	if (
		receipt.frames.length !== effective.frameCount ||
		effective.frameCount * effective.width * effective.height > MAXIMUM_TOTAL_PIXELS
	) {
		return Effect.fail(
			previewError(
				"receipt_invalid",
				"capture",
				"The producer receipt has an incomplete or over-budget frame inventory.",
				"Update the producer and retry the bounded preview.",
				false,
				request.runId
			)
		);
	}
	for (let index = 0; index < receipt.frames.length; index += 1) {
		const frame = receipt.frames[index];
		const expectedTime = effective.startSeconds + index * effective.frameIntervalSeconds;
		if (
			frame === undefined ||
			frame.index !== index ||
			frame.relativePath !== expectedFramePath(index) ||
			Math.abs(frame.timeSeconds - expectedTime) > 0.0001
		) {
			return Effect.fail(
				previewError(
					"receipt_invalid",
					"capture",
					`The producer receipt has invalid identity or timing at frame ${index}.`,
					"Update the producer and retry the preview.",
					false,
					request.runId
				)
			);
		}
	}
	return Effect.void;
}

function validateArtifacts(options: {
	readonly receipt: NiagaraPreviewProducerReceipt;
	readonly stagingRoot: string;
}): Effect.Effect<NiagaraPreviewRunManifestValue["artifacts"], NiagaraPreviewError> {
	return Effect.gen(function* () {
		const rootDetails = yield* safeIo(
			Effect.promise(() => lstat(options.stagingRoot)),
			previewError(
				"artifact_invalid",
				"capture",
				"The producer staging directory is unavailable.",
				"Inspect the Unreal log and retry the preview.",
				true,
				options.receipt.runId
			)
		);
		if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
			return yield* previewError(
				"artifact_invalid",
				"capture",
				"The producer staging root is not a normal directory.",
				"Remove the staged path and retry.",
				false,
				options.receipt.runId
			);
		}
		const canonicalRoot = yield* safeIo(
			Effect.promise(() => realpath(options.stagingRoot)),
			previewError(
				"artifact_invalid",
				"capture",
				"The producer staging root could not be resolved.",
				"Inspect filesystem permissions and retry.",
				true,
				options.receipt.runId
			)
		);
		const frameDirectory = join(options.stagingRoot, "frames");
		const names = yield* safeIo(
			Effect.promise(() => readdir(frameDirectory)),
			previewError(
				"artifact_invalid",
				"capture",
				"The staged frame directory is unavailable.",
				"Inspect the Unreal log and retry.",
				true,
				options.receipt.runId
			)
		);
		const expectedNames = options.receipt.frames.map((frame) => basename(frame.relativePath));
		if (
			names.length !== expectedNames.length ||
			names.some((name) => !expectedNames.includes(name))
		) {
			return yield* previewError(
				"artifact_invalid",
				"capture",
				"The staged frame directory does not exactly match the producer receipt.",
				"Remove the staged run and retry.",
				false,
				options.receipt.runId
			);
		}
		return yield* Effect.forEach(
			options.receipt.frames,
			(frame) =>
				Effect.gen(function* () {
					const candidate = resolve(
						options.stagingRoot,
						...frame.relativePath.split("/")
					);
					if (!pathContained(resolve(options.stagingRoot), candidate)) {
						return yield* previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} escapes the producer staging root.`,
							"Update the producer and retry.",
							false,
							options.receipt.runId
						);
					}
					const details = yield* safeIo(
						Effect.promise(() => lstat(candidate)),
						previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} is missing.`,
							"Inspect the Unreal log and retry.",
							true,
							options.receipt.runId
						)
					);
					if (!details.isFile() || details.isSymbolicLink()) {
						return yield* previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} is not a normal file.`,
							"Remove the staged run and retry.",
							false,
							options.receipt.runId
						);
					}
					const canonical = yield* safeIo(
						Effect.promise(() => realpath(candidate)),
						previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} could not be resolved.`,
							"Inspect filesystem permissions and retry.",
							true,
							options.receipt.runId
						)
					);
					if (!pathContained(canonicalRoot, canonical)) {
						return yield* previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} resolves outside the producer staging root.`,
							"Remove the staged run and retry.",
							false,
							options.receipt.runId
						);
					}
					const maximumBytes =
						options.receipt.effectiveSettings.width *
							options.receipt.effectiveSettings.height *
							4 +
						8 * 1024 * 1024;
					if (details.size < 1 || details.size > maximumBytes) {
						return yield* previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} has an invalid byte length.`,
							"Update the producer and retry.",
							false,
							options.receipt.runId
						);
					}
					const bytes = yield* safeIo(
						Effect.promise(() => readFile(candidate)),
						previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} could not be read.`,
							"Inspect filesystem permissions and retry.",
							true,
							options.receipt.runId
						)
					);
					let dimensions: { readonly height: number; readonly width: number };
					try {
						dimensions = pngDimensions(bytes);
					} catch {
						return yield* previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} is not a valid PNG header.`,
							"Update the producer and retry.",
							false,
							options.receipt.runId
						);
					}
					if (
						dimensions.width !== options.receipt.effectiveSettings.width ||
						dimensions.height !== options.receipt.effectiveSettings.height
					) {
						return yield* previewError(
							"artifact_invalid",
							"capture",
							`Frame ${frame.index} dimensions do not match the producer receipt.`,
							"Update the producer and retry.",
							false,
							options.receipt.runId
						);
					}
					return {
						bytes: details.size,
						height: dimensions.height,
						index: frame.index,
						maximumRgb: frame.maximumRgb,
						mimeType: "image/png" as const,
						nonTransparentPixelFraction: frame.nonTransparentPixelFraction,
						relativePath: frame.relativePath,
						sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
						timeSeconds: frame.timeSeconds,
						width: dimensions.width
					};
				}),
			{ concurrency: 1 }
		);
	});
}

function publishRun(options: {
	readonly artifacts: NiagaraPreviewRunManifestValue["artifacts"];
	readonly generatedAtUtc: string;
	readonly outputRoot: string;
	readonly receipt: NiagaraPreviewProducerReceipt;
	readonly stagingRoot: string;
}): Effect.Effect<NiagaraPreviewRunOutcome, NiagaraPreviewError> {
	return Effect.gen(function* () {
		const manifest = yield* Schema.decodeUnknownEffect(NiagaraPreviewRunManifest)({
			alphaPolicy: options.receipt.alphaPolicy,
			artifacts: options.artifacts,
			camera: options.receipt.camera,
			colorSpace: options.receipt.colorSpace,
			contract: {
				name: "ue-shed-niagara-preview-run",
				version: { major: 1, minor: 0 }
			},
			diagnostics: diagnosticsFor(options.receipt.frames),
			effectiveSettings: options.receipt.effectiveSettings,
			generatedAtUtc: options.generatedAtUtc,
			producer: {
				engineVersion: options.receipt.engineVersion,
				receiptContract: options.receipt.contract
			},
			requestedSettings: options.receipt.requestedSettings,
			runId: options.receipt.runId,
			status: "complete",
			systemObjectPath: options.receipt.systemObjectPath
		}).pipe(
			Effect.mapError(() =>
				previewError(
					"receipt_invalid",
					"publication",
					"The validated producer result could not form a published manifest.",
					"Update UE Shed so the producer and host contracts match.",
					false,
					options.receipt.runId
				)
			)
		);
		const runsRoot = join(resolve(options.outputRoot), "runs");
		const finalRoot = join(runsRoot, options.receipt.runId);
		const temporaryRoot = join(runsRoot, `.${options.receipt.runId}.publishing`);
		const exists = yield* Effect.promise(() =>
			stat(finalRoot)
				.then(() => true)
				.catch(() => false)
		);
		if (exists) {
			return yield* previewError(
				"run_exists",
				"publication",
				`Niagara Preview Run ${options.receipt.runId} already exists.`,
				"Choose a new run ID or inspect the existing immutable run.",
				false,
				options.receipt.runId
			);
		}
		const publishFailure = previewError(
			"publish_failed",
			"publication",
			"The validated Niagara Preview Run could not be published atomically.",
			"Verify destination permissions and free space, then retry with a new run ID.",
			true,
			options.receipt.runId
		);
		yield* safeIo(
			Effect.promise(async () => {
				await mkdir(runsRoot, { recursive: true });
				await mkdir(temporaryRoot, { recursive: false });
				await mkdir(join(temporaryRoot, "frames"), { recursive: false });
				try {
					for (const artifact of options.artifacts) {
						await copyFile(
							resolve(options.stagingRoot, ...artifact.relativePath.split("/")),
							resolve(temporaryRoot, ...artifact.relativePath.split("/"))
						);
					}
					await writeFile(
						join(temporaryRoot, "manifest.json"),
						`${JSON.stringify(manifest, null, 2)}\n`,
						"utf8"
					);
					await rename(temporaryRoot, finalRoot);
				} catch (cause) {
					await rm(temporaryRoot, { force: true, recursive: true });
					throw cause;
				}
			}),
			publishFailure
		);
		yield* Effect.promise(() => rm(options.stagingRoot, { force: true, recursive: true }));
		return { manifest, manifestPath: join(finalRoot, "manifest.json") };
	});
}

export const NiagaraPreviewLive = Layer.effect(
	NiagaraPreview,
	Effect.gen(function* () {
		const engines = yield* EngineInstallationDiscovery;
		const processes = yield* OwnedProcessTree;
		const runScoped = Effect.fn("NiagaraPreview.run")(function* (
			options: RunNiagaraPreviewOptions
		) {
			const projectDescriptor = resolve(options.projectDescriptor);
			const projectRoot = dirname(projectDescriptor);
			const runId = options.runId ?? randomUUID();
			const request = yield* decodeNiagaraPreviewProducerRequest({
				contract: {
					name: "ue-shed-niagara-preview-request",
					version: { major: 1, minor: 0 }
				},
				runId,
				settings: options.settings ?? {},
				systemObjectPath: options.systemObjectPath
			}).pipe(
				Effect.mapError(() =>
					previewError(
						"invalid_request",
						"validation",
						"The Niagara preview request is invalid.",
						"Provide a /Game object path, a UUID run ID, and bounded capture settings.",
						false,
						runId
					)
				)
			);
			yield* validateRenderBudget(request);
			yield* safeIo(
				Effect.promise(() => access(projectDescriptor)),
				previewError(
					"invalid_request",
					"validation",
					`Project descriptor does not exist: ${projectDescriptor}`,
					"Choose an existing .uproject descriptor.",
					false,
					request.runId
				)
			);
			const pluginDescriptor =
				options.pluginDescriptor === undefined
					? undefined
					: resolve(options.pluginDescriptor);
			if (pluginDescriptor !== undefined) {
				yield* safeIo(
					Effect.promise(() => access(pluginDescriptor)),
					previewError(
						"plugin_unavailable",
						"validation",
						`UEShedNiagara descriptor does not exist: ${pluginDescriptor}`,
						"Install the plugin in the project or pass its source descriptor.",
						false,
						request.runId
					)
				);
			}
			const installation = yield* engines
				.resolve({
					projectDescriptor,
					...(options.explicitEngineRoot === undefined
						? undefined
						: { explicitRoot: options.explicitEngineRoot })
				})
				.pipe(
					Effect.mapError((cause) =>
						previewError(
							"engine_discovery_failed",
							"validation",
							cause.message,
							cause.recovery,
							cause.retrySafe,
							request.runId
						)
					)
				);
			const executable = unrealEditorCommandletExecutable(installation.root);
			yield* safeIo(
				Effect.promise(() => access(executable)),
				previewError(
					"commandlet_unavailable",
					"validation",
					`Unreal commandlet executable does not exist: ${executable}`,
					"Choose a complete Unreal installation and retry.",
					false,
					request.runId
				)
			);
			const temporaryRoot = yield* Effect.acquireRelease(
				safeIo(
					Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-preview-"))),
					previewError(
						"invalid_request",
						"validation",
						"A temporary request directory could not be created.",
						"Verify temporary-directory permissions and retry.",
						true,
						request.runId
					)
				),
				(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
			);
			const requestPath = join(temporaryRoot, "request.json");
			yield* safeIo(
				Effect.promise(() =>
					writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8")
				),
				previewError(
					"invalid_request",
					"validation",
					"The commandlet request could not be written.",
					"Verify temporary-directory permissions and retry.",
					true,
					request.runId
				)
			);
			const args = [
				projectDescriptor,
				...(pluginDescriptor === undefined ? [] : [`-PLUGIN=${pluginDescriptor}`]),
				"-EnablePlugins=UEShedNiagara",
				"-run=UEShedNiagaraPreview",
				`-Request=${requestPath}`,
				"-AllowCommandletRendering",
				"-RenderOffscreen",
				"-unattended",
				"-nop4",
				"-nosplash"
			];
			const process = yield* Effect.acquireRelease(
				processes
					.launch({
						args,
						cwd: projectRoot,
						executable,
						terminationTimeout: Duration.seconds(15)
					})
					.pipe(
						Effect.mapError((cause) =>
							previewError(
								"process_failed",
								"capture",
								cause.message,
								cause.recovery,
								cause.retrySafe,
								request.runId
							)
						)
					),
				(process) => process.terminate("released").pipe(Effect.ignore)
			);
			const exit = yield* process.awaitExit.pipe(
				Effect.mapError((cause) =>
					previewError(
						"process_failed",
						"capture",
						cause.message,
						cause.recovery,
						cause.retrySafe,
						request.runId
					)
				),
				Effect.timeoutOrElse({
					duration: COMMANDLET_TIMEOUT,
					orElse: () =>
						Effect.fail(
							previewError(
								"process_timeout",
								"capture",
								"The Niagara preview commandlet exceeded 30 minutes.",
								"Inspect shader compilation and reduce the render budget before retrying.",
								true,
								request.runId
							)
						)
				})
			);
			if (exit.kind !== "exited" || exit.exitCode !== 0) {
				return yield* previewError(
					"process_failed",
					"capture",
					`The Niagara preview commandlet exited with ${exit.exitCode ?? "no exit code"}.`,
					"Inspect the Unreal log, confirm UEShedNiagara is enabled, and retry.",
					true,
					request.runId
				);
			}
			const stagingRoot = join(
				projectRoot,
				"Saved",
				"UEShed",
				"NiagaraPreviewStaging",
				request.runId
			);
			const receiptPath = join(stagingRoot, "producer-receipt.json");
			const receiptDetails = yield* safeIo(
				Effect.promise(() => stat(receiptPath)),
				previewError(
					"receipt_missing",
					"capture",
					"The commandlet exited without a producer receipt.",
					"Inspect the Unreal log and retry.",
					true,
					request.runId
				)
			);
			if (receiptDetails.size < 1 || receiptDetails.size > MAXIMUM_RECEIPT_BYTES) {
				return yield* previewError(
					"receipt_invalid",
					"capture",
					"The producer receipt has an invalid byte length.",
					"Update the producer and retry.",
					false,
					request.runId
				);
			}
			const receiptUnknown = yield* safeIo(
				Effect.promise(() => readFile(receiptPath, "utf8").then(JSON.parse)),
				previewError(
					"receipt_invalid",
					"capture",
					"The producer receipt is not readable JSON.",
					"Inspect the Unreal log and retry.",
					false,
					request.runId
				)
			);
			const receipt = yield* decodeNiagaraPreviewProducerReceipt(receiptUnknown).pipe(
				Effect.mapError(() =>
					previewError(
						"receipt_invalid",
						"capture",
						"The producer receipt does not match Niagara preview contract v1.",
						"Update UE Shed so the producer and host contracts match.",
						false,
						request.runId
					)
				)
			);
			yield* validateReceipt(receipt, request);
			const artifacts = yield* validateArtifacts({ receipt, stagingRoot });
			return yield* publishRun({
				artifacts,
				generatedAtUtc: isoTimestamp(yield* Clock.currentTimeMillis),
				outputRoot:
					options.outputRoot === undefined
						? join(projectRoot, ".ue-shed", "niagara-preview")
						: resolve(options.outputRoot),
				receipt,
				stagingRoot
			});
		});
		const run: NiagaraPreviewApi["run"] = (options) => Effect.scoped(runScoped(options));
		return NiagaraPreview.of({ run });
	})
);

const NiagaraPreviewDependenciesLive = Layer.merge(
	Layer.orDie(EngineInstallationDiscoveryLive),
	OwnedProcessTreeLive
);

export function runNiagaraPreview(
	options: RunNiagaraPreviewOptions
): Effect.Effect<NiagaraPreviewRunOutcome, NiagaraPreviewError> {
	return Effect.flatMap(NiagaraPreview, (preview) => preview.run(options)).pipe(
		Effect.provide(NiagaraPreviewLive),
		Effect.provide(NiagaraPreviewDependenciesLive)
	);
}

export function makeNiagaraPreviewTestLayer(
	run: NiagaraPreviewApi["run"]
): Layer.Layer<NiagaraPreview> {
	return Layer.succeed(NiagaraPreview, NiagaraPreview.of({ run }));
}
