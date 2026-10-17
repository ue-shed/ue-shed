import { performance } from "node:perf_hooks";

/**
 * Tracks callback gaps, including a synchronous operation that ends before its first timer fires.
 * The owner must stop the probe in finally; stopping records the unfinished gap and clears its timer.
 */
export function trackBenchmarkEventLoop(resolutionMs = 10) {
	const gaps: number[] = [];
	let previous = performance.now();
	let maximum = 0;
	let result: { maximumDelayMs: number; p99DelayMs: number } | undefined;
	const sample = () => {
		const now = performance.now();
		const gap = now - previous;
		previous = now;
		gaps.push(gap);
		maximum = Math.max(maximum, gap);
	};
	const timer = setInterval(sample, resolutionMs);
	return {
		stop: () => {
			if (result) return result;
			sample();
			clearInterval(timer);
			gaps.sort((left, right) => left - right);
			result = {
				maximumDelayMs: maximum,
				p99DelayMs: gaps[Math.max(0, Math.ceil(gaps.length * 0.99) - 1)]!
			};
			return result;
		}
	};
}
