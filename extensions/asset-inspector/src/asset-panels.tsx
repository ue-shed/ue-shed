import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo } from "solid-js";
import type { AssetInspection, InspectedAsset } from "./contract.js";
import {
	InspectionValueView,
	PropertyTree,
	inspectionValueMatches,
	inspectionValueType,
	propertyMatches
} from "./property-tree.js";
import { styles } from "./styles.js";
import { countLabel } from "./count-label.js";

const ROW_LIMIT = 200;
const COLUMN_LIMIT = 50;
const WRAPPING_VALUE_KINDS = new Set([
	"string",
	"text",
	"raw",
	"object_ref",
	"soft_object_path",
	"data_table_row_handle",
	"struct",
	"native_struct",
	"instanced_struct",
	"array",
	"map",
	"set"
]);

export function shortObjectName(path: string): string {
	return path.split(/[/.:]/).at(-1) || path;
}

export function exportCount(asset: InspectedAsset): string {
	switch (asset.kind) {
		case "StringTable":
			return countLabel(asset.string_table_entries.length, "entry", "entries");
		case "Enum":
			return countLabel(asset.enum_entries.length, "entry", "entries");
		case "Struct":
			return countLabel(asset.struct_fields.length, "field");
		case "Skeleton":
			return countLabel(asset.bones.length, "bone");
		case "DataTable":
		case "CompositeDataTable":
			return countLabel(asset.row_count, "row");
		case "CurveTable":
			return countLabel(asset.curve_rows.length, "row");
		default:
			return countLabel(asset.properties.length, "prop");
	}
}

export function inspectionClassPath(asset: InspectedAsset | undefined): string {
	if (asset === undefined) return "";
	if (asset.class_path !== undefined) return asset.class_path;
	switch (asset.kind) {
		case "StringTable":
			return "/Script/Engine.StringTable";
		case "DataTable":
			return "/Script/Engine.DataTable";
		case "CompositeDataTable":
			return "/Script/Engine.CompositeDataTable";
		case "Enum":
			return "/Script/Engine.UserDefinedEnum";
		case "Struct":
			return "/Script/Engine.UserDefinedStruct";
		case "UObject":
			return "/Script/CoreUObject.Object";
		default:
			return asset.kind;
	}
}

function matches(query: string, ...values: readonly (string | undefined)[]): boolean {
	return values.some((value) => value?.toLowerCase().includes(query));
}

/** Search decoded evidence, never serialized JSON or file bytes. */
export function assetMatches(asset: InspectedAsset, query: string): boolean {
	if (matches(query, asset.kind, asset.object_path, asset.class_path)) return true;
	if (asset.properties.some((property) => propertyMatches(property, query))) return true;
	if (asset.native_data && inspectionValueMatches(asset.native_data, query)) return true;
	switch (asset.kind) {
		case "StringTable":
			return (
				matches(query, asset.string_table_namespace) ||
				asset.string_table_entries.some((entry) =>
					matches(query, entry.key, entry.source, entry.dev_notes)
				)
			);
		case "Enum":
			return asset.enum_entries.some((entry) =>
				matches(query, entry.name, String(entry.value), entry.display_name)
			);
		case "Struct":
			return asset.struct_fields.some((field) =>
				matches(query, field.name, field.type, field.display_name, field.referenced_path)
			);
		case "Skeleton":
			return asset.bones.some((bone) => matches(query, bone.name, String(bone.parent_index)));
		case "DataTable":
		case "CompositeDataTable":
			return (
				matches(query, asset.row_struct, ...(asset.parent_tables ?? [])) ||
				asset.rows.some(
					(row) =>
						matches(query, row.name) ||
						row.properties.some((item) => propertyMatches(item, query))
				)
			);
		case "CurveTable":
			return asset.curve_rows.some(
				(row) =>
					matches(query, row.name) ||
					row.keys.some((key) => matches(query, String(key.time), String(key.value)))
			);
		default:
			return false;
	}
}

