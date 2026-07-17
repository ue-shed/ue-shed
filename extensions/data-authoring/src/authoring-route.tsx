import * as stylex from "@stylexjs/stylex";
import type {
	AuthoringCatalogResult,
	AuthoringCatalogProgress,
	AuthoringClientShape,
	AuthoringLoadFailure,
	AuthoringLoadResult,
	AuthoringSessionListResult,
	AuthoringSessionResult,
	AuthoringRowIntent,
	AuthoringSessionSummary,
	AuthoringSessionView
} from "@ue-shed/authoring-sdk";
import type { AuthoringRow, AuthoringTableSnapshot, AuthoringValue } from "@ue-shed/protocol";
import { Button, PageHeader, createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Schedule, Stream, type Effect } from "effect";
import {
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createSignal,
	onMount
} from "solid-js";
import {
	fieldInRow,
	filterRows,
	formatAuthoringValue,
	tableColumns,
	valueSummary
} from "./authoring-view.js";
import { AuthoringCombinedView } from "./authoring-combined-view.js";
import { AuthoringTableGrid } from "./authoring-table-grid.js";
import type { AuthoringGridGesture } from "./authoring-grid-model.js";

export type {
	AuthoringCatalogResult,
	AuthoringLoadFailure,
	AuthoringLoadResult,
	AuthoringTableCatalogEntry
} from "@ue-shed/authoring-sdk";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| { readonly status: "failed"; readonly error: AuthoringLoadFailure }
	| { readonly status: "ready"; readonly snapshot: AuthoringTableSnapshot };

type CatalogState = AuthoringCatalogResult | { readonly status: "loading" };
type SessionListState = AuthoringSessionListResult | { readonly status: "loading" };
type RowIntentWithoutScope = AuthoringRowIntent extends infer Intent
	? Intent extends AuthoringRowIntent
		? Omit<Intent, "sessionId" | "tableObjectPath">
		: never
	: never;

type RowEditor =
	| { readonly kind: "add_row"; readonly atIndex: number; readonly value: string }
	| {
			readonly kind: "duplicate_row";
			readonly atIndex: number;
			readonly sourceRowId: string;
			readonly value: string;
	  }
	| { readonly kind: "rename_row"; readonly rowId: string; readonly value: string };

interface CellSelection {
	readonly rowId: string;
	readonly fieldName: string;
}

type RowReferenceValue = Extract<AuthoringValue, { readonly kind: "row_reference" }>;

type RowReferenceLookup =
	| { readonly status: "idle" }
	| { readonly status: "loading"; readonly tableObjectPath: string }
	| {
			readonly status: "ready";
			readonly snapshot: AuthoringTableSnapshot;
			readonly tableObjectPath: string;
	  }
	| { readonly status: "failed"; readonly message: string; readonly tableObjectPath: string };

function asRowReference(value: AuthoringValue): RowReferenceValue | undefined {
	return value.kind === "row_reference" ? value : undefined;
}

type ReviewChange = AuthoringSessionView["review"]["tables"][number]["changes"][number];

function reviewChangeTitle(change: ReviewChange): string {
	switch (change.kind) {
		case "cell_changed":
			return `${change.rowName}.${change.fieldName}`;
		case "row_added":
			return `Added ${change.row.name}`;
		case "row_removed":
			return `Removed ${change.row.name}`;
		case "row_renamed":
			return `Renamed ${change.oldName}`;
		case "rows_reordered":
			return "Canonical row order";
	}
}

function reviewChangeSummary(change: ReviewChange): string {
	switch (change.kind) {
		case "cell_changed":
			return `${formatAuthoringValue(change.oldValue)} → ${formatAuthoringValue(change.newValue)}`;
		case "row_added":
			return `${change.row.fields.length} typed field(s)`;
		case "row_removed":
			return "Row and all typed values staged for removal";
		case "row_renamed":
			return `${change.oldName} → ${change.newName}`;
		case "rows_reordered":
			return change.newOrder.join(" · ");
	}
}

function shortObjectName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function authorityLabel(snapshot: AuthoringTableSnapshot): string {
	return snapshot.authority.kind === "project_files" ? "SAVED PACKAGE" : "LIVE EDITOR";
}

function RowReferencePicker(props: {
	readonly client: AuthoringClientShape;
	readonly disabled: boolean;
	readonly onStage: (value: RowReferenceValue) => void;
	readonly sourceKey: string;
	readonly tableObjectPaths: readonly string[];
	readonly value: RowReferenceValue;
}) {
	const lookupAction = createEffectAction();
	const [lookup, setLookup] = createSignal<RowReferenceLookup>({ status: "idle" });
	const [rowName, setRowName] = createSignal(props.value.rowName);
	const [tableObjectPath, setTableObjectPath] = createSignal(props.value.tableObjectPath ?? "");
	let activeSourceKey = "";

	const tableChoices = createMemo(() => {
		const choices = new Set(props.tableObjectPaths);
		if (props.value.tableObjectPath) choices.add(props.value.tableObjectPath);
		return [...choices].toSorted((left, right) => left.localeCompare(right));
	});
	const targetRows = createMemo(() => {
		const current = lookup();
		return current.status === "ready" ? current.snapshot.table.rows : [];
	});
	const selectedTargetExists = createMemo(() =>
		targetRows().some((row) => row.name === rowName())
	);

	const loadTarget = (path: string, sourceKey = props.sourceKey) => {
		lookupAction.cancel();
		if (path.length === 0) {
			setLookup({ status: "idle" });
			return;
		}
		setLookup({ status: "loading", tableObjectPath: path });
		lookupAction.run(props.client.openCatalogTable(path), {
			onFailure: (cause) => {
				if (props.sourceKey !== sourceKey) return;
				setLookup({
					message: Cause.pretty(cause),
					status: "failed",
					tableObjectPath: path
				});
			},
			onSuccess: (result) => {
				if (props.sourceKey !== sourceKey) return;
				if (result.status === "ready" && result.snapshot.table.objectPath === path) {
					setLookup({
						snapshot: result.snapshot,
						status: "ready",
						tableObjectPath: path
					});
					return;
				}
				const message =
					result.status === "failed"
						? `${result.error.message} ${result.error.recovery}`
						: result.status === "cancelled"
							? "Target lookup was cancelled."
							: "The target table is not available from this host.";
				setLookup({ message, status: "failed", tableObjectPath: path });
			}
		});
	};

	createEffect(() => {
		const sourceKey = props.sourceKey;
		if (activeSourceKey === sourceKey) return;
		activeSourceKey = sourceKey;
		const initialTable = props.value.tableObjectPath ?? "";
		setTableObjectPath(initialTable);
		setRowName(props.value.rowName);
		loadTarget(initialTable, sourceKey);
	});

	return (
		<section aria-label="Row reference picker" {...stylex.props(styles.referencePicker)}>
			<div {...stylex.props(styles.referenceHeading)}>
				<span {...stylex.props(styles.detailLabel)}>RELATIONSHIP TARGET</span>
				<span {...stylex.props(styles.referenceStatus)}>
					{lookup().status === "loading"
						? "RESOLVING"
						: lookup().status === "ready"
							? `${targetRows().length} ROWS`
							: "UNRESOLVED"}
				</span>
			</div>
			<label {...stylex.props(styles.referenceField)}>
				<span>Target table</span>
				<select
					aria-label="Reference target table"
					disabled={props.disabled}
					value={tableObjectPath()}
					onChange={(event) => {
						const path = event.currentTarget.value;
						setTableObjectPath(path);
						setRowName("None");
						loadTarget(path);
					}}
					{...stylex.props(styles.referenceSelect)}
				>
					<option value="">No table assigned</option>
					<For each={tableChoices()}>
						{(path) => <option value={path}>{shortObjectName(path)}</option>}
					</For>
				</select>
				<small>{tableObjectPath() || "Choose a table from the project catalog."}</small>
			</label>
			<Switch>
				<Match when={lookup().status === "loading"}>
					<div {...stylex.props(styles.referenceMessage)}>Reading target rows…</div>
				</Match>
				<Match when={lookup().status === "failed"}>
					<div {...stylex.props(styles.referenceMessage, styles.referenceError)}>
						{(() => {
							const current = lookup();
							return current.status === "failed"
								? current.message
								: "Target lookup failed.";
						})()}
						<button
							type="button"
							disabled={props.disabled}
							onClick={() => loadTarget(tableObjectPath())}
							{...stylex.props(styles.referenceRetry)}
						>
							Retry
						</button>
					</div>
				</Match>
				<Match when={lookup().status === "ready"}>
					<label {...stylex.props(styles.referenceField)}>
						<span>Target row</span>
						<select
							aria-label="Reference target row"
							disabled={props.disabled || targetRows().length === 0}
							value={rowName()}
							onChange={(event) => setRowName(event.currentTarget.value)}
							{...stylex.props(styles.referenceSelect)}
						>
							<Show when={!selectedTargetExists() && rowName() !== "None"}>
								<option value={rowName()}>{rowName()} — missing</option>
							</Show>
							<option value="None">No row assigned</option>
							<For each={targetRows()}>
								{(row) => <option value={row.name}>{row.name}</option>}
							</For>
						</select>
					</label>
				</Match>
			</Switch>
			<button
				type="button"
				disabled={
					props.disabled ||
					lookup().status !== "ready" ||
					!selectedTargetExists() ||
					(tableObjectPath() === props.value.tableObjectPath &&
						rowName() === props.value.rowName)
				}
				onClick={() =>
					props.onStage({
						kind: "row_reference",
						rowName: rowName(),
						tableObjectPath: tableObjectPath()
					})
				}
				{...stylex.props(styles.referenceStage)}
			>
				Stage reference
			</button>
		</section>
	);
}

