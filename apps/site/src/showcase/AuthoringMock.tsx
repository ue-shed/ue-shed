import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { authoringFields, authoringRows, type AuthoringField, type AuthoringRow } from "./data.js";
import { WindowFrame } from "./WindowFrame.js";

type Value = string | boolean;

type Edit = {
	readonly key: string;
	readonly prev: Value;
	readonly next: Value;
};

function cellKey(row: AuthoringRow, field: AuthoringField): string {
	return `${row.id}:${field.name}`;
}

function baseValue(row: AuthoringRow, field: AuthoringField): Value {
	return row.values[field.name] ?? "";
}

export function AuthoringMock() {
	const [drafts, setDrafts] = createSignal<Readonly<Record<string, Value>>>({});
	const [past, setPast] = createSignal<readonly Edit[]>([]);
	const [future, setFuture] = createSignal<readonly Edit[]>([]);
	const [editingKey, setEditingKey] = createSignal<string | null>(null);

	const currentValue = (row: AuthoringRow, field: AuthoringField): Value =>
		drafts()[cellKey(row, field)] ?? baseValue(row, field);

	const isDraft = (row: AuthoringRow, field: AuthoringField): boolean =>
		currentValue(row, field) !== baseValue(row, field);

	const draftCount = createMemo(() =>
		authoringRows.reduce(
			(count, row) => count + authoringFields.filter((field) => isDraft(row, field)).length,
			0
		)
	);

	const commit = (row: AuthoringRow, field: AuthoringField, next: Value) => {
		const prev = currentValue(row, field);
		if (prev === next) {
			return;
		}
		const key = cellKey(row, field);
		setPast((edits) => [...edits, { key, prev, next }]);
		setFuture([]);
		setDrafts((current) => ({ ...current, [key]: next }));
	};

	const apply = (edit: Edit, value: Value) => {
		setDrafts((current) => ({ ...current, [edit.key]: value }));
	};

	const undo = () => {
		const edit = past().at(-1);
		if (!edit) {
			return;
		}
		setPast((edits) => edits.slice(0, -1));
		setFuture((edits) => [...edits, edit]);
		apply(edit, edit.prev);
	};

	const redo = () => {
		const edit = future().at(-1);
		if (!edit) {
			return;
		}
		setFuture((edits) => edits.slice(0, -1));
		setPast((edits) => [...edits, edit]);
		apply(edit, edit.next);
	};

	return (
		<WindowFrame title="Data Authoring — DT_Scalars" badge="draft editor">
			<div {...stylex.props(styles.toolbar)}>
				<span {...stylex.props(styles.chip)}>authority: project_files</span>
				<span {...stylex.props(styles.chip)}>complete</span>
				<span {...stylex.props(styles.spacer)} />
				<Show
					when={draftCount() > 0}
					fallback={<span {...stylex.props(styles.chipQuiet)}>no local edits</span>}
				>
					<span {...stylex.props(styles.chipDraft)}>
						{draftCount()} draft {draftCount() === 1 ? "cell" : "cells"}
					</span>
				</Show>
				<button
					type="button"
					disabled={past().length === 0}
					onClick={undo}
					{...stylex.props(styles.toolButton)}
				>
					Undo
				</button>
				<button
					type="button"
					disabled={future().length === 0}
					onClick={redo}
					{...stylex.props(styles.toolButton)}
				>
					Redo
				</button>
			</div>
			<div {...stylex.props(styles.gridScroll)}>
				<div {...stylex.props(styles.grid)}>
					<div {...stylex.props(styles.headerCell)}>Row</div>
					<For each={authoringFields}>
						{(field) => (
							<div {...stylex.props(styles.headerCell)}>
								{field.name}
								<span {...stylex.props(styles.headerType)}>{field.type}</span>
							</div>
						)}
					</For>
					<For each={authoringRows}>
						{(row) => (
							<>
								<div {...stylex.props(styles.rowName)}>{row.name}</div>
								<For each={authoringFields}>
									{(field) => {
										const key = cellKey(row, field);
										return (
											<div
												{...stylex.props(
													styles.cell,
													isDraft(row, field) && styles.cellDraft
												)}
											>
												{field.type === "bool" ? (
													<button
														type="button"
														aria-label={`${field.name} for ${row.name}`}
														onClick={() =>
															commit(
																row,
																field,
																currentValue(row, field) !== true
															)
														}
														{...stylex.props(
															styles.boolToggle,
															currentValue(row, field) === true &&
																styles.boolOn
														)}
													>
														{currentValue(row, field) === true
															? "true"
															: "false"}
													</button>
												) : editingKey() === key ? (
													<input
														ref={(el) =>
															queueMicrotask(() => el.select())
														}
														value={String(currentValue(row, field))}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																commit(
																	row,
																	field,
																	event.currentTarget.value
																);
																setEditingKey(null);
															}
															if (event.key === "Escape") {
																setEditingKey(null);
															}
														}}
														onBlur={(event) => {
															commit(
																row,
																field,
																event.currentTarget.value
															);
															setEditingKey(null);
														}}
														{...stylex.props(styles.cellInput)}
													/>
												) : (
													<button
														type="button"
														onClick={() => setEditingKey(key)}
														{...stylex.props(styles.cellButton)}
													>
														{String(currentValue(row, field))}
													</button>
												)}
											</div>
										);
									}}
								</For>
							</>
						)}
					</For>
				</div>
			</div>
			<div {...stylex.props(styles.footer)}>Click a cell to draft an edit.</div>
		</WindowFrame>
	);
}

