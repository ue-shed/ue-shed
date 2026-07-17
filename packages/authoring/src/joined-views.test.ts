import type { AuthoringRow, AuthoringTableSnapshotV1 } from "@ue-shed/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { JoinedView, buildJoinedView } from "./joined-views.js";

function snapshot(objectPath: string, rows: readonly AuthoringRow[]): AuthoringTableSnapshotV1 {
	return {
		authority: { kind: "project_files", packageName: objectPath.split(".")[0]! },
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
		diagnostics: [],
		table: {
			kind: "data_table",
			objectPath,
			parentTables: [],
			rows: [...rows],
			rowStruct: "/Script/Fixture.Row"
		}
	};
}

const leftPath = "/Game/Fixture/DT_Left.DT_Left";
const rightPath = "/Game/Fixture/DT_Right.DT_Right";

describe("joined authoring views", () => {
	it("projects resolved rows with source and target provenance without gaining edit authority", () => {
		const left = snapshot(leftPath, [
			{
				fields: [
					{
						name: "Target",
						typeName: "StructProperty",
						value: {
							kind: "row_reference",
							rowName: "Right_Alpha",
							tableObjectPath: rightPath
						}
					},
					{ name: "Weight", typeName: "IntProperty", value: { kind: "int", value: "2" } }
				],
				id: "row:Left_Alpha",
				name: "Left_Alpha"
			}
		]);
		const right = snapshot(rightPath, [
			{
				fields: [
					{
						name: "Description",
						typeName: "StrProperty",
						value: { kind: "string", value: "Resolved target" }
					}
				],
				id: "row:Right_Alpha",
				name: "Right_Alpha"
			}
		]);

		const view = buildJoinedView({
			query: { referenceFieldName: "Target", sourceTableObjectPath: leftPath },
			snapshots: [left, right]
		});

		expect(Schema.decodeUnknownSync(JoinedView)(view)).toEqual(view);
		expect(view).toMatchObject({
			editability: { kind: "read_only" },
			rows: [
				{
					source: { rowId: "row:Left_Alpha", tableObjectPath: leftPath },
					status: "resolved",
					target: { rowId: "row:Right_Alpha", tableObjectPath: rightPath },
					targetRow: {
						fields: [{ value: { kind: "string", value: "Resolved target" } }]
					}
				}
			],
			status: "ready",
			summary: { resolvedCount: 1, rowCount: 1, unresolvedCount: 0 }
		});
	});

	it("keeps broken and non-reference rows visible as unresolved", () => {
		const source = snapshot(leftPath, [
			{
				fields: [
					{
						name: "Target",
						typeName: "StructProperty",
						value: {
							kind: "row_reference",
							rowName: "Missing",
							tableObjectPath: rightPath
						}
					}
				],
				id: "row:Broken",
				name: "Broken"
			},
			{ fields: [], id: "row:NoField", name: "NoField" }
		]);
		const view = buildJoinedView({
			query: { referenceFieldName: "Target", sourceTableObjectPath: leftPath },
			snapshots: [source, snapshot(rightPath, [])]
		});

		expect(view).toMatchObject({
			rows: [
				{ reason: "missing_row", status: "unresolved" },
				{ reason: "not_reference", status: "unresolved" }
			],
			status: "ready",
			summary: { resolvedCount: 0, rowCount: 2, unresolvedCount: 2 }
		});
	});

	it("refuses to choose between duplicate source authorities", () => {
		const source = snapshot(leftPath, []);
		expect(
			buildJoinedView({
				query: { referenceFieldName: "Target", sourceTableObjectPath: leftPath },
				snapshots: [source, source]
			})
		).toMatchObject({ reason: "source_table_ambiguous", status: "unavailable" });
	});
});
