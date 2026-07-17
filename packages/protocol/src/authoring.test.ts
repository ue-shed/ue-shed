import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	AuthoringApplyRequest,
	AuthoringApplyResult,
	AuthoringSaveRequest,
	AuthoringSaveResult,
	AuthoringTableList,
	AuthoringTableSnapshotV1,
	AuthoringTableSnapshotV2,
	AuthoringValue,
	classifyAuthoringSnapshot,
	decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect,
	makeAuthoringJsonSchema
} from "./authoring.js";

const decodeAuthoringTableSnapshot = (input: unknown) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

describe("authoring wire contract", () => {
	it("accepts recursive typed values and explicit unsupported evidence", () => {
		const snapshot = decodeAuthoringTableSnapshot({
			contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
			authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Test" },
			completeness: "partial",
			table: {
				kind: "data_table",
				objectPath: "/Game/Fixture/DT_Test.DT_Test",
				parentTables: [],
				rowStruct: "/Script/Fixture.Row",
				rows: [
					{
						id: "row:Alpha",
						name: "Alpha",
						fields: [
							{
								name: "Nested",
								typeName: "StructProperty",
								value: {
									kind: "struct",
									fields: [
										{
											name: "Opaque",
											typeName: "StructProperty",
											value: {
												byteSize: 8,
												kind: "unsupported",
												reason: "unsupported type"
											}
										}
									]
								}
							}
						]
					}
				]
			},
			diagnostics: []
		});

		expect(snapshot.table.rows[0]?.fields[0]?.value.kind).toBe("struct");
		expect(classifyAuthoringSnapshot(snapshot).status).toBe("legacy_read_only");
	});

	it("accepts v2 schema descriptors independently of populated rows", () => {
		const snapshot = decodeAuthoringTableSnapshot({
			authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Empty" },
			completeness: "complete",
			contract: { name: "unreal-authoring", version: { major: 2, minor: 0 } },
			diagnostics: [],
			fingerprint: {
				algorithm: "sha256",
				status: "available",
				value: "sha256-v1:empty",
				version: 1
			},
			producer: { name: "uasset-parser", version: "6" },
			table: {
				kind: "data_table",
				objectPath: "/Game/Fixture/DT_Empty.DT_Empty",
				packageName: "/Game/Fixture/DT_Empty",
				parentTables: [],
				rows: [],
				rowStruct: "/Script/Fixture.EmptyRow",
				schema: {
					fields: [
						{
							annotations: {
								deprecated: false,
								readOnly: false
							},
							defaultValue: { status: "unknown" },
							editability: { kind: "editable" },
							id: "field:Enabled",
							name: "Enabled",
							presence: "required",
							type: { kind: "scalar", valueKind: "bool" },
							typeName: "BoolProperty"
						}
					],
					source: "saved_package",
					status: "available"
				}
			}
		});

		const compatibility = classifyAuthoringSnapshot(snapshot);
		expect(compatibility.status).toBe("current");
		if (compatibility.status === "current") {
			expect(compatibility.snapshot.table.schema).toMatchObject({
				fields: [{ name: "Enabled" }],
				status: "available"
			});
		}
	});

	it("preserves an explicit DataTable row handle", () => {
		const value = Schema.decodeUnknownSync(AuthoringValue)({
			kind: "row_reference",
			rowName: "Right_Alpha",
			tableObjectPath: "/Game/Fixture/DT_Right.DT_Right"
		});
		expect(value).toEqual({
			kind: "row_reference",
			rowName: "Right_Alpha",
			tableObjectPath: "/Game/Fixture/DT_Right.DT_Right"
		});
	});

	it("keeps the runtime schemas conformant with the language-neutral contracts", async () => {
		const check = async (version: "v1" | "v2", name: string, contract: Schema.Top) => {
			const path = fileURLToPath(
				new URL(`../contracts/authoring/${version}/${name}.schema.json`, import.meta.url)
			);
			const checkedIn: unknown = JSON.parse(await readFile(path, "utf8"));
			const derived = makeAuthoringJsonSchema(contract);
			expect(checkedIn, name).toEqual(derived);
		};
		for (const [version, name, contract] of [
			["v1", "table-snapshot", AuthoringTableSnapshotV1],
			["v2", "table-snapshot", AuthoringTableSnapshotV2],
			["v1", "table-list", AuthoringTableList],
			["v1", "apply-request", AuthoringApplyRequest],
			["v1", "apply-result", AuthoringApplyResult],
			["v1", "save-request", AuthoringSaveRequest],
			["v1", "save-result", AuthoringSaveResult]
		] as const) {
			await check(version, name, contract);
		}
	});
});