function CatalogPanel(props: {
	readonly activeObjectPath?: string;
	readonly disabled: boolean;
	readonly onOpen: (objectPath: string) => void;
	readonly onQueryChange: (query: string) => void;
	readonly onRefresh: () => void;
	readonly query: string;
	readonly onDiscardSession: (session: AuthoringSessionSummary) => void;
	readonly onOpenSession: (sessionId: string) => void;
	readonly progress: AuthoringCatalogProgress;
	readonly sessions: SessionListState;
	readonly state: CatalogState;
}) {
	const tables = createMemo(() => {
		if (props.state.status !== "ready") return [];
		const filter = props.query.trim().toLocaleLowerCase();
		return filter.length === 0
			? props.state.tables
			: props.state.tables.filter(
					(table) =>
						table.objectPath.toLocaleLowerCase().includes(filter) ||
						table.rowStruct.toLocaleLowerCase().includes(filter)
				);
	});

	return (
		<nav {...stylex.props(styles.catalog)} aria-label="Project DataTables">
			<div {...stylex.props(styles.catalogHeading)}>
				<div {...stylex.props(styles.catalogTitle)}>
					<span {...stylex.props(styles.catalogEyebrow)}>PROJECT INDEX</span>
					<strong {...stylex.props(styles.catalogName)}>Tables</strong>
				</div>
				<button
					type="button"
					disabled={props.disabled}
					onClick={props.onRefresh}
					aria-label="Refresh project DataTables"
					{...stylex.props(styles.catalogRefresh)}
				>
					↻
				</button>
			</div>
			<input
				aria-label="Filter project DataTables"
				placeholder="Filter tables…"
				value={props.query}
				onInput={(event) => props.onQueryChange(event.currentTarget.value)}
				{...stylex.props(styles.catalogSearch)}
			/>
			<Switch>
				<Match when={props.state.status === "loading"}>
					<div {...stylex.props(styles.catalogProgressBlock)}>
						<div {...stylex.props(styles.catalogProgressLabel)}>
							<span>
								{props.progress.phase === "enumerating"
									? "Finding packages…"
									: props.progress.phase === "writing_cache"
										? "Saving project index…"
										: "Indexing package headers…"}
							</span>
							<strong>
								{props.progress.totalAssets > 0
									? `${props.progress.processedAssets.toLocaleString()} / ${props.progress.totalAssets.toLocaleString()}`
									: "—"}
							</strong>
						</div>
						<progress
							aria-label="Project DataTable indexing progress"
							max={Math.max(1, props.progress.totalAssets)}
							value={props.progress.processedAssets}
							{...stylex.props(styles.catalogProgress)}
						/>
						<small>
							{props.progress.cacheHits.toLocaleString()} cached ·{" "}
							{props.progress.tablesFound.toLocaleString()} tables found
						</small>
					</div>
				</Match>
				<Match when={props.state.status === "not_configured"}>
					<div {...stylex.props(styles.catalogStatus)}>
						Configure UE_SHED_PROJECT_ROOT to discover tables.
					</div>
				</Match>
				<Match when={props.state.status === "failed"}>
					<div {...stylex.props(styles.catalogStatus)}>
						Catalog unavailable. The open table is unchanged.
					</div>
				</Match>
				<Match when={props.state.status === "ready"}>
					<div {...stylex.props(styles.catalogList)}>
						<Show
							when={
								props.state.status === "ready" && props.state.diagnostics.length > 0
							}
						>
							<div {...stylex.props(styles.catalogWarning)}>
								{props.state.status === "ready"
									? `${props.state.diagnostics.length} catalog diagnostic${props.state.diagnostics.length === 1 ? "" : "s"}`
									: ""}
							</div>
						</Show>
						<For each={tables()}>
							{(table) => (
								<button
									type="button"
									disabled={props.disabled}
									onClick={() => props.onOpen(table.objectPath)}
									{...stylex.props(
										styles.catalogItem,
										table.objectPath === props.activeObjectPath &&
											styles.catalogItemActive
									)}
								>
									<span {...stylex.props(styles.catalogItemName)}>
										{shortObjectName(table.objectPath)}
									</span>
									<small {...stylex.props(styles.catalogItemKind)}>
										{table.kind === "composite_data_table"
											? "COMPOSITE"
											: "DATA TABLE"}
										{" · "}
										{table.authorities.join("+").toUpperCase()}
									</small>
									<Show when={table.divergence.length > 0}>
										<small {...stylex.props(styles.catalogDivergence)}>
											DIVERGED · {table.divergence.join(", ")}
										</small>
									</Show>
								</button>
							)}
						</For>
						<Show when={tables().length === 0}>
							<div {...stylex.props(styles.catalogStatus)}>No matching tables.</div>
						</Show>
					</div>
				</Match>
			</Switch>
			<div {...stylex.props(styles.draftShelf)}>
				<div {...stylex.props(styles.draftShelfHeading)}>
					<span>RECENT DRAFTS</span>
					<Show when={props.sessions.status === "ready"}>
						<small>
							{props.sessions.status === "ready" ? props.sessions.sessions.length : 0}
						</small>
					</Show>
				</div>
				<Show
					when={props.sessions.status === "ready"}
					fallback={
						<div {...stylex.props(styles.catalogStatus)}>
							{props.sessions.status === "failed"
								? "Draft list unavailable. The active table is unchanged."
								: "Loading drafts…"}
						</div>
					}
				>
					<For
						each={
							props.sessions.status === "ready"
								? props.sessions.sessions.slice(0, 6)
								: []
						}
					>
						{(draft) => (
							<div {...stylex.props(styles.draftItem)}>
								<button
									type="button"
									disabled={props.disabled}
									onClick={() => props.onOpenSession(draft.id)}
									{...stylex.props(styles.draftOpen)}
								>
									<strong>
										{shortObjectName(draft.tableObjectPaths[0] ?? draft.id)}
									</strong>
									<small>
										{draft.undoPointer} CHANGE
										{draft.undoPointer === 1 ? "" : "S"}
										{" · "}
										{draft.lifecycle.toUpperCase()}
									</small>
								</button>
								<button
									type="button"
									disabled={props.disabled}
									aria-label={`Discard draft ${shortObjectName(draft.tableObjectPaths[0] ?? draft.id)}`}
									onClick={() => props.onDiscardSession(draft)}
									{...stylex.props(styles.draftDiscard)}
								>
									×
								</button>
							</div>
						)}
					</For>
					<Show
						when={
							props.sessions.status === "ready" &&
							props.sessions.sessions.length === 0
						}
					>
						<div {...stylex.props(styles.catalogStatus)}>No persisted drafts yet.</div>
					</Show>
				</Show>
			</div>
		</nav>
	);
}

