import * as stylex from "@stylexjs/stylex";
import type { AuthoringRow } from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import {
	Sheet,
	rowId,
	type ColumnDef,
	type Selection,
	type SheetController,
	type SheetOperation
} from "peculiar-sheets";
import "peculiar-sheets/styles";
import { createMemo, onCleanup } from "solid-js";
import {
	AUTHORING_ROW_NAME_COLUMN_ID,
	AUTHORING_ROW_NAME_COLUMN_INDEX,
	authoringModelColumnIndex,
	authoringRowAtVisualIndex,
	buildReadOnlyAuthoringGridModel,
	decodeAuthoringSheetOperation,
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
	readonly readOnly?: boolean;
	readonly dirtyCells?:
		| readonly { readonly fieldName: string; readonly rowId: string }[]
		| undefined;
	readonly dirtyRowIds?: readonly string[] | undefined;
	readonly onGesture?: (gesture: AuthoringGridGesture) => void;
	readonly onEditFailure?: (message: string) => void;
	readonly onSelectionChange?: (selection: AuthoringGridSelection | undefined) => void;
}

export function AuthoringTableGrid(props: AuthoringTableGridProps) {
	let controller: SheetController | undefined;
	onCleanup(() => {
		controller = undefined;
	});
	const visualRow = (index: number) =>
		authoringRowAtVisualIndex(
			props.rows,
			index,
			controller?.getRawCellValue(index, AUTHORING_ROW_NAME_COLUMN_INDEX)
		);
	const model = createMemo(() =>
		buildReadOnlyAuthoringGridModel({
			columns: props.columns,
			rows: props.rows,
			readOnly: props.readOnly ?? false
		})
	);
	const dirtyCells = createMemo(
		() =>
			new Set((props.dirtyCells ?? []).map((cell) => `${cell.rowId}\u0000${cell.fieldName}`))
	);
	const dirtyRows = createMemo(() => new Set(props.dirtyRowIds ?? []));
	const sheetColumns = createMemo<ColumnDef[]>(() => [
		{
			id: AUTHORING_ROW_NAME_COLUMN_ID,
			header: "Row",
			editable: false,
			pinned: "left",
			resizable: true,
			sortable: true,
			minWidth: 120,
			maxWidth: 280,
			width: Math.min(
				280,
				Math.max(
					120,
					props.rows.reduce((length, row) => Math.max(length, row.name.length), 3) * 7 +
						(dirtyRows().size > 0 ? 76 : 28)
				)
			),
			renderCell: (context) => (
				<span
					role="rowheader"
					aria-label={context.formattedText}
					aria-readonly="true"
					{...stylex.attrs(styles.rowName)}
				>
					<span {...stylex.attrs(styles.rowLabel)}>{context.formattedText}</span>
					{dirtyRows().has(
						authoringRowAtVisualIndex(props.rows, context.row, context.value)?.id ?? ""
					) && (
						<span aria-hidden="true" {...stylex.attrs(styles.edited)}>
							edited
						</span>
					)}
				</span>
			)
		},
		...model().columns
	]);
	const sheetData = createMemo(() =>
		model().data.map((values, index) => [props.rows[index]?.name ?? "", ...values])
	);

	const handleSelection = (selection: Selection) => {
		const row = visualRow(selection.focus.row);
		const columnIndex =
			selection.focus.col === AUTHORING_ROW_NAME_COLUMN_INDEX
				? 0
				: authoringModelColumnIndex(selection.focus.col);
		const column = columnIndex === undefined ? undefined : props.columns[columnIndex];
		props.onSelectionChange?.(
			row && column ? { fieldName: column.name, rowId: row.id } : undefined
		);
	};

	const handleOperation = (operation: SheetOperation) => {
		if (props.readOnly || props.disabled) return;
		const result = decodeAuthoringSheetOperation({
			columns: props.columns,
			operation,
			rows: props.rows
		});
		if (result.status === "failed") props.onEditFailure?.(result.message);
		else if (result.status === "ready") props.onGesture?.(result.gesture);
	};

	return (
		<div
			{...stylex.attrs(styles.frame)}
			style={`height: min(70vh, ${52 + Math.max(1, props.rows.length) * 28}px)`}
		>
			<Sheet
				ref={(value) => {
					controller = value;
				}}
				columns={sheetColumns()}
				customization={{
					getCellStyle: (rowIndex, columnIndex) => {
						const row = visualRow(rowIndex);
						if (columnIndex === AUTHORING_ROW_NAME_COLUMN_INDEX) {
							return row && dirtyRows().has(row.id)
								? { background: tokens.colorAccentWash }
								: undefined;
						}
						const modelIndex = authoringModelColumnIndex(columnIndex);
						const column =
							modelIndex === undefined ? undefined : props.columns[modelIndex];
						return row && column && dirtyCells().has(`${row.id}\u0000${column.name}`)
							? {
									background: tokens.colorAccentWash,
									boxShadow: `inset 0 0 0 1px ${tokens.colorAccent}`
								}
							: undefined;
					}
				}}
				data={sheetData()}
				onOperation={handleOperation}
				onSelectionChange={handleSelection}
				onSortChange={() => {
					queueMicrotask(() => {
						if (controller) handleSelection(controller.getSelection());
					});
				}}
				readOnly={props.readOnly || props.disabled || false}
				rowIds={model().rowKeys.map(rowId)}
				rowHeight={28}
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
		maxHeight: "70vh",
		marginTop: tokens.space2,
		overflow: "hidden",
		minWidth: 0
	},
	rowName: {
		alignItems: "center",
		color: tokens.colorTextMuted,
		display: "flex",
		fontSize: 12,
		fontWeight: 500,
		gap: tokens.space2,
		minWidth: 0,
		width: "100%"
	},
	rowLabel: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	edited: {
		color: tokens.colorAccent,
		flexShrink: 0,
		fontSize: 10,
		fontWeight: 500
	}
});
