import * as stylex from "@stylexjs/stylex";
import type {
	TextFilter,
	TextFilterClause,
	TextFilterField,
	TextGroupList
} from "@ue-shed/game-text/browser";
import { AnchoredPopover, Button } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import {
	CHOICE_FIELDS,
	FIELD_LABELS,
	clauseParts,
	hasValue,
	toggleValue,
	type ChoiceField
} from "./game-text-filter-model.js";

/** Counts the menu shows beside each value, when the page has them. */
export interface FilterCounts {
	readonly choices: Partial<Record<ChoiceField, Readonly<Record<string, number>>>>;
	readonly folders: TextGroupList | undefined;
	readonly assets: TextGroupList | undefined;
}

/** A field that is not a clause yet, such as review state: one choice at a time. */
export interface ExtraField {
	readonly key: string;
	readonly label: string;
	readonly options: readonly {
		readonly label: string;
		readonly count: number | undefined;
		readonly selected: boolean;
		readonly onSelect: () => void;
	}[];
}

interface Option {
	readonly key: string;
	readonly label: string;
	readonly count: number | undefined;
	readonly selected: boolean;
	readonly select: () => void;
}

interface Field {
	readonly key: string;
	readonly label: string;
	/** Values for a submenu filtered by its own typed text. */
	readonly options: (typed: string) => readonly Option[];
}

const CHOICE_ORDER: readonly ChoiceField[] = ["problem", "translation", "finding"];
const AFTER_PLACES: readonly ChoiceField[] = ["origin"];
const ATTRIBUTES: readonly ChoiceField[] = ["editing", "notes"];

const matches = (typed: string, text: string) => {
	const needle = typed.trim().toLocaleLowerCase();
	return needle === "" || text.toLocaleLowerCase().includes(needle);
};

/**
 * One entry point for every filter: fields first, each opening a submenu of its values with counts.
 * Typing at the first level finds values across every field. Each value toggles its pill; a pill's
 * operator switches between "is" and "is not".
 */
