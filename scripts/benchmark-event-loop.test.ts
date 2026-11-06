import assert from "node:assert/strict";
import test from "node:test";
import { trackBenchmarkEventLoop } from "./benchmark-event-loop.ts";
import { Deferred, Effect, Fiber, Result } from "effect";
import { timeBenchmarkEffect } from "./benchmark-effect-timer.ts";

void test("a blocking operation is measured even when it prevents every scheduled timer", () => {
	const probe = trackBenchmarkEventLoop();
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
	} finally {
		const result = probe.stop();
		assert(result.maximumDelayMs >= 60, JSON.stringify(result));
		assert(result.p99DelayMs >= 60, JSON.stringify(result));
		assert.equal(probe.stop(), result);
	}
});

void test("effect measurement stops its timer when its caller interrupts", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const timers = () =>
				process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
			const before = timers();
			const started = yield* Deferred.make<void>();
			const fiber = yield* timeBenchmarkEffect(
				Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
			).pipe(Effect.forkChild);
			yield* Deferred.await(started);
			assert.equal(timers(), before + 1);
			yield* Fiber.interrupt(fiber);
			assert.equal(timers(), before);
		})
	);
});

void test("effect measurement preserves a failure's identity and releases its probe", async () => {
	const failure = { code: "fixture_refused" } as const;
	const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	const result = await Effect.runPromise(
		timeBenchmarkEffect(Effect.fail(failure)).pipe(Effect.result)
	);
	assert(Result.isFailure(result));
	assert.equal(result.failure, failure);
	assert.equal(
		process.getActiveResourcesInfo().filter((name) => name === "Timeout").length,
		before
	);
});
