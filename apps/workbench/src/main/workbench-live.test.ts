import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, ManagedRuntime, Ref } from "effect";
import { expect } from "vitest";

/**
 * Proves the `WorkbenchLive` topology's finalization contract using lightweight stand-ins for
 * the window, IPC, CameraFeed, presentation-worker, and fixture-launcher resources instead of
 * real Electron/Unreal dependencies. Each stand-in records `${name}:acquire` /
 * `${name}:release` into a shared journal so every scenario can assert exactly-once
 * acquisition and finalization.
 */

interface Journal {
	readonly entries: () => Effect.Effect<ReadonlyArray<string>>;
	readonly record: (event: string) => Effect.Effect<void>;
}

function makeJournal(): Effect.Effect<Journal> {
	return Effect.map(Ref.make<ReadonlyArray<string>>([]), (log) => ({
		entries: () => Ref.get(log),
		record: (event: string) =>
			Ref.update(log, (entries) => [...entries, event]).pipe(Effect.asVoid)
	}));
}

/** Lets other scheduled fibers make progress without depending on wall-clock time. */
const settle = Effect.gen(function* () {
	for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

function countOf(entries: ReadonlyArray<string>, event: string): number {
	return entries.filter((entry) => entry === event).length;
}

function expectExactlyOnce(entries: ReadonlyArray<string>, ...names: ReadonlyArray<string>) {
	for (const name of names) {
		expect(countOf(entries, `${name}:acquire`)).toBe(1);
		expect(countOf(entries, `${name}:release`)).toBe(1);
	}
}

class TestWindow extends Context.Service<TestWindow, { readonly kind: "window" }>()(
	"Test/TestWindow"
) {}

class TestIpc extends Context.Service<TestIpc, { readonly kind: "ipc" }>()("Test/TestIpc") {}

class TestCameraFeed extends Context.Service<TestCameraFeed, { readonly kind: "camera-feed" }>()(
	"Test/TestCameraFeed"
) {}

class TestPresentation extends Context.Service<
	TestPresentation,
	{ readonly kind: "presentation" }
>()("Test/TestPresentation") {}

interface TestFixtureLauncherShape {
	readonly launchSlow: () => Effect.Effect<void>;
}

class TestFixtureLauncher extends Context.Service<TestFixtureLauncher, TestFixtureLauncherShape>()(
	"Test/TestFixtureLauncher"
) {}

function trackedLayer<Self, Shape>(
	tag: Context.Key<Self, Shape>,
	name: string,
	journal: Journal,
	value: Shape
): Layer.Layer<Self> {
	return Layer.effect(
		tag,
		Effect.gen(function* () {
			yield* journal.record(`${name}:acquire`);
			yield* Effect.addFinalizer(() => journal.record(`${name}:release`));
			return value;
		})
	);
}

/** Mirrors `CameraPresentationLive`'s scoped forever-running presentation worker. */
function testPresentationLayer(
	journal: Journal
): Layer.Layer<TestPresentation, never, TestWindow | TestCameraFeed> {
	return Layer.effect(
		TestPresentation,
		Effect.gen(function* () {
			yield* TestWindow;
			yield* TestCameraFeed;
			yield* journal.record("presentation:acquire");
			yield* Effect.addFinalizer(() => journal.record("presentation:release"));
			yield* Effect.never.pipe(
				Effect.onInterrupt(() => journal.record("presentation-worker:interrupted")),
				Effect.forkScoped
			);
			return TestPresentation.of({ kind: "presentation" });
		})
	);
}

/** Mirrors `FixtureLauncherLive`'s demand-driven, potentially long-running launch. */
function testFixtureLauncherLayer(journal: Journal): Layer.Layer<TestFixtureLauncher> {
	return Layer.effect(
		TestFixtureLauncher,
		Effect.gen(function* () {
			yield* journal.record("fixture-launcher:acquire");
			yield* Effect.addFinalizer(() => journal.record("fixture-launcher:release"));
			const launchSlow = Effect.gen(function* () {
				yield* journal.record("fixture-launch:started");
				yield* Effect.never;
				yield* journal.record("fixture-launch:completed");
			}).pipe(Effect.onInterrupt(() => journal.record("fixture-launch:interrupted")));
			return TestFixtureLauncher.of({ launchSlow: () => launchSlow });
		})
	);
}

function testBaseLayer(journal: Journal) {
	return Layer.mergeAll(
		trackedLayer(TestWindow, "window", journal, TestWindow.of({ kind: "window" })),
		trackedLayer(TestIpc, "ipc", journal, TestIpc.of({ kind: "ipc" })),
		trackedLayer(
			TestCameraFeed,
			"camera-feed",
			journal,
			TestCameraFeed.of({ kind: "camera-feed" })
		)
	);
}

/** The full stand-in graph: base infrastructure, then presentation + fixture launcher. */
function buildTestLive(journal: Journal) {
	return Layer.mergeAll(testPresentationLayer(journal), testFixtureLauncherLayer(journal)).pipe(
		Layer.provideMerge(testBaseLayer(journal))
	);
}

/** A malformed-config stand-in: fails only after the base layer has fully acquired. */
function buildFailingLive(journal: Journal) {
	return Layer.effectDiscard(
		Effect.gen(function* () {
			yield* TestWindow;
			yield* TestIpc;
			yield* TestCameraFeed;
			yield* journal.record("poison:attempt");
			return yield* Effect.fail("malformed configuration");
		})
	).pipe(Layer.provideMerge(testBaseLayer(journal)));
}

it.effect(
	"finalizes window, ipc, camera-feed, presentation, and fixture-launcher exactly once on dispose",
	() =>
		Effect.gen(function* () {
			const journal = yield* makeJournal();
			const runtime = ManagedRuntime.make(buildTestLive(journal));

			const context = yield* runtime.contextEffect;
			const launcher = Context.get(context, TestFixtureLauncher);
			runtime.runFork(launcher.launchSlow());
			yield* settle;

			yield* runtime.disposeEffect;
			yield* runtime.disposeEffect;

			const entries = yield* journal.entries();
			expectExactlyOnce(entries, "window", "ipc", "camera-feed", "presentation");
			expect(countOf(entries, "presentation-worker:interrupted")).toBe(1);
			expect(countOf(entries, "fixture-launch:interrupted")).toBe(1);
			expect(countOf(entries, "fixture-launch:completed")).toBe(0);
		})
);

it.effect("releases already-acquired resources exactly once after a startup failure", () =>
	Effect.gen(function* () {
		const journal = yield* makeJournal();
		const runtime = ManagedRuntime.make(buildFailingLive(journal));

		const exit = yield* Effect.exit(runtime.contextEffect);
		expect(Exit.isFailure(exit)).toBe(true);

		yield* runtime.disposeEffect;
		yield* runtime.disposeEffect;

		const entries = yield* journal.entries();
		expectExactlyOnce(entries, "window", "ipc", "camera-feed");
		expect(countOf(entries, "poison:attempt")).toBe(1);
	})
);

it.effect(
	"interrupting an in-flight fixture launch cleans it up once without duplicating layer finalizers",
	() =>
		Effect.gen(function* () {
			const journal = yield* makeJournal();
			const runtime = ManagedRuntime.make(buildTestLive(journal));

			const context = yield* runtime.contextEffect;
			const launcher = Context.get(context, TestFixtureLauncher);

			const fiber = runtime.runFork(launcher.launchSlow());
			yield* settle;
			yield* Fiber.interrupt(fiber);

			const midFlight = yield* journal.entries();
			expect(countOf(midFlight, "fixture-launch:started")).toBe(1);
			expect(countOf(midFlight, "fixture-launch:completed")).toBe(0);
			expect(countOf(midFlight, "fixture-launch:interrupted")).toBe(1);

			yield* runtime.disposeEffect;
			yield* runtime.disposeEffect;

			const entries = yield* journal.entries();
			expectExactlyOnce(entries, "window", "ipc", "camera-feed", "presentation");
			expect(countOf(entries, "presentation-worker:interrupted")).toBe(1);
			expect(countOf(entries, "fixture-launch:interrupted")).toBe(1);
		})
);
