// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { columnIdx, physicalRow, rowId, visualRow, type CellMutation } from "peculiar-sheets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAuthoringSheet } from "./authoring-sheet.test-support.js";
import { AuthoringTableGrid } from "./authoring-table-grid.js";
import type { AuthoringColumn } from "./authoring-view.js";
import { viewerSnapshot } from "./viewer-fixture.test-support.js";

const columns: readonly AuthoringColumn[] = [
	{
		name: "Enabled",
		typeName: "BoolProperty",
		descriptor: {
			id: "field:Enabled",
			name: "Enabled",
			typeName: "BoolProperty",
			presence: "required",
			type: { kind: "scalar", valueKind: "bool" },
			annotations: { deprecated: false, readOnly: false },
			defaultValue: { status: "unknown" },
			editability: { kind: "editable" }
		}
	},
	{
		name: "Count",
		typeName: "IntProperty",
		descriptor: {
			id: "field:Count",
			name: "Count",
			typeName: "IntProperty",
			presence: "required",
			type: { kind: "scalar", valueKind: "int" },
			annotations: { deprecated: false, readOnly: false },
			defaultValue: { status: "unknown" },
			editability: { kind: "editable" }
		}
	}
];

const countEdit: CellMutation = {
	address: { row: physicalRow(0), col: columnIdx(2) },
	viewAddress: { row: visualRow(0), col: columnIdx(2) },
	rowId: rowId("row:Scalar_Alpha"),
	columnId: "Count",
	oldValue: "12",
	newValue: "13",
	source: "user"
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("authoring Sheet operation boundary", () => {
	it("pins read-only names and maps physical field columns through the real handler", () => {
		const sheet = captureAuthoringSheet();
		const onGesture = vi.fn();
		const onSelection = vi.fn();
		render(() => (
			<AuthoringTableGrid
				rows={viewerSnapshot.table.rows}
				columns={columns}
				onGesture={onGesture}
				onSelectionChange={onSelection}
			/>
		));
		expect(sheet.props().columns.map((column) => column.id)).toEqual([
			"$row-name",
			"Enabled",
			"Count"
		]);
		expect(sheet.props().columns[0]).toMatchObject({ editable: false, pinned: "left" });
		expect(sheet.props().columns[2]?.editable).toBe(true);
		expect(sheet.props().sortBehavior).toBe("view");
		expect(sheet.props().data[0]).toEqual(["Scalar_Alpha", true, "12"]);
		sheet.select(0, 0);
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Enabled",
			rowId: "row:Scalar_Alpha"
		});
		sheet.select(0, 1);
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Enabled",
			rowId: "row:Scalar_Alpha"
		});
		sheet.select(0, 2);
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Count",
			rowId: "row:Scalar_Alpha"
		});
		sheet.emit({ type: "cell-edit", mutation: countEdit });
		expect(onGesture).toHaveBeenCalledOnce();
		expect(onGesture).toHaveBeenCalledWith({
			kind: "set_cells",
			edits: [
				{
					fieldName: "Count",
					rowId: "row:Scalar_Alpha",
					value: { kind: "int", value: "13" }
				}
			]
		});
	});

	it("rejects an entire paste that writes the name column, then accepts skipped name cells", () => {
		const sheet = captureAuthoringSheet();
		const onGesture = vi.fn();
		const onEditFailure = vi.fn();
		render(() => (
			<AuthoringTableGrid
				rows={viewerSnapshot.table.rows}
				columns={columns}
				onGesture={onGesture}
				onEditFailure={onEditFailure}
			/>
		));
		const enabledEdit: CellMutation = {
			...countEdit,
			address: { row: physicalRow(0), col: columnIdx(1) },
			viewAddress: { row: visualRow(0), col: columnIdx(1) },
			columnId: "Enabled",
			oldValue: true,
			newValue: false,
			source: "paste"
		};
		const pastedCount = { ...countEdit, source: "paste" as const };
		sheet.emit({
			type: "batch-edit",
			mutations: [
				{
					...countEdit,
					address: { row: physicalRow(0), col: columnIdx(0) },
					viewAddress: { row: visualRow(0), col: columnIdx(0) },
					columnId: "$row-name",
					oldValue: "Scalar_Alpha",
					newValue: "Renamed",
					source: "paste"
				},
				enabledEdit,
				pastedCount
			]
		});
		expect(onGesture).not.toHaveBeenCalled();
		expect(onEditFailure).toHaveBeenCalledOnce();
		expect(onEditFailure).toHaveBeenCalledWith("Row names are read-only in the grid.");
		expect(sheet.props().data[0]?.[0]).toBe("Scalar_Alpha");
		// Peculiar's paste builder skips editable:false columns; it emits only the field writes.
		sheet.emit({ type: "batch-edit", mutations: [enabledEdit, pastedCount] });
		expect(onGesture).toHaveBeenCalledOnce();
		expect(onGesture).toHaveBeenCalledWith({
			kind: "set_cells",
			edits: [
				{
					fieldName: "Enabled",
					rowId: "row:Scalar_Alpha",
					value: { kind: "bool", value: false }
				},
				{
					fieldName: "Count",
					rowId: "row:Scalar_Alpha",
					value: { kind: "int", value: "13" }
				}
			]
		});
	});

	it.each(["readOnly", "disabled"] as const)("blocks operations when %s", (guard) => {
		const sheet = captureAuthoringSheet();
		const onGesture = vi.fn();
		const onEditFailure = vi.fn();
		render(() => (
			<AuthoringTableGrid
				rows={viewerSnapshot.table.rows}
				columns={columns}
				readOnly={guard === "readOnly"}
				disabled={guard === "disabled"}
				onGesture={onGesture}
				onEditFailure={onEditFailure}
			/>
		));
		expect(sheet.props().readOnly).toBe(true);
		sheet.emit({ type: "cell-edit", mutation: countEdit });
		expect(onGesture).not.toHaveBeenCalled();
		expect(onEditFailure).not.toHaveBeenCalled();
	});

	it("maps sorted selections, dirty cells and edits by row identity", async () => {
		const sheet = captureAuthoringSheet();
		const onGesture = vi.fn();
		const onSelection = vi.fn();
		render(() => (
			<AuthoringTableGrid
				rows={viewerSnapshot.table.rows}
				columns={columns}
				dirtyRowIds={["row:Scalar_Alpha"]}
				dirtyCells={[{ fieldName: "Count", rowId: "row:Scalar_Alpha" }]}
				onGesture={onGesture}
				onSelectionChange={onSelection}
			/>
		));
		sheet.sortRows([1, 0]);
		await Promise.resolve();
		const renderName = sheet.props().columns[0]?.renderCell;
		render(() => (
			<div>
				{renderName?.({
					row: 0,
					col: 0,
					value: "Scalar_Beta",
					formattedText: "Scalar_Beta",
					readOnly: true,
					isEditing: false
				})}
				{renderName?.({
					row: 1,
					col: 0,
					value: "Scalar_Alpha",
					formattedText: "Scalar_Alpha",
					readOnly: true,
					isEditing: false
				})}
			</div>
		));
		expect(
			within(screen.getByRole("rowheader", { name: "Scalar_Alpha" })).getByText("edited")
		).toBeTruthy();
		expect(
			within(screen.getByRole("rowheader", { name: "Scalar_Beta" })).queryByText("edited")
		).toBeNull();
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Enabled",
			rowId: "row:Scalar_Beta"
		});
		expect(onGesture).not.toHaveBeenCalled();
		const getStyle = sheet.props().customization?.getCellStyle;
		expect(getStyle?.(0, 0)).toBeUndefined();
		expect(getStyle?.(1, 0)?.background).toBeTruthy();
		expect(getStyle?.(1, 1)).toBeUndefined();
		expect(getStyle?.(0, 2)).toBeUndefined();
		expect(getStyle?.(1, 2)).toMatchObject({ boxShadow: expect.any(String) });
		sheet.select(0, 2);
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Count",
			rowId: "row:Scalar_Beta"
		});
		sheet.emit({
			type: "cell-edit",
			mutation: {
				...countEdit,
				address: { row: physicalRow(1), col: columnIdx(2) },
				viewAddress: { row: visualRow(0), col: columnIdx(2) },
				rowId: rowId("row:Scalar_Beta"),
				oldValue: "24",
				newValue: "25"
			}
		});
		expect(onGesture).toHaveBeenCalledOnce();
		expect(onGesture).toHaveBeenCalledWith({
			kind: "set_cells",
			edits: [
				{
					fieldName: "Count",
					rowId: "row:Scalar_Beta",
					value: { kind: "int", value: "25" }
				}
			]
		});
	});
});
