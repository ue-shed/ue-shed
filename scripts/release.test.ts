import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPublicationConfirmation,
	publicationConfirmationPhrase,
	runRelease
} from "./release.ts";

test("requires the exact versioned publication phrase", () => {
	assert.equal(publicationConfirmationPhrase("0.5.2"), "publish 0.5.2");
	assert.doesNotThrow(() => assertPublicationConfirmation("publish 0.5.2", "0.5.2"));
	assert.throws(
		() => assertPublicationConfirmation("", "0.5.2"),
		/expected the exact phrase "publish 0\.5\.2"/
	);
	assert.throws(
		() => assertPublicationConfirmation("publish 0.5.1", "0.5.2"),
		/expected the exact phrase "publish 0\.5\.2"/
	);
});

test("waits for confirmation after checks and before publication", async () => {
	const events: string[] = [];
	await runRelease({
		validateSource: () => {
			events.push("validate-source");
			return "a".repeat(40);
		},
		check: () => events.push("check"),
		confirm: async () => {
			events.push("confirm-start");
			await Promise.resolve();
			events.push("confirm-end");
		},
		publish: () => events.push("publish")
	});
	assert.deepEqual(events, [
		"validate-source",
		"check",
		"confirm-start",
		"confirm-end",
		"validate-source",
		"publish"
	]);
});

test("does not check or publish when the release source is dirty", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				validateSource: () => {
					events.push("validate-source");
					throw new Error("release source is dirty");
				},
				check: () => events.push("check"),
				confirm: async () => {
					events.push("confirm");
				},
				publish: () => events.push("publish")
			}),
		/release source is dirty/
	);
	assert.deepEqual(events, ["validate-source"]);
});

test("does not publish when the source changes during release checks", async () => {
	const events: string[] = [];
	let validationCount = 0;
	await assert.rejects(
		() =>
			runRelease({
				validateSource: () => {
					validationCount += 1;
					events.push("validate-source");
					return validationCount === 1 ? "a".repeat(40) : "b".repeat(40);
				},
				check: () => events.push("check"),
				confirm: async () => {
					events.push("confirm");
				},
				publish: () => events.push("publish")
			}),
		/Release source changed from a{40} to b{40} during validation\./
	);
	assert.deepEqual(events, ["validate-source", "check", "confirm", "validate-source"]);
});

test("does not request confirmation or publish when checks fail", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				validateSource: () => {
					events.push("validate-source");
					return "a".repeat(40);
				},
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
	assert.deepEqual(events, ["validate-source", "check"]);
});

test("does not publish when confirmation is blank or interrupted", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				validateSource: () => {
					events.push("validate-source");
					return "a".repeat(40);
				},
				check: () => events.push("check"),
				confirm: async () => {
					events.push("confirm");
					assertPublicationConfirmation("", "0.5.2");
				},
				publish: () => events.push("publish")
			}),
		/expected the exact phrase "publish 0\.5\.2"/
	);
	assert.deepEqual(events, ["validate-source", "check", "confirm"]);
});
