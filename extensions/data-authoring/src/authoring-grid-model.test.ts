import type { AuthoringRow } from "@ue-shed/protocol";
import type { CellMutation, SheetOperation } from "peculiar-sheets";
import { describe, expect, it } from "vitest";
import {
	authoringModelColumnIndex,
	authoringRowAtVisualIndex,
	buildReadOnlyAuthoringGridModel,
	decodeAuthoringGridOperation,
	decodeAuthoringGridMutation,
	decodeAuthoringSheetOperation,
	projectAuthoringSheetOperation,
	toReadOnlyGridValue
} from "./authoring-grid-model.js";
import type { AuthoringColumn } from "./authoring-view.js";

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

// SAFETY: Peculiar Sheets brands plain integer row/column coordinates without a public constructor.
const address = (row: number, col: number): CellMutation["address"] =>
	({ col, row }) as CellMutation["address"];

const countColumn: AuthoringColumn = {
	name: "Count",
	typeName: "Int64Property",
	descriptor: {
		annotations: { deprecated: false, readOnly: false },
		defaultValue: { status: "unknown" },
		editability: { kind: "editable" },
		id: "field:Count",
		name: "Count",
		presence: "required",
		type: { kind: "scalar", valueKind: "int" },
		typeName: "Int64Property"
	}
};

const sheetMutation: CellMutation = {
	address: address(0, 1),
	columnId: "Count",
	newValue: "13",
	oldValue: "9223372036854775807",
	source: "user"
};

