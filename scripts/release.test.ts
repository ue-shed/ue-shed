import assert from "node:assert/strict";
import test from "node:test";
import { runRelease } from "./release.ts";

test("waits for confirmation after checks and before publication", async () => {
	const events: string[] = [];
	await runRelease({
		check: () => events.push("check"),
		confirm: async () => {
			events.push("confirm-start");
			await Promise.resolve();
			events.push("confirm-end");
		},
		publish: () => events.push("publish")
	});
	assert.deepEqual(events, ["check", "confirm-start", "confirm-end", "publish"]);
});

test("does not request confirmation or publish when checks fail", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				check: () => {
					events.push("check");
					throw new Error("checks failed");
				},
				confirm: async () => {
					events.push("confirm");
				},
				publish: () => events.push("publish")
			}),
		/checks failed/
	);
	assert.deepEqual(events, ["check"]);
});

test("does not publish when confirmation is interrupted", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				check: () => events.push("check"),
				confirm: async () => {
					events.push("confirm");
					throw new Error("confirmation interrupted");
				},
				publish: () => events.push("publish")
			}),
		/confirmation interrupted/
	);
	assert.deepEqual(events, ["check", "confirm"]);
});
