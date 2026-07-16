import {
	CameraFeed,
	configureCameras,
	getCameraStatus,
	type CameraControlError,
	type CameraFrame
} from "@ue-shed/cameras";
import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { Clock, Context, Effect, HashMap, Layer, Option, Queue, Ref, Stream } from "effect";
import { ElectronApp } from "../adapters/electron-app.js";
import { WorkbenchWindow } from "../adapters/electron-window.js";
import type { RendererCameraFrame, WorkbenchCameraMetrics } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

const minimumPresentationBudgetMbPerSecond = 25;
const maximumPresentationBudgetMbPerSecond = 500;
const defaultPresentationBudgetMbPerSecond = 80;
const minimumCameraIndex = 0;
const maximumCameraIndex = 31;

function clampPresentationBudget(megabytesPerSecond: number): number {
	return Math.min(
		maximumPresentationBudgetMbPerSecond,
		Math.max(minimumPresentationBudgetMbPerSecond, megabytesPerSecond)
	);
}

function isSupportedCameraIndex(cameraIndex: number): boolean {
	return (
		Number.isInteger(cameraIndex) &&
		cameraIndex >= minimumCameraIndex &&
		cameraIndex <= maximumCameraIndex
	);
}

function toRendererCameraFrame(frame: CameraFrame): RendererCameraFrame {
	return {
		cameraId: frame.cameraId,
		cameraIndex: frame.cameraIndex,
		captureMonotonicMs: frame.captureMonotonicMs,
		height: frame.height,
		pixels: frame.pixels,
		producerId: frame.producerId,
		readbackDrops: frame.readbackDrops,
		readbackLatencyMs: frame.readbackLatencyMs,
		receivedMonotonicMs: frame.receivedMonotonicMs,
		sequence: frame.sequence.toString(),
		sessionId: frame.sessionId,
		transportReplacements: frame.transportReplacements,
		width: frame.width,
		worldSeconds: frame.worldSeconds
	};
}

function takeOnePendingFrame(
	pending: Ref.Ref<HashMap.HashMap<number, CameraFrame>>
): Effect.Effect<Option.Option<CameraFrame>> {
	return Ref.modify(pending, (map) => {
		const first = HashMap.entries(map).next();
		if (first.done) return [Option.none(), map];
		const [cameraIndex, frame] = first.value;
		return [Option.some(frame), HashMap.remove(map, cameraIndex)];
	});
}

export interface CameraPresentationShape {
	readonly configure: (
		config: CameraScheduleConfig
	) => Effect.Effect<CameraStatus, CameraControlError>;
	readonly metrics: () => Effect.Effect<WorkbenchCameraMetrics>;
	readonly setPresentationBudget: (megabytesPerSecond: number) => Effect.Effect<number>;
	readonly status: () => Effect.Effect<CameraStatus, CameraControlError>;
}

export class CameraPresentation extends Context.Service<
	CameraPresentation,
	CameraPresentationShape
>()("@ue-shed/workbench/CameraPresentation") {}

