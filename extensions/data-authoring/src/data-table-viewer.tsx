import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import type { Effect } from "effect";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { AuthoringTableGrid, type AuthoringGridSelection } from "./authoring-table-grid.js";
import { AuthoringAnalysisView } from "./authoring-analysis-view.js";
import {
	tableColumns,
	filterRows,
	fieldInRow,
	formatAuthoringValue,
	containsRowReference,
	unsupportedValueCount
} from "./authoring-view.js";
import type { AuthoringReadResult, AuthoringReadFailure } from "./wasm-reader.js";

export type AuthoringReadEffect = Effect.Effect<AuthoringReadResult, unknown>;
export interface AuthoringOpenerControls {
	readonly open: (read: AuthoringReadEffect) => void;
	readonly loading: boolean;
	readonly hasTable: boolean;
}
export interface DataTableViewerProps {
	readonly opener: (controls: AuthoringOpenerControls) => JSX.Element;
	readonly initialRead?: AuthoringReadEffect | undefined;
	readonly failureActions?: (failure: AuthoringReadFailure) => JSX.Element;
}

export function DataTableViewer(props: DataTableViewerProps) {
	const initialRead = props.initialRead;
	const action = createEffectAction();
	const [result, setResult] = createSignal<AuthoringReadResult>();
	const [loading, setLoading] = createSignal(false);
	const [transportFailed, setTransportFailed] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const [mode, setMode] = createSignal<"grid" | "charts">("grid");
	const [selection, setSelection] = createSignal<AuthoringGridSelection>();
	const ready = createMemo(() => {
		const read = result();
		return read?.status === "ready" ? read : undefined;
	});
	const failure = createMemo(() => {
		const read = result();
		return read?.status === "failed" ? read : undefined;
	});
	const columns = createMemo(() => {
		const snapshot = ready()?.snapshot;
		return snapshot === undefined ? [] : tableColumns(snapshot);
	});
	const rows = createMemo(() => filterRows(ready()?.snapshot.table.rows ?? [], query()));
	const cell = createMemo(() => {
		const selected = selection();
		const row = rows().find((item) => item.id === selected?.rowId);
		const field = row && selected ? fieldInRow(row, selected.fieldName) : undefined;
		return row && field ? { row, field } : undefined;
	});
	const metadata = createMemo(() => {
		const selected = cell();
		if (!selected) return [];
		const descriptor = columns().find(
			(column) => column.name === selected.field.name
		)?.descriptor;
		return [
			{ name: "Row key", value: selected.row.id },
			{ name: "Property", value: selected.field.typeName },
			...(descriptor?.annotations.description
				? [{ name: "Description", value: descriptor.annotations.description }]
				: []),
			...(descriptor?.annotations.unit
				? [{ name: "Unit", value: descriptor.annotations.unit }]
				: [])
		];
	});
	const partialCount = createMemo(() => {
		const read = ready();
		if (!read) return 0;
		return (
			read.diagnostics.length +
			read.snapshot.table.rows.reduce(
				(count, row) =>
					row.fields.reduce(
						(count, field) => count + unsupportedValueCount(field.value),
						count
					),
				0
			)
		);
	});
	const open = (read: AuthoringReadEffect) => {
		setLoading(true);
		setTransportFailed(false);
		action.run(read, {
			onSuccess: (value) => {
				setLoading(false);
				setResult(value);
				setSelection(undefined);
				setQuery("");
				setMode("grid");
			},
			onFailure: () => {
				setLoading(false);
				setTransportFailed(true);
			}
		});
	};
	const opener = props.opener({
		open,
		get loading() {
			return loading();
		},
		get hasTable() {
			return ready() !== undefined;
		}
	});
	onSettled(() => {
		if (initialRead !== undefined) open(initialRead);
	});
	return (
		<main aria-busy={loading() ? "true" : "false"} {...stylex.attrs(styles.page)}>
			<header {...stylex.attrs(styles.header)}>
				<div>
					<h1 {...stylex.attrs(styles.pageTitle)}>Data Tables</h1>
					<p {...stylex.attrs(styles.intro)}>
						Explore saved DataTable rows, typed values and patterns from package bytes.
					</p>
				</div>
				<span {...stylex.attrs(styles.quiet)}>Read-only · no Unreal required</span>
			</header>
			<section aria-label="Table summary" {...stylex.attrs(styles.summary)}>
				<Show when={ready()}>
					{(read) => (
						<>
							<div {...stylex.attrs(styles.identity)}>
								<h2 {...stylex.attrs(styles.tableName)}>
									{read().snapshot.table.objectPath.split(".").at(-1)}
								</h2>
								<span {...stylex.attrs(styles.path)}>
									{read().snapshot.table.objectPath}
								</span>
							</div>
							<span {...stylex.attrs(styles.chip)}>
								{read().snapshot.table.kind === "data_table"
									? "DataTable"
									: "Composite DataTable"}
							</span>
							<span {...stylex.attrs(styles.quiet)}>
								{read().snapshot.table.rows.length} rows · {columns().length} fields
							</span>
							<span
								{...stylex.attrs(
									styles.coverageChip,
									read().outcome === "partial" && styles.partial
								)}
							>
								<i
									aria-hidden="true"
									{...stylex.attrs(
										styles.dot,
										read().outcome === "partial" && styles.partialDot
									)}
								/>
								{read().outcome === "complete"
									? "Fully decoded"
									: `Partial · ${partialCount()}`}
							</span>
						</>
					)}
				</Show>
				{opener}
				<Show when={ready()}>
					<div role="group" aria-label="Table view" {...stylex.attrs(styles.toggle)}>
						<Button
							aria-pressed={mode() === "grid" ? "true" : "false"}
							onClick={() => setMode("grid")}
							tone={mode() === "grid" ? "secondary" : "quiet"}
							type="button"
						>
							Grid
						</Button>
						<Button
							aria-pressed={mode() === "charts" ? "true" : "false"}
							onClick={() => setMode("charts")}
							tone={mode() === "charts" ? "secondary" : "quiet"}
							type="button"
						>
							Charts
						</Button>
					</div>
				</Show>
			</section>
			<Show when={loading()}>
				<p role="status">Reading saved table…</p>
			</Show>
			<Show when={transportFailed()}>
				<div role="alert" {...stylex.attrs(styles.callout)}>
					<strong>The browser decoder is unavailable</strong>
					<p>
						Reload the page and try again in a browser with WebAssembly and Web Worker
						support.
					</p>
				</div>
			</Show>
			<Show when={failure()}>
				{(value) => (
					<div role="alert" {...stylex.attrs(styles.callout)}>
						<strong>{value().message}</strong>
						<p>{value().recovery}</p>
						{props.failureActions?.(value())}
					</div>
				)}
			</Show>
			<Show when={ready()}>
				{(read) => (
					<>
						<div {...stylex.attrs(styles.toolbar)}>
							<input
								aria-label="Filter rows"
								type="search"
								placeholder="Filter rows…"
								value={query()}
								onInput={(event) => setQuery(event.currentTarget.value)}
								{...stylex.attrs(styles.input)}
							/>
							<span {...stylex.attrs(styles.quiet, styles.rowStruct)}>
								Row struct: {read().snapshot.table.rowStruct || "Not saved"}
							</span>
							<Show when={read().snapshot.table.parentTables.length > 0}>
								<span {...stylex.attrs(styles.path)}>
									Parents:{" "}
									<For each={read().snapshot.table.parentTables}>
										{(path, index) => (
											<>
												{index() > 0 ? ", " : ""}
												<span title={path}>
													{
														path
															.slice(path.lastIndexOf("/") + 1)
															.split(".")[0]
													}
												</span>
											</>
										)}
									</For>
								</span>
							</Show>
						</div>
						<Show when={read().diagnostics.length > 0}>
							<details {...stylex.attrs(styles.notes)}>
								<summary>Decode notes · {read().diagnostics.length}</summary>
								<For each={read().diagnostics}>
									{(diagnostic) => <p>{diagnostic.message}</p>}
								</For>
							</details>
						</Show>
						<Show
							when={mode() === "grid"}
							fallback={
								<div {...stylex.attrs(styles.charts)}>
									<AuthoringAnalysisView
										snapshot={read().snapshot}
										rows={rows()}
									/>
								</div>
							}
						>
							<div {...stylex.attrs(styles.workspace)}>
								<section aria-label="Table grid" {...stylex.attrs(styles.grid)}>
									<AuthoringTableGrid
										readOnly
										rows={rows()}
										columns={columns()}
										onSelectionChange={setSelection}
									/>
								</section>
								<section
									aria-label="Cell inspector"
									{...stylex.attrs(styles.inspector)}
								>
									<Show
										when={cell()}
										fallback={
											<p {...stylex.attrs(styles.quiet)}>
												Select a cell to inspect its value.
											</p>
										}
									>
										{(selected) => (
											<>
												<header {...stylex.attrs(styles.cellHeader)}>
													<strong>{selected().field.name}</strong>
													<span {...stylex.attrs(styles.quiet)}>
														{selected().row.name}
													</span>
													<span {...stylex.attrs(styles.chip)}>
														{selected().field.value.kind.replaceAll(
															"_",
															" "
														)}
													</span>
												</header>
												<p {...stylex.attrs(styles.value)}>
													{formatAuthoringValue(selected().field.value)}
												</p>
												<Show
													when={containsRowReference(
														selected().field.value
													)}
												>
													<p {...stylex.attrs(styles.quiet)}>
														Referenced table not loaded
													</p>
												</Show>
												<dl {...stylex.attrs(styles.metadata)}>
													<For each={metadata()}>
														{(item) => (
															<>
																<dt {...stylex.attrs(styles.quiet)}>
																	{item.name}
																</dt>
																<dd
																	{...stylex.attrs(
																		styles.metadataValue
																	)}
																>
																	{item.value}
																</dd>
															</>
														)}
													</For>
												</dl>
											</>
										)}
									</Show>
								</section>
							</div>
						</Show>
					</>
				)}
			</Show>
		</main>
	);
}

