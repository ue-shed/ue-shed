import type { AuthoringRow } from "@ue-shed/protocol";
import type { CellMutation } from "peculiar-sheets";
import { describe, expect, it } from "vitest";
import {
	buildReadOnlyAuthoringGridModel,
	decodeAuthoringGridOperation,
	decodeAuthoringGridMutation,
	toReadOnlyGridValue
} from "./authoring-grid-model.js";

const rows: readonly AuthoringRow[] = [
	{
		fields: [
			{ name: "Enabled", typeName: "BoolProperty", value: { kind: "bool", value: true } },
			{
				name: "Count",
				typeName: "Int64Property",
				value: { kind: "int", value: "9223372036854775807" }
			}
		],
		id: "row:Primary",
		name: "Primary"
	},
	{
		fields: [
			{
				name: "Enabled",
				typeName: "BoolProperty",
				value: { kind: "bool", value: false }
			}
		],
		id: "row:Sparse",
		name: "Sparse"
	}
];

const address = (row: number, col: number): CellMutation["address"] =>
	({ col, row }) as CellMutation["address"];

describe("read-only Peculiar Sheets model", () => {
	it("preserves stable row identity and sparse cells", () => {
		const model = buildReadOnlyAuthoringGridModel({
			columns: [
				{ name: "Enabled", typeName: "BoolProperty" },
				{ name: "Count", typeName: "Int64Property" }
			],
			rows
		});

		expect(model.rowKeys).toEqual(["row:Primary", "row:Sparse"]);
		expect(model.data).toEqual([
			[true, "9223372036854775807"],
			[false, null]
		]);
		expect(model.columns.map((column) => column.id)).toEqual(["Enabled", "Count"]);
		expect(model.columns.every((column) => column.editable === false)).toBe(true);
	});

	it("formats rich values without collapsing them into JavaScript numbers", () => {
		expect(toReadOnlyGridValue({ kind: "int", value: "9223372036854775807" })).toBe(
			"9223372036854775807"
		);
		expect(
			toReadOnlyGridValue({
				kind: "struct",
				fields: [
					{ name: "X", typeName: "DoubleProperty", value: { kind: "double", value: 1 } }
				]
			})
		).toBe("X: 1");
	});

	it("decodes exact integer edits without converting through JavaScript numbers", () => {
		const result = decodeAuthoringGridMutation({
			columns: [
				{
					descriptor: {
						annotations: { deprecated: false, readOnly: false },
						defaultValue: { status: "unknown" },
						editability: { kind: "editable" },
						id: "field:Count",
						name: "Count",
						presence: "required",
						type: { kind: "scalar", valueKind: "int" },
						typeName: "Int64Property"
					},
					name: "Count",
					typeName: "Int64Property"
				}
			],
			mutation: {
				address: address(0, 0),
				columnId: "Count",
				newValue: "90071992547409931234",
				oldValue: "9223372036854775807",
				source: "paste"
			},
			rows
		});
		expect(result).toEqual({
			edit: {
				fieldName: "Count",
				rowId: "row:Primary",
				value: { kind: "int", value: "90071992547409931234" }
			},
			status: "ready"
		});
	});

	it("rejects an entire pasted gesture when one cell is invalid", () => {
		const columns = [
			{
				descriptor: {
					annotations: { deprecated: false, readOnly: false },
					defaultValue: { status: "unknown" as const },
					editability: { kind: "editable" as const },
					id: "field:Count",
					name: "Count",
					presence: "required" as const,
					type: { kind: "scalar" as const, valueKind: "int" as const },
					typeName: "Int64Property"
				},
				name: "Count",
				typeName: "Int64Property"
			}
		];
		const result = decodeAuthoringGridOperation({
			columns,
			operation: {
				mutations: [
					{
						address: address(0, 0),
						columnId: "Count",
						newValue: "2",
						oldValue: "1",
						source: "paste"
					},
					{
						address: address(0, 0),
						columnId: "Count",
						newValue: "not-an-integer",
						oldValue: "1",
						source: "paste"
					}
				],
				type: "batch-edit"
			},
			rows
		});
		expect(result.status).toBe("failed");
	});

	it("rejects edits to fields without editable schema evidence", () => {
		const result = decodeAuthoringGridMutation({
			columns: [{ name: "Count", typeName: "Int64Property" }],
			mutation: {
				address: address(0, 0),
				columnId: "Count",
				newValue: "2",
				oldValue: "1",
				source: "user"
			},
			rows
		});
		expect(result.status).toBe("failed");
	});

	it("keeps view sorting separate from canonical row reorder", () => {
		const result = decodeAuthoringGridOperation({
			columns: [{ name: "Enabled", typeName: "BoolProperty" }],
			operation: {
				mutation: {
					columnId: "Enabled",
					direction: "asc",
					indexOrder: [],
					newOrder: [],
					oldOrder: [],
					source: "sort"
				},
				type: "row-reorder"
			},
			rows
		});
		expect(result).toEqual({ status: "ignored" });
	});

	it("decodes single structural gestures by stable row identity", () => {
		expect(
			decodeAuthoringGridOperation({
				columns: [],
				operation: { atIndex: 1, count: 1, type: "row-delete" },
				rows
			})
		).toEqual({ gesture: { kind: "remove_row", rowId: "row:Sparse" }, status: "ready" });
		expect(
			decodeAuthoringGridOperation({
				columns: [],
				operation: { atIndex: 1, count: 1, type: "row-insert" },
				rows
			})
		).toEqual({ gesture: { atIndex: 1, kind: "add_row" }, status: "ready" });
	});
});
