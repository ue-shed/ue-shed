import * as stylex from "@stylexjs/stylex";
import type { AuthoringRow } from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Sheet, rowId, type Selection, type SheetOperation } from "peculiar-sheets";
import "peculiar-sheets/styles";
import { createMemo } from "solid-js";
import {
	buildReadOnlyAuthoringGridModel,
	decodeAuthoringGridOperation,
	type AuthoringGridGesture
} from "./authoring-grid-model.js";
import type { AuthoringColumn } from "./authoring-view.js";

export interface AuthoringGridSelection {
	readonly fieldName: string;
	readonly rowId: string;
}

export interface AuthoringTableGridProps {
	readonly rows: readonly AuthoringRow[];
	readonly columns: readonly AuthoringColumn[];
	readonly disabled?: boolean;
	readonly dirtyCells?:
		| readonly { readonly fieldName: string; readonly rowId: string }[]
		| undefined;
	readonly dirtyRowIds?: readonly string[] | undefined;
	readonly onGesture?: (gesture: AuthoringGridGesture) => void;
	readonly onEditFailure?: (message: string) => void;
	readonly onSelectionChange?: (selection: AuthoringGridSelection | undefined) => void;
}

export function AuthoringTableGrid(props: AuthoringTableGridProps) {
	const model = createMemo(() =>
		buildReadOnlyAuthoringGridModel({ columns: props.columns, rows: props.rows })
	);
	const dirtyCells = createMemo(
		() =>
			new Set((props.dirtyCells ?? []).map((cell) => `${cell.rowId}\u0000${cell.fieldName}`))
	);
	const dirtyRows = createMemo(() => new Set(props.dirtyRowIds ?? []));

	const handleSelection = (selection: Selection) => {
		const row = props.rows[selection.focus.row];
		const column = props.columns[selection.focus.col];
		props.onSelectionChange?.(
			row && column ? { fieldName: column.name, rowId: row.id } : undefined
		);
	};

	const handleOperation = (operation: SheetOperation) => {
		const result = decodeAuthoringGridOperation({
			columns: props.columns,
			operation,
			rows: props.rows
		});
		if (result.status === "failed") props.onEditFailure?.(result.message);
		else if (result.status === "ready") props.onGesture?.(result.gesture);
	};

	return (
		<div {...stylex.props(styles.frame)}>
			<Sheet
				columns={model().columns}
				customization={{
					getCellStyle: (rowIndex, columnIndex) => {
						const row = props.rows[rowIndex];
						const column = props.columns[columnIndex];
						return row && column && dirtyCells().has(`${row.id}\u0000${column.name}`)
							? { background: "#253020", boxShadow: "inset 0 0 0 1px #91bd65" }
							: undefined;
					},
					getRowHeaderLabel: (index) => {
						const row = props.rows[index];
						if (!row) return String(index + 1);
						return `${dirtyRows().has(row.id) ? "● " : ""}${row.name}`;
					},
					getRowHeaderSublabel: (index) =>
						dirtyRows().has(props.rows[index]?.id ?? "") ? "DIRTY ROW" : "ROW"
				}}
				data={model().data}
				onOperation={handleOperation}
				onSelectionChange={handleSelection}
				readOnly={props.disabled ?? false}
				rowIds={model().rowKeys.map(rowId)}
				showFormulaBar={false}
				showReferenceHeaders={false}
				sortBehavior="view"
			/>
		</div>
	);
}

const styles = stylex.create({
	frame: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		height: "min(68vh, 760px)",
		minHeight: 420,
		overflow: "hidden"
	}
});
