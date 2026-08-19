import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	makeEngineInstallationDiscoveryTestLayer,
	makeOwnedProcessTreeTestLayer,
	unrealEditorCommandletExecutable,
	type OwnedProcessTreeLaunchOptions
} from "@ue-shed/engine";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { expect } from "vitest";
import { NiagaraPreview, NiagaraPreviewError, NiagaraPreviewLive, publishRun } from "./preview.js";
import {
	NiagaraPreviewArtifact,
	NiagaraPreviewProducerReceipt,
	NiagaraPreviewProducerRequest
} from "./schema.js";

const runId = "11111111-1111-4111-8111-111111111111";
const systemObjectPath = "/Game/Fixture/Niagara/NS_Preview.NS_Preview";

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(data.byteLength + 12);
	chunk.writeUInt32BE(data.byteLength, 0);
	typeBytes.copy(chunk, 4);
	Buffer.from(data).copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
	return chunk;
}

function pngImage(width: number, height: number): Uint8Array {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.alloc(height * (width * 4 + 1));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0))
	]);
}

function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function requestPath(options: OwnedProcessTreeLaunchOptions): string {
	const argument = options.args.find((candidate) => candidate.startsWith("-Request="));
	if (argument === undefined) throw new Error("missing request argument");
	return argument.slice("-Request=".length);
}

function producerReceipt(
	request: NiagaraPreviewProducerRequest,
	effectiveOverrides: Partial<NiagaraPreviewProducerReceipt["effectiveSettings"]> = {}
) {
	const requested = request.settings;
	const effectiveBase = {
		captureMode: requested.captureMode ?? ("component_only" as const),
		durationSeconds: Math.fround(requested.durationSeconds ?? 1),
		frameCount: requested.frameCount ?? 2,
		height: requested.height ?? 64,
		simulationFramesPerSecond: requested.simulationFramesPerSecond ?? 60,
		startSeconds: Math.fround(requested.startSeconds ?? 0),
		width: requested.width ?? 64
	};
	const effectiveSettings = {
		...effectiveBase,
		frameIntervalSeconds: effectiveBase.durationSeconds / effectiveBase.frameCount,
		playbackFramesPerSecond: effectiveBase.frameCount / effectiveBase.durationSeconds,
		...effectiveOverrides
	};
	return {
		alphaPolicy: "scene_opacity_or_emissive_coverage_v1",
		camera: {
			aspectRatio: 1,
			fieldOfViewDegrees: 90,
			location: { x: 0, y: -200, z: 0 },
			orthoWidth: 512,
			projection: "perspective",
			rotation: { pitch: 0, roll: 0, yaw: 0 },
			usesCustomAspectRatio: false
		},
		colorSpace: "srgb",
		contract: {
			name: "ue-shed-niagara-preview-receipt",
			version: { major: 1, minor: 0 }
		},
		effectiveSettings,
		engineVersion: "5.7.2-test",
		frames: [
			{
				index: 0,
				maximumRgb: 1,
				nonTransparentPixelFraction: 0.1,
				relativePath: "frames/frame_0000.png",
				timeSeconds: effectiveSettings.startSeconds
			},
			{
				index: 1,
				maximumRgb: 0.5,
				nonTransparentPixelFraction: 0.2,
				relativePath: "frames/frame_0001.png",
				timeSeconds: effectiveSettings.startSeconds + effectiveSettings.frameIntervalSeconds
			}
		],
		generatedAtUtc: "2026-08-20T00:00:00.000Z",
		requestedSettings: request.settings,
		runId: request.runId,
		status: "complete",
		systemObjectPath: request.systemObjectPath
	};
}

