import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	sha256,
	validateCandidateVersion,
	validateCommit,
	validateRunId
} from "./create-release-candidate.mjs";

test("accepts exact release-candidate identities", () => {
	assert.equal(validateCandidateVersion("0.1.0-rc.1"), "0.1.0-rc.1");
	assert.equal(validateCommit("a".repeat(40)), "a".repeat(40));
	assert.equal(validateRunId("123456"), "123456");
});

test("rejects ranges, latest, shortened commits, and ambiguous run IDs", () => {
	for (const version of ["latest", "^0.1.0", "0.1.0", "0.1.0-rc.x"]) {
		assert.throws(() => validateCandidateVersion(version), /exact x\.y\.z-rc\.n SemVer/);
	}
	assert.throws(() => validateCommit("abc123"), /full lowercase Git SHA/);
	assert.throws(() => validateRunId("latest"), /exact positive integer/);
	assert.throws(() => validateRunId("0"), /exact positive integer/);
});

test("hashes the exact candidate bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ue-shed-candidate-hash-"));
	try {
		const path = join(directory, "artifact.txt");
		await writeFile(path, "candidate\n", "utf8");
		assert.equal(
			await sha256(path),
			"1e81270f1a47dce22a2e4985250c74b2e3374443734f1492b03ea2cd2af4ec48"
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