export function FilterMenu(props: {
	readonly filter: TextFilter;
	readonly counts: FilterCounts;
	readonly hasTarget: boolean;
	readonly disabled: boolean;
	readonly onChange: (filter: TextFilter) => void;
	readonly extraFields?: readonly ExtraField[];
}) {
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	const [typed, setTyped] = createSignal("");
	const [active, setActive] = createSignal<string>();
	const [subTyped, setSubTyped] = createSignal("");
	const [subTop, setSubTop] = createSignal(0);
	const toggle = (field: TextFilterField, value: string) => {
		const clause = makeClause(field, value);
		if (clause !== undefined) props.onChange(toggleValue(props.filter, clause));
	};
	const chosen = (field: TextFilterField, value: string) =>
		hasValue(props.filter, field, value) || hasValue(props.filter, field, value, "is_not");
	const choiceField = (field: ChoiceField): Field => ({
		key: field,
		label: FIELD_LABELS[field],
		options: (text) => {
			// Counts follow every pill, so once a field has one its other values would read 0;
			// the problem counts already leave their own field out.
			const narrowed =
				field !== "problem" && props.filter.some((clause) => clause.field === field);
			const counts = narrowed ? undefined : props.counts.choices[field];
			const labels: Readonly<Record<string, string>> = CHOICE_FIELDS[field].labels;
			return CHOICE_FIELDS[field].values.flatMap((value: string): Option[] => {
				const label = labels[value] ?? value;
				const count = counts?.[value];
				if (!matches(text, label)) return [];
				// Values with nothing in them stay out unless already chosen.
				if (count === 0 && !chosen(field, value)) return [];
				return [
					{
						key: `${field}:${value}`,
						label,
						count,
						selected: chosen(field, value),
						select: () => toggle(field, value)
					}
				];
			});
		}
	});
	const placeField = (field: "folder" | "asset"): Field => ({
		key: field,
		label: FIELD_LABELS[field],
		options: (text) => {
			const list = field === "folder" ? props.counts.folders : props.counts.assets;
			const found = (list?.entries ?? [])
				.filter((entry) => matches(text, entry.label))
				.map((entry): Option => {
					const value = field === "folder" ? entry.key + "/" : entry.key;
					return {
						key: `${field}:${value}`,
						label: entry.label,
						count: entry.count,
						selected: chosen(field, value),
						select: () => toggle(field, value)
					};
				});
			const needle = text.trim();
			// A typed folder filters by prefix even when it is not listed at this level.
			return field === "folder" && needle !== ""
				? [
						...found,
						{
							key: `folder-typed:${needle}`,
							label: `Starts with ${needle}`,
							count: undefined,
							selected: chosen("folder", needle),
							select: () => toggle("folder", needle)
						}
					]
				: found;
		}
	});
	const extraField = (field: ExtraField): Field => ({
		key: field.key,
		label: field.label,
		options: (text) =>
			field.options
				.filter((option) => matches(text, option.label))
				.filter((option) => option.selected || option.count !== 0)
				.map((option, index) => ({
					key: `${field.key}:${index}`,
					label: option.label,
					count: option.count,
					selected: option.selected,
					select: option.onSelect
				}))
	});
	// Sections in menu order: problems, places, attributes, and fields that are not clauses yet.
	const sections = createMemo((): readonly (readonly Field[])[] => [
		CHOICE_ORDER.filter((field) => props.hasTarget || field !== "translation").map(choiceField),
		[placeField("folder"), placeField("asset"), ...AFTER_PLACES.map(choiceField)],
		ATTRIBUTES.map(choiceField),
		(props.extraFields ?? []).map(extraField)
	]);
	const fields = () => sections().flat();
	const activeField = () => fields().find((field) => field.key === active());
	// Typing at the first level lists matching values from every field, labelled by field.
	const found = createMemo(() =>
		typed().trim() === ""
			? []
			: fields().flatMap((field) => {
					const options = field.options(matches(typed(), field.label) ? "" : typed());
					return options.length === 0 ? [] : [{ field, options }];
				})
	);
	const openField = (key: string, row: HTMLElement) => {
		if (active() !== key) setSubTyped("");
		setActive(key);
		setSubTop(row.offsetTop);
	};
	return (
		<AnchoredPopover
			id={id}
			ariaLabel="Filter"
			open={open()}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setTyped("");
					setActive(undefined);
				}
			}}
			placement="bottom-end"
			style={styles.panel}
			trigger={(trigger) => (
				<Button
					{...trigger}
					type="button"
					size="compact"
					disabled={props.disabled}
					aria-keyshortcuts="F"
				>
					Filter
				</Button>
			)}
		>
			<input
				type="search"
				aria-label="Filter by"
				placeholder="Filter…"
				value={typed()}
				onInput={(event) => {
					setTyped(event.currentTarget.value);
					setActive(undefined);
				}}
				{...stylex.attrs(styles.typed)}
			/>
			<Show
				when={typed().trim() === ""}
				fallback={
					<div {...stylex.attrs(styles.scroll)}>
						<For each={found()}>
							{(section) => (
								<div role="group" aria-label={section.field.label}>
									<div {...stylex.attrs(styles.head)}>{section.field.label}</div>
									<OptionRows options={section.options} />
								</div>
							)}
						</For>
						<Show when={found().length === 0}>
							<p {...stylex.attrs(styles.none)}>Nothing matches.</p>
						</Show>
					</div>
				}
			>
				<div role="menu" aria-label="Filter fields" {...stylex.attrs(styles.fields)}>
					<For each={sections().filter((section) => section.length > 0)}>
						{(section, index) => (
							<div {...stylex.attrs(styles.section, index() > 0 && styles.divided)}>
								<For each={section}>
									{(field) => (
										<button
											type="button"
											role="menuitem"
											aria-haspopup="menu"
											aria-expanded={
												active() === field.key ? "true" : "false"
											}
											onPointerEnter={(event) =>
												openField(field.key, event.currentTarget)
											}
											onClick={(event) =>
												openField(field.key, event.currentTarget)
											}
											onKeyDown={(event) => {
												if (
													event.key === "ArrowRight" ||
													event.key === "Enter"
												)
													openField(field.key, event.currentTarget);
											}}
											{...stylex.attrs(
												styles.field,
												active() === field.key && styles.fieldOn
											)}
										>
											<span {...stylex.attrs(styles.label)}>
												{field.label}
											</span>
											<Show
												when={
													field
														.options("")
														.filter((option) => option.selected).length
												}
											>
												{(count) => (
													<span {...stylex.attrs(styles.count)}>
														{count()}
													</span>
												)}
											</Show>
											<span
												aria-hidden="true"
												{...stylex.attrs(styles.arrow)}
											>
												▸
											</span>
										</button>
									)}
								</For>
							</div>
						)}
					</For>
				</div>
			</Show>
			<Show when={activeField()}>
				{(field) => (
					<div
						role="menu"
						aria-label={field().label}
						onKeyDown={(event) => {
							if (event.key === "ArrowLeft" || event.key === "Escape") {
								event.stopPropagation();
								setActive(undefined);
							}
						}}
						{...stylex.attrs(styles.submenu)}
						style={{ top: `${subTop()}px` }}
					>
						<input
							type="search"
							aria-label={`Filter ${field().label}`}
							placeholder="Filter…"
							value={subTyped()}
							onInput={(event) => setSubTyped(event.currentTarget.value)}
							{...stylex.attrs(styles.typed, styles.subTyped)}
						/>
						<div {...stylex.attrs(styles.scroll)}>
							<OptionRows options={field().options(subTyped())} />
							<Show when={field().options(subTyped()).length === 0}>
								<p {...stylex.attrs(styles.none)}>Nothing here.</p>
							</Show>
						</div>
					</div>
				)}
			</Show>
		</AnchoredPopover>
	);
}

