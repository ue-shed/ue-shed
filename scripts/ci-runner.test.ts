import assert from "node:assert/strict";
import test from "node:test";
import {
	boatRunner,
	githubRunner,
	remainingStarts,
	selectRunner,
	startHeadroom
} from "./ci-runner.ts";

const limits = (day: number, hour: number) => ({
	ok: true,
	canStart: true,
	starts: {
		unlimited: false,
		minute: { limit: 12, used: 0, remaining: 12 },
		hour: { limit: 60, used: 60 - hour, remaining: hour },
		day: { limit: 200, used: 200 - day, remaining: day }
	}
});

test("boat runs the lanes only when the run's starts fit with headroom in both windows", () => {
	const enough = 3 + startHeadroom;
	assert.equal(selectRunner(3, { unlimited: false, day: enough, hour: enough }), boatRunner);
	assert.equal(selectRunner(3, { unlimited: false, day: enough - 1, hour: 60 }), githubRunner);
	assert.equal(selectRunner(3, { unlimited: false, day: 200, hour: enough - 1 }), githubRunner);
	assert.equal(
		selectRunner(1, { unlimited: false, day: 1 + startHeadroom, hour: 60 }),
		boatRunner
	);
	assert.equal(selectRunner(3, { unlimited: true, day: 0, hour: 0 }), boatRunner);
});

test("no answer from boat falls back to GitHub-hosted runners", () => {
	assert.equal(selectRunner(1, undefined), githubRunner);
	assert.equal(selectRunner(1, remainingStarts(null)), githubRunner);
	assert.equal(selectRunner(1, remainingStarts({ ok: true })), githubRunner);
	assert.equal(selectRunner(1, remainingStarts({ starts: { day: {}, hour: {} } })), githubRunner);
});

test("remaining starts are read from boat's limits response", () => {
	assert.deepEqual(remainingStarts(limits(183, 43)), { unlimited: false, day: 183, hour: 43 });
	assert.deepEqual(remainingStarts({ ...limits(183, 43), canStart: false }), {
		unlimited: false,
		day: 0,
		hour: 0
	});
	assert.deepEqual(remainingStarts({ starts: { unlimited: true, day: null, hour: null } }), {
		unlimited: true,
		day: 0,
		hour: 0
	});
});
