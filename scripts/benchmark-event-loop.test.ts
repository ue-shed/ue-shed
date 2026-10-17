import assert from "node:assert/strict";
import test from "node:test";
import { trackBenchmarkEventLoop } from "./benchmark-event-loop.ts";

test("a blocking operation is measured even when it prevents every scheduled timer", () => {
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
