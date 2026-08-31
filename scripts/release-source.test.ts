import assert from "node:assert/strict";
import test from "node:test";
import { validateCleanReleaseSource } from "./release-source.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

test("accepts a clean release source at the expected commit", () => {
	assert.equal(validateCleanReleaseSource({ changes: "", head: commit }, commit), commit);
});

test("rejects release artifacts from a different checked-out commit", () => {
	assert.throws(
		() =>
			validateCleanReleaseSource(
				{ changes: "", head: "fedcba9876543210fedcba9876543210fedcba98" },
				commit
			),
		/does not match checked-out HEAD/
	);
});

test("rejects release artifacts when tracked or untracked source is dirty", () => {
	for (const changes of [" M packages/cameras/src/index.ts", "?? local-contract.ts"]) {
		assert.throws(
			() => validateCleanReleaseSource({ changes, head: commit }, commit),
			/requires a clean worktree/
		);
	}
});
