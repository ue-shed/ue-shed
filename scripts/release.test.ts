import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { delimiter, dirname, join } from "node:path";
import { PUBLIC_PACKAGES } from "./pack-public-packages.ts";
import {
	gateFingerprint,
	type GateResult,
	type ReleaseEvidence,
	type TreeEntry
} from "./release-evidence.ts";
import { RELEASE_GATES } from "./release-gates.ts";
import {
	assertPublicationConfirmation,
	packedPublishPlan,
	parseReleaseArguments,
	publicationConfirmationPhrase,
	releaseEnvironment,
	releaseGateCoverage,
	runRelease,
	verifyPackedRelease
} from "./release.ts";

test("release puts the running Node first in one normalized PATH without mutating the shell", () => {
	const environment = { Path: "existing-tools", OTHER: "kept" };
	const result = releaseEnvironment(environment);
	assert.deepEqual(
		Object.keys(result).filter((key) => key.toLowerCase() === "path"),
		["PATH"]
	);
	assert.deepEqual(result.PATH?.split(delimiter), [dirname(process.execPath), "existing-tools"]);
	assert.equal(result.OTHER, "kept");
	assert.deepEqual(environment, { Path: "existing-tools", OTHER: "kept" });
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

function steps(events: string[], commits: readonly string[] = ["a".repeat(40)]) {
	let validations = 0;
	return {
		validateSource: () => {
			events.push("validate-source");
			const commit = commits[Math.min(validations, commits.length - 1)]!;
			validations += 1;
			return commit;
		},
		verify: (commit: string) => {
			events.push("verify");
			return commit;
		},
		confirm: async () => {
			events.push("confirm-start");
			await Promise.resolve();
			events.push("confirm-end");
		},
		publish: () => {
			events.push("publish");
		}
	};
}

test("verifies evidence, then waits for confirmation before publication", async () => {
	const events: string[] = [];
	await runRelease(steps(events));
	assert.deepEqual(events, [
		"validate-source",
		"verify",
		"confirm-start",
		"confirm-end",
		"validate-source",
		"publish"
	]);
});

test("does not verify or publish when the release source is dirty", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				...steps(events),
				validateSource: () => {
					events.push("validate-source");
					throw new Error("release source is dirty");
				}
			}),
		/release source is dirty/
	);
	assert.deepEqual(events, ["validate-source"]);
});

test("does not publish when the source changes before publication", async () => {
	const events: string[] = [];
	await assert.rejects(
		() => runRelease(steps(events, ["a".repeat(40), "b".repeat(40)])),
		/Release source changed from a{40} to b{40} during validation\./
	);
	assert.deepEqual(events, [
		"validate-source",
		"verify",
		"confirm-start",
		"confirm-end",
		"validate-source"
	]);
});

test("does not request confirmation or publish when the evidence does not cover the release", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				...steps(events),
				verify: () => {
					events.push("verify");
					throw new Error("Release evidence does not cover");
				}
			}),
		/Release evidence does not cover/
	);
	assert.deepEqual(events, ["validate-source", "verify"]);
});

test("does not publish when confirmation is blank or interrupted", async () => {
	const events: string[] = [];
	await assert.rejects(
		() =>
			runRelease({
				...steps(events),
				confirm: async () => {
					events.push("confirm");
					assertPublicationConfirmation("", "0.5.2");
				}
			}),
		/expected the exact phrase "publish 0\.5\.2"/
	);
	assert.deepEqual(events, ["validate-source", "verify", "confirm"]);
});

const tree: readonly TreeEntry[] = [
	{ path: "packages/game-text/src/index.ts", object: "1".repeat(40) },
	{ path: "packages/game-text/CHANGELOG.md", object: "2".repeat(40) },
	{ path: "docs/releases/0.5.2.md", object: "3".repeat(40) }
];

function edited(path: string): TreeEntry[] {
	return tree.map((entry) => (entry.path === path ? { path, object: "9".repeat(40) } : entry));
}

function passedOn(entries: readonly TreeEntry[]): ReleaseEvidence {
	const gates: Record<string, GateResult> = {};
	for (const gate of RELEASE_GATES) {
		gates[gate.id] = {
			status: gate.id === "plugins-4.27" ? "unavailable" : "passed",
			scope: gate.scope,
			fingerprint: gateFingerprint(gate.scope, entries),
			commit: "c".repeat(40),
			finishedAt: "2026-10-21T00:00:00.000Z",
			durationMs: 1,
			trace: "out/release-prepare/run"
		};
	}
	return { schemaVersion: 1, version: "0.5.2", gates };
}

test("evidence for the same inputs covers every required gate, including an unavailable engine", () => {
	assert.deepEqual(releaseGateCoverage(passedOn(tree), tree).problems, []);
});

test("a changelog edit only invalidates the gates that read changelogs", () => {
	const { problems } = releaseGateCoverage(
		passedOn(tree),
		edited("packages/game-text/CHANGELOG.md")
	);
	assert.deepEqual(problems, [
		`release-text: inputs changed since it passed on ${"c".repeat(10)}`,
		`pack: inputs changed since it passed on ${"c".repeat(10)}`
	]);
});

