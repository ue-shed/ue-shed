import * as stylex from "@stylexjs/stylex";
import type { SavedProperty, SavedPropertyValue } from "@ue-shed/protocol";
import { For, Show, createMemo, createSignal } from "solid-js";
import { countLabel } from "./count-label.js";
import { styles } from "./styles.js";

const CHILD_LIMIT = 200;
const DEPTH_LIMIT = 64;

/** Human-readable scalar evidence, including the provenance of text and opaque values. */
export function inspectionValueSummary(value: SavedPropertyValue): string {
	switch (value.value_kind) {
		case "bool":
			return value.value ? "true" : "false";
		case "int":
		case "uint":
		case "float":
		case "double":
			return value.value === null ? "non-finite number" : String(value.value);
		case "name":
		case "enum":
		case "string":
		case "guid":
		case "soft_object_path":
			return value.value;
		case "text": {
			const identity =
				value.history === "base"
					? ` · ${value.namespace} / ${value.key}${value.dev_notes ? ` · ${value.dev_notes}` : ""}`
					: value.history === "string_table"
						? ` · ${value.table_id} / ${value.key}`
						: "";
			return `${value.value} (${value.history}${identity})`;
		}
		case "object_ref":
			return value.value ?? "None";
		case "data_table_row_handle":
			return `${value.table_object_path ?? "None"} / ${value.row_name}`;
		case "vector":
			return `X ${value.x} · Y ${value.y} · Z ${value.z}`;
		case "int_point":
			return `X ${value.x} · Y ${value.y}`;
		case "rotator":
			return `Pitch ${value.pitch} · Yaw ${value.yaw} · Roll ${value.roll}`;
		case "color":
		case "linear_color":
			return `R ${value.r} · G ${value.g} · B ${value.b} · A ${value.a}`;
		case "raw":
			return `${countLabel(value.size, "opaque byte")} · ${value.reason}`;
		case "array":
		case "set":
			return countLabel(value.values.length, "item");
		case "map":
			return countLabel(value.entries.length, "entry", "entries");
		case "struct":
			return countLabel(value.properties.length, "property", "properties");
		case "native_struct":
			return countLabel(value.fields.length, "field");
		case "instanced_struct":
			return `${value.struct_type ?? "None"} · ${countLabel(value.size, "byte")}`;
	}
}

interface ValueChild {
	readonly label: string;
	readonly type?: string;
	readonly value: SavedPropertyValue;
}

function children(value: SavedPropertyValue): readonly ValueChild[] {
	switch (value.value_kind) {
		case "struct":
			return value.properties.map((item) => ({
				label: item.name,
				type: item.type,
				value: item
			}));
		case "native_struct":
			return value.fields.map((item) => ({ label: item.name, value: item.value }));
		case "instanced_struct":
			return value.value === null ? [] : [{ label: "Value", value: value.value }];
		case "array":
		case "set":
			return value.values.map((item, index) => ({ label: `[${index}]`, value: item }));
		case "map":
			return value.entries.flatMap((entry, index) => [
				{ label: `[${index}] Key`, value: entry.key },
				{ label: `[${index}] Value`, value: entry.value }
			]);
		default:
			return [];
	}
}

export function inspectionValueMatches(
	value: SavedPropertyValue,
	query: string,
	depth = 0
): boolean {
	if (query === "" || inspectionValueSummary(value).toLowerCase().includes(query)) return true;
	if (value.value_kind.includes(query)) return true;
	if (depth >= DEPTH_LIMIT) return false;
	return children(value).some(
		(child) =>
			child.label.toLowerCase().includes(query) ||
			(child.type ?? "").toLowerCase().includes(query) ||
			inspectionValueMatches(child.value, query, depth + 1)
	);
}

export function propertyMatches(property: SavedProperty, query: string): boolean {
	return (
		property.name.toLowerCase().includes(query) ||
		property.type.toLowerCase().includes(query) ||
		inspectionValueMatches(property, query)
	);
}

/** Preserve the Unreal property type; add a kind only when it supplies missing detail. */
export function inspectionValueType(value: SavedPropertyValue, type?: string): string {
	const kind = value.value_kind.replaceAll("_", " ");
	if (type === undefined) return kind;
	return (type === "StructProperty" && value.value_kind !== "struct") ||
		["raw", "native_struct", "instanced_struct"].includes(value.value_kind)
		? `${type} · ${kind}`
		: type;
}

interface ValueViewProps {
	readonly value: SavedPropertyValue;
	readonly label?: string | undefined;
	readonly type?: string | undefined;
	readonly query?: string | undefined;
	readonly depth?: number | undefined;
	/** Table cells inherit their column's type and row divider. */
	readonly cell?: boolean | undefined;
}

interface ValueHeadingProps extends ValueViewProps {
	readonly expandable?: boolean | undefined;
	readonly expanded?: boolean | undefined;
}

