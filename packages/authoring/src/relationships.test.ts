import type { AuthoringRow, AuthoringTableSnapshotV1, AuthoringValue } from "@ue-shed/protocol";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
	RowReferenceReport,
	inspectRowReferences,
	makeRowReferenceReport,
	rowReferenceDiagnostics
} from "./relationships.js";

function snapshot(objectPath: string, rows: readonly AuthoringRow[]): AuthoringTableSnapshotV1 {
	const packageName = objectPath.slice(0, objectPath.lastIndexOf("."));
	return {
		authority: { kind: "project_files", packageName },
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

function row(name: string, value?: AuthoringValue): AuthoringRow {
	return {
		fields: value === undefined ? [] : [{ name: "Target", typeName: "StructProperty", value }],
		id: `row:${name}`,
		name
	};
}

const leftPath = "/Game/Fixture/DT_Left.DT_Left";
const rightPath = "/Game/Fixture/DT_Right.DT_Right";

describe("DataTable row relationships", () => {
	it("resolves native row handles to one authoritative target row", () => {
		const edges = inspectRowReferences([
			snapshot(leftPath, [
				row("Left", {
					kind: "row_reference",
					rowName: "Right",
					tableObjectPath: rightPath
				})
			]),
			snapshot(rightPath, [row("Right")])
		]);

		expect(edges).toEqual([
			expect.objectContaining({
				status: "resolved",
				target: { rowName: "Right", tableObjectPath: rightPath },
				targetRowId: "row:Right"
			})
		]);
		expect(rowReferenceDiagnostics(edges)).toEqual([]);
	});

	it("finds handles nested in containers without losing cell provenance", () => {
		const edges = inspectRowReferences([
			snapshot(leftPath, [
				row("Left", {
					kind: "array",
					values: [
						{
							kind: "row_reference",
							rowName: "Right",
							tableObjectPath: rightPath
						}
					]
				})
			]),
			snapshot(rightPath, [row("Right")])
		]);

		expect(edges[0]?.source).toMatchObject({
			fieldName: "Target",
			rowId: "row:Left",
			tableObjectPath: leftPath,
			valuePath: ["array:0"]
		});
	});

	it("reports missing tables, rows, and unassigned handles with recovery guidance", () => {
		const edges = inspectRowReferences([
			snapshot(leftPath, [
				row("NoTable", {
					kind: "row_reference",
					rowName: "Right",
					tableObjectPath: "/Game/Missing.DT_Missing"
				}),
				row("NoRow", {
					kind: "row_reference",
					rowName: "Missing",
					tableObjectPath: rightPath
				}),
				row("Empty", {
					kind: "row_reference",
					rowName: "None",
					tableObjectPath: null
				})
			]),
			snapshot(rightPath, [row("Right")])
		]);

		expect(edges.map((edge) => edge.status)).toEqual([
			"missing_table",
			"missing_row",
			"unassigned"
		]);
		expect(rowReferenceDiagnostics(edges).map((diagnostic) => diagnostic.code)).toEqual([
			"row_reference_missing_table",
			"row_reference_missing_row",
			"row_reference_unassigned"
		]);
		expect(
			rowReferenceDiagnostics(edges).every((diagnostic) => diagnostic.recovery.length > 0)
		).toBe(true);
	});

	it("refuses to resolve duplicate table authorities or duplicate row names", () => {
		const reference = row("Left", {
			kind: "row_reference",
			rowName: "Right",
			tableObjectPath: rightPath
		});
		const ambiguousTable = inspectRowReferences([
			snapshot(leftPath, [reference]),
			snapshot(rightPath, [row("Right")]),
			snapshot(rightPath, [row("Right")])
		]);
		const ambiguousRow = inspectRowReferences([
			snapshot(leftPath, [reference]),
			snapshot(rightPath, [row("Right"), row("Right")])
		]);

		expect(ambiguousTable[0]).toMatchObject({ matchCount: 2, status: "ambiguous_table" });
		expect(ambiguousRow[0]).toMatchObject({ matchCount: 2, status: "ambiguous_row" });
	});

	it("emits a runtime-validated versioned headless report", () => {
		const report = makeRowReferenceReport([
			snapshot(leftPath, [
				row("Left", {
					kind: "row_reference",
					rowName: "Right",
					tableObjectPath: rightPath
				})
			]),
			snapshot(rightPath, [row("Right")])
		]);

		expect(Schema.decodeUnknownSync(RowReferenceReport)(report)).toEqual(report);
		expect(report.summary).toEqual({
			issueCount: 0,
			referenceCount: 1,
			resolvedCount: 1,
			snapshotCount: 2
		});
	});
});
