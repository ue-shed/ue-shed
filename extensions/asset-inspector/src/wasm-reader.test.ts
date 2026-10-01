import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { cannedOutput, generic, packageHeader, stringTable } from "./inspection.test-support.js";
import { adaptWasmInspectionResult, readWasmInspection } from "./wasm-reader.js";

describe("WASM inspection adapter", () => {
	it("validates ok output and retains null UE3, counts, offsets, and soft paths", async () => {
		const result = await Effect.runPromise(
			adaptWasmInspectionResult("Test.uasset", 1024, cannedOutput())
		);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error("Expected ready inspection");
		expect(result.inspection.package).toEqual(packageHeader);
		expect(result.inspection.assets[0]?.class_path).toBe("/Script/Engine.StringTable");
		expect(result.inspection.decode_errors).toEqual([]);
	});

	it("retains generic native evidence and partial decode errors", async () => {
		const result = await Effect.runPromise(
			adaptWasmInspectionResult("Test.uasset", 1024, {
				...cannedOutput(),
				assets: [generic],
				status: "partial",
				decode_errors: [
					{
						object_path: "Unreadable",
						kind: "unsupported_capability",
						message: "Native layout unavailable"
					}
				]
			})
		);
		expect(result).toMatchObject({
			status: "ready",
			inspection: {
				status: "partial",
				assets: [{ native_data: generic.native_data, tail_bytes: 8 }],
				decode_errors: [{ kind: "unsupported_capability" }]
			}
		});
	});

	it.each([
		["malformed_data", "malformed_package"],
		["unsupported_format", "unsupported_asset"],
		["unsupported_version", "unsupported_version"],
		["unsupported_capability", "unsupported_capability"],
		["resource_limit", "reader_failure"],
		["internal", "reader_failure"]
	])("maps %s to %s with browser recovery", async (kind, reason) => {
		const result = await Effect.runPromise(
			adaptWasmInspectionResult("Test.uasset", 42, {
				schema_version: 8,
				status: "error",
				path: "Test.uasset",
				kind,
				message: "Package rejected",
				field: null,
				offset: null
			})
		);
		expect(result).toMatchObject({ status: "failed", reason, message: "Package rejected" });
		if (result.status === "failed") {
			expect(result.recovery.length).toBeGreaterThan(0);
			expect(result.recovery).not.toContain("EXECUTABLE");
		}
	});

	it.each([
		{ ...cannedOutput(), schema_version: 9 },
		{ ...cannedOutput(), package: { ...packageHeader, names: { count: -1, offset: 0 } } },
		{
			...cannedOutput(),
			package: { ...packageHeader, version: { ...packageHeader.version, legacy_ue3: "bad" } }
		},
		{ ...cannedOutput(), assets: [{ ...generic, native_data: { value_kind: "unknown" } }] },
		{
			...cannedOutput(),
			assets: [{ ...stringTable, string_table_entries: [{ key: "Key", source: 42 }] }]
		}
	])("rejects invalid evidence", async (output) => {
		expect(
			await Effect.runPromise(adaptWasmInspectionResult("Test.uasset", 1024, output))
		).toMatchObject({
			status: "failed",
			reason: "reader_failure"
		});
	});

	it("accepts an empty string table with omitted entries, as Rust emits it", async () => {
		const { string_table_entries: _entries, ...empty } = stringTable;
		const result = await Effect.runPromise(
			adaptWasmInspectionResult("Test.uasset", 1024, { ...cannedOutput(), assets: [empty] })
		);
		expect(result).toMatchObject({
			status: "ready",
			inspection: { assets: [{ string_table_entries: [] }] }
		});
	});

	it("turns runtime exceptions into typed reader failures", async () => {
		const result = await Effect.runPromise(
			readWasmInspection(
				{
					inspect: () => {
						throw new Error("runtime");
					}
				},
				"Test.uasset",
				new Uint8Array(4)
			)
		);
		expect(result).toMatchObject({ status: "failed", reason: "reader_failure" });
	});

	it("accepts numeric legacy UE3 revisions and rejects invalid file identities", async () => {
		const result = await Effect.runPromise(
			adaptWasmInspectionResult("Test.uasset", 1024, {
				...cannedOutput(),
				package: {
					...packageHeader,
					version: { ...packageHeader.version, legacy_ue3: 864 }
				}
			})
		);
		expect(result).toMatchObject({
			status: "ready",
			inspection: { package: { version: { legacy_ue3: 864 } } }
		});
		expect(
			await Effect.runPromise(adaptWasmInspectionResult("", -1, cannedOutput()))
		).toMatchObject({
			status: "failed",
			reason: "reader_failure"
		});
	});
});