export const CameraPresentationLive = Layer.effect(
	CameraPresentation,
	Effect.gen(function* () {
		const feed = yield* CameraFeed;
		const window = yield* WorkbenchWindow;
		const electronApp = yield* ElectronApp;
		const configuration = yield* WorkbenchConfiguration;
		const remoteControl = yield* RemoteControlClient;

		const pending = yield* Ref.make(HashMap.empty<number, CameraFrame>());
		const wake = yield* Queue.sliding<void>(1);
		const budget = yield* Ref.make(defaultPresentationBudgetMbPerSecond);
		const nextPresentationAtMillis = yield* Ref.make(0);
		const framesSent = yield* Ref.make(0);
		const replacements = yield* Ref.make(0);

		yield* Effect.addFinalizer(() =>
			Ref.set(pending, HashMap.empty()).pipe(Effect.andThen(Queue.shutdown(wake)))
		);

		const sendPendingFrame = Effect.fn("Workbench.CameraPresentation.sendPendingFrame")(
			function* (frame: CameraFrame) {
				const now = yield* Clock.currentTimeMillis;
				const deadline = yield* Ref.get(nextPresentationAtMillis);
				const scheduledAt = Math.max(now, deadline);
				const delayMs = scheduledAt - now;
				if (delayMs > 0) yield* Effect.sleep(delayMs);
				yield* window.send("camera:frame", toRendererCameraFrame(frame)).pipe(
					Effect.matchEffect({
						onFailure: () => Effect.void,
						onSuccess: () => Ref.update(framesSent, (count) => count + 1)
					})
				);
				// Read the budget after sending so an in-flight configuration change applies to
				// the outgoing pacing calculation as soon as possible.
				const currentBudget = yield* Ref.get(budget);
				const durationMs = (frame.pixels.byteLength / (currentBudget * 1_000_000)) * 1_000;
				yield* Ref.set(nextPresentationAtMillis, scheduledAt + durationMs);
			}
		);

		const drainPendingFrames: Effect.Effect<void> = Effect.gen(function* () {
			while (true) {
				const next = yield* takeOnePendingFrame(pending);
				if (Option.isNone(next)) return;
				yield* sendPendingFrame(next.value);
			}
		});

		const drainWorker: Effect.Effect<void> = Effect.gen(function* () {
			while (true) {
				yield* Queue.take(wake);
				yield* drainPendingFrames;
			}
		});

		const ingestFrame = Effect.fn("Workbench.CameraPresentation.ingestFrame")(function* (
			frame: CameraFrame
		) {
			if (!isSupportedCameraIndex(frame.cameraIndex)) return;
			const hadExisting = yield* Ref.modify(pending, (map) => [
				HashMap.has(map, frame.cameraIndex),
				HashMap.set(map, frame.cameraIndex, frame)
			]);
			if (hadExisting) yield* Ref.update(replacements, (count) => count + 1);
			yield* Queue.offer(wake, undefined);
		});

		yield* feed.frames.pipe(Stream.runForEach(ingestFrame), Effect.forkScoped);
		yield* drainWorker.pipe(Effect.forkScoped);

		const metrics = Effect.fn("Workbench.CameraPresentation.metrics")(function* () {
			const feedMetrics = yield* feed.metrics;
			const processMetrics = yield* electronApp.getAppMetrics();
			const electronPrivateMemoryMb =
				processMetrics.reduce(
					(sum, metric) =>
						sum + (metric.memory.privateBytes ?? metric.memory.workingSetSize),
					0
				) / 1_024;
			const gpuMemory = processMetrics.find((metric) => metric.type === "GPU")?.memory;
			const gpuProcessPrivateMemoryMb = gpuMemory
				? (gpuMemory.privateBytes ?? gpuMemory.workingSetSize) / 1_024
				: 0;
			return {
				...feedMetrics,
				electronPrivateMemoryMb,
				gpuProcessPrivateMemoryMb,
				presentationBudgetMbPerSecond: yield* Ref.get(budget),
				presentationFramesSent: yield* Ref.get(framesSent),
				presentationReplacements: yield* Ref.get(replacements)
			} satisfies WorkbenchCameraMetrics;
		});

		const setPresentationBudget = Effect.fn(
			"Workbench.CameraPresentation.setPresentationBudget"
		)(function* (megabytesPerSecond: number) {
			const clamped = clampPresentationBudget(megabytesPerSecond);
			yield* Ref.set(budget, clamped);
			return clamped;
		});

		const status = Effect.fn("Workbench.CameraPresentation.status")(() =>
			getCameraStatus(configuration.remoteControlEndpoint).pipe(
				Effect.provideService(RemoteControlClient, remoteControl)
			)
		);

		const configure = Effect.fn("Workbench.CameraPresentation.configure")(
			(config: CameraScheduleConfig) =>
				configureCameras(configuration.remoteControlEndpoint, config).pipe(
					Effect.provideService(RemoteControlClient, remoteControl)
				)
		);

		return CameraPresentation.of({ configure, metrics, setPresentationBudget, status });
	})
);

export function makeCameraPresentationTestLayer(
	service: CameraPresentationShape
): Layer.Layer<CameraPresentation> {
	return Layer.succeed(CameraPresentation, CameraPresentation.of(service));
}
