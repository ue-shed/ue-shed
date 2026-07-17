import type {
	AuthoringFieldValue,
	AuthoringFieldDescriptor,
	AuthoringRow,
	AuthoringTableSnapshot,
	AuthoringValue
} from "@ue-shed/protocol";

export interface AuthoringColumn {
	readonly name: string;
	readonly typeName: string;
	readonly descriptor?: AuthoringFieldDescriptor;
}

export function tableColumns(snapshot: AuthoringTableSnapshot): readonly AuthoringColumn[] {
	if ("producer" in snapshot && snapshot.table.schema.status === "available") {
		return snapshot.table.schema.fields.map((descriptor) => ({
			descriptor,
			name: descriptor.name,
			typeName: descriptor.typeName
		}));
	}
	const columns = new Map<string, string>();
	for (const row of snapshot.table.rows) {
		for (const field of row.fields) {
			if (!columns.has(field.name)) columns.set(field.name, field.typeName);
		}
	}
	return [...columns].map(([name, typeName]) => ({ name, typeName }));
}

export function fieldInRow(row: AuthoringRow, name: string): AuthoringFieldValue | undefined {
	return row.fields.find((field) => field.name === name);
}

export function filterRows(rows: readonly AuthoringRow[], query: string): readonly AuthoringRow[] {
	const normalized = query.trim().toLocaleLowerCase();
	if (normalized.length === 0) return rows;
	return rows.filter(
		(row) =>
			row.name.toLocaleLowerCase().includes(normalized) ||
			row.fields.some((field) =>
				formatAuthoringValue(field.value).toLocaleLowerCase().includes(normalized)
			)
	);
}

export function formatAuthoringValue(value: AuthoringValue): string {
	switch (value.kind) {
		case "bool":
			return value.value ? "True" : "False";
		case "int":
		case "uint":
		case "float":
		case "double":
		case "name":
		case "enum":
		case "string":
		case "text":
		case "guid":
		case "soft_object_path":
			return String(value.value);
		case "object_ref":
			return value.value ?? "None";
		case "row_reference":
			return `${value.tableObjectPath ?? "None"} → ${value.rowName}`;
		case "vector":
			return `X ${value.x} · Y ${value.y} · Z ${value.z}`;
		case "array":
			return `[${value.values.map(formatAuthoringValue).join(", ")}]`;
		case "set":
			return `{${value.values.map(formatAuthoringValue).join(", ")}}`;
		case "map":
			return value.entries
				.map(
					(entry) =>
						`${formatAuthoringValue(entry.key)} → ${formatAuthoringValue(entry.value)}`
				)
				.join(", ");
		case "struct":
			return value.fields
				.map((field) => `${field.name}: ${formatAuthoringValue(field.value)}`)
				.join(" · ");
		case "unsupported":
			return `Unsupported · ${value.reason}`;
	}
}

export function valueSummary(value: AuthoringValue): string {
	switch (value.kind) {
		case "array":
		case "set":
			return `${value.values.length} ${value.kind === "array" ? "items" : "members"}`;
		case "map":
			return `${value.entries.length} entries`;
		case "struct":
			return `${value.fields.length} fields`;
		case "row_reference":
			return "row reference";
		case "unsupported":
			return `${value.byteSize} opaque bytes`;
		default:
			return value.kind.replaceAll("_", " ");
	}
}
