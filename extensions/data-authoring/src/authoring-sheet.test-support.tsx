import * as peculiarSheets from "peculiar-sheets";
import type { Selection, SheetController, SheetOperation, SheetProps } from "peculiar-sheets";
import { vi } from "vitest";

export function sheetSelection(row: number, col: number): Selection {
	const address = { row: peculiarSheets.visualRow(row), col: peculiarSheets.columnIdx(col) };
	return {
		anchor: address,
		focus: address,
		ranges: [{ start: address, end: address }],
		editing: null
	};
}

/** Capture the public Sheet boundary; this double does not simulate the vendor editor or menus. */
export function captureAuthoringSheet() {
	let captured: SheetProps | undefined;
	let selection = sheetSelection(0, 0);
	let visualOrder: readonly number[] | undefined;
	const props = () => {
		if (!captured) throw new Error("The authoring Sheet has not mounted.");
		return captured;
	};
	const unexpected = () => {
		throw new Error("Unexpected SheetController call in an operation-boundary test.");
	};
	const controller: SheetController = {
		getSelection: () => selection,
		getRawCellValue: (row, col) => props().data[visualOrder?.[row] ?? row]?.[col] ?? null,
		setSelection: unexpected,
		clearSelection: unexpected,
		scrollToCell: unexpected,
		startEditing: unexpected,
		stopEditing: unexpected,
		getDisplayCellValue: unexpected,
		getEditorText: unexpected,
		canInsertReference: unexpected,
		insertReferenceText: unexpected,
		setReferenceHighlight: unexpected,
		setActiveEditorValue: unexpected,
		commitActiveEditor: unexpected,
		cancelActiveEditor: unexpected,
		getCellValue: unexpected,
		setCellValue: unexpected,
		setCellValues: unexpected,
		insertRows: unexpected,
		deleteRows: unexpected,
		getColumnMeta: unexpected,
		undo: unexpected,
		redo: unexpected,
		canUndo: unexpected,
		canRedo: unexpected,
		getCanvasElement: unexpected
	};
	vi.spyOn(peculiarSheets, "Sheet").mockImplementation((sheetProps) => {
		captured = sheetProps;
		sheetProps.ref?.(controller);
		return <div role="grid" aria-label="Sheet operation test double" />;
	});
	return {
		props,
		emit: (operation: SheetOperation) => props().onOperation?.(operation),
		select: (row: number, col: number) => {
			selection = sheetSelection(row, col);
			props().onSelectionChange?.(selection);
		},
		sortRows: (order: readonly number[]) => {
			visualOrder = order;
			props().onSortChange?.({ columnId: "$row-name", direction: "desc" });
		}
	};
}