it.effect("publishes a run with high-range binary32 timing through a supervised commandlet", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-test-"))),
			(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
		);
		const engineRoot = join(root, "engine");
		const projectDescriptor = join(root, "project", "Fixture.uproject");
		const executable = unrealEditorCommandletExecutable(engineRoot);
		yield* Effect.promise(() => mkdir(dirname(executable), { recursive: true }));
		yield* Effect.promise(() => mkdir(dirname(projectDescriptor), { recursive: true }));
		yield* Effect.promise(() => writeFile(executable, ""));
		yield* Effect.promise(() => writeFile(projectDescriptor, "{}"));
		const launches = yield* Ref.make<readonly OwnedProcessTreeLaunchOptions[]>([]);
		const dependencies = Layer.merge(
			makeEngineInstallationDiscoveryTestLayer(() =>
				Effect.succeed({ root: engineRoot, version: { major: 5, minor: 7, patch: 2 } })
			),
			makeOwnedProcessTreeTestLayer((options) =>
				Effect.gen(function* () {
					yield* Ref.update(launches, (current) => [...current, options]);
					const unknown: unknown = JSON.parse(
						yield* Effect.promise(() => readFile(requestPath(options), "utf8"))
					);
					const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(
						unknown
					);
					const staging = join(
						dirname(projectDescriptor),
						"Saved",
						"UEShed",
						"NiagaraPreviewStaging",
						request.runId
					);
					yield* Effect.promise(() =>
						mkdir(join(staging, "frames"), { recursive: true })
					);
					yield* Effect.promise(() =>
						Promise.all([
							writeFile(join(staging, "frames", "frame_0000.png"), pngImage(64, 64)),
							writeFile(join(staging, "frames", "frame_0001.png"), pngImage(64, 64)),
							writeFile(
								join(staging, "producer-receipt.json"),
								JSON.stringify(producerReceipt(request))
							)
						])
					);
					return {
						awaitExit: Effect.succeed({
							exitCode: 0,
							kind: "exited" as const,
							signal: null
						}),
						pid: 42,
						terminate: () =>
							Effect.succeed({ exitCode: 0, kind: "exited" as const, signal: null })
					};
				})
			)
		);
		const outputRoot = join(root, "published");
		const outcome = yield* Effect.flatMap(NiagaraPreview, (preview) =>
			preview.run({
				explicitEngineRoot: engineRoot,
				outputRoot,
				projectDescriptor,
				runId,
				settings: {
					captureMode: "component_only",
					durationSeconds: 1,
					frameCount: 2,
					height: 64,
					simulationFramesPerSecond: 60,
					startSeconds: 3000.00012,
					width: 64
				},
				systemObjectPath
			})
		).pipe(Effect.provide(NiagaraPreviewLive), Effect.provide(dependencies));
		expect(outcome.manifest.artifacts).toHaveLength(2);
		expect(outcome.manifest.effectiveSettings.startSeconds).toBe(Math.fround(3000.00012));
		expect(outcome.manifest.artifacts[0]?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(
			JSON.parse(yield* Effect.promise(() => readFile(outcome.manifestPath, "utf8")))
		).toMatchObject({ runId, status: "complete" });
		expect(yield* Effect.promise(() => stat(dirname(outcome.manifestPath)))).toBeDefined();
		expect(yield* Ref.get(launches)).toHaveLength(1);
	}).pipe(Effect.scoped)
);

it.effect("rejects a truncated PNG before publishing the run", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-png-test-"))),
			(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
		);
		const engineRoot = join(root, "engine");
		const projectDescriptor = join(root, "project", "Fixture.uproject");
		const executable = unrealEditorCommandletExecutable(engineRoot);
		yield* Effect.promise(() => mkdir(dirname(executable), { recursive: true }));
		yield* Effect.promise(() => mkdir(dirname(projectDescriptor), { recursive: true }));
		yield* Effect.promise(() => writeFile(executable, ""));
		yield* Effect.promise(() => writeFile(projectDescriptor, "{}"));
		const dependencies = Layer.merge(
			makeEngineInstallationDiscoveryTestLayer(() =>
				Effect.succeed({ root: engineRoot, version: { major: 5, minor: 7, patch: 2 } })
			),
			makeOwnedProcessTreeTestLayer((options) =>
				Effect.gen(function* () {
					const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(
						JSON.parse(
							yield* Effect.promise(() => readFile(requestPath(options), "utf8"))
						)
					);
					const staging = join(
						dirname(projectDescriptor),
						"Saved",
						"UEShed",
						"NiagaraPreviewStaging",
						request.runId
					);
					yield* Effect.promise(() =>
						mkdir(join(staging, "frames"), { recursive: true })
					);
					yield* Effect.promise(() =>
						Promise.all([
							writeFile(join(staging, "frames", "frame_0000.png"), pngHeader(64, 64)),
							writeFile(join(staging, "frames", "frame_0001.png"), pngImage(64, 64)),
							writeFile(
								join(staging, "producer-receipt.json"),
								JSON.stringify(producerReceipt(request))
							)
						])
					);
					return {
						awaitExit: Effect.succeed({
							exitCode: 0,
							kind: "exited" as const,
							signal: null
						}),
						pid: 43,
						terminate: () =>
							Effect.succeed({ exitCode: 0, kind: "exited" as const, signal: null })
					};
				})
			)
		);
		const error = yield* Effect.flip(
			Effect.flatMap(NiagaraPreview, (preview) =>
				preview.run({
					explicitEngineRoot: engineRoot,
					projectDescriptor,
					runId,
					settings: {
						captureMode: "component_only",
						durationSeconds: 1,
						frameCount: 2,
						height: 64,
						simulationFramesPerSecond: 60,
						startSeconds: 0,
						width: 64
					},
					systemObjectPath
				})
			).pipe(Effect.provide(NiagaraPreviewLive), Effect.provide(dependencies))
		);
		expect(error.code).toBe("artifact_invalid");
		expect(error.message).toContain("valid PNG");
	}).pipe(Effect.scoped)
);