const styles = stylex.create({
	page: {
		fontFamily: tokens.fontBody,
		color: tokens.colorText,
		padding: {
			default: "24px 28px",
			"@media (max-width: 600px)": "18px 12px"
		},
		minWidth: 0
	},
	header: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		marginBottom: 20
	},
	pageTitle: { fontSize: 20, fontWeight: 600, margin: 0, color: tokens.colorTextStrong },
	intro: { fontSize: 13, color: tokens.colorTextMuted, margin: "6px 0 0" },
	quiet: { color: tokens.colorTextMuted, fontSize: 12 },
	rowStruct: { minWidth: 0, overflowWrap: "anywhere" },
	summary: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 },
	identity: { minWidth: 0, maxWidth: "100%" },
	tableName: { fontSize: 14, fontWeight: 600, margin: 0 },
	path: { color: tokens.colorTextMuted, fontSize: 11, overflowWrap: "anywhere" },
	chip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextMuted,
		borderRadius: tokens.radiusPill,
		padding: "3px 8px",
		fontSize: 11
	},
	coverageChip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 7,
		flexShrink: 0,
		padding: "4px 10px",
		borderRadius: tokens.radiusPill,
		backgroundColor: `color-mix(in srgb, ${tokens.colorSuccess} 10%, transparent)`,
		color: tokens.colorSuccess,
		fontSize: 12,
		fontWeight: 510,
		whiteSpace: "nowrap"
	},
	partial: {
		color: tokens.colorWarning,
		backgroundColor: `color-mix(in srgb, ${tokens.colorWarning} 10%, transparent)`
	},
	dot: {
		display: "inline-block",
		width: 6,
		height: 6,
		borderRadius: "50%",
		backgroundColor: tokens.colorSuccess
	},
	partialDot: { backgroundColor: tokens.colorWarning },
	toggle: {
		display: "flex",
		gap: 2,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		padding: 2
	},
	toolbar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 16 },
	input: {
		backgroundColor: tokens.colorSurfaceInset,
		boxSizing: "border-box",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		minWidth: 0,
		width: 180,
		maxWidth: "100%",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		padding: "6px 10px"
	},
	workspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 300px",
			"@media (max-width: 900px)": "minmax(0, 1fr)"
		},
		gap: 12,
		marginTop: 8,
		minWidth: 0
	},
	grid: { minWidth: 0, overflow: "auto" },
	charts: { minWidth: 0, maxWidth: "100%", overflow: "hidden" },
	inspector: {
		minWidth: 0,
		alignSelf: "start",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		padding: 12,
		marginTop: 8
	},
	cellHeader: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 8,
		fontSize: 12,
		overflowWrap: "anywhere"
	},
	value: { fontSize: 13, overflowWrap: "anywhere", margin: "14px 0" },
	metadata: {
		display: "grid",
		gridTemplateColumns: "auto minmax(0, 1fr)",
		gap: "8px 12px",
		margin: 0,
		fontSize: 12
	},
	metadataValue: { margin: 0, overflowWrap: "anywhere" },
	notes: { marginTop: 12, fontSize: 12, color: tokens.colorTextMuted },
	callout: {
		marginTop: 16,
		padding: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurfaceRaised,
		fontSize: 13
	}
});