export function AuthoringRoute(props: { readonly client: AuthoringClientShape }) {
	const loadAction = createEffectAction();
	const catalogAction = createEffectAction();
	const catalogProgressSubscription = createEffectSubscription();
	const beginAction = createEffectAction();
	const sessionAction = createEffectAction();
	const sessionListAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [catalogState, setCatalogState] = createSignal<CatalogState>({ status: "loading" });
	const [catalogProgress, setCatalogProgress] = createSignal<AuthoringCatalogProgress>({
		cacheHits: 0,
		phase: "idle",
		processedAssets: 0,
		tablesFound: 0,
		totalAssets: 0
	});
	const [catalogQuery, setCatalogQuery] = createSignal("");
	const [isReplacing, setIsReplacing] = createSignal(false);
	const [replacementNotice, setReplacementNotice] = createSignal<string>();
	const [query, setQuery] = createSignal("");
	const [selection, setSelection] = createSignal<CellSelection>();
	const [session, setSession] = createSignal<AuthoringSessionView>();
	const [sessions, setSessions] = createSignal<SessionListState>({ status: "loading" });
	const [sessionNotice, setSessionNotice] = createSignal<string>();
	const [isPersisting, setIsPersisting] = createSignal(false);
	const [inspectorTab, setInspectorTab] = createSignal<"cell" | "review">("cell");
	const [workspaceMode, setWorkspaceMode] = createSignal<"table" | "relationships">("table");
	const [rowEditor, setRowEditor] = createSignal<RowEditor>();

	const refreshSessions = () => {
		sessionListAction.run(props.client.listSessions(), {
			onFailure: (cause) => setSessionNotice(Cause.pretty(cause)),
			onSuccess: setSessions
		});
	};

	const acceptSessionResult = (result: AuthoringSessionResult) => {
		if (result.status === "failed") {
			setSessionNotice(`${result.error.message} ${result.error.recovery}`);
			return;
		}
		setSession(result.view);
		setState({ snapshot: result.view.snapshot, status: "ready" });
		setSessionNotice(undefined);
		refreshSessions();
	};

	const beginSession = (objectPath: string) => {
		setSession(undefined);
		setSessionNotice(undefined);
		beginAction.run(props.client.beginSession(objectPath), {
			onFailure: (cause) => setSessionNotice(Cause.pretty(cause)),
			onSuccess: acceptSessionResult
		});
	};

	const applyResult = (result: AuthoringLoadResult, preserveCurrent: boolean) => {
		if (result.status === "ready") {
			setState(result);
			setReplacementNotice(undefined);
			const firstRow = result.snapshot.table.rows[0];
			const firstField = firstRow?.fields[0];
			setSelection(
				firstRow && firstField
					? { fieldName: firstField.name, rowId: firstRow.id }
					: undefined
			);
			beginSession(result.snapshot.table.objectPath);
			return;
		}
		if (preserveCurrent) {
			if (result.status === "failed") setReplacementNotice(result.error.message);
			else if (result.status === "cancelled")
				setReplacementNotice("Table selection cancelled.");
			return;
		}
		setState(result);
	};

	const load = (choose: boolean) => {
		if (
			session()?.dirty &&
			!window.confirm(
				"Replace the active dirty draft? Its persisted commands will remain available under Recent drafts."
			)
		)
			return;
		beginAction.cancel();
		const preserveCurrent = state().status === "ready";
		if (preserveCurrent) setIsReplacing(true);
		else setState({ status: "loading" });
		loadAction.run(choose ? props.client.chooseTable() : props.client.loadConfiguredTable(), {
			onFailure: (cause) => {
				applyResult(
					{
						error: {
							code: "contract_failure",
							message: Cause.pretty(cause),
							recovery:
								"Restart the host. If the problem persists, verify package versions.",
							retrySafe: true
						},
						status: "failed"
					},
					preserveCurrent
				);
				setIsReplacing(false);
			},
			onSuccess: (result) => {
				applyResult(result, preserveCurrent);
				setIsReplacing(false);
			}
		});
	};

	const loadCatalog = () => {
		setCatalogState({ status: "loading" });
		setCatalogProgress({
			cacheHits: 0,
			phase: "enumerating",
			processedAssets: 0,
			tablesFound: 0,
			totalAssets: 0
		});
		catalogProgressSubscription.subscribe(
			Stream.fromEffectSchedule(
				props.client.getCatalogProgress(),
				Schedule.spaced("250 millis")
			),
			{ onValue: setCatalogProgress }
		);
		catalogAction.run(props.client.loadConfiguredCatalog(), {
			onFailure: (cause) => {
				catalogProgressSubscription.cancel();
				setCatalogState({
					error: {
						code: "contract_failure",
						message: Cause.pretty(cause),
						recovery:
							"Restart the host. If the problem persists, verify package versions.",
						retrySafe: true
					},
					status: "failed"
				});
			},
			onSuccess: (result) => {
				catalogProgressSubscription.cancel();
				setCatalogState(result);
			}
		});
	};

	const openCatalogTable = (objectPath: string) => {
		const currentState = state();
		const isDifferentTable =
			currentState.status !== "ready" ||
			currentState.snapshot.table.objectPath !== objectPath;
		if (
			session()?.dirty &&
			isDifferentTable &&
			!window.confirm(
				"Switch tables? The active dirty draft will remain persisted under Recent drafts."
			)
		)
			return;
		beginAction.cancel();
		setIsReplacing(true);
		const preserveCurrent = state().status === "ready";
		loadAction.run(props.client.openCatalogTable(objectPath), {
			onFailure: (cause) => {
				setReplacementNotice(Cause.pretty(cause));
				setIsReplacing(false);
			},
			onSuccess: (result) => {
				applyResult(result, preserveCurrent);
				setIsReplacing(false);
			}
		});
	};

	const runSessionOperation = (effect: Effect.Effect<AuthoringSessionResult, unknown>): void => {
		if (isPersisting()) return;
		setIsPersisting(true);
		sessionAction.run(effect, {
			onFailure: (cause) => {
				setSessionNotice(Cause.pretty(cause));
				setIsPersisting(false);
			},
			onSuccess: (result) => {
				acceptSessionResult(result);
				setIsPersisting(false);
			}
		});
	};

	const openPersistedSession = (sessionId: string) => {
		if (
			session()?.dirty &&
			session()?.sessionId !== sessionId &&
			!window.confirm("Open another draft? The active dirty draft will remain persisted.")
		)
			return;
		runSessionOperation(props.client.openSession(sessionId));
	};

	const discardPersistedSession = (draft: AuthoringSessionSummary) => {
		if (
			!window.confirm(
				`Discard the persisted draft for ${shortObjectName(draft.tableObjectPaths[0] ?? draft.id)}? This cannot be undone.`
			)
		)
			return;
		if (isPersisting()) return;
		setIsPersisting(true);
		sessionAction.run(props.client.discardSession(draft.id), {
			onFailure: (cause) => {
				setSessionNotice(Cause.pretty(cause));
				setIsPersisting(false);
			},
			onSuccess: (result) => {
				setSessions(result);
				setIsPersisting(false);
				if (result.status === "failed") {
					setSessionNotice(`${result.error.message} ${result.error.recovery}`);
					return;
				}
				if (session()?.sessionId === draft.id) {
					const currentState = state();
					setSession(undefined);
					if (currentState.status === "ready") {
						beginSession(currentState.snapshot.table.objectPath);
					}
				}
			}
		});
	};

	const currentRows = (): readonly AuthoringRow[] => {
		const current = state();
		return current.status === "ready" ? current.snapshot.table.rows : [];
	};

	const suggestedRowName = (base: string): string => {
		const names = new Set(currentRows().map((row) => row.name.toLocaleLowerCase()));
		if (!names.has(base.toLocaleLowerCase())) return base;
		let suffix = 2;
		while (names.has(`${base}${suffix}`.toLocaleLowerCase())) suffix += 1;
		return `${base}${suffix}`;
	};

	const runRowIntent = (intent: RowIntentWithoutScope) => {
		const currentSession = session();
		const currentState = state();
		if (!currentSession || currentState.status !== "ready") return;
		const completeIntent: AuthoringRowIntent = {
			...intent,
			sessionId: currentSession.sessionId,
			tableObjectPath: currentState.snapshot.table.objectPath
		};
		runSessionOperation(props.client.editSession(completeIntent));
	};

	const removeRow = (rowId: string) => {
		const row = currentRows().find((candidate) => candidate.id === rowId);
		if (!row || !window.confirm(`Delete row ${row.name} and all of its values?`)) return;
		runRowIntent({ kind: "remove_row", rowId });
		setSelection(undefined);
	};

	const moveSelectedRow = (offset: -1 | 1) => {
		if (query().trim().length > 0) {
			setSessionNotice("Clear the row filter before changing canonical row order.");
			return;
		}
		const selectedRowId = selection()?.rowId;
		if (!selectedRowId) return;
		const ids = currentRows().map((row) => row.id);
		const index = ids.indexOf(selectedRowId);
		const target = index + offset;
		if (index < 0 || target < 0 || target >= ids.length) return;
		const reordered = [...ids];
		const selectedId = reordered[index];
		const targetId = reordered[target];
		if (selectedId === undefined || targetId === undefined) return;
		reordered[index] = targetId;
		reordered[target] = selectedId;
		runRowIntent({ kind: "reorder_rows", rowIds: reordered });
	};

	const submitRowEditor = () => {
		const editor = rowEditor();
		if (!editor) return;
		const rowName = editor.value.trim();
		if (rowName.length === 0) {
			setSessionNotice("Row names cannot be empty.");
			return;
		}
		if (editor.kind === "add_row") {
			runRowIntent({ atIndex: editor.atIndex, kind: "add_row", rowName });
		} else if (editor.kind === "duplicate_row") {
			runRowIntent({
				atIndex: editor.atIndex,
				kind: "duplicate_row",
				rowName,
				sourceRowId: editor.sourceRowId
			});
		} else {
			runRowIntent({ kind: "rename_row", rowId: editor.rowId, rowName });
		}
		setRowEditor(undefined);
	};

	const handleGridGesture = (gesture: AuthoringGridGesture) => {
		if (gesture.kind !== "set_cells" && query().trim().length > 0) {
			setSessionNotice("Clear the row filter before using grid structural shortcuts.");
			return;
		}
		if (gesture.kind === "set_cells") {
			const currentSession = session();
			const currentState = state();
			if (!currentSession || currentState.status !== "ready") return;
			runSessionOperation(
				props.client.editSession({
					edits: gesture.edits,
					kind: "set_cells",
					sessionId: currentSession.sessionId,
					tableObjectPath: currentState.snapshot.table.objectPath
				})
			);
		} else if (gesture.kind === "add_row") {
			setRowEditor({
				atIndex: gesture.atIndex,
				kind: "add_row",
				value: suggestedRowName("NewRow")
			});
		} else {
			removeRow(gesture.rowId);
		}
	};

	const stageRowReference = (args: {
		readonly fieldName: string;
		readonly rowId: string;
		readonly value: RowReferenceValue;
	}) => {
		const currentSession = session();
		const currentState = state();
		if (!currentSession || currentState.status !== "ready") return;
		runSessionOperation(
			props.client.editSession({
				edits: [args],
				kind: "set_cells",
				sessionId: currentSession.sessionId,
				tableObjectPath: currentState.snapshot.table.objectPath
			})
		);
	};

	onMount(() => {
		load(false);
		loadCatalog();
		refreshSessions();
	});

	return (
		<main {...stylex.props(styles.page)}>
			<PageHeader
				eyebrow="DATA AUTHORING / SAVED + LIVE AUTHORITY"
				title="Table ledger"
				description="Typed DataTable evidence with durable staged edits."
				actions={
					<>
						<Button
							type="button"
							tone="primary"
							disabled={isReplacing()}
							onClick={() => void load(true)}
						>
							{isReplacing() ? "Opening…" : "Open saved table"}
						</Button>
						<Button
							type="button"
							disabled={isReplacing()}
							onClick={() => void load(false)}
						>
							Reload preset
						</Button>
					</>
				}
			/>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.emptyState)}>
						<span {...stylex.props(styles.pulse)} /> Reading typed table snapshot…
					</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.coldStart)}>
						<CatalogPanel
							disabled={isReplacing()}
							onDiscardSession={discardPersistedSession}
							onOpen={openCatalogTable}
							onOpenSession={openPersistedSession}
							onQueryChange={setCatalogQuery}
							onRefresh={loadCatalog}
							query={catalogQuery()}
							progress={catalogProgress()}
							sessions={sessions()}
							state={catalogState()}
						/>
						<div {...stylex.props(styles.emptyState)}>
							<strong>Select a project DataTable.</strong>
							<span>
								Choose from the project index or open a package outside the
								configured root.
							</span>
							<button
								type="button"
								onClick={() => void load(true)}
								{...stylex.props(styles.inlineButton)}
							>
								Choose .uasset
							</button>
						</div>
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.emptyState)}>
						Selection cancelled. The current table was not replaced.
					</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<div {...stylex.props(styles.errorState)}>
								<strong>{current.error.message}</strong>
								<span>{current.error.recovery}</span>
								<Show when={current.error.retrySafe}>
									<button
										type="button"
										onClick={() => void load(false)}
										{...stylex.props(styles.inlineButton)}
									>
										Retry
									</button>
								</Show>
							</div>
						);
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					{(() => {
						const current = state();
						if (current.status !== "ready") return null;
						const snapshot = current.snapshot;
						const columns = tableColumns(snapshot);
						const visibleRows = createMemo(() =>
							filterRows(snapshot.table.rows, query())
						);
						const selected = createMemo(() => {
							const target = selection();
							if (!target) return undefined;
							const row = snapshot.table.rows.find(
								(item) => item.id === target.rowId
							);
							const field = row ? fieldInRow(row, target.fieldName) : undefined;
							return row && field ? { field, row } : undefined;
						});
						const selectedRow = createMemo(() =>
							snapshot.table.rows.find((row) => row.id === selection()?.rowId)
						);
						const catalogTablePaths = createMemo(() =>
							(() => {
								const catalog = catalogState();
								return catalog.status === "ready"
									? catalog.tables.map((table) => table.objectPath)
									: [];
							})()
						);
						return (
							<div {...stylex.props(styles.workspace)}>
								<section
									{...stylex.props(styles.manifest)}
									aria-label="Table manifest"
								>
									<div {...stylex.props(styles.assetIdentity)}>
										<span {...stylex.props(styles.assetBadge)}>
											{authorityLabel(snapshot)}
										</span>
										<strong>
											{shortObjectName(snapshot.table.objectPath)}
										</strong>
										<small>{snapshot.table.objectPath}</small>
									</div>
									<div {...stylex.props(styles.metric)}>
										<strong>
											{String(snapshot.table.rows.length).padStart(2, "0")}
										</strong>
										<span>ROWS</span>
									</div>
									<div {...stylex.props(styles.metric)}>
										<strong>{String(columns.length).padStart(2, "0")}</strong>
										<span>FIELDS</span>
									</div>
									<div {...stylex.props(styles.metric)}>
										<strong>{snapshot.completeness.toUpperCase()}</strong>
										<span>SNAPSHOT</span>
									</div>
									<div {...stylex.props(styles.readOnlyFlag)}>
										<span>{session()?.dirty ? "●" : "○"}</span>
										<div {...stylex.props(styles.draftState)}>
											<strong>
												{session()?.dirty ? "STAGED DRAFT" : "DRAFT READY"}
											</strong>
											<small {...stylex.props(styles.draftStateDetail)}>
												{session()
													? `${session()?.commandCount ?? 0} active command(s) · ${session()?.review.validation.errorCount ?? 0} errors`
													: "Opening persistent session…"}
											</small>
										</div>
									</div>
								</section>

								<Show when={snapshot.diagnostics.length > 0}>
									<section {...stylex.props(styles.diagnostics)}>
										<strong>
											{snapshot.diagnostics.length} PACKAGE DIAGNOSTICS
										</strong>
										<For each={snapshot.diagnostics}>
											{(diagnostic) => <span>{diagnostic.message}</span>}
										</For>
									</section>
								</Show>

								<Show when={replacementNotice()}>
									<div {...stylex.props(styles.replacementNotice)}>
										<span>{replacementNotice()}</span>
										<button
											type="button"
											onClick={() => setReplacementNotice(undefined)}
											{...stylex.props(styles.noticeDismiss)}
										>
											Dismiss
										</button>
									</div>
								</Show>
								<Show when={sessionNotice()}>
									<div {...stylex.props(styles.replacementNotice)}>
										<span>{sessionNotice()}</span>
									</div>
								</Show>
								<Show when={rowEditor()}>
									{(editor) => (
										<div {...stylex.props(styles.rowEditorBackdrop)}>
											<form
												aria-label="Row name editor"
												onSubmit={(event) => {
													event.preventDefault();
													submitRowEditor();
												}}
												{...stylex.props(styles.rowEditor)}
											>
												<span {...stylex.props(styles.inspectorKicker)}>
													{editor().kind === "add_row"
														? "ADD ROW"
														: editor().kind === "duplicate_row"
															? "DUPLICATE ROW"
															: "RENAME ROW"}
												</span>
												<label {...stylex.props(styles.rowEditorLabel)}>
													Unreal row name
													<input
														autofocus
														value={editor().value}
														onInput={(event) =>
															setRowEditor({
																...editor(),
																value: event.currentTarget.value
															})
														}
														{...stylex.props(styles.rowEditorInput)}
													/>
												</label>
												<div {...stylex.props(styles.rowEditorActions)}>
													<button
														type="button"
														onClick={() => setRowEditor(undefined)}
														{...stylex.props(styles.dialogButton)}
													>
														Cancel
													</button>
													<button
														type="submit"
														{...stylex.props(
															styles.dialogButton,
															styles.dialogPrimary
														)}
													>
														Stage row
													</button>
												</div>
											</form>
										</div>
									)}
								</Show>

								<div
									role="tablist"
									aria-label="Authoring workspace view"
									{...stylex.props(styles.viewTabs)}
								>
									<button
										type="button"
										role="tab"
										aria-selected={workspaceMode() === "table"}
										onClick={() => setWorkspaceMode("table")}
										{...stylex.props(
											styles.viewTab,
											workspaceMode() === "table" && styles.viewTabActive
										)}
									>
										Canonical table
									</button>
									<button
										type="button"
										role="tab"
										aria-selected={workspaceMode() === "relationships"}
										onClick={() => setWorkspaceMode("relationships")}
										{...stylex.props(
											styles.viewTab,
											workspaceMode() === "relationships" &&
												styles.viewTabActive
										)}
									>
										Relationship view
									</button>
								</div>

								<Show
									when={workspaceMode() === "table"}
									fallback={
										<AuthoringCombinedView
											catalogTablePaths={catalogTablePaths()}
											client={props.client}
											initialSnapshot={snapshot}
											onOpenForEditing={(objectPath) => {
												setWorkspaceMode("table");
												openCatalogTable(objectPath);
											}}
										/>
									}
								>
									<div {...stylex.props(styles.contentGrid)}>
										<CatalogPanel
											activeObjectPath={snapshot.table.objectPath}
											disabled={isReplacing()}
											onDiscardSession={discardPersistedSession}
											onOpen={(objectPath) =>
												void openCatalogTable(objectPath)
											}
											onOpenSession={openPersistedSession}
											onQueryChange={setCatalogQuery}
											onRefresh={() => void loadCatalog()}
											query={catalogQuery()}
											progress={catalogProgress()}
											sessions={sessions()}
											state={catalogState()}
										/>
										<section {...stylex.props(styles.sheet)}>
											<div {...stylex.props(styles.sheetTools)}>
												<label {...stylex.props(styles.searchWrap)}>
													<span>FILTER</span>
													<input
														aria-label="Filter table rows"
														value={query()}
														onInput={(event) =>
															setQuery(event.currentTarget.value)
														}
														placeholder="Row names and values…"
														{...stylex.props(styles.search)}
													/>
												</label>
												<span {...stylex.props(styles.visibleCount)}>
													{visibleRows().length} /{" "}
													{snapshot.table.rows.length} VISIBLE
												</span>
												<span {...stylex.props(styles.rowStruct)}>
													ROW STRUCT · {snapshot.table.rowStruct}
												</span>
												<Show when={session()}>
													{(currentSession) => (
														<div {...stylex.props(styles.rowActions)}>
															<button
																type="button"
																disabled={isPersisting()}
																onClick={() =>
																	setRowEditor({
																		atIndex:
																			snapshot.table.rows
																				.length,
																		kind: "add_row",
																		value: suggestedRowName(
																			"NewRow"
																		)
																	})
																}
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																+ Row
															</button>
															<button
																type="button"
																disabled={
																	!selectedRow() || isPersisting()
																}
																onClick={() => {
																	const row = selectedRow();
																	if (!row) return;
																	setRowEditor({
																		atIndex:
																			snapshot.table.rows.indexOf(
																				row
																			) + 1,
																		kind: "duplicate_row",
																		sourceRowId: row.id,
																		value: suggestedRowName(
																			`${row.name}Copy`
																		)
																	});
																}}
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																Duplicate
															</button>
															<button
																type="button"
																disabled={
																	!selectedRow() || isPersisting()
																}
																onClick={() => {
																	const row = selectedRow();
																	if (row)
																		setRowEditor({
																			kind: "rename_row",
																			rowId: row.id,
																			value: row.name
																		});
																}}
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																Rename
															</button>
															<button
																type="button"
																disabled={
																	!selectedRow() || isPersisting()
																}
																onClick={() => {
																	const row = selectedRow();
																	if (row) removeRow(row.id);
																}}
																{...stylex.props(
																	styles.sheetAction,
																	styles.dangerAction
																)}
															>
																Delete
															</button>
															<button
																type="button"
																disabled={
																	!selectedRow() ||
																	query().trim().length > 0 ||
																	isPersisting()
																}
																onClick={() => moveSelectedRow(-1)}
																aria-label="Move selected row up"
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																↑
															</button>
															<button
																type="button"
																disabled={
																	!selectedRow() ||
																	query().trim().length > 0 ||
																	isPersisting()
																}
																onClick={() => moveSelectedRow(1)}
																aria-label="Move selected row down"
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																↓
															</button>
															<button
																type="button"
																disabled={
																	!currentSession().canUndo ||
																	isPersisting()
																}
																onClick={() =>
																	runSessionOperation(
																		props.client.undoSession(
																			currentSession()
																				.sessionId
																		)
																	)
																}
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																Undo
															</button>
															<button
																type="button"
																disabled={
																	!currentSession().canRedo ||
																	isPersisting()
																}
																onClick={() =>
																	runSessionOperation(
																		props.client.redoSession(
																			currentSession()
																				.sessionId
																		)
																	)
																}
																{...stylex.props(
																	styles.sheetAction
																)}
															>
																Redo
															</button>
															<Show
																when={(() => {
																	const pipeline =
																		currentSession().pipeline;
																	return (
																		pipeline.kind === "draft" &&
																		pipeline.canApply
																	);
																})()}
															>
																<Button
																	disabled={isPersisting()}
																	onClick={() => {
																		if (
																			!window.confirm(
																				`Apply ${currentSession().commandCount} staged command(s) to the live editor? This does not save packages.`
																			)
																		)
																			return;
																		runSessionOperation(
																			props.client.applySession(
																				currentSession()
																					.sessionId
																			)
																		);
																	}}
																>
																	Apply
																</Button>
															</Show>
															<Show
																when={(() => {
																	const pipeline =
																		currentSession().pipeline;
																	return (
																		pipeline.kind ===
																			"indeterminate" &&
																		pipeline.operation ===
																			"apply"
																	);
																})()}
															>
																<Button
																	disabled={isPersisting()}
																	onClick={() =>
																		runSessionOperation(
																			props.client.reconcileSession(
																				currentSession()
																					.sessionId
																			)
																		)
																	}
																>
																	Reconcile Apply
																</Button>
															</Show>
															<Show
																when={(() => {
																	const pipeline =
																		currentSession().pipeline;
																	return (
																		pipeline.kind ===
																			"applied" ||
																		(pipeline.kind ===
																			"indeterminate" &&
																			pipeline.operation ===
																				"save")
																	);
																})()}
															>
																<Button
																	disabled={isPersisting()}
																	onClick={() =>
																		runSessionOperation(
																			props.client.saveSession(
																				currentSession()
																					.sessionId
																			)
																		)
																	}
																>
																	Save packages
																</Button>
															</Show>
														</div>
													)}
												</Show>
											</div>
											<AuthoringTableGrid
												columns={columns}
												disabled={!session() || isPersisting()}
												dirtyCells={
													session()?.review.tables.find(
														(table) =>
															table.objectPath ===
															snapshot.table.objectPath
													)?.dirtyCells
												}
												dirtyRowIds={
													session()?.review.tables.find(
														(table) =>
															table.objectPath ===
															snapshot.table.objectPath
													)?.dirtyRowIds
												}
												onEditFailure={setSessionNotice}
												onGesture={handleGridGesture}
												onSelectionChange={setSelection}
												rows={visibleRows()}
											/>
										</section>

										<aside {...stylex.props(styles.inspector)}>
											<div {...stylex.props(styles.inspectorTabs)}>
												<button
													type="button"
													onClick={() => setInspectorTab("cell")}
													{...stylex.props(
														styles.inspectorTab,
														inspectorTab() === "cell" &&
															styles.inspectorTabActive
													)}
												>
													Cell
												</button>
												<button
													type="button"
													onClick={() => setInspectorTab("review")}
													{...stylex.props(
														styles.inspectorTab,
														inspectorTab() === "review" &&
															styles.inspectorTabActive
													)}
												>
													Review{" "}
													{session()?.review.activeCommandCount ?? 0}
												</button>
											</div>
											<Show when={inspectorTab() === "cell"}>
												<Show
													when={selected()}
													fallback={
														<div
															{...stylex.props(styles.inspectorEmpty)}
														>
															Select a typed cell to inspect its
															value.
														</div>
													}
												>
													{(target) => (
														<>
															<span
																{...stylex.props(
																	styles.inspectorKicker
																)}
															>
																CELL EVIDENCE
															</span>
															<h2
																{...stylex.props(
																	styles.inspectorTitle
																)}
															>
																{target().field.name}
															</h2>
															<p
																{...stylex.props(
																	styles.inspectorPath
																)}
															>
																{target().row.name} /{" "}
																{target().field.name}
															</p>
															<div
																{...stylex.props(styles.valueHero)}
															>
																<small>
																	{valueSummary(
																		target().field.value
																	).toUpperCase()}
																</small>
																<strong>
																	{formatAuthoringValue(
																		target().field.value
																	)}
																</strong>
															</div>
															<div
																{...stylex.props(styles.detailList)}
															>
																<div
																	{...stylex.props(
																		styles.detailItem
																	)}
																>
																	<span
																		{...stylex.props(
																			styles.detailLabel
																		)}
																	>
																		UNREAL TYPE
																	</span>
																	<strong>
																		{target().field.typeName}
																	</strong>
																</div>
																<div
																	{...stylex.props(
																		styles.detailItem
																	)}
																>
																	<span
																		{...stylex.props(
																			styles.detailLabel
																		)}
																	>
																		VALUE KIND
																	</span>
																	<strong>
																		{target().field.value.kind}
																	</strong>
																</div>
																<div
																	{...stylex.props(
																		styles.detailItem
																	)}
																>
																	<span
																		{...stylex.props(
																			styles.detailLabel
																		)}
																	>
																		ROW IDENTITY
																	</span>
																	<strong>
																		{target().row.id}
																	</strong>
																</div>
															</div>
															<Show
																when={asRowReference(
																	target().field.value
																)}
															>
																{(value) => (
																	<RowReferencePicker
																		client={props.client}
																		disabled={
																			isPersisting() ||
																			!session()
																		}
																		onStage={(nextValue) =>
																			stageRowReference({
																				fieldName:
																					target().field
																						.name,
																				rowId: target().row
																					.id,
																				value: nextValue
																			})
																		}
																		sourceKey={`${snapshot.table.objectPath}:${target().row.id}:${target().field.name}`}
																		tableObjectPaths={catalogTablePaths()}
																		value={value()}
																	/>
																)}
															</Show>
														</>
													)}
												</Show>
											</Show>
											<Show when={inspectorTab() === "review"}>
												<div {...stylex.props(styles.reviewSummary)}>
													<span {...stylex.props(styles.inspectorKicker)}>
														SESSION REVIEW
													</span>
													<strong>
														{(session()?.review.activeCommandCount ??
															0) === 0
															? "No staged changes"
															: session()?.review.validation.valid
																? "Ready to apply"
																: "Needs attention"}
													</strong>
													<small>
														{session()?.review.validation.errorCount ??
															0}{" "}
														errors ·{" "}
														{session()?.review.validation
															.warningCount ?? 0}{" "}
														warnings ·{" "}
														{session()?.review.commandGroups.filter(
															(group) => group.active
														).length ?? 0}{" "}
														gestures
													</small>
												</div>
												<div {...stylex.props(styles.reviewList)}>
													<For
														each={
															session()?.review.tables.flatMap(
																(table) => table.changes
															) ?? []
														}
													>
														{(change) => (
															<div
																{...stylex.props(
																	styles.reviewChange
																)}
															>
																<strong>
																	{reviewChangeTitle(change)}
																</strong>
																<small>
																	{reviewChangeSummary(change)}
																</small>
															</div>
														)}
													</For>
													<Show
														when={
															(session()?.review.activeCommandCount ??
																0) === 0
														}
													>
														<div
															{...stylex.props(styles.inspectorEmpty)}
														>
															No staged changes.
														</div>
													</Show>
												</div>
												<For
													each={
														session()?.review.validation.diagnostics ??
														[]
													}
												>
													{(diagnostic) => (
														<div
															{...stylex.props(
																styles.reviewDiagnostic
															)}
														>
															<strong>
																{diagnostic.severity.toUpperCase()}
															</strong>
															<span>{diagnostic.message}</span>
														</div>
													)}
												</For>
											</Show>
										</aside>
									</div>
								</Show>
							</div>
						);
					})()}
				</Match>
			</Switch>
		</main>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: { default: "32px 36px 42px", "@media (max-width: 700px)": "18px 14px 28px" },
		color: tokens.colorText,
		backgroundColor: tokens.colorCanvas,
		backgroundImage:
			"linear-gradient(90deg, #ffffff05 1px, transparent 1px), linear-gradient(#ffffff04 1px, transparent 1px)",
		backgroundSize: "32px 32px"
	},
	coldStart: {
		display: "grid",
		gridTemplateColumns: {
			default: "230px minmax(0, 1fr)",
			"@media (max-width: 700px)": "minmax(0, 1fr)"
		},
		gap: 10
	},
	emptyState: {
		minHeight: 360,
		border: "1px solid #343a36",
		backgroundColor: "#111412",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		color: "#879088",
		fontSize: 11
	},
	errorState: {
		minHeight: 280,
		border: "1px solid #704a3c",
		backgroundColor: "#1b1210",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		color: "#d7a08b",
		fontSize: 11
	},
	inlineButton: {
		marginTop: 8,
		border: "1px solid #58614e",
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorAccent,
		padding: "8px 12px",
		cursor: "pointer",
		fontSize: 9,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	pulse: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		backgroundColor: tokens.colorAccent
	},
	workspace: { display: "flex", flexDirection: "column", gap: 10 },
	viewTabs: {
		display: "flex",
		alignItems: "center",
		border: "1px solid #39403b",
		backgroundColor: "#0e110f",
		padding: 4
	},
	viewTab: {
		border: 0,
		borderBottom: "2px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "#171d18" },
		color: "#78827a",
		cursor: "pointer",
		padding: "9px 13px",
		fontSize: 8,
		letterSpacing: ".1em",
		textTransform: "uppercase"
	},
	viewTabActive: {
		borderBottomColor: tokens.colorAccent,
		backgroundColor: "#171d18",
		color: "#dce3d8"
	},
	manifest: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(300px, 1.7fr) repeat(3, minmax(105px, .42fr)) minmax(220px, .8fr)",
			"@media (max-width: 1000px)":
				"minmax(220px, 1.4fr) repeat(3, minmax(65px, .35fr)) minmax(160px, .8fr)",
			"@media (max-width: 700px)": "repeat(3, minmax(0, 1fr))"
		},
		border: "1px solid #39403b",
		backgroundColor: "#111412"
	},
	assetIdentity: {
		display: "flex",
		flexDirection: "column",
		gridColumn: { default: "auto", "@media (max-width: 700px)": "1 / -1" },
		gap: 5,
		padding: "14px 16px"
	},
	assetBadge: { color: tokens.colorAccent, fontSize: 8, letterSpacing: ".14em" },
	metric: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		padding: "10px 15px",
		borderLeft: "1px solid #303632",
		gap: 4
	},
	readOnlyFlag: {
		display: "flex",
		alignItems: "center",
		gridColumn: { default: "auto", "@media (max-width: 700px)": "1 / -1" },
		gap: 10,
		padding: "10px 15px",
		borderLeft: "1px solid #303632",
		color: "#d6a363"
	},
	draftState: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
	draftStateDetail: { color: "#9b8060", fontSize: 8, lineHeight: 1.35 },
	diagnostics: {
		display: "flex",
		gap: 16,
		padding: "10px 14px",
		border: "1px solid #665337",
		backgroundColor: "#1a1710",
		color: "#d6a363",
		fontSize: 9
	},
	replacementNotice: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "9px 12px",
		border: "1px solid #665337",
		backgroundColor: "#1a1710",
		color: "#d6a363",
		fontSize: 9
	},
	noticeDismiss: {
		border: 0,
		backgroundColor: "transparent",
		color: "#d6a363",
		cursor: "pointer",
		fontSize: 8,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	contentGrid: {
		display: "grid",
		gridTemplateColumns: {
			default: "230px minmax(0, 1fr) 300px",
			"@media (max-width: 1050px)": "minmax(0, 1fr)"
		},
		gap: 10
	},
	catalog: {
		minHeight: 480,
		border: "1px solid #39403b",
		backgroundColor: "#0e110f",
		overflow: "hidden"
	},
	catalogHeading: {
		height: 58,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "0 12px",
		borderBottom: "1px solid #303632"
	},
	catalogTitle: { display: "flex", flexDirection: "column", gap: 4 },
	catalogEyebrow: { color: "#718073", fontSize: 7, letterSpacing: ".14em" },
	catalogName: { color: "#d9ded7", fontFamily: "Georgia, serif", fontSize: 18, fontWeight: 400 },
	catalogRefresh: {
		width: 28,
		height: 28,
		border: "1px solid #39413b",
		backgroundColor: { default: "transparent", ":hover": "#202720" },
		color: "#9dab9e",
		cursor: "pointer"
	},
	catalogSearch: {
		width: "calc(100% - 20px)",
		margin: 10,
		border: "1px solid #343b36",
		backgroundColor: "#090b0a",
		color: "#e0e5dd",
		padding: "8px 9px",
		outlineColor: tokens.colorAccent,
		fontSize: 9
	},
	catalogStatus: { padding: 14, color: "#737d75", fontSize: 9, lineHeight: 1.6 },
	catalogProgressBlock: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: 14,
		color: "#737d75",
		fontSize: 9,
		lineHeight: 1.4
	},
	catalogProgressLabel: {
		display: "flex",
		justifyContent: "space-between",
		gap: 8,
		color: "#9dab9e"
	},
	catalogProgress: {
		width: "100%",
		height: 5,
		accentColor: tokens.colorAccent
	},
	catalogList: {
		maxHeight: "calc(100vh - 350px)",
		overflowY: "auto",
		borderTop: "1px solid #252b27"
	},
	catalogItem: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 5,
		border: 0,
		borderBottom: "1px solid #252b27",
		borderLeft: "3px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "#171d18" },
		color: "#b8c0b8",
		padding: "11px 10px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 10
	},
	catalogItemActive: {
		borderLeftColor: tokens.colorAccent,
		backgroundColor: tokens.colorSurfaceHover
	},
	catalogItemName: {
		width: "100%",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	catalogItemKind: { color: "#68736a", fontSize: 7, letterSpacing: ".1em" },
	catalogDivergence: {
		color: "#d6a363",
		fontSize: 7,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	catalogWarning: {
		borderBottom: "1px solid #665337",
		backgroundColor: "#1a1710",
		color: "#d6a363",
		fontSize: 7,
		letterSpacing: ".08em",
		padding: "8px 10px",
		textTransform: "uppercase"
	},
	draftShelf: { borderTop: "1px solid #303632" },
	draftShelfHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "10px 11px 7px",
		color: "#718073",
		fontSize: 7,
		letterSpacing: ".14em"
	},
	draftItem: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 28px",
		borderTop: "1px solid #252b27"
	},
	draftOpen: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 4,
		border: 0,
		backgroundColor: { default: "transparent", ":hover": "#171d18" },
		color: "#b8c0b8",
		padding: "9px 10px",
		textAlign: "left",
		cursor: "pointer"
	},
	draftDiscard: {
		border: 0,
		borderLeft: "1px solid #252b27",
		backgroundColor: { default: "transparent", ":hover": "#351c19" },
		color: "#9e6d63",
		cursor: "pointer",
		fontSize: 15
	},
	sheet: { minWidth: 0, border: "1px solid #39403b", backgroundColor: "#101311" },
	sheetTools: {
		minHeight: 48,
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 6,
		padding: "8px 10px",
		borderBottom: "1px solid #303632"
	},
	searchWrap: { display: "flex", alignItems: "center", gap: 9, color: "#707a72", fontSize: 8 },
	search: {
		width: { default: 250, "@media (max-width: 700px)": "100%" },
		border: "1px solid #39413b",
		backgroundColor: "#090b0a",
		color: "#e0e5dd",
		padding: "8px 10px",
		outlineColor: tokens.colorAccent
	},
	visibleCount: { color: "#89938c", fontSize: 8, letterSpacing: ".08em" },
	rowStruct: {
		marginLeft: "auto",
		maxWidth: 360,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: "#58615a",
		fontSize: 8
	},
	rowActions: {
		width: "100%",
		display: "flex",
		alignItems: "center",
		gap: 6,
		paddingTop: 7,
		borderTop: "1px solid #252b27"
	},
	sheetAction: {
		border: "1px solid #39413b",
		backgroundColor: { default: "#111512", ":hover": "#202720", ":disabled": "#101210" },
		color: { default: "#aeb9af", ":disabled": "#4d554f" },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontSize: 8,
		padding: "6px 9px",
		textTransform: "uppercase"
	},
	dangerAction: { color: "#d18b7e" },
	inspector: {
		minHeight: 480,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		padding: 20,
		overflow: "hidden"
	},
	inspectorTabs: {
		display: "grid",
		gridTemplateColumns: "1fr 1fr",
		margin: "-20px -20px 20px",
		borderBottom: "1px solid #333a35"
	},
	inspectorTab: {
		border: 0,
		borderBottom: "2px solid transparent",
		backgroundColor: { default: "#0e110f", ":hover": "#171d18" },
		color: "#78827a",
		cursor: "pointer",
		padding: "12px 8px",
		fontSize: 8,
		letterSpacing: ".1em",
		textTransform: "uppercase"
	},
	inspectorTabActive: { borderBottomColor: tokens.colorAccent, color: "#dce3d8" },
	inspectorEmpty: { color: "#727a74", fontSize: 10, lineHeight: 1.6 },
	inspectorKicker: { color: "#8fa080", fontSize: 8, letterSpacing: ".15em" },
	inspectorTitle: {
		margin: "12px 0 5px",
		fontFamily: "Georgia, serif",
		fontSize: 28,
		fontWeight: 400
	},
	inspectorPath: { margin: 0, color: "#6f7871", fontSize: 9 },
	valueHero: {
		marginTop: 22,
		minHeight: 120,
		display: "flex",
		flexDirection: "column",
		justifyContent: "space-between",
		padding: 16,
		borderLeftColor: tokens.colorAccent,
		borderLeftStyle: "solid",
		borderLeftWidth: 3,
		backgroundColor: "#0b0e0c",
		color: "#dfe4dc",
		wordBreak: "break-word"
	},
	detailList: { display: "flex", flexDirection: "column", gap: 0, marginTop: 18 },
	detailItem: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		padding: "9px 0",
		borderBottom: "1px solid #292f2b",
		fontSize: 9,
		wordBreak: "break-word"
	},
	detailLabel: { color: "#6f7871", fontSize: 7, letterSpacing: ".1em" },
	referencePicker: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
		marginTop: 20,
		padding: "14px 0 0",
		borderTop: "1px solid #39413b"
	},
	referenceHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8
	},
	referenceStatus: {
		padding: "3px 6px",
		border: "1px solid #39463d",
		backgroundColor: "#0b100c",
		color: tokens.colorAccent,
		fontSize: 7,
		letterSpacing: ".08em"
	},
	referenceField: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: "#aab4ab",
		fontSize: 8,
		letterSpacing: ".06em",
		textTransform: "uppercase"
	},
	referenceSelect: {
		width: "100%",
		border: "1px solid #3a443c",
		borderRadius: 0,
		backgroundColor: "#0a0e0b",
		color: "#d9e0d9",
		fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
		fontSize: 10,
		padding: "9px 10px"
	},
	referenceMessage: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		padding: "9px 10px",
		borderLeft: "2px solid #667368",
		backgroundColor: "#0b0f0c",
		color: "#89938b",
		fontSize: 8,
		lineHeight: 1.45
	},
	referenceError: { borderLeftColor: "#a86f61", color: "#d39b8d" },
	referenceRetry: {
		border: 0,
		backgroundColor: "transparent",
		color: tokens.colorAccent,
		cursor: "pointer",
		fontSize: 8,
		textTransform: "uppercase"
	},
	referenceStage: {
		border: "1px solid #536456",
		backgroundColor: { default: "#172019", ":hover": "#223026", ":disabled": "#101310" },
		color: { default: "#dce5dc", ":disabled": "#505851" },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontSize: 8,
		letterSpacing: ".09em",
		padding: "9px 12px",
		textTransform: "uppercase"
	},
	reviewSummary: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		paddingBottom: 16,
		borderBottom: "1px solid #333a35"
	},
	reviewList: { maxHeight: "calc(100vh - 410px)", overflowY: "auto" },
	reviewChange: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: "11px 0",
		borderBottom: "1px solid #292f2b",
		fontSize: 9
	},
	reviewDiagnostic: {
		display: "grid",
		gridTemplateColumns: "54px 1fr",
		gap: 8,
		padding: "9px 0",
		borderTop: "1px solid #665337",
		color: "#d6a363",
		fontSize: 8,
		lineHeight: 1.45
	},
	rowEditorBackdrop: {
		position: "fixed",
		inset: 0,
		zIndex: 20,
		display: "grid",
		placeItems: "center",
		backgroundColor: "#050706cc"
	},
	rowEditor: {
		width: "min(420px, calc(100vw - 40px))",
		display: "flex",
		flexDirection: "column",
		gap: 18,
		border: "1px solid #566159",
		backgroundColor: "#111512",
		boxShadow: "0 24px 80px #00000088",
		padding: 22
	},
	rowEditorLabel: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		color: "#879088",
		fontSize: 9,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	rowEditorInput: {
		border: "1px solid #465047",
		backgroundColor: "#090b0a",
		color: "#e0e5dd",
		padding: "10px 11px",
		outlineColor: tokens.colorAccent,
		fontSize: 12
	},
	rowEditorActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
	dialogButton: {
		border: "1px solid #465047",
		backgroundColor: { default: "#151a16", ":hover": "#202720" },
		color: "#b8c0b8",
		cursor: "pointer",
		padding: "8px 11px",
		fontSize: 9,
		textTransform: "uppercase"
	},
	dialogPrimary: { borderColor: "#8cad57", color: "#c8ef87" }
});
