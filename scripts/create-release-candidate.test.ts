import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertTrustedUnrealEvidence,
	sha256,
	validateCandidateVersion,
	validateCommit,
	validateRunId,
	validateWasmBuildInfo,
	type WasmBuildInfo
} from "./create-release-candidate.ts";
import { PUBLIC_PACKAGES, PUBLIC_VERSION } from "./pack-public-packages.ts";
import {
	parseRegistryIntegrity,
	publicationDecision,
	reconcilePackage,
	sha512Integrity,
	validatePublicationManifest,
	type PublishRequest
} from "./publish-public-packages.ts";

test("accepts exact release-candidate identities", () => {
	assert.equal(validateCandidateVersion("0.1.0-rc.1"), "0.1.0-rc.1");
	assert.equal(validateCommit("a".repeat(40)), "a".repeat(40));
	assert.equal(validateRunId("123456"), "123456");
});

test("accepts generated WASM build evidence for optimized and no-opt builds", () => {
	const buildInfo: WasmBuildInfo = {
		schemaVersion: 1,
		cargoLocked: true,
		packageVersion: PUBLIC_VERSION,
		crateVersion: PUBLIC_VERSION,
		targets: ["nodejs", "web"],
		tools: {
			rustc: "rustc 1.94.0",
			wasmPack: "wasm-pack 0.14.0",
			wasmBindgen: "0.2.126",
			wasmOpt: "wasm-opt version 131"
		},
		optimizer: {
			name: "wasm-opt",
			command: "wasm-opt",
			version: "wasm-opt version 131",
			enabled: true
		},
		limits: {
			maxInputBytes: 67108864,
			maxOutputBytes: 67108864,
			maxExports: 100000,
			maxProjectionItems: 1000000
		}
	};
	assert.equal(validateWasmBuildInfo(buildInfo), buildInfo);
	const noOptBuildInfo: WasmBuildInfo = {
		...structuredClone(buildInfo),
		tools: { ...buildInfo.tools, wasmOpt: "disabled (--no-opt)" },
		optimizer: {
			name: "wasm-opt",
			status: "disabled",
			reason: "wasm-pack --no-opt",
			command: null,
			version: null,
			enabled: false
		}
	};
	assert.equal(validateWasmBuildInfo(noOptBuildInfo), noOptBuildInfo);
	assert.throws(
		() => validateWasmBuildInfo({ ...buildInfo, cargoLocked: false }),
		/Invalid WASM build-info\.json.*cargoLocked must be true/s
	);
});

test("rejects WASM evidence that hides optimizer state", () => {
	assert.throws(
		() =>
			validateWasmBuildInfo({
				schemaVersion: 1,
				cargoLocked: true,
				packageVersion: PUBLIC_VERSION,
				crateVersion: PUBLIC_VERSION,
				targets: ["nodejs", "web"],
				tools: {
					rustc: "rustc",
					wasmPack: "wasm-pack",
					wasmBindgen: "wasm-bindgen",
					wasmOpt: "unavailable"
				},
				optimizer: {
					name: "wasm-opt",
					command: "wasm-opt",
					version: "unavailable",
					enabled: true
				},
				limits: {
					maxInputBytes: 67108864,
					maxOutputBytes: 67108864,
					maxExports: 100000,
					maxProjectionItems: 1000000
				}
			}),
		/Invalid WASM build-info\.json.*concrete version/s
	);
});

