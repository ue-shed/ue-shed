import { performance } from "node:perf_hooks";

/**
 * Wall time between marks inside one sequential step, for a stage breakdown on that step's span.
 * Stages are consecutive on one fiber, so they add up to the step's own wall time; they include
 * the event-loop turns the step yields, and never count work done in parallel workers.
 */
export class StageClock {
	private last = performance.now();
	private readonly totals = new Map<string, number>();
	/** Charges the time since the previous mark (or construction) to `stage`. */
	mark(stage: string) {
		const now = performance.now();
		this.add(stage, now - this.last);
		this.last = now;
	}
	/** Charges a separately measured duration to `stage`, without moving the mark. */
	add(stage: string, ms: number) {
		this.totals.set(stage, (this.totals.get(stage) ?? 0) + ms);
	}
	/** Moves the mark without charging the elapsed time to any stage. */
	restart() {
		this.last = performance.now();
	}
	/** Span attributes `<prefix>.<stage>` in milliseconds, in first-mark order. */
	attributes(prefix: string): Record<string, number> {
		return Object.fromEntries(
			[...this.totals].map(([stage, ms]) => [
				`${prefix}.${stage}`,
				Math.round(ms * 1000) / 1000
			])
		);
	}
}