describe("authoring sheet coordinates", () => {
	it("maps only field columns into model coordinates", () => {
		expect(authoringModelColumnIndex(0)).toBeUndefined();
		expect(authoringModelColumnIndex(1)).toBe(0);
		expect(authoringModelColumnIndex(5)).toBe(4);
		expect(authoringModelColumnIndex(-1)).toBeUndefined();
		expect(authoringModelColumnIndex(1.5)).toBeUndefined();
	});

	it("translates physical and visual addresses without mutating sheet operations", () => {
		// SAFETY: these integer coordinates use Peculiar's distinct visual-row brand.
		const viewAddress = { col: 1, row: 1 } as NonNullable<CellMutation["viewAddress"]>;
		const operation: SheetOperation = {
			type: "cell-edit",
			mutation: { ...sheetMutation, viewAddress }
		};
		expect(projectAuthoringSheetOperation(operation)).toEqual({
			status: "ready",
			operation: {
				type: "cell-edit",
				mutation: {
					...sheetMutation,
					address: address(0, 0),
					viewAddress: { col: 0, row: 1 }
				}
			}
		});
		expect(operation.mutation.address.col).toBe(1);
		expect(operation.mutation.viewAddress?.col).toBe(1);
	});

	it.each(["user", "paste", "delete", "formula", "external", "fill"] as const)(
		"maps %s mutations through the same decoding boundary",
		(source) => {
			expect(
				decodeAuthoringSheetOperation({
					columns: [countColumn],
					operation: { type: "cell-edit", mutation: { ...sheetMutation, source } },
					rows
				})
			).toEqual({
				status: "ready",
				gesture: {
					kind: "set_cells",
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Primary",
							value: { kind: "int", value: "13" }
						}
					]
				}
			});
		}
	);

	it("rejects the whole paste when it includes the pinned name column", () => {
		const result = decodeAuthoringSheetOperation({
			columns: [countColumn],
			operation: {
				type: "batch-edit",
				mutations: [
					{ ...sheetMutation, source: "paste" },
					{
						...sheetMutation,
						address: address(0, 0),
						columnId: "$row-name",
						newValue: "Renamed",
						source: "paste"
					}
				]
			},
			rows
		});
		expect(result).toEqual({
			message: "Row names are read-only in the grid.",
			status: "failed"
		});
	});

	it("accepts paste after the sheet skips its read-only name cells", () => {
		const enabledColumn: AuthoringColumn = {
			...countColumn,
			name: "Enabled",
			typeName: "BoolProperty",
			descriptor: {
				...countColumn.descriptor!,
				id: "field:Enabled",
				name: "Enabled",
				typeName: "BoolProperty",
				type: { kind: "scalar", valueKind: "bool" }
			}
		};
		const result = decodeAuthoringSheetOperation({
			columns: [enabledColumn, countColumn],
			operation: {
				type: "batch-edit",
				mutations: [
					{
						...sheetMutation,
						columnId: "Enabled",
						newValue: false,
						oldValue: true,
						source: "paste"
					},
					{ ...sheetMutation, address: address(0, 2), source: "paste" }
				]
			},
			rows
		});
		expect(result).toEqual({
			status: "ready",
			gesture: {
				kind: "set_cells",
				edits: [
					{
						fieldName: "Enabled",
						rowId: "row:Primary",
						value: { kind: "bool", value: false }
					},
					{
						fieldName: "Count",
						rowId: "row:Primary",
						value: { kind: "int", value: "13" }
					}
				]
			}
		});
	});

	it("rejects mismatched IDs and name targets even with a field coordinate", () => {
		for (const columnId of ["$row-name", "Enabled"]) {
			expect(
				decodeAuthoringSheetOperation({
					columns: [countColumn],
					operation: { type: "cell-edit", mutation: { ...sheetMutation, columnId } },
					rows
				}).status
			).toBe("failed");
		}
	});

	it("resolves sorted selections and mutations by stable row identity", () => {
		expect(authoringRowAtVisualIndex(rows, 0, "Sparse")?.id).toBe("row:Sparse");
		expect(authoringRowAtVisualIndex(rows, 1, "Primary")?.id).toBe("row:Primary");
		expect(authoringRowAtVisualIndex(rows, 0, "Removed")).toBeUndefined();
		// SAFETY: fixture row IDs use the same string representation as Peculiar's row-ID brand.
		const rowId = rows[0]!.id as NonNullable<CellMutation["rowId"]>;
		expect(
			decodeAuthoringSheetOperation({
				columns: [countColumn],
				operation: {
					type: "cell-edit",
					mutation: { ...sheetMutation, rowId }
				},
				rows: [...rows].reverse()
			})
		).toMatchObject({
			status: "ready",
			gesture: { edits: [{ rowId: "row:Primary" }] }
		});
		expect(
			decodeAuthoringSheetOperation({
				columns: [countColumn],
				operation: { type: "cell-edit", mutation: { ...sheetMutation, rowId } },
				rows: [rows[1]!]
			}).status
		).toBe("failed");
	});

	it("preserves structural operations and ignores view-only name sorting", () => {
		const deletion: SheetOperation = { type: "row-delete", atIndex: 1, count: 1 };
		expect(projectAuthoringSheetOperation(deletion)).toEqual({
			operation: deletion,
			status: "ready"
		});
		expect(decodeAuthoringSheetOperation({ columns: [], operation: deletion, rows })).toEqual({
			status: "ready",
			gesture: { kind: "remove_row", rowId: "row:Sparse" }
		});
		expect(
			decodeAuthoringSheetOperation({
				columns: [],
				operation: {
					type: "row-reorder",
					mutation: {
						columnId: "$row-name",
						direction: "desc",
						indexOrder: [],
						newOrder: [],
						oldOrder: [],
						source: "sort"
					}
				},
				rows
			})
		).toEqual({ status: "ignored" });
	});
});

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

	it("sizes numeric and string columns from content within scrolling bounds", () => {
		const model = buildReadOnlyAuthoringGridModel({
			columns: [
				{ name: "Count", typeName: "IntProperty" },
				{ name: "Notes", typeName: "StrProperty" }
			],
			rows: [
				{
					id: "row:Primary",
					name: "Primary",
					fields: [
						{
							name: "Count",
							typeName: "IntProperty",
							value: { kind: "int", value: "7" }
						},
						{
							name: "Notes",
							typeName: "StrProperty",
							value: {
								kind: "string",
								value: "First deterministic scalar row with notes"
							}
						}
					]
				}
			]
		});
		expect(model.columns[0]?.width).toBe(96);
		expect(model.columns[1]?.width).toBeGreaterThan(190);
		expect(model.columns[1]?.width).toBeLessThanOrEqual(360);
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
