import assert from "node:assert/strict";
import test from "node:test";
import { delimiter, join, resolve } from "node:path";
import {
	assertPublicationConfirmation,
	publicationConfirmationPhrase,
	releaseEnvironment,
	runRelease
} from "./release.ts";

test("release discovers rustup without replacing PATH or mutating the shell environment", () => {
	const home = resolve("test-home");
	const environment = { Path: "existing-tools" };
	const result = releaseEnvironment(environment, home);
	assert.ok(result.Path?.split(delimiter).includes("existing-tools"));
	assert.ok(result.Path?.split(delimiter).includes(join(home, ".cargo", "bin")));
	assert.equal(result.PATH, undefined);
	assert.equal(result.CARGO_TARGET_DIR, resolve(import.meta.dirname, "..", "target"));
	assert.deepEqual(environment, { Path: "existing-tools" });
});

test("release respects custom Cargo installation and build output", () => {
	const cargoHome = resolve("custom-cargo");
	const target = resolve("shared-target");
	const result = releaseEnvironment({ CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target });
	assert.ok(result.PATH?.split(delimiter).includes(join(cargoHome, "bin")));
	assert.equal(result.CARGO_TARGET_DIR, target);
});

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
