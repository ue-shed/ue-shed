import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { PACK_EVIDENCE_FILE } from "./check-clean-release-pack.ts";
import { releaseEvidencePath, type ReleaseEvidence } from "./release-evidence.ts";
import {
	fetchReleaseHandoff,
	handoffEvidence,
	handoffFiles,
	handoffRelease,
	receivedEvidence
} from "./release-handoff.ts";

const evidence: ReleaseEvidence = {
	schemaVersion: 1,
	version: "0.24.0",
	gates: {
		check: {
			status: "passed",
			scope: "code",
			fingerprint: "abc",
			commit: "1234567890",
			finishedAt: "2026-10-30T00:00:00.000Z",
			durationMs: 1,
			trace: "out/release-prepare/0.24.0-1/trace.json"
		}
	},
	pack: {
		directory: "D:/git/ue-shed/out/release-prepare/0.24.0-1/npm",
		commit: "1234567890"
	}
};

test("a handoff carries the evidence with the pack left to wherever it is unpacked", () => {
	const travelling = handoffEvidence(evidence);
	assert.deepEqual(travelling.gates, evidence.gates);
	assert.deepEqual(travelling.pack, { directory: ".", commit: "1234567890" });
	assert.throws(() => handoffEvidence({ ...evidence, pack: undefined }), /no kept pack/u);
	assert.equal(handoffRelease("0.24.0"), "release-handoff-0.24.0");
});

test("received evidence points at the unpacked handoff and must be for this version", () => {
	const text = JSON.stringify(handoffEvidence(evidence));
	assert.deepEqual(receivedEvidence(text, "0.24.0", "C:/here/npm").pack, {
		directory: "C:/here/npm",
		commit: "1234567890"
	});
	assert.throws(() => receivedEvidence(text, "0.25.0", "C:/here/npm"), /holds 0\.24\.0/u);
});

test("a checkout with its own evidence for the version fetches nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-handoff-"));
	try {
		const path = releaseEvidencePath("0.24.0", root);
		mkdirSync(join(root, "out", "release-evidence"), { recursive: true });
		writeFileSync(path, JSON.stringify(evidence));
		assert.equal(fetchReleaseHandoff("0.24.0", root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a handoff uploads the kept pack without the plans publication writes", () => {
	const pack = mkdtempSync(join(tmpdir(), "ue-shed-handoff-pack-"));
	try {
		for (const name of [
			"packages-manifest.json",
			PACK_EVIDENCE_FILE,
			"ue-shed-protocol-0.24.0.tgz",
			"publish-plan.json",
			"changesets-plan.json"
		])
			writeFileSync(join(pack, name), "{}");
		assert.deepEqual(
			handoffFiles(pack)
				.map((file) => file.slice(pack.length + 1))
				.sort(),
			[PACK_EVIDENCE_FILE, "packages-manifest.json", "ue-shed-protocol-0.24.0.tgz"].sort()
		);
		rmSync(join(pack, "packages-manifest.json"));
		assert.throws(() => handoffFiles(pack), /not a kept pack/u);
	} finally {
		rmSync(pack, { recursive: true, force: true });
	}
});
