import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { HostSliceClock, sortRowsInSlices, withHostSlices } from "./host-slices.js";

const busy = (ms: number) => {
	const end = performance.now() + ms;
	while (performance.now() < end);
};

/** Mirrors an index build: synchronous batches behind promises that settle without I/O. */
const batches = Effect.gen(function* () {
	for (let batch = 0; batch < 12; batch++) {
		yield* Effect.tryPromise({ try: async () => batch, catch: (cause) => cause });
		busy(10);
	}
});

/** Runs `effect` and returns the longest stretch in which no `setImmediate` callback ran. */
const longestEventLoopGap = async (effect: Effect.Effect<void, unknown>) => {
	let last = performance.now(),
		longest = 0,
		probing = true;
	const probe = () => {
		const now = performance.now();
		longest = Math.max(longest, now - last);
		last = now;
		if (probing) setImmediate(probe);
	};
	setImmediate(probe);
	await Effect.runPromise(effect);
	probing = false;
	longest = Math.max(longest, performance.now() - last);
	return longest;
};

describe("withHostSlices", () => {
	it("lets the event loop run between batches that resume from settled promises", async () => {
		// The default scheduler restarts its operation count at each promise resume: one ~120 ms gap.
		expect(await longestEventLoopGap(batches)).toBeGreaterThan(80);
		expect(await longestEventLoopGap(withHostSlices(batches))).toBeLessThan(50);
	});

	it("keeps the result and failures of the effect", async () => {
		expect(await Effect.runPromise(withHostSlices(Effect.succeed(1)))).toBe(1);
		const failed = await Effect.runPromise(Effect.flip(withHostSlices(Effect.fail("nope"))));
		expect(failed).toBe("nope");
	});
});

it("sorts rows exactly like a stable native sort, including ties", async () => {
	let seed = 7;
	const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
	for (const count of [0, 1, 17, 4096, 4097, 20_000, 70_001]) {
		const keys = Uint32Array.from({ length: count }, () => random() % 997);
		const compare = (left: number, right: number) => keys[left]! - keys[right]!;
		const expected = Uint32Array.from({ length: count }, (_, row) => row).sort(compare);
		// A zero budget yields at every opportunity, exercising every resume point.
		const actual = await Effect.runPromise(
			sortRowsInSlices(
				Uint32Array.from({ length: count }, (_, row) => row),
				compare,
				new HostSliceClock(0, count > 5000 ? 4096 : 1),
				1000
			)
		);
		expect(Array.from(actual)).toEqual(Array.from(expected));
	}
});