it.effect("rejects a producer that ignores a requested override", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-override-test-"))),
			(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
		);
		const engineRoot = join(root, "engine");
		const projectDescriptor = join(root, "project", "Fixture.uproject");
		const executable = unrealEditorCommandletExecutable(engineRoot);
		yield* Effect.promise(() => mkdir(dirname(executable), { recursive: true }));
		yield* Effect.promise(() => mkdir(dirname(projectDescriptor), { recursive: true }));
		yield* Effect.promise(() => writeFile(executable, ""));
		yield* Effect.promise(() => writeFile(projectDescriptor, "{}"));
		const dependencies = Layer.merge(
			makeEngineInstallationDiscoveryTestLayer(() =>
				Effect.succeed({ root: engineRoot, version: { major: 5, minor: 7, patch: 2 } })
			),
			makeOwnedProcessTreeTestLayer((options) =>
				Effect.gen(function* () {
					const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(
						JSON.parse(
							yield* Effect.promise(() => readFile(requestPath(options), "utf8"))
						)
					);
					const staging = join(
						dirname(projectDescriptor),
						"Saved",
						"UEShed",
						"NiagaraPreviewStaging",
						request.runId
					);
					yield* Effect.promise(() => mkdir(staging, { recursive: true }));
					yield* Effect.promise(() =>
						writeFile(
							join(staging, "producer-receipt.json"),
							JSON.stringify(producerReceipt(request, { width: 32 }))
						)
					);
					return {
						awaitExit: Effect.succeed({
							exitCode: 0,
							kind: "exited" as const,
							signal: null
						}),
						pid: 44,
						terminate: () =>
							Effect.succeed({ exitCode: 0, kind: "exited" as const, signal: null })
					};
				})
			)
		);
		const error = yield* Effect.flip(
			Effect.flatMap(NiagaraPreview, (preview) =>
				preview.run({
					explicitEngineRoot: engineRoot,
					projectDescriptor,
					runId,
					settings: { width: 64 },
					systemObjectPath
				})
			).pipe(Effect.provide(NiagaraPreviewLive), Effect.provide(dependencies))
		);
		expect(error.code).toBe("receipt_invalid");
		expect(error.message).toContain("ignored");
	}).pipe(Effect.scoped)
);