test("a release-notes edit only invalidates the release-text gate", () => {
	const { problems } = releaseGateCoverage(passedOn(tree), edited("docs/releases/0.5.2.md"));
	assert.deepEqual(problems, [
		`release-text: inputs changed since it passed on ${"c".repeat(10)}`
	]);
});

test("a source edit invalidates every gate", () => {
	const { problems } = releaseGateCoverage(
		passedOn(tree),
		edited("packages/game-text/src/index.ts")
	);
	// An engine recorded as unavailable is rechecked too: it may be installed by now.
	assert.equal(problems.length, RELEASE_GATES.length);
});

test("missing and failed gates block the release; --without-unreal drops only Unreal gates", () => {
	const evidence = passedOn(tree);
	const { check: _check, ...withoutCheck } = evidence.gates;
	const failedMatrix: ReleaseEvidence = {
		...evidence,
		gates: {
			...withoutCheck,
			"engine-matrix": { ...evidence.gates["engine-matrix"]!, status: "failed" }
		}
	};
	assert.deepEqual(releaseGateCoverage(failedMatrix, tree).problems, [
		"check: no evidence",
		`engine-matrix: failed on ${"c".repeat(10)}`
	]);
	assert.deepEqual(
		releaseGateCoverage(failedMatrix, tree, { withoutUnreal: "docs-only release" }).problems,
		["check: no evidence"]
	);
});

test("parses --without-unreal and rejects unknown release arguments", () => {
	assert.deepEqual(parseReleaseArguments([]), { withoutUnreal: undefined });
	assert.deepEqual(parseReleaseArguments(["--without-unreal", "docs-only release"]), {
		withoutUnreal: "docs-only release"
	});
	assert.throws(() => parseReleaseArguments(["--without-unreal", " "]), /needs the reason/);
	assert.throws(() => parseReleaseArguments(["--checked", "a".repeat(40)]));
});

function writePack(directory: string, version: string, commit: string) {
	const packages = PUBLIC_PACKAGES.map(({ name }) => {
		const filename = `${name.slice(1).replace("/", "-")}-${version}.tgz`;
		const bytes = Buffer.from(`${name}@${version}`);
		writeFileSync(join(directory, filename), bytes);
		return {
			name,
			version,
			license: "MIT",
			filename,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length
		};
	});
	writeFileSync(
		join(directory, "packages-manifest.json"),
		JSON.stringify({ schemaVersion: 1, version, packages })
	);
	writeFileSync(
		join(directory, "pack-evidence.json"),
		JSON.stringify({
			schemaVersion: 1,
			version,
			commit,
			packedAt: "2026-10-21T00:00:00.000Z",
			node: "v26.12.0"
		})
	);
	return packages;
}

test("publishes only an untouched pack of the evidence commit", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "ue-shed-release-pack-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	const packages = writePack(directory, "0.5.2", "c".repeat(40));
	assert.equal(verifyPackedRelease(directory, "0.5.2", "c".repeat(40)).length, packages.length);
	assert.throws(
		() => verifyPackedRelease(directory, "0.5.2", "d".repeat(40)),
		/packed from c{40}, not 0\.5\.2 from d{40}/
	);
	writeFileSync(join(directory, packages[3]!.filename), "rebuilt");
	assert.throws(
		() => verifyPackedRelease(directory, "0.5.2", "c".repeat(40)),
		/changed after it was packed/
	);
});

test("points every planned publication at its validated tarball", () => {
	const entries = PUBLIC_PACKAGES.slice(0, 2).map(({ name }, index) => ({
		name,
		version: "0.5.2",
		license: "MIT",
		filename: `package-${index}.tgz`,
		sha256: "0".repeat(64),
		bytes: 1
	}));
	const plan = packedPublishPlan(
		{
			version: 1,
			plan: [
				[
					{
						kind: "publish",
						name: entries[0]!.name,
						version: "0.5.2",
						tag: "latest",
						access: "public"
					}
				],
				[
					{ kind: "publish", name: entries[1]!.name, version: "0.5.2", tag: "latest" },
					{ kind: "tag-only", name: "@ue-shed/private-tool", version: "0.5.2" }
				]
			]
		},
		entries,
		(entry) => `sha256-${entry.filename}`
	);
	assert.deepEqual(plan.plan, [
		[
			{
				kind: "publish",
				name: entries[0]!.name,
				version: "0.5.2",
				tag: "latest",
				access: "public",
				tarball: { path: "package-0.tgz", integrity: "sha256-package-0.tgz" }
			}
		],
		[
			{
				kind: "publish",
				name: entries[1]!.name,
				version: "0.5.2",
				tag: "latest",
				tarball: { path: "package-1.tgz", integrity: "sha256-package-1.tgz" }
			},
			{ kind: "tag-only", name: "@ue-shed/private-tool", version: "0.5.2" }
		]
	]);
	assert.throws(
		() =>
			packedPublishPlan(
				{
					version: 1,
					plan: [
						[
							{
								kind: "publish",
								name: "@ue-shed/unpacked",
								version: "0.5.2",
								tag: "latest"
							}
						]
					]
				},
				entries,
				() => ""
			),
		/@ue-shed\/unpacked@0\.5\.2, which the validated pack does not contain/
	);
});
