import { setImmediate } from "node:timers";
import { Effect, Scheduler } from "effect";
/** Runs `callback` after the timers and I/O of the next event-loop turn. */
const nextTurn = (callback) => {
    setImmediate(callback);
};
/**
 * Yields whenever the host's event loop has gone `budgetMs` without a turn. Effect's default
 * scheduler counts operations per run, and every promise resume starts a new run, so a build whose
 * promises settle from memory never reaches a macrotask and the host stops answering HTTP and IPC.
 */
export class HostSliceScheduler {
    executionMode = "async";
    base = new Scheduler.MixedScheduler();
    turnPending = false;
    sliceStarted = 0;
    budgetMs;
    constructor(budgetMs = 16) {
        this.budgetMs = budgetMs;
    }
    shouldYield(fiber) {
        if (this.base.shouldYield(fiber))
            return true;
        const now = performance.now();
        if (!this.turnPending) {
            // The callback runs after the timers and I/O of the next event-loop turn.
            this.turnPending = true;
            this.sliceStarted = now;
            nextTurn(() => {
                this.turnPending = false;
            });
            return false;
        }
        return now - this.sliceStarted >= this.budgetMs;
    }
    makeDispatcher() {
        return this.base.makeDispatcher();
    }
}
const hostSliceScheduler = new HostSliceScheduler();
/** Runs `effect`, and every fiber it forks, on the shared `HostSliceScheduler`. */
export const withHostSlices = (effect) => Effect.provideService(effect, Scheduler.Scheduler, hostSliceScheduler);
/**
 * Counts cheap units of synchronous work and reports when the current slice is spent, so a long
 * loop inside one step can `yield* Effect.yieldNow`. It reads the clock only every `stride` steps.
 */
export class HostSliceClock {
    started = performance.now();
    steps = 0;
    budgetMs;
    stride;
    constructor(budgetMs = 16, stride = 1024) {
        this.budgetMs = budgetMs;
        this.stride = stride;
    }
    /** Counts one cheap unit of work and reports whether the current slice is spent. */
    step() {
        if (++this.steps < this.stride)
            return false;
        return this.expired();
    }
    /** Reports whether the current slice is spent, after one expensive unit of work. */
    expired() {
        this.steps = 0;
        const now = performance.now();
        if (now - this.started < this.budgetMs)
            return false;
        this.started = now;
        return true;
    }
}
/** Runs host steps in the Effect scheduler, letting the event loop run between slices. */
export const runHostSteps = Effect.fnUntraced(function* (steps) {
    for (;;) {
        const next = steps.next();
        if (next.done)
            return next.value;
        yield* Effect.yieldNow;
    }
});
/** Runs host steps like `runHostSteps`, mapping a throw from any step to a typed failure. */
export const tryHostSteps = Effect.fnUntraced(function* (steps, onThrow) {
    const running = yield* Effect.try({ try: steps, catch: onThrow });
    for (;;) {
        const next = yield* Effect.try({ try: () => running.next(), catch: onThrow });
        if (next.done)
            return next.value;
        yield* Effect.yieldNow;
    }
});
/** Runs host steps to completion on the current call stack, for synchronous callers. */
export function runHostStepsSync(steps) {
    for (;;) {
        const next = steps.next();
        if (next.done)
            return next.value;
    }
}
/** Ascending distinct IDs of `columns`, marked in one byte per ID up to the largest ID. */
export function* uniqueIdsSteps(columns, clock) {
    let maximum = -1;
    for (const values of columns)
        for (let row = 0; row < values.length; row++) {
            if (values[row] > maximum)
                maximum = values[row];
            if (clock.step())
                yield;
        }
    const seen = new Uint8Array(maximum + 1);
    let count = 0;
    for (const values of columns)
        for (let row = 0; row < values.length; row++) {
            if (!seen[values[row]]) {
                seen[values[row]] = 1;
                count++;
            }
            if (clock.step())
                yield;
        }
    const ids = new Uint32Array(count);
    let next = 0;
    for (let id = 0; id < seen.length; id++) {
        if (seen[id])
            ids[next++] = id;
        if (clock.step())
            yield;
    }
    return ids;
}
/** Stable sort of row indices that yields between bounded chunk sorts and merge slices.
 * The result equals a stable `values.sort(compare)` for any consistent comparator.
 */
export const sortRowsInSlices = (values, compare, clock = new HostSliceClock(), chunk = 4096) => runHostSteps(sortRowsSteps(values, compare, clock, chunk));
/** Host steps for `sortRowsInSlices`, for callers that are themselves host steps. */
export function* sortRowsSteps(values, compare, clock = new HostSliceClock(), chunk = 4096) {
    const count = values.length;
    for (let start = 0; start < count; start += chunk) {
        values.subarray(start, Math.min(count, start + chunk)).sort(compare);
        if (clock.expired())
            yield;
    }
    if (count <= chunk)
        return values;
    let source = values, target = new Uint32Array(count);
    for (let width = chunk; width < count; width *= 2) {
        for (let left = 0; left < count; left += width * 2) {
            const middle = Math.min(count, left + width), right = Math.min(count, left + width * 2);
            let a = left, b = middle, out = left;
            while (a < middle && b < right) {
                // Ties take the left run, which keeps the merge stable.
                target[out++] = compare(source[b], source[a]) < 0 ? source[b++] : source[a++];
                if (clock.step())
                    yield;
            }
            target.set(source.subarray(a, middle), out);
            target.set(source.subarray(b, right), out + middle - a);
        }
        [source, target] = [target, source];
    }
    if (source !== values)
        values.set(source);
    return values;
}