function EvidenceTable(props: {
	readonly label: string;
	readonly headers: readonly string[];
	readonly rows: readonly (readonly JSX.Element[])[];
	readonly columnKinds?: readonly ("scalar" | "text")[];
}) {
	return (
		<>
			<div {...stylex.attrs(styles.scroll)}>
				<table aria-label={props.label} {...stylex.attrs(styles.table)}>
					<thead>
						<tr>
							<For each={props.headers}>
								{(header) => (
									<th
										scope="col"
										{...stylex.attrs(styles.cell, styles.scalarCell)}
									>
										{header}
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={props.rows.slice(0, ROW_LIMIT)}>
							{(row) => (
								<tr>
									<For each={row}>
										{(cell, index) => {
											const longText = createMemo(
												() => props.columnKinds?.[index()] === "text"
											);
											return (
												<td
													{...stylex.attrs(
														styles.cell,
														longText()
															? styles.textCell
															: styles.scalarCell
													)}
												>
													{cell}
												</td>
											);
										}}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
			<Show when={props.rows.length > ROW_LIMIT}>
				<p {...stylex.attrs(styles.quiet)}>
					Showing the first 200 of {props.rows.length} matching rows.
				</p>
			</Show>
			<Show when={props.rows.length === 0}>
				<p {...stylex.attrs(styles.quiet)}>No matching rows.</p>
			</Show>
		</>
	);
}

function DataRows(props: {
	readonly asset: Extract<InspectedAsset, { readonly kind: "DataTable" | "CompositeDataTable" }>;
	readonly query: string;
}) {
	const rows = createMemo(() =>
		props.asset.rows.filter(
			(row) =>
				matches(props.query, row.name) ||
				row.properties.some((item) => propertyMatches(item, props.query))
		)
	);
	const allColumns = createMemo(() => {
		const columns = new Map<string, string>();
		for (const row of props.asset.rows) {
			for (const property of row.properties) {
				if (!columns.has(property.name)) columns.set(property.name, "");
				const isNull = "value" in property && property.value === null;
				if (columns.get(property.name) === "" && !isNull) {
					columns.set(property.name, inspectionValueType(property, property.type));
				}
			}
		}
		return [...columns].map(([name, type]) => ({ name, type }));
	});
	const columns = createMemo(() => allColumns().slice(0, COLUMN_LIMIT));
	return (
		<>
			<p {...stylex.attrs(styles.quiet)}>
				Row struct: {props.asset.row_struct ?? "Not saved"} ·{" "}
				{countLabel(props.asset.row_count, "row")}
			</p>
			<Show when={(props.asset.parent_tables?.length ?? 0) > 0}>
				<p {...stylex.attrs(styles.mono)}>
					Parent tables: {props.asset.parent_tables?.join(", ")}
				</p>
			</Show>
			<div {...stylex.attrs(styles.scroll)}>
				<table aria-label="DataTable rows" {...stylex.attrs(styles.table)}>
					<thead>
						<tr>
							<th scope="col" {...stylex.attrs(styles.cell, styles.scalarCell)}>
								Row
							</th>
							<For each={columns()}>
								{(column) => (
									<th
										scope="col"
										{...stylex.attrs(styles.cell, styles.scalarCell)}
									>
										{column.name}{" "}
										<small {...stylex.attrs(styles.typeTag)}>
											{column.type}
										</small>
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={rows().slice(0, ROW_LIMIT)}>
							{(row) => (
								<tr>
									<th
										scope="row"
										{...stylex.attrs(styles.cell, styles.scalarCell)}
									>
										{row.name}
									</th>
									<For each={columns()}>
										{(column) => {
											const property = row.properties.find(
												(item) => item.name === column.name
											);
											const longText = createMemo(
												() =>
													property !== undefined &&
													WRAPPING_VALUE_KINDS.has(property.value_kind)
											);
											return (
												<td
													{...stylex.attrs(
														styles.cell,
														longText()
															? styles.textCell
															: styles.scalarCell
													)}
												>
													{property === undefined ? (
														"—"
													) : (
														<InspectionValueView
															value={property}
															cell
															query={
																row.name
																	.toLowerCase()
																	.includes(props.query)
																	? ""
																	: props.query
															}
														/>
													)}
												</td>
											);
										}}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
			<Show when={rows().length > ROW_LIMIT}>
				<p {...stylex.attrs(styles.quiet)}>
					Showing the first 200 of {rows().length} matching rows.
				</p>
			</Show>
			<Show when={allColumns().length > COLUMN_LIMIT}>
				<p {...stylex.attrs(styles.quiet)}>
					Showing the first 50 of {allColumns().length} columns.
				</p>
			</Show>
			<Show when={rows().length === 0}>
				<p {...stylex.attrs(styles.quiet)}>No matching rows.</p>
			</Show>
		</>
	);
}

function CurveRows(props: {
	readonly asset: Extract<InspectedAsset, { readonly kind: "CurveTable" }>;
	readonly query: string;
}) {
	const rows = createMemo(() =>
		props.asset.curve_rows.filter(
			(row) =>
				matches(props.query, row.name) ||
				row.keys.some((key) => matches(props.query, String(key.time), String(key.value)))
		)
	);
	return (
		<>
			<For
				each={rows().slice(0, ROW_LIMIT)}
				fallback={<p {...stylex.attrs(styles.quiet)}>No matching curves.</p>}
			>
				{(row) => (
					<details>
						<summary>
							{row.name} · {countLabel(row.keys.length, "key")}
						</summary>
						<EvidenceTable
							label={`Curve ${row.name}`}
							headers={["Time", "Value"]}
							rows={row.keys.map((key) => [String(key.time), String(key.value)])}
						/>
					</details>
				)}
			</For>
			<Show when={rows().length > ROW_LIMIT}>
				<p {...stylex.attrs(styles.quiet)}>
					Showing the first 200 of {rows().length} matching curves.
				</p>
			</Show>
		</>
	);
}

/** Iterative preorder also retains orphaned and cyclic records without recursive rendering. */
function boneHierarchy(bones: readonly { readonly name: string; readonly parent_index: number }[]) {
	const byParent = new Map<number, number[]>();
	for (const [index, bone] of bones.entries()) {
		const parent =
			bone.parent_index >= 0 &&
			bone.parent_index < bones.length &&
			bone.parent_index !== index
				? bone.parent_index
				: -1;
		const siblings = byParent.get(parent) ?? [];
		siblings.push(index);
		byParent.set(parent, siblings);
	}
	const ordered: { readonly index: number; readonly depth: number }[] = [];
	const seen = new Set<number>();
	const visit = (root: number) => {
		const stack = [{ index: root, depth: 0 }];
		while (stack.length > 0) {
			const next = stack.pop();
			if (next === undefined || seen.has(next.index)) continue;
			seen.add(next.index);
			ordered.push(next);
			for (const child of [...(byParent.get(next.index) ?? [])].reverse()) {
				stack.push({ index: child, depth: next.depth + 1 });
			}
		}
	};
	for (const root of byParent.get(-1) ?? []) visit(root);
	for (let index = 0; index < bones.length; index += 1) {
		if (!seen.has(index)) visit(index);
	}
	return ordered;
}

function KindPanel(props: { readonly asset: InspectedAsset; readonly query: string }) {
	// Assets are immutable decoded records; For creates a new panel for a replacement record.
	const asset = props.asset;
	switch (asset.kind) {
		case "StringTable": {
			const hasNotes = asset.string_table_entries.some(
				(entry) => entry.dev_notes.trim() !== ""
			);
			return (
				<>
					<p {...stylex.attrs(styles.quiet)}>Namespace: {asset.string_table_namespace}</p>
					<EvidenceTable
						label="String table entries"
						columnKinds={["scalar", "text", "text"]}
						headers={
							hasNotes ? ["Key", "Source", "Developer notes"] : ["Key", "Source"]
						}
						rows={asset.string_table_entries
							.filter((entry) =>
								matches(props.query, entry.key, entry.source, entry.dev_notes)
							)
							.map((entry) =>
								hasNotes
									? [entry.key, entry.source, entry.dev_notes]
									: [entry.key, entry.source]
							)}
					/>
					<Show when={asset.string_table_metadata !== undefined}>
						<details>
							<summary>String table metadata</summary>
							<MetadataRecords records={asset.string_table_metadata ?? {}} />
						</details>
					</Show>
				</>
			);
		}
		case "Enum":
			return (
				<EvidenceTable
					label="Enum entries"
					columnKinds={["scalar", "scalar", "text"]}
					headers={["Name", "Value", "Display name"]}
					rows={asset.enum_entries
						.filter((entry) =>
							matches(
								props.query,
								entry.name,
								String(entry.value),
								entry.display_name
							)
						)
						.map((entry) => [
							entry.name,
							String(entry.value),
							entry.display_name ?? "—"
						])}
				/>
			);
		case "Struct":
			return (
				<EvidenceTable
					label="Struct fields"
					columnKinds={["scalar", "scalar", "text", "text"]}
					headers={["Field", "Type", "Display name", "Referenced path"]}
					rows={asset.struct_fields
						.filter((field) =>
							matches(
								props.query,
								field.name,
								field.type,
								field.display_name,
								field.referenced_path
							)
						)
						.map((field) => [
							field.name,
							field.type,
							field.display_name ?? "—",
							field.referenced_path ?? "—"
						])}
				/>
			);
		case "DataTable":
		case "CompositeDataTable":
			return <DataRows asset={asset} query={props.query} />;
		case "CurveTable":
			return <CurveRows asset={asset} query={props.query} />;
		case "Skeleton":
			return (
				<>
					<EvidenceTable
						label="Skeleton bones"
						headers={["Bone hierarchy"]}
						rows={boneHierarchy(asset.bones)
							.filter((item) =>
								matches(
									props.query,
									asset.bones[item.index]?.name,
									String(asset.bones[item.index]?.parent_index)
								)
							)
							.map((item) => {
								const bone = asset.bones[item.index];
								return [
									<span style={`padding-left:${Math.min(item.depth, 12) * 12}px`}>
										{item.depth > 0 ? "↳ " : ""}
										{bone?.name}
										<small {...stylex.attrs(styles.typeTag)}>
											{" · "}
											{item.index}
										</small>
									</span>
								];
							})}
					/>
					<Show when={asset.reference_pose}>
						{(pose) => (
							<InspectionValueView
								label="Reference pose"
								value={pose()}
								query={props.query}
							/>
						)}
					</Show>
				</>
			);
		default:
			return null;
	}
}

export function MetadataRecords(props: {
	readonly records: Readonly<Record<string, Readonly<Record<string, string>>>>;
}) {
	return (
		<For each={Object.entries(props.records)}>
			{([name, values]) => (
				<details>
					<summary {...stylex.attrs(styles.mono)}>{name}</summary>
					<EvidenceTable
						label={`Metadata ${name}`}
						columnKinds={["scalar", "text"]}
						headers={["Key", "Value"]}
						rows={Object.entries(values)}
					/>
				</details>
			)}
		</For>
	);
}

export function PackageHeaderPanel(props: { readonly header: AssetInspection["package"] }) {
	return (
		<details {...stylex.attrs(styles.disclosure)}>
			<summary>Package header</summary>
			<p {...stylex.attrs(styles.quiet)}>
				Legacy file version: {props.header.version.legacy_file} · UE3:{" "}
				{props.header.version.legacy_ue3 ?? "Not serialized"}
			</p>
			<p {...stylex.attrs(styles.quiet)}>
				Flags: 0x{props.header.package_flags.toString(16)} · Summary:{" "}
				{countLabel(props.header.summary_size, "byte")}
			</p>
			<EvidenceTable
				label="Package tables"
				headers={["Table", "Count", "Byte offset"]}
				rows={[
					["Names", String(props.header.names.count), String(props.header.names.offset)],
					[
						"Imports",
						String(props.header.imports.count),
						String(props.header.imports.offset)
					],
					[
						"Exports",
						String(props.header.exports.count),
						String(props.header.exports.offset)
					]
				]}
			/>
			<Show when={props.header.soft_object_paths}>
				{(paths) => (
					<p {...stylex.attrs(styles.quiet)}>
						Soft object paths: {paths().count} · Parsed: {paths().parsed_count}
						{" · "}Offset: {paths().offset}
					</p>
				)}
			</Show>
		</details>
	);
}

export function AssetPanel(props: { readonly asset: InspectedAsset; readonly query: string }) {
	const query = createMemo(() =>
		matches(props.query, props.asset.object_path, props.asset.kind, props.asset.class_path)
			? ""
			: props.query
	);
	const nativeData = createMemo(() => {
		const value = props.asset.native_data;
		return value !== undefined && inspectionValueMatches(value, query()) ? value : undefined;
	});
	return (
		<section aria-label={props.asset.object_path} {...stylex.attrs(styles.detail)}>
			<div {...stylex.attrs(styles.detailHeader)}>
				<span title={inspectionClassPath(props.asset)} {...stylex.attrs(styles.classChip)}>
					{shortObjectName(inspectionClassPath(props.asset))}
				</span>
				<code
					title={props.asset.object_path}
					{...stylex.attrs(styles.mono, styles.truncate)}
				>
					{props.asset.object_path}
				</code>
			</div>
			<Show when={props.asset.object_guid}>
				<p {...stylex.attrs(styles.quiet)}>Object GUID: {props.asset.object_guid}</p>
			</Show>
			<KindPanel asset={props.asset} query={query()} />
			<Show when={props.asset.properties.some((item) => propertyMatches(item, query()))}>
				<PropertyTree properties={props.asset.properties} query={query()} />
			</Show>
			<Show when={nativeData()}>
				{(value) => (
					<InspectionValueView label="Native data" value={value()} query={query()} />
				)}
			</Show>
			<Show when={(props.asset.tail_bytes ?? 0) > 0}>
				<p {...stylex.attrs(styles.quiet)}>
					{countLabel(props.asset.tail_bytes ?? 0, "opaque tail byte")} · Class-specific
					payload remains undecoded.
				</p>
			</Show>
		</section>
	);
}
