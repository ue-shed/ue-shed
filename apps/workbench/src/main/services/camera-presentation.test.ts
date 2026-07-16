import { it } from "@effect/vitest";
import { makeCameraFeedTestLayer, type CameraFrame } from "@ue-shed/cameras";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect, Exit, Layer, Option, Queue, Ref, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeElectronAppTestLayer } from "../adapters/electron-app.js";
import {
	makeWorkbenchWindowTestLayer,
	WorkbenchWindow,
	WorkbenchWindowError
} from "../adapters/electron-window.js";
import type { RendererCameraFrame } from "../ipc-contracts.js";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import {
	CameraPresentation,
	CameraPresentationLive,
	type CameraPresentationShape
} from "./camera-presentation.js";

const configuration = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

const remoteControl = makeRemoteControlClientTestLayer(() => Effect.die("not used"));

function makeFrame(overrides: {
	readonly cameraIndex: number;
	readonly pixels?: Uint8Array;
	readonly sequence?: bigint;
}): CameraFrame {
	return {
		cameraId: "camera",
		cameraIndex: overrides.cameraIndex,
		captureMonotonicMs: 0,
		height: 1,
		pixels: overrides.pixels ?? new Uint8Array(0),
		producerId: "producer",
		readbackDrops: 0,
		readbackLatencyMs: 0,
		receivedMonotonicMs: 0,
		sequence: overrides.sequence ?? 1n,
		sessionId: "session",
		transportReplacements: 0,
		width: 1,
		worldSeconds: 0
	};
}

/** Yields the fiber scheduler repeatedly so independent fibers can make progress. */
const settle = Effect.gen(function* () {
	for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

/**
 * A `WorkbenchWindow` test double whose `send` blocks until the test explicitly
 * releases it. This is the deterministic synchronization boundary used to prove
 * latest-frame-wins replacement, bounded slow-window delivery, and pacing without
 * racing the ingestion and drain workers against real or virtual time.
 */
const makeGatedRecordingWindow = () =>
	Effect.gen(function* () {
		const destroyed = yield* Ref.make(false);
		const sentFrames = yield* Ref.make<ReadonlyArray<RendererCameraFrame>>([]);
		const started = yield* Queue.unbounded<void>();
		const release = yield* Queue.unbounded<void>();

		const send = Effect.fn("Test.GatedRecordingWindow.send")(function* (
			_channel: string,
			payload: unknown
		) {
			yield* Queue.offer(started, undefined);
			if (yield* Ref.get(destroyed)) {
				return yield* Effect.fail(
					new WorkbenchWindowError({
						causeText: "Window is destroyed",
						message: "Workbench window send failed.",
						operation: "send",
						recovery: "Ignore late renderer deliveries after shutdown.",
						retrySafe: false
					})
				);
			}
			yield* Queue.take(release);
			yield* Ref.update(sentFrames, (frames) => [...frames, payload as RendererCameraFrame]);
		});

		const destroy = Effect.fn("Test.GatedRecordingWindow.destroy")(() =>
			Ref.set(destroyed, true)
		);
		const isDestroyed = Effect.fn("Test.GatedRecordingWindow.isDestroyed")(() =>
			Ref.get(destroyed)
		);

		return {
			awaitStarted: () => Queue.take(started),
			destroyWindow: destroy,
			layer: makeWorkbenchWindowTestLayer({ destroy, isDestroyed, send }),
			pollStarted: () => Queue.poll(started),
			releaseNext: () => Queue.offer(release, undefined).pipe(Effect.asVoid),
			sentFrames: () => Ref.get(sentFrames)
		};
	});

type GatedRecordingWindow = Effect.Success<ReturnType<typeof makeGatedRecordingWindow>>;

function buildLayer(
	feedQueue: Queue.Queue<CameraFrame>,
	windowLayer: Layer.Layer<WorkbenchWindow>
) {
	return CameraPresentationLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				makeCameraFeedTestLayer({ frames: Stream.fromQueue(feedQueue) }),
				windowLayer,
				makeElectronAppTestLayer(),
				configuration,
				remoteControl
			)
		)
	);
}

function runWithPresentation<A, E>(
	feedQueue: Queue.Queue<CameraFrame>,
	recordingWindow: GatedRecordingWindow,
	body: (presentation: CameraPresentationShape) => Effect.Effect<A, E, CameraPresentation>
) {
	return Effect.provide(
		Effect.gen(function* () {
			const presentation = yield* CameraPresentation;
			return yield* body(presentation);
		}),
		buildLayer(feedQueue, recordingWindow.layer)
	);
}

