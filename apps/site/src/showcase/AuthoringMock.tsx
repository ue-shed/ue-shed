import * as stylex from "@stylexjs/stylex";
import { Button } from "@ue-shed/ui";
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

function unrealType(field: AuthoringField): string {
	switch (field.type) {
		case "bool":
			return "BoolProperty";
		case "int":
			return "IntProperty";
		case "float":
			return "FloatProperty";
		case "name":
			return "NameProperty";
		case "text":
			return "TextProperty";
	}
}

export function AuthoringMock() {
	const [drafts, setDrafts] = createSignal<Readonly<Record<string, Value>>>({});
	const [past, setPast] = createSignal<readonly Edit[]>([]);
	const [future, setFuture] = createSignal<readonly Edit[]>([]);
	const [editingKey, setEditingKey] = createSignal<string | null>(null);
	const [selection, setSelection] = createSignal({
		rowId: authoringRows[0]?.id,
		fieldName: authoringFields[0]?.name
	});
	const selected = createMemo(() => {
		const row = authoringRows.find((item) => item.id === selection().rowId);
		const field = authoringFields.find((item) => item.name === selection().fieldName);
		return row && field ? { row, field } : undefined;
	});

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
		setSelection({ rowId: row.id, fieldName: field.name });
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
			<section aria-label="Table summary" {...stylex.attrs(styles.toolbar)}>
				<div {...stylex.attrs(styles.identity)}>
					<strong {...stylex.attrs(styles.assetTitle)}>DT_Scalars</strong>
					<code
						title="/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"
						{...stylex.attrs(styles.assetPath)}
					>
						/Game/Fixture/Authoring/DT_Scalars.DT_Scalars
					</code>
				</div>
				<span {...stylex.attrs(styles.chip)}>Saved package</span>
				<span {...stylex.attrs(styles.stats)}>
					{authoringRows.length} rows · {authoringFields.length} fields
				</span>
				<span {...stylex.attrs(styles.complete)}>
					<span aria-hidden="true" {...stylex.attrs(styles.dot)} />
					Complete snapshot
				</span>
				<span {...stylex.attrs(styles.stats, draftCount() > 0 && styles.draft)}>
					{draftCount() > 0 ? "Draft" : "Saved"} · {draftCount()} changes · 0 errors
				</span>
				<Button type="button" tone="quiet" disabled={past().length === 0} onClick={undo}>
					Undo
				</Button>
				<Button type="button" tone="quiet" disabled={future().length === 0} onClick={redo}>
					Redo
				</Button>
			</section>
			<div {...stylex.attrs(styles.panes)}>
				<div {...stylex.attrs(styles.gridScroll)}>
					<div {...stylex.attrs(styles.grid)}>
						<div {...stylex.attrs(styles.headerCell)}>Row</div>
						<For each={authoringFields}>
							{(field) => (
								<div {...stylex.attrs(styles.headerCell)}>
									{field.name}
									<span {...stylex.attrs(styles.headerType)}>{field.type}</span>
								</div>
							)}
						</For>
						<For each={authoringRows}>
							{(row) => (
								<>
									<div {...stylex.attrs(styles.rowName)}>{row.name}</div>
									<For each={authoringFields}>
										{(field) => {
											const key = cellKey(row, field);
											const draft = createMemo(() => isDraft(row, field));
											const value = createMemo(() =>
												currentValue(row, field)
											);
											return (
												<div
													{...stylex.attrs(
														styles.cell,
														draft() && styles.cellDraft
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
																	currentValue(row, field) !==
																		true
																)
															}
															{...stylex.attrs(
																styles.boolToggle,
																value() === true && styles.boolOn
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
															{...stylex.attrs(styles.cellInput)}
														/>
													) : (
														<button
															type="button"
															onClick={() => {
																setSelection({
																	rowId: row.id,
																	fieldName: field.name
																});
																setEditingKey(key);
															}}
															{...stylex.attrs(styles.cellButton)}
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
				<aside aria-label="Cell inspector" {...stylex.attrs(styles.inspector)}>
					<Show when={selected()}>
						{(target) => (
							<>
								<div {...stylex.attrs(styles.inspectorHeading)}>
									<strong {...stylex.attrs(styles.fieldName)}>
										{target().field.name}
									</strong>
									<span {...stylex.attrs(styles.stats)}>{target().row.name}</span>
									<span {...stylex.attrs(styles.chip)}>
										{unrealType(target().field)}
									</span>
								</div>
								<div {...stylex.attrs(styles.detailRow)}>
									<span {...stylex.attrs(styles.stats)}>Value</span>
									<span>
										{target().field.type === "bool"
											? currentValue(target().row, target().field)
												? "True"
												: "False"
											: String(currentValue(target().row, target().field))}
									</span>
								</div>
								<dl {...stylex.attrs(styles.details)}>
									<div {...stylex.attrs(styles.detailRow)}>
										<dt {...stylex.attrs(styles.stats)}>Row key</dt>
										<dd {...stylex.attrs(styles.detailValue)}>
											{target().row.id}
										</dd>
									</div>
								</dl>
							</>
						)}
					</Show>
				</aside>
			</div>
			<div {...stylex.attrs(styles.footer)}>Click a cell to draft an edit.</div>
		</WindowFrame>
	);
}

const styles = stylex.create({
	identity: { display: "flex", flexDirection: "column", flex: "1 1 200px", gap: 2, minWidth: 0 },
	assetTitle: { color: tokens.colorTextStrong, fontSize: 13, fontWeight: 500 },
	assetPath: {
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	stats: { color: tokens.colorTextMuted, fontSize: 12 },
	complete: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorSuccess,
		borderRadius: tokens.radiusPill,
		padding: "3px 8px",
		fontSize: 11
	},
	dot: { width: 5, height: 5, borderRadius: "50%", backgroundColor: "currentColor" },
	draft: { color: tokens.colorAccent },
	panes: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 220px",
			"@media (max-width: 700px)": "minmax(0, 1fr)"
		}
	},
	inspector: { padding: 12, backgroundColor: tokens.colorSurface },
	inspectorHeading: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 6 },
	fieldName: { fontSize: 13, fontWeight: 500 },
	details: { margin: 0 },
	detailRow: {
		display: "grid",
		gridTemplateColumns: "64px minmax(0, 1fr)",
		gap: 8,
		padding: "6px 0",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		fontSize: 12,
		overflowWrap: "anywhere"
	},
	detailValue: { margin: 0, fontFamily: tokens.fontMono, fontSize: 11 },
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
		backgroundColor: tokens.colorSurfaceRaised,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextMuted,
		fontSize: 11,
		padding: "2px 6px"
	},
	gridScroll: {
		minWidth: 0,
		overflowX: "auto"
	},
	grid: {
		display: "grid",
		gridTemplateColumns: "minmax(130px, 1.1fr) 76px 76px 76px 96px minmax(210px, 1.8fr)",
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
		display: "flex",
		padding: "3px 6px"
	},
	cellDraft: {
		backgroundColor: tokens.colorAccentWash
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
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorTextMuted },
		outlineOffset: 2,
		outlineStyle: "solid",
		outlineWidth: 1,
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