function OptionRows(props: { readonly options: readonly Option[] }) {
	return (
		<For each={props.options}>
			{(option) => (
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={option.selected ? "true" : "false"}
					aria-label={
						option.count === undefined
							? option.label
							: `${option.label} ${option.count.toLocaleString()}`
					}
					onClick={() => option.select()}
					{...stylex.attrs(styles.option)}
				>
					<span
						aria-hidden="true"
						{...stylex.attrs(styles.box, option.selected && styles.boxOn)}
					>
						{option.selected ? "✓" : ""}
					</span>
					<span {...stylex.attrs(styles.label)}>{option.label}</span>
					<Show when={option.count !== undefined}>
						<span {...stylex.attrs(styles.count)}>
							{option.count?.toLocaleString()}
						</span>
					</Show>
				</button>
			)}
		</For>
	);
}

function makeClause(field: TextFilterField, value: string): TextFilterClause | undefined {
	switch (field) {
		case "folder":
		case "asset":
		case "namespace":
			return { field, op: "is", values: [value] };
		default: {
			const clause = fromChoice(field, value);
			return clause.values.length === 0 ? undefined : clause;
		}
	}
}

/** A one-value clause; the value is kept only when it is one of the field's literals. */
function fromChoice(field: ChoiceField, value: string): TextFilterClause {
	const same = (item: string) => item === value;
	const op = "is";
	switch (field) {
		case "problem":
			return { field, op, values: CHOICE_FIELDS.problem.values.filter(same) };
		case "translation":
			return { field, op, values: CHOICE_FIELDS.translation.values.filter(same) };
		case "finding":
			return { field, op, values: CHOICE_FIELDS.finding.values.filter(same) };
		case "origin":
			return { field, op, values: CHOICE_FIELDS.origin.values.filter(same) };
		case "editing":
			return { field, op, values: CHOICE_FIELDS.editing.values.filter(same) };
		case "notes":
			return { field, op, values: CHOICE_FIELDS.notes.values.filter(same) };
	}
}

/**
 * The active clauses as pills: "Problem | is any of | Key changed, Not gathered yet | ×". The
 * operator switches between "is" and "is not".
 */
