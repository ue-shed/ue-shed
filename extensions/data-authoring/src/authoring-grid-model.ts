import type { AuthoringRow, AuthoringValue } from "@ue-shed/protocol";
import type { CellMutation, CellValue, ColumnDef, SheetOperation } from "peculiar-sheets";
import type { AuthoringColumn } from "./authoring-view.js";
import { fieldInRow, formatAuthoringValue } from "./authoring-view.js";

export interface ReadOnlyAuthoringGridModel {
	readonly columns: ColumnDef[];
	readonly data: CellValue[][];
	readonly rowKeys: string[];
}

export interface AuthoringGridEdit {
	readonly fieldName: string;
	readonly rowId: string;
	readonly value: AuthoringValue;
}

export type AuthoringGridDecodeResult =
	| { readonly status: "ready"; readonly edit: AuthoringGridEdit }
	| { readonly status: "failed"; readonly message: string };

export type AuthoringGridGesture =
	| { readonly kind: "set_cells"; readonly edits: readonly AuthoringGridEdit[] }
	| { readonly kind: "add_row"; readonly atIndex: number }
	| { readonly kind: "remove_row"; readonly rowId: string };

export type AuthoringGridOperationResult =
	| { readonly status: "ready"; readonly gesture: AuthoringGridGesture }
	| { readonly status: "ignored" }
	| { readonly status: "failed"; readonly message: string };

function isEditable(column: AuthoringColumn): boolean {
	const descriptor = column.descriptor;
	if (!descriptor || descriptor.editability.kind !== "editable") return false;
	switch (descriptor.type.kind) {
		case "scalar":
			return descriptor.type.valueKind !== "text";
		case "enum":
		case "reference":
			return true;
		default:
			return false;
	}
}

function parseEditorText(text: string, context: { readonly previousValue: CellValue }): CellValue {
	if (typeof context.previousValue === "boolean") {
		if (text.toLocaleLowerCase() === "true") return true;
		if (text.toLocaleLowerCase() === "false") return false;
	}
	return text;
}

function decodeValue(current: AuthoringValue, input: CellValue): AuthoringValue | undefined {
	switch (current.kind) {
		case "bool":
			if (typeof input === "boolean") return { kind: "bool", value: input };
			if (typeof input === "string" && /^(true|false)$/i.test(input.trim())) {
				return { kind: "bool", value: input.trim().toLocaleLowerCase() === "true" };
			}
			return undefined;
		case "int": {
			const value = String(input ?? "").trim();
			return /^-?\d+$/.test(value) ? { kind: "int", value } : undefined;
		}
		case "uint": {
			const value = String(input ?? "").trim();
			return /^\d+$/.test(value) ? { kind: "uint", value } : undefined;
		}
		case "float":
		case "double": {
			const value = typeof input === "number" ? input : Number(input);
			return Number.isFinite(value) ? { kind: current.kind, value } : undefined;
		}
		case "name":
		case "enum":
		case "string":
		case "guid":
		case "soft_object_path":
			return typeof input === "string" ? { kind: current.kind, value: input } : undefined;
		case "object_ref":
			return input === null || input === ""
				? { kind: "object_ref", value: null }
				: typeof input === "string"
					? { kind: "object_ref", value: input }
					: undefined;
		default:
			return undefined;
	}
}

export function decodeAuthoringGridMutation(args: {
	readonly mutation: CellMutation;
	readonly rows: readonly AuthoringRow[];
	readonly columns: readonly AuthoringColumn[];
}): AuthoringGridDecodeResult {
	const row = args.rows[args.mutation.address.row];
	const column = args.columns.find((candidate) => candidate.name === args.mutation.columnId);
	if (!row || !column)
		return { message: "The edited cell is outside the table.", status: "failed" };
	if (!isEditable(column)) {
		return { message: `${column.name} is read-only for this authority.`, status: "failed" };
	}
	const field = fieldInRow(row, column.name);
	if (!field)
		return { message: `${row.name}.${column.name} has no typed value.`, status: "failed" };
	const value = decodeValue(field.value, args.mutation.newValue);
	if (!value) {
		return {
			message: `${String(args.mutation.newValue)} is not valid for ${column.typeName}.`,
			status: "failed"
		};
	}
	if (column.descriptor?.type.kind === "enum") {
		const choices = column.descriptor.type.options.map(({ name }) => name);
		if (value.kind !== "enum" || !choices.includes(value.value)) {
			return { message: `Choose one of: ${choices.join(", ")}.`, status: "failed" };
		}
	}
	return { edit: { fieldName: column.name, rowId: row.id, value }, status: "ready" };
}

export function decodeAuthoringGridOperation(args: {
	readonly operation: SheetOperation;
	readonly rows: readonly AuthoringRow[];
	readonly columns: readonly AuthoringColumn[];
}): AuthoringGridOperationResult {
	const { operation } = args;
	if (operation.type === "cell-edit" || operation.type === "batch-edit") {
		const mutations =
			operation.type === "cell-edit" ? [operation.mutation] : operation.mutations;
		if (mutations.length === 0) return { status: "ignored" };
		const decoded = mutations.map((mutation) =>
			decodeAuthoringGridMutation({ columns: args.columns, mutation, rows: args.rows })
		);
		const failure = decoded.find((result) => result.status === "failed");
		if (failure?.status === "failed") return failure;
		return {
			gesture: {
				edits: decoded.flatMap((result) =>
					result.status === "ready" ? [result.edit] : []
				),
				kind: "set_cells"
			},
			status: "ready"
		};
	}
	if (operation.type === "row-insert") {
		return operation.count === 1
			? { gesture: { atIndex: operation.atIndex, kind: "add_row" }, status: "ready" }
			: {
					message: "Insert one row at a time so its Unreal row name can be validated.",
					status: "failed"
				};
	}
	if (operation.type === "row-delete") {
		const row = operation.count === 1 ? args.rows[operation.atIndex] : undefined;
		return row
			? { gesture: { kind: "remove_row", rowId: row.id }, status: "ready" }
			: {
					message: "Delete one selected row at a time after confirming data removal.",
					status: "failed"
				};
	}
	// Peculiar emits row-reorder for view sorting and its local history. Canonical DataTable order
	// changes only through the explicit service-backed Move actions.
	return { status: "ignored" };
}

export function toReadOnlyGridValue(value: AuthoringValue): CellValue {
	switch (value.kind) {
		case "bool":
			return value.value;
		case "object_ref":
			return value.value;
		default:
			return formatAuthoringValue(value);
	}
}

export function buildReadOnlyAuthoringGridModel(args: {
	readonly rows: readonly AuthoringRow[];
	readonly columns: readonly AuthoringColumn[];
}): ReadOnlyAuthoringGridModel {
	return {
		columns: args.columns.map((column) => ({
			editable: isEditable(column),
			getCellTitle: (value) => (value === null ? undefined : String(value)),
			header: column.name,
			id: column.name,
			meta: { typeName: column.typeName },
			minWidth: 140,
			parseValue: parseEditorText,
			resizable: true,
			sortable: false,
			width: 190
		})),
		data: args.rows.map((row) =>
			args.columns.map((column) => {
				const field = fieldInRow(row, column.name);
				return field ? toReadOnlyGridValue(field.value) : null;
			})
		),
		rowKeys: args.rows.map((row) => row.id)
	};
}
