import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	makeEngineInstallationDiscoveryTestLayer,
	makeOwnedProcessTreeTestLayer,
	unrealEditorCommandletExecutable,
	type OwnedProcessTreeLaunchOptions
} from "@ue-shed/engine";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { expect } from "vitest";
import { NiagaraPreview, NiagaraPreviewError, NiagaraPreviewLive } from "./preview.js";
import { NiagaraPreviewProducerRequest } from "./schema.js";

const runId = "11111111-1111-4111-8111-111111111111";
const systemObjectPath = "/Game/Fixture/Niagara/NS_Preview.NS_Preview";

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

function producerReceipt(request: NiagaraPreviewProducerRequest) {
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
		effectiveSettings: {
			captureMode: "component_only",
			durationSeconds: 1,
			frameCount: 2,
			frameIntervalSeconds: 0.5,
			height: 64,
			playbackFramesPerSecond: 2,
			simulationFramesPerSecond: 60,
			startSeconds: 0,
			width: 64
		},
		engineVersion: "5.7.2-test",
		frames: [
			{
				index: 0,
				maximumRgb: 1,
				nonTransparentPixelFraction: 0.1,
				relativePath: "frames/frame_0000.png",
				timeSeconds: 0
			},
			{
				index: 1,
				maximumRgb: 0.5,
				nonTransparentPixelFraction: 0.2,
				relativePath: "frames/frame_0001.png",
				timeSeconds: 0.5
			}
		],
		generatedAtUtc: "2026-08-20T00:00:00.000Z",
		requestedSettings: request.settings,
		runId: request.runId,
		status: "complete",
		systemObjectPath: request.systemObjectPath
	};
}

it.effect("publishes a validated immutable run through a supervised commandlet", () =>
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
							writeFile(join(staging, "frames", "frame_0000.png"), pngHeader(64, 64)),
							writeFile(join(staging, "frames", "frame_0001.png"), pngHeader(64, 64)),
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
					startSeconds: 0,
					width: 64
				},
				systemObjectPath
			})
		).pipe(Effect.provide(NiagaraPreviewLive), Effect.provide(dependencies));
		expect(outcome.manifest.artifacts).toHaveLength(2);
		expect(outcome.manifest.artifacts[0]?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(
			JSON.parse(yield* Effect.promise(() => readFile(outcome.manifestPath, "utf8")))
		).toMatchObject({ runId, status: "complete" });
		expect(yield* Effect.promise(() => stat(dirname(outcome.manifestPath)))).toBeDefined();
		expect(yield* Ref.get(launches)).toHaveLength(1);
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
