import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { trackBenchmarkEventLoop } from "./benchmark-event-loop.ts";

/** Measures work in the caller's fiber and stops the event-loop probe on every exit. */
export const timeBenchmarkEffect = Effect.fn("Benchmark.timeEffect")(function* <A, E, R>(
	work: Effect.Effect<A, E, R>,
	profile = false
) {
	const started = performance.now();
	const loopStart = performance.eventLoopUtilization();
	const profileStarted = profile ? Number(process.hrtime.bigint() / 1000n) : 0;
	return yield* Effect.acquireUseRelease(
		Effect.sync(() => trackBenchmarkEventLoop()),
		(probe) =>
			work.pipe(
				Effect.map((value) => {
					const finished = performance.now();
					const profileFinished = profile ? Number(process.hrtime.bigint() / 1000n) : 0;
					const utilization = performance.eventLoopUtilization(loopStart).utilization;
					return {
						value,
						seconds: (finished - started) / 1000,
						eventLoop: { ...probe.stop(), utilization },
						...(profile
							? {
									profileWindowMicros: {
										start: profileStarted,
										end: profileFinished
									}
								}
							: undefined)
					};
				})
			),
		// stop is idempotent; failure and interruption also release the probe's timer.
		(probe) =>
			Effect.sync(() => {
				probe.stop();
			})
	);
});

/** Measures Promise-owned work without starting an Effect runtime for its operations. */
export async function timeBenchmarkPromise<A>(run: () => Promise<A>, profile = false) {
	const started = performance.now();
	const loopStart = performance.eventLoopUtilization();
	const profileStarted = profile ? Number(process.hrtime.bigint() / 1000n) : 0;
	const probe = trackBenchmarkEventLoop();
	try {
		const value = await run();
		const finished = performance.now();
		const profileFinished = profile ? Number(process.hrtime.bigint() / 1000n) : 0;
		const utilization = performance.eventLoopUtilization(loopStart).utilization;
		return {
			value,
			seconds: (finished - started) / 1000,
			eventLoop: { ...probe.stop(), utilization },
			...(profile
				? { profileWindowMicros: { start: profileStarted, end: profileFinished } }
				: undefined)
		};
	} finally {
		probe.stop();
	}
}