it.effect("preserves stable commandlet failure identities", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-exit-test-"))),
			(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
		);
		const engineRoot = join(root, "engine");
		const projectDescriptor = join(root, "project", "Fixture.uproject");
		const executable = unrealEditorCommandletExecutable(engineRoot);
		yield* Effect.promise(() => mkdir(dirname(executable), { recursive: true }));
		yield* Effect.promise(() => mkdir(dirname(projectDescriptor), { recursive: true }));
		yield* Effect.promise(() => writeFile(executable, ""));
		yield* Effect.promise(() => writeFile(projectDescriptor, "{}"));
		const cases = [
			[10, "invalid_request"],
			[20, "rendering_unavailable"],
			[21, "system_unavailable"],
			[22, "baker_camera_missing"],
			[23, "compilation_failed"],
			[24, "capture_failed"]
		] as const;
		yield* Effect.forEach(cases, ([exitCode, expectedCode]) => {
			const dependencies = Layer.merge(
				makeEngineInstallationDiscoveryTestLayer(() =>
					Effect.succeed({ root: engineRoot, version: { major: 5, minor: 7, patch: 2 } })
				),
				makeOwnedProcessTreeTestLayer(() =>
					Effect.succeed({
						awaitExit: Effect.succeed({
							exitCode,
							kind: "exited" as const,
							signal: null
						}),
						pid: 45,
						terminate: () =>
							Effect.succeed({ exitCode, kind: "exited" as const, signal: null })
					})
				)
			);
			return Effect.flip(
				Effect.flatMap(NiagaraPreview, (preview) =>
					preview.run({
						explicitEngineRoot: engineRoot,
						projectDescriptor,
						runId,
						systemObjectPath
					})
				).pipe(Effect.provide(NiagaraPreviewLive), Effect.provide(dependencies))
			).pipe(Effect.tap((error) => Effect.sync(() => expect(error.code).toBe(expectedCode))));
		});
	}).pipe(Effect.scoped)
);

it.effect("returns completion when staging cleanup fails after publication commits", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-commit-test-"))),
			(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
		);
		const stagingRoot = join(root, "staging");
		yield* Effect.promise(() => mkdir(join(stagingRoot, "frames"), { recursive: true }));
		const image = pngImage(64, 64);
		yield* Effect.promise(() =>
			Promise.all([
				writeFile(join(stagingRoot, "frames", "frame_0000.png"), image),
				writeFile(join(stagingRoot, "frames", "frame_0001.png"), image)
			])
		);
		const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)({
			contract: {
				name: "ue-shed-niagara-preview-request",
				version: { major: 1, minor: 0 }
			},
			runId,
			settings: {
				captureMode: "component_only",
				durationSeconds: 1,
				frameCount: 2,
				height: 64,
				simulationFramesPerSecond: 60,
				startSeconds: 0,
				width: 64
			},
			systemObjectPath
		});
		const receipt = Schema.decodeUnknownSync(NiagaraPreviewProducerReceipt)(
			producerReceipt(request)
		);
		const artifacts = Schema.decodeUnknownSync(Schema.Array(NiagaraPreviewArtifact))(
			receipt.frames.map((frame) => ({
				bytes: image.byteLength,
				height: 64,
				index: frame.index,
				maximumRgb: frame.maximumRgb,
				mimeType: "image/png",
				nonTransparentPixelFraction: frame.nonTransparentPixelFraction,
				relativePath: frame.relativePath,
				sha256: `sha256:${"0".repeat(64)}`,
				timeSeconds: frame.timeSeconds,
				width: 64
			}))
		);
		const outcome = yield* publishRun({
			artifacts,
			cleanupStaging: () => Effect.fail(new Error("staging directory is locked")),
			generatedAtUtc: "2026-08-20T00:00:00.000Z",
			outputRoot: join(root, "published"),
			receipt,
			stagingRoot
		});
		expect(outcome.manifest.status).toBe("complete");
		expect(yield* Effect.promise(() => stat(outcome.manifestPath))).toBeDefined();
		expect(yield* Effect.promise(() => stat(stagingRoot))).toBeDefined();
	}).pipe(Effect.scoped)
);

it.effect("rejects an over-budget request before launching Unreal", () =>
	Effect.gen(function* () {
		const dependencies = Layer.merge(
			makeEngineInstallationDiscoveryTestLayer(() =>
				Effect.die("engine discovery must not run")
			),
			makeOwnedProcessTreeTestLayer(() => Effect.die("process launch must not run"))
		);
		const error = yield* Effect.flip(
			Effect.flatMap(NiagaraPreview, (preview) =>
				preview.run({
					projectDescriptor: "Fixture.uproject",
					runId,
					settings: { frameCount: 512, height: 4096, width: 4096 },
					systemObjectPath
				})
			).pipe(Effect.provide(NiagaraPreviewLive), Effect.provide(dependencies))
		);
		expect(error).toBeInstanceOf(NiagaraPreviewError);
		expect(error.code).toBe("invalid_request");
	})
);