test("requires a candidate to bind the exact successful Trusted Unreal evidence artifact", () => {
	const manifest = {
		evidence: { unrealWorkflow: "Trusted Unreal", unrealRunId: "123456" },
		artifacts: [{ kind: "trusted-unreal-evidence" }]
	};
	assert.doesNotThrow(() => assertTrustedUnrealEvidence({ manifest, expectedRunId: "123456" }));
	assert.throws(
		() => assertTrustedUnrealEvidence({ manifest, expectedRunId: "654321" }),
		/exactly successful Trusted Unreal run|expected 654321|Candidate is bound/
	);
	assert.throws(
		() =>
			assertTrustedUnrealEvidence({
				manifest: { evidence: manifest.evidence, artifacts: [] },
				expectedRunId: "123456"
			}),
		/trusted-unreal-evidence artifact/
	);
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

test("computes npm SHA-512 SRI and makes retry-safe publication decisions", () => {
	const integrity =
		"sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";
	assert.equal(sha512Integrity(Buffer.from("abc")), integrity);
	assert.deepEqual(
		publicationDecision({
			packageSpec: "@ue-shed/uasset-inspection-wasm@0.1.0-rc.4",
			localIntegrity: integrity,
			registryIntegrity: null
		}),
		{ action: "publish", integrity }
	);
	assert.deepEqual(
		publicationDecision({
			packageSpec: "@ue-shed/uasset-inspection-wasm@0.1.0-rc.4",
			localIntegrity: integrity,
			registryIntegrity: integrity
		}),
		{ action: "skip", integrity }
	);
	assert.throws(
		() =>
			publicationDecision({
				packageSpec: "@ue-shed/uasset-inspection-wasm@0.1.0-rc.4",
				localIntegrity: integrity,
				registryIntegrity: sha512Integrity(Buffer.from("different"))
			}),
		/Registry integrity mismatch/
	);
});

test("treats only an exact npm E404 as an absent package version", () => {
	const packageSpec = "@ue-shed/uasset-inspection-wasm@0.1.0-rc.4";
	const integrity = sha512Integrity(Buffer.from("candidate"));
	assert.equal(
		parseRegistryIntegrity({
			packageSpec,
			status: 0,
			stdout: JSON.stringify(integrity)
		}),
		integrity
	);
	assert.equal(
		parseRegistryIntegrity({
			packageSpec,
			status: 1,
			stdout: JSON.stringify({ error: { code: "E404" } })
		}),
		null
	);
	assert.throws(
		() =>
			parseRegistryIntegrity({
				packageSpec,
				status: 1,
				stderr: "npm error code ETIMEDOUT"
			}),
		/Registry query failed/
	);
});

test("validates the exact publication manifest order", () => {
	const manifest = {
		schemaVersion: 1,
		version: "0.1.0-rc.4",
		packages: PUBLIC_PACKAGES.map(({ name }, index) => ({
			name,
			version: "0.1.0-rc.4",
			license: "MIT",
			filename: `package-${index}.tgz`,
			sha256: "a".repeat(64),
			bytes: index + 1
		}))
	};
	assert.equal(
		validatePublicationManifest({ manifest, expectedVersion: "0.1.0-rc.4" }),
		manifest.packages
	);
	const reordered = structuredClone(manifest);
	reordered.packages.reverse();
	assert.throws(
		() => validatePublicationManifest({ manifest: reordered, expectedVersion: "0.1.0-rc.4" }),
		/package order/
	);
});

test("reconciles a tarball by skipping exact bytes and publishing only an absent version", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ue-shed-publication-reconcile-"));
	try {
		const bytes = Buffer.from("candidate tarball bytes\n");
		const filename = "ue-shed-uasset-inspection-wasm-0.1.0-rc.4.tgz";
		await writeFile(join(directory, filename), bytes);
		const entry = {
			name: "@ue-shed/uasset-inspection-wasm",
			version: "0.1.0-rc.4",
			filename,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length
		};
		const localIntegrity = sha512Integrity(bytes);
		const skipped = await reconcilePackage({
			entry,
			directory,
			tag: "next",
			provenance: false,
			queryIntegrity: () => localIntegrity,
			publish: () => {
				throw new Error("matching package must not be republished");
			}
		});
		assert.equal(skipped.action, "skip");
		const published: Array<PublishRequest | string> = [];
		const result = await reconcilePackage({
			entry,
			directory,
			tag: "next",
			provenance: true,
			queryIntegrity: () => null,
			publish: (request) => published.push(request)
		});
		assert.equal(result.action, "publish");
		assert.deepEqual(published, [
			{
				tarball: join(directory, filename),
				tag: "next",
				provenance: true
			}
		]);
		await assert.rejects(
			() =>
				reconcilePackage({
					entry,
					directory,
					tag: "next",
					provenance: false,
					queryIntegrity: () => sha512Integrity(Buffer.from("registry mismatch")),
					publish: (request) => published.push(request)
				}),
			/Registry integrity mismatch/
		);
		assert.equal(published.length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
