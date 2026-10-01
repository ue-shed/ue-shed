import { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { adaptWasmAuthoringTable, readWasmAuthoringTable } from "./wasm-reader.js";
import { viewerSnapshot } from "./viewer-fixture.test-support.js";

const envelope = {
	schema_version: 1,
	status: "ok",
	path: "DT_Scalars.uasset",
	snapshot: viewerSnapshot
};

describe("DataTable WASM adapter", () => {
	it("builds fixture evidence that decodes with the protocol snapshot schema", () => {
		expect(Schema.decodeUnknownSync(AuthoringTableSnapshot)(viewerSnapshot)).toEqual(
			viewerSnapshot
		);
	});

	it("preserves the native snapshot and accepts partial evidence", async () => {
		const read = await Effect.runPromise(adaptWasmAuthoringTable(envelope.path, envelope));
		expect(read).toMatchObject({
			status: "ready",
			outcome: "complete",
			snapshot: viewerSnapshot
		});
		const partial = await Effect.runPromise(
			adaptWasmAuthoringTable(envelope.path, {
				...envelope,
				status: "partial",
				snapshot: { ...viewerSnapshot, completeness: "partial" }
			})
		);
		expect(partial).toMatchObject({ status: "ready", outcome: "partial" });
	});

	it.each([
		["malformed_data", "malformed_package"],
		["resource_limit", "reader_failure"],
		["unsupported_format", "unsupported_asset"],
		["unsupported_version", "unsupported_version"],
		["unsupported_capability", "unsupported_asset"],
		["internal", "reader_failure"]
	])("maps %s to %s with browser recovery", async (kind, reason) => {
		const read = await Effect.runPromise(
			adaptWasmAuthoringTable(envelope.path, {
				schema_version: 1,
				status: "error",
				path: envelope.path,
				kind,
				message: "Cannot decode"
			})
		);
		expect(read).toMatchObject({ status: "failed", reason, message: "Cannot decode" });
		if (read.status === "failed") expect(read.recovery.length).toBeGreaterThan(0);
	});

	it.each([
		{ ...envelope, schema_version: 2 },
		{ ...envelope, snapshot: {} },
		{ ...envelope, status: "complete" },
		{
			...envelope,
			snapshot: {
				...viewerSnapshot,
				diagnostics: [{ code: "resource_limit", message: "Invalid path", path: null }]
			}
		},
		{ ...envelope, snapshot: { ...viewerSnapshot, table: { rows: [] } } }
	])("rejects invalid foreign evidence", async (output) => {
		expect(
			await Effect.runPromise(adaptWasmAuthoringTable(envelope.path, output))
		).toMatchObject({ status: "failed", reason: "reader_failure" });
	});

	it("keeps snapshot codes and maps only known display diagnostics", async () => {
		const snapshot = {
			...viewerSnapshot,
			diagnostics: [
				{
					code: "resource_limit",
					message: "Bounded",
					path: viewerSnapshot.table.objectPath
				},
				{ code: "custom_warning", message: "Custom" },
				{ code: "asset_malformed_data", message: "Already prefixed" }
			]
		};
		const read = await Effect.runPromise(
			adaptWasmAuthoringTable(envelope.path, { ...envelope, snapshot })
		);
		if (read.status !== "ready") throw new Error("Expected ready read");
		expect(read.snapshot).toEqual(snapshot);
		expect(read.diagnostics.map((item) => item.code)).toEqual([
			"asset_resource_limit",
			"custom_warning",
			"asset_malformed_data"
		]);
	});

	it("maps runtime exceptions and invalid filenames to typed failures", async () => {
		expect(
			await Effect.runPromise(
				readWasmAuthoringTable(
					{
						extractAuthoringTable: () => {
							throw new Error("Runtime failed");
						}
					},
					envelope.path,
					new Uint8Array()
				)
			)
		).toMatchObject({ status: "failed", reason: "reader_failure" });
		expect(await Effect.runPromise(adaptWasmAuthoringTable("", envelope))).toMatchObject({
			status: "failed",
			reason: "reader_failure"
		});
	});

	it.each([
		"malformed_data",
		"resource_limit",
		"unsupported_format",
		"unsupported_version",
		"unsupported_capability"
	])("maps the known diagnostic prefix for %s", async (code) => {
		const read = await Effect.runPromise(
			adaptWasmAuthoringTable(envelope.path, {
				...envelope,
				snapshot: {
					...viewerSnapshot,
					diagnostics: [{ code, message: "Partial decode" }]
				}
			})
		);
		if (read.status !== "ready") throw new Error("Expected ready read");
		expect(read.diagnostics[0]?.code).toBe(`asset_${code}`);
		expect(read.snapshot.diagnostics[0]?.code).toBe(code);
	});
});