const gridTemplate = "minmax(130px, 1.1fr) 76px 76px 76px 96px minmax(210px, 1.8fr)";

const styles = stylex.create({
	toolbar: {
		alignItems: "center",
		backgroundColor: tokens.colorSurface,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		padding: "8px 12px"
	},
	chip: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	chipQuiet: {
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	chipDraft: {
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorAccent,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	spacer: {
		flexGrow: 1
	},
	toolButton: {
		backgroundColor: {
			default: "transparent",
			":hover:not(:disabled)": tokens.colorSurfaceHover
		},
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: {
			default: tokens.colorText,
			":disabled": tokens.colorTextFaint
		},
		cursor: {
			default: "pointer",
			":disabled": "default"
		},
		fontFamily: tokens.fontBody,
		fontSize: 10,
		padding: "4px 10px"
	},
	gridScroll: {
		overflowX: "auto"
	},
	grid: {
		display: "grid",
		gridTemplateColumns: gridTemplate,
		minWidth: 700
	},
	headerCell: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextSubtle,
		display: "flex",
		flexDirection: "column",
		fontSize: 9,
		gap: 2,
		letterSpacing: ".14em",
		padding: "8px 12px",
		textTransform: "uppercase"
	},
	headerType: {
		color: tokens.colorTextFaint
	},
	rowName: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextStrong,
		fontSize: 11,
		fontWeight: 700,
		padding: "7px 12px"
	},
	cell: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderLeftColor: "transparent",
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		display: "flex",
		padding: "3px 6px"
	},
	cellDraft: {
		borderLeftColor: tokens.colorAccent
	},
	cellButton: {
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover
		},
		borderWidth: 0,
		color: tokens.colorText,
		cursor: "text",
		flexGrow: 1,
		fontFamily: tokens.fontBody,
		fontSize: 11,
		overflow: "hidden",
		padding: "4px 6px",
		textAlign: "left",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	cellInput: {
		backgroundColor: tokens.colorCanvas,
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextStrong,
		flexGrow: 1,
		fontFamily: tokens.fontBody,
		fontSize: 11,
		outline: "none",
		padding: "3px 6px",
		width: "100%"
	},
	boolToggle: {
		backgroundColor: "transparent",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 10,
		padding: "3px 10px"
	},
	boolOn: {
		borderColor: tokens.colorAccent,
		color: tokens.colorAccent
	},
	footer: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 10,
		padding: "8px 12px"
	}
});