export function FilterPills(props: {
	readonly filter: TextFilter;
	readonly onChange: (filter: TextFilter) => void;
}) {
	const flip = (index: number) =>
		props.onChange(
			props.filter.map((clause, position) =>
				position === index
					? { ...clause, op: clause.op === "is" ? ("is_not" as const) : ("is" as const) }
					: clause
			)
		);
	return (
		<Show when={props.filter.length > 0}>
			<div role="list" aria-label="Filters" {...stylex.attrs(styles.pills)}>
				<For each={props.filter}>
					{(clause, index) => {
						const parts = () => clauseParts(clause);
						return (
							<span role="listitem" {...stylex.attrs(styles.pill)}>
								<span {...stylex.attrs(styles.pillPart)}>{parts().field}</span>
								<button
									type="button"
									title={clause.op === "is" ? "Switch to is not" : "Switch to is"}
									onClick={() => flip(index())}
									{...stylex.attrs(styles.pillPart, styles.pillOp)}
								>
									{parts().op}
								</button>
								<span {...stylex.attrs(styles.pillPart, styles.pillValue)}>
									{parts().values}
								</span>
								<button
									type="button"
									aria-label={`Remove ${parts().field} ${parts().op} ${parts().values}`}
									onClick={() =>
										props.onChange(
											props.filter.filter(
												(_, position) => position !== index()
											)
										)
									}
									{...stylex.attrs(styles.pillPart, styles.pillRemove)}
								>
									×
								</button>
							</span>
						);
					}}
				</For>
				<Show when={props.filter.length > 1}>
					<Button
						type="button"
						size="compact"
						tone="quiet"
						onClick={() => props.onChange([])}
					>
						Clear filters
					</Button>
				</Show>
			</div>
		</Show>
	);
}

const styles = stylex.create({
	panel: {
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
		display: "grid",
		gap: 4,
		width: 260,
		boxSizing: "border-box",
		padding: 4,
		zIndex: 20
	},
	submenu: {
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
		position: "absolute",
		right: "calc(100% + 6px)",
		display: "grid",
		gap: 4,
		width: 260,
		maxWidth: "calc(100vw - 32px)",
		boxSizing: "border-box",
		padding: 4
	},
	typed: {
		height: 30,
		paddingInline: 8,
		borderWidth: 0,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		backgroundColor: "transparent",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		outlineStyle: "none"
	},
	subTyped: { fontSize: 12 },
	fields: { display: "grid" },
	section: { display: "grid", paddingBlock: 2 },
	divided: { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: tokens.colorBorder },
	scroll: { display: "grid", gap: 2, maxHeight: 420, overflowY: "auto" },
	head: { paddingBlock: "4px 2px", paddingInline: 8, color: tokens.colorTextFaint, fontSize: 11 },
	field: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		minHeight: 28,
		paddingInline: 8,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	fieldOn: { backgroundColor: tokens.colorSurfaceHover, color: tokens.colorTextStrong },
	arrow: { color: tokens.colorTextMuted, fontSize: 9 },
	option: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		minHeight: 28,
		paddingInline: 8,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	box: {
		width: 13,
		height: 13,
		flexShrink: 0,
		display: "grid",
		placeItems: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: 3,
		fontSize: 9
	},
	boxOn: {
		backgroundColor: tokens.colorAccent,
		borderColor: tokens.colorAccent,
		color: tokens.colorAccentText
	},
	label: {
		flex: 1,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	count: { color: tokens.colorTextMuted, fontVariantNumeric: "tabular-nums", fontSize: 12 },
	none: {
		margin: 0,
		paddingBlock: 6,
		paddingInline: 8,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	pills: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 },
	pill: {
		display: "inline-flex",
		alignItems: "stretch",
		height: 24,
		overflow: "hidden",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		fontSize: 12
	},
	pillPart: {
		display: "inline-flex",
		alignItems: "center",
		paddingInline: 7,
		borderWidth: 0,
		borderLeftWidth: { default: 1, ":first-child": 0 },
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorder,
		backgroundColor: "transparent",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12
	},
	pillOp: {
		color: tokens.colorTextMuted,
		cursor: "pointer",
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover }
	},
	pillValue: { color: tokens.colorTextStrong },
	pillRemove: {
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		cursor: "pointer"
	}
});