it.effect("sends the latest frame and reports frames-sent metrics", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 3, sequence: 7n }));
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({ cameraIndex: 3, sequence: "7" });

				const metrics = yield* presentation.metrics();
				expect(metrics.presentationFramesSent).toBe(1);
				expect(metrics.presentationReplacements).toBe(0);
				expect(metrics.presentationBudgetMbPerSecond).toBe(80);
				expect(metrics.electronPrivateMemoryMb).toBeGreaterThan(0);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("keeps only the latest pending frame per camera and counts replacements", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 1n }));
				yield* recordingWindow.awaitStarted();

				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 2n }));
				yield* settle;
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 3n }));
				yield* settle;

				yield* recordingWindow.releaseNext();
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent.map((frame) => frame.sequence)).toEqual(["1", "3"]);

				const metrics = yield* presentation.metrics();
				expect(metrics.presentationReplacements).toBe(1);
				expect(metrics.presentationFramesSent).toBe(2);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("makes progress across camera indices without starving either", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 1n }));
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 1, sequence: 1n }));
				yield* settle;

				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent.map((frame) => frame.cameraIndex).toSorted()).toEqual([0, 1]);

				const metrics = yield* presentation.metrics();
				expect(metrics.presentationFramesSent).toBe(2);
				expect(metrics.presentationReplacements).toBe(0);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("rejects camera indices outside the supported 0-31 range", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 32, sequence: 1n }));
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: -1, sequence: 2n }));
				yield* settle;
				expect(yield* recordingWindow.pollStarted()).toEqual(Option.none());

				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 3n }));
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({ cameraIndex: 0, sequence: "3" });

				const metrics = yield* presentation.metrics();
				expect(metrics.presentationReplacements).toBe(0);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("remains bounded when the window is slow to accept frames", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 1n }));
				yield* recordingWindow.awaitStarted();

				for (const sequence of [2n, 3n, 4n, 5n]) {
					yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence }));
					yield* settle;
				}

				yield* recordingWindow.releaseNext();
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent.map((frame) => frame.sequence)).toEqual(["1", "5"]);

				const metrics = yield* presentation.metrics();
				expect(metrics.presentationReplacements).toBe(3);
				expect(metrics.presentationFramesSent).toBe(2);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("paces aggregate delivery by the configured byte budget", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();
		const pixels = new Uint8Array(8_000_000);

		yield* runWithPresentation(feedQueue, recordingWindow, () =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, pixels, sequence: 1n }));
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();

				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 1, pixels, sequence: 2n }));
				yield* settle;

				expect(yield* recordingWindow.pollStarted()).toEqual(Option.none());

				yield* TestClock.adjust(60);
				yield* settle;
				expect(yield* recordingWindow.pollStarted()).toEqual(Option.none());

				yield* TestClock.adjust(40);
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent.map((frame) => frame.sequence)).toEqual(["1", "2"]);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("applies a changed presentation budget to subsequent frames", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();
		const pixels = new Uint8Array(8_000_000);

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, pixels, sequence: 1n }));
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();

				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 1, pixels, sequence: 2n }));
				yield* settle;

				const clamped = yield* presentation.setPresentationBudget(500);
				expect(clamped).toBe(500);

				yield* TestClock.adjust(100);
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();

				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 2, pixels, sequence: 3n }));
				yield* settle;

				expect(yield* recordingWindow.pollStarted()).toEqual(Option.none());
				yield* TestClock.adjust(15);
				yield* settle;
				expect(yield* recordingWindow.pollStarted()).toEqual(Option.none());

				yield* TestClock.adjust(1);
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent.map((frame) => frame.sequence)).toEqual(["1", "2", "3"]);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("stops delivering frames once the window is destroyed", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();

		yield* runWithPresentation(feedQueue, recordingWindow, (presentation) =>
			Effect.gen(function* () {
				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 1n }));
				yield* recordingWindow.awaitStarted();
				yield* recordingWindow.releaseNext();
				yield* settle;

				yield* recordingWindow.destroyWindow();

				yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 2n }));
				yield* recordingWindow.awaitStarted();
				yield* settle;

				const sent = yield* recordingWindow.sentFrames();
				expect(sent).toHaveLength(1);

				const metrics = yield* presentation.metrics();
				expect(metrics.presentationFramesSent).toBe(1);
			})
		);
	}).pipe(Effect.scoped)
);

it.effect("interrupts both workers and never sends after the scope closes", () =>
	Effect.gen(function* () {
		const feedQueue = yield* Queue.unbounded<CameraFrame>();
		const recordingWindow = yield* makeGatedRecordingWindow();
		const layer = buildLayer(feedQueue, recordingWindow.layer);

		const scope = yield* Scope.make();
		yield* Layer.buildWithScope(layer, scope);

		yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 1n }));
		yield* recordingWindow.awaitStarted();
		yield* recordingWindow.releaseNext();
		yield* settle;

		yield* Scope.close(scope, Exit.succeed(undefined));

		yield* Queue.offer(feedQueue, makeFrame({ cameraIndex: 0, sequence: 2n }));
		yield* settle;

		expect(yield* recordingWindow.pollStarted()).toEqual(Option.none());
		expect(yield* recordingWindow.sentFrames()).toHaveLength(1);
	})
);
