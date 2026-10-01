import type { LevelSequenceProjection } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { sequenceReadFixture } from "./sequence-fixture.test-support.js";
import { adaptWasmSequenceResult, readWasmSequence } from "./wasm-reader.js";

const path = "LS_Test.uasset";
const sequence = sequenceReadFixture.sequence;

const output = {
	schema_version: 1,
	status: "complete",
	path,
	sequences: [sequence],
	diagnostics: []
};

describe("WASM Sequence read adapter", () => {
	it("maps complete evidence to the native complete read", async () => {
		expect(await Effect.runPromise(adaptWasmSequenceResult(path, output))).toEqual({
			assetPath: path,
			sequence,
			diagnostics: [],
			outcome: "complete",
			status: "ready"
		});
	});

	it.each([
		"malformed_data",
		"resource_limit",
		"unsupported_format",
		"unsupported_version",
		"unsupported_capability"
	])("matches native warning diagnostics for %s", async (code) => {
		const result = await Effect.runPromise(
			adaptWasmSequenceResult(path, {
				...output,
				status: "partial",
				diagnostics: [
					{ object_path: "Graph.Node", code, message: "Saved evidence missing" }
				]
			})
		);
		expect(result).toEqual({
			assetPath: path,
			sequence,
			diagnostics: [
				{ code: `asset_${code}`, message: "Saved evidence missing", severity: "warning" }
			],
			outcome: "partial",
			status: "ready"
		});
	});

	it.each([
		["malformed_data", "asset_malformed_data"],
		["saved_node_note", "saved_node_note"],
		["asset_malformed_data", "asset_malformed_data"]
	])("maps diagnostic %s to %s with native warning severity", async (code, expectedCode) => {
		const result = await Effect.runPromise(
			adaptWasmSequenceResult(path, {
				...output,
				status: "partial",
				diagnostics: [{ object_path: "Graph.Node", code, message: "Saved node note" }]
			})
		);
		expect(result).toMatchObject({
			status: "ready",
			outcome: "partial",
			diagnostics: [{ code: expectedCode, message: "Saved node note", severity: "warning" }]
		});
	});

	it("retains partial coverage without operation diagnostics", async () => {
		const partial: LevelSequenceProjection = {
			...sequence,
			coverage_gaps: [
				{
					object_path: "Graph.Node",
					reason: "unsupported_track_content",
					property_path: "OtherTrack"
				}
			]
		};
		const result = await Effect.runPromise(
			adaptWasmSequenceResult(path, {
				...output,
				status: "partial",
				sequences: [partial]
			})
		);
		expect(result).toMatchObject({ status: "ready", outcome: "partial", sequence: partial });
	});

	it.each([
		["unsupported_capability", "unsupported_asset"],
		["unsupported_version", "unsupported_version"],
		["malformed_data", "malformed_package"],
		["unsupported_format", "unsupported_asset"],
		["resource_limit", "reader_failure"],
		["internal", "reader_failure"]
	])("maps %s to %s with browser recovery", async (kind, reason) => {
		const result = await Effect.runPromise(
			adaptWasmSequenceResult(path, {
				schema_version: 1,
				status: "error",
				path,
				kind,
				message: "Package rejected"
			})
		);
		expect(result).toMatchObject({
			assetPath: path,
			status: "failed",
			reason,
			message: "Package rejected"
		});
		if (result.status === "failed") {
			expect(result.recovery).not.toContain("UE_SHED_UASSET_EXECUTABLE");
			expect(result.recovery).not.toContain("configured UAsset reader");
			expect(result.recovery.length).toBeGreaterThan(0);
		}
	});

	it.each(["complete", "partial"])(
		"matches native unsupported for empty %s output",
		async (status) => {
			const result = await Effect.runPromise(
				adaptWasmSequenceResult(path, { ...output, status, sequences: [] })
			);
			expect(result).toMatchObject({
				status: "failed",
				reason: "unsupported_asset",
				message: `package ${path} contains no saved Level Sequence`
			});
		}
	);

	it.each([
		null,
		{ ...output, schema_version: 99 },
		{ ...output, status: "ok" },
		{ ...output, sequences: [{}] },
		{ ...output, sequences: [{ ...sequence, schema_version: 99 }] },
		{ ...output, sequences: [sequence, sequence] },
		{ ...output, diagnostics: [{ code: "malformed_data" }] },
		{ schema_version: 1, path, status: "error", kind: "unknown", message: "Rejected" }
	])("rejects schema-invalid output %#", async (invalid) => {
		expect(await Effect.runPromise(adaptWasmSequenceResult(path, invalid))).toMatchObject({
			assetPath: path,
			status: "failed",
			reason: "reader_failure"
		});
	});

	it("validates the input path", async () => {
		expect(await Effect.runPromise(adaptWasmSequenceResult("", output))).toMatchObject({
			status: "failed",
			reason: "reader_failure"
		});
	});

	it("accepts a structural runtime and forwards the original bytes", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const result = await Effect.runPromise(
			readWasmSequence(
				{
					extractLevelSequences: (assetPath, input) => {
						expect(assetPath).toBe(path);
						expect(input).toBe(bytes);
						return output;
					}
				},
				path,
				bytes
			)
		);
		expect(result).toMatchObject({ status: "ready", outcome: "complete" });
	});

	it("turns runtime exceptions into a reader failure", async () => {
		const result = await Effect.runPromise(
			readWasmSequence(
				{
					extractLevelSequences: () => {
						throw new Error("Binding failed");
					}
				},
				path,
				new Uint8Array()
			)
		);
		expect(result).toMatchObject({ status: "failed", reason: "reader_failure" });
	});
});