function ValueHeading(props: ValueHeadingProps) {
	const type = createMemo(() => inspectionValueType(props.value, props.type));
	const objectPath = createMemo(() =>
		props.value.value_kind === "object_ref" ? props.value.value : null
	);
	return (
		<div {...stylex.attrs(!props.cell && styles.propertyRow, props.cell && styles.cellHeading)}>
			<Show when={!props.cell}>
				<span {...stylex.attrs(styles.propertyLabel)}>
					<Show when={props.expandable}>
						<span aria-hidden="true">{props.expanded ? "▾" : "▸"}</span>
					</Show>
					<strong title={props.label} {...stylex.attrs(styles.propertyName)}>
						{props.label}
					</strong>
					<small {...stylex.attrs(styles.typeTag)}>{type()}</small>
				</span>
			</Show>
			<Show when={props.cell && props.expandable}>
				<span aria-hidden="true">{props.expanded ? "▾" : "▸"}</span>
			</Show>
			<span {...stylex.attrs(styles.value)}>
				<Show when={objectPath()} fallback={inspectionValueSummary(props.value)}>
					{(path) => (
						<span title={path()}>
							<strong {...stylex.attrs(styles.referenceName)}>
								{path().split(/[/.:]/).at(-1)}
							</strong>{" "}
							<small {...stylex.attrs(styles.typeTag)}>{path()}</small>
						</span>
					)}
				</Show>
			</span>
		</div>
	);
}

export function InspectionValueView(props: ValueViewProps) {
	const depth = createMemo(() => props.depth ?? 0);
	const [expanded, setExpanded] = createSignal(false);
	const childQuery = createMemo(() =>
		(props.label ?? "").toLowerCase().includes(props.query ?? "") ||
		(props.type ?? "").toLowerCase().includes(props.query ?? "") ||
		props.value.value_kind.includes(props.query ?? "")
			? ""
			: (props.query ?? "")
	);
	const all = createMemo(() => children(props.value));
	const visible = createMemo(() => {
		const query = childQuery();
		return inspectionValueSummary(props.value).toLowerCase().includes(query)
			? all()
			: all().filter(
					(child) =>
						child.label.toLowerCase().includes(query) ||
						(child.type ?? "").toLowerCase().includes(query) ||
						inspectionValueMatches(child.value, query)
				);
	});
	return (
		<Show
			when={all().length > 0}
			fallback={
				<div
					{...stylex.attrs(
						!props.cell && styles.property,
						props.cell && styles.cellValue
					)}
				>
					<ValueHeading
						value={props.value}
						label={props.label}
						type={props.type}
						cell={props.cell}
					/>
				</div>
			}
		>
			<details
				open={expanded() || (props.query ?? "") !== ""}
				onToggle={(event) => setExpanded(event.currentTarget.open)}
				{...stylex.attrs(!props.cell && styles.property, props.cell && styles.cellValue)}
			>
				<summary {...stylex.attrs(styles.propertySummary)}>
					<ValueHeading
						value={props.value}
						label={props.label}
						type={props.type}
						cell={props.cell}
						expandable
						expanded={expanded() || (props.query ?? "") !== ""}
					/>
				</summary>
				<Show when={expanded() || (props.query ?? "") !== ""}>
					<Show
						when={depth() < DEPTH_LIMIT}
						fallback={<p>Nested display limited to 64 levels.</p>}
					>
						<div
							{...stylex.attrs(styles.children, depth() >= 8 && styles.childrenFlat)}
						>
							<For each={visible().slice(0, CHILD_LIMIT)}>
								{(child) => (
									<InspectionValueView
										value={child.value}
										label={child.label}
										type={child.type}
										query={childQuery()}
										depth={depth() + 1}
									/>
								)}
							</For>
							<Show when={visible().length > CHILD_LIMIT}>
								<p {...stylex.attrs(styles.quiet)}>
									Showing the first 200 child values.
								</p>
							</Show>
						</div>
					</Show>
				</Show>
			</details>
		</Show>
	);
}

export function PropertyTree(props: {
	readonly properties: readonly SavedProperty[];
	readonly query?: string;
}) {
	const visible = createMemo(() =>
		props.properties.filter((item) => propertyMatches(item, props.query ?? ""))
	);
	return (
		<div aria-label="Saved properties">
			<For
				each={visible().slice(0, CHILD_LIMIT)}
				fallback={
					<Show when={props.properties.length > 0 && (props.query ?? "") !== ""}>
						<p {...stylex.attrs(styles.quiet)}>No matching properties.</p>
					</Show>
				}
			>
				{(item) => (
					<InspectionValueView
						value={item}
						label={item.name}
						type={item.type}
						query={props.query ?? ""}
					/>
				)}
			</For>
			<Show when={visible().length > CHILD_LIMIT}>
				<p {...stylex.attrs(styles.quiet)}>Showing the first 200 matching properties.</p>
			</Show>
		</div>
	);
}
