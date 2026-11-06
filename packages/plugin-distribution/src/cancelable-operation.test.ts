import { Effect, Fiber, Result } from "effect";
import { expect, it } from "vitest";
import { awaitCancelableOperation } from "./archive.js";

interface ForeignOperationControls {
	started?: (signal: AbortSignal) => void;
	finish?: () => void;
}

it("waits for foreign cleanup after interruption before releasing the caller", async () => {
	const controls: ForeignOperationControls = {};
	const started = new Promise<AbortSignal>((resolve) => {
		controls.started = resolve;
	});
	const settled = new Promise<void>((resolve) => {
		controls.finish = resolve;
	});
	const notifyStarted = controls.started;
	const finish = controls.finish;
	if (!notifyStarted || !finish)
		throw new Error("The Promise executors did not install their resolvers.");
	const fiber = Effect.runFork(
		awaitCancelableOperation(
			(signal) => {
				notifyStarted(signal);
				return settled;
			},
			() => ({ _tag: "FixtureFailure" as const })
		)
	);
	const signal = await started;
	const aborted = new Promise<void>((resolve) =>
		signal.addEventListener("abort", () => resolve(), { once: true })
	);
	let interrupted = false;
	const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
		interrupted = true;
	});
	await aborted;
	expect(interrupted).toBe(false);
	finish();
	await interruption;
	expect(interrupted).toBe(true);
});

it("retains the mapped failure and its original foreign cause", async () => {
	const original = new Error("The stream could not close.");
	const failure = { _tag: "FixtureFailure", cause: original } as const;
	const result = await Effect.runPromise(
		awaitCancelableOperation(
			() => Promise.reject(original),
			(cause) => {
				expect(cause).toBe(original);
				return failure;
			}
		).pipe(Effect.result)
	);
	expect(Result.isFailure(result)).toBe(true);
	if (Result.isFailure(result)) expect(result.failure).toBe(failure);
});

it("creates a separate cancellation signal for each execution", async () => {
	const signals: AbortSignal[] = [];
	const work = awaitCancelableOperation(
		async (signal) => {
			signals.push(signal);
			return 1;
		},
		() => ({ _tag: "FixtureFailure" as const })
	);
	expect(await Effect.runPromise(work)).toBe(1);
	expect(await Effect.runPromise(work)).toBe(1);
	expect(signals).toHaveLength(2);
	expect(signals[0]).not.toBe(signals[1]);
});
