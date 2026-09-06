import * as stylex from "@stylexjs/stylex";
import type {
	AuthoringCatalogResult,
	AuthoringCatalogProgress,
	AuthoringAuthority,
	AuthoringClientApi,
	AuthoringLoadFailure,
	AuthoringLoadResult,
	AuthoringSessionListResult,
	AuthoringSessionResult,
	AuthoringRowIntent,
	AuthoringSessionSummary,
	AuthoringSessionView
} from "@ue-shed/authoring-sdk";
import type { AuthoringRow, AuthoringTableSnapshot, AuthoringValue } from "@ue-shed/protocol";
import { Button, createEffectAction, createEffectSubscription } from "@ue-shed/ui";
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
import { AuthoringAnalysisView } from "./authoring-analysis-view.js";
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
type AuthorityPreference = "automatic" | AuthoringAuthority;
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
			return `${change.row.fields.length} ${change.row.fields.length === 1 ? "field" : "fields"}`;
		case "row_removed":
			return "Row and all values will be removed";
		case "row_renamed":
			return `${change.oldName} → ${change.newName}`;
		case "rows_reordered":
			return change.newOrder.join(" · ");
	}
}

function shortObjectName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function sentenceCase(text: string): string {
	const first = text.charAt(0).toLocaleUpperCase();
	return first.length > 0 ? `${first}${text.slice(1)}` : text;
}

function authorityLabel(snapshot: AuthoringTableSnapshot): string {
	return snapshot.authority.kind === "project_files" ? "Saved package" : "Live editor";
}

const noticeInlineLimit = 240;

type NoticeParts = {
	readonly headline: string;
	readonly technical: string | undefined;
};

function noticeParts(text: string): NoticeParts {
	if (text.length <= noticeInlineLimit && !text.includes("\n")) {
		return { headline: text, technical: undefined };
	}
	const [firstLine] = text.split("\n");
	return {
		headline: (firstLine ?? text).slice(0, 160).trim(),
		technical: text
	};
}

function authorityForSnapshot(snapshot: AuthoringTableSnapshot): AuthoringAuthority {
	return snapshot.authority.kind === "project_files" ? "saved" : "live";
}

function applyNotice(view: AuthoringSessionView): string | undefined {
	const apply = view.lastApply;
	if (apply === undefined || apply.status === "committed") return undefined;
	const details = apply.errors.map((error) => error.message).join(" ");
	const status = apply.status === "rolled_back" ? "rolled back" : apply.status;
	return details.length > 0 ? `Apply ${status}: ${details}` : `Apply ${status}.`;
}

function RowReferencePicker(props: {
	readonly client: AuthoringClientApi;
	readonly authority: AuthoringAuthority;
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
		lookupAction.run(props.client.openCatalogTable(path, props.authority), {
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
				<span {...stylex.props(styles.detailLabel)}>Relationship target</span>
				<span {...stylex.props(styles.referenceStatus)}>
					{lookup().status === "loading"
						? "Resolving…"
						: lookup().status === "ready"
							? `${targetRows().length} ${targetRows().length === 1 ? "row" : "rows"}`
							: "Unresolved"}
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
	readonly progress: AuthoringCatalogProgress;
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
				<strong {...stylex.props(styles.catalogName)}>Tables</strong>
				<button
					type="button"
					disabled={props.disabled}
					onClick={props.onRefresh}
					aria-label="Refresh project DataTables"
					{...stylex.props(styles.catalogRefresh)}
				>
					Refresh
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
						Choose a project to list its saved DataTables.
					</div>
				</Match>
				<Match when={props.state.status === "failed"}>
					<div {...stylex.props(styles.catalogStatus)}>
						Could not load the table list. The open table is unchanged.
					</div>
				</Match>
				<Match when={props.state.status === "ready"}>
					<div
						aria-label="Project DataTable list"
						role="region"
						{...stylex.props(styles.catalogList)}
					>
						<Show
							when={
								props.state.status === "ready" && props.state.diagnostics.length > 0
							}
						>
							<div {...stylex.props(styles.catalogWarning)}>
								{props.state.status === "ready"
									? `${props.state.diagnostics.length} catalog ${props.state.diagnostics.length === 1 ? "warning" : "warnings"}`
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
											? "Composite"
											: "Data table"}
										{" · "}
										{table.authorities.join("+")}
									</small>
									<Show when={table.divergence.length > 0}>
										<small {...stylex.props(styles.catalogDivergence)}>
											Diverged · {table.divergence.join(", ")}
										</small>
									</Show>
								</button>
							)}
						</For>
						<Show when={tables().length === 0}>
							<div {...stylex.props(styles.catalogStatus)}>
								No tables match this filter. Clear the filter or refresh the list.
							</div>
						</Show>
					</div>
				</Match>
			</Switch>
		</nav>
	);
}

function SessionShelf(props: {
	readonly disabled: boolean;
	readonly onDiscardSession: (session: AuthoringSessionSummary) => void;
	readonly onOpenSession: (sessionId: string) => void;
	readonly sessions: SessionListState;
}) {
	const drafts = createMemo(() =>
		props.sessions.status === "ready"
			? props.sessions.sessions.filter((session) => session.commandCount > 0)
			: []
	);
	const pendingSaves = createMemo(() =>
		props.sessions.status === "ready"
			? props.sessions.sessions.filter(
					(session) => session.commandCount === 0 && session.needsSave === true
				)
			: []
	);
	const sessionItem = (session: AuthoringSessionSummary, detail: string) => (
		<div {...stylex.props(styles.draftItem)}>
			<button
				type="button"
				disabled={props.disabled}
				onClick={() => props.onOpenSession(session.id)}
				{...stylex.props(styles.draftOpen)}
			>
				<strong>{shortObjectName(session.tableObjectPaths[0] ?? session.id)}</strong>
				<small>{detail}</small>
			</button>
			<button
				type="button"
				disabled={props.disabled}
				aria-label={`Discard draft ${shortObjectName(session.tableObjectPaths[0] ?? session.id)}`}
				onClick={() => props.onDiscardSession(session)}
				{...stylex.props(styles.draftDiscard)}
			>
				×
			</button>
		</div>
	);

	return (
		<section {...stylex.props(styles.sessionShelf)} aria-label="Draft sessions">
			<div {...stylex.props(styles.draftShelfHeading)}>
				<span>Drafts</span>
				<Show when={props.sessions.status === "ready"}>
					<small {...stylex.props(styles.draftCount)}>{drafts().length}</small>
				</Show>
			</div>
			<Show
				when={props.sessions.status === "ready"}
				fallback={
					<div {...stylex.props(styles.catalogStatus)}>
						{props.sessions.status === "failed"
							? "Could not load drafts. The active table is unchanged."
							: "Loading drafts…"}
					</div>
				}
			>
				<For each={drafts()}>
					{(draft) =>
						sessionItem(
							draft,
							`${draft.commandCount} ${draft.commandCount === 1 ? "change" : "changes"} · ${sentenceCase(draft.lifecycle)}`
						)
					}
				</For>
				<Show when={pendingSaves().length > 0}>
					<div {...stylex.props(styles.pendingSaveHeading)}>Unsaved live changes</div>
					<For each={pendingSaves()}>
						{(session) => sessionItem(session, "Saved to editor · save pending")}
					</For>
				</Show>
				<Show when={drafts().length === 0 && pendingSaves().length === 0}>
					<div {...stylex.props(styles.catalogStatus)}>
						No drafts. Changes you stage are kept here until you apply or discard them.
					</div>
				</Show>
			</Show>
		</section>
	);
}

export function AuthoringRoute(props: { readonly client: AuthoringClientApi }) {
	const loadAction = createEffectAction();
	const catalogAction = createEffectAction();
	const catalogProgressSubscription = createEffectSubscription();
	const beginAction = createEffectAction();
	const sessionAction = createEffectAction();
	const sessionListAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const readySnapshot = createMemo(() => {
		const current = state();
		return current.status === "ready" ? current.snapshot : undefined;
	});
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
	let sessionSelectionRevision = 0;
	const replaceSessionSelection = () => {
		sessionSelectionRevision += 1;
		beginAction.cancel();
	};
	const captureSessionOwner = () => {
		const revision = sessionSelectionRevision;
		const currentSession = session();
		const snapshot = readySnapshot();
		return () =>
			revision === sessionSelectionRevision &&
			currentSession?.sessionId === session()?.sessionId &&
			snapshot?.table.objectPath === readySnapshot()?.table.objectPath &&
			snapshot?.authority === readySnapshot()?.authority;
	};
	const [inspectorTab, setInspectorTab] = createSignal<"cell" | "review" | "sessions">("cell");
	const [workspaceMode, setWorkspaceMode] = createSignal<"table" | "relationships">("table");
	const [tableProjection, setTableProjection] = createSignal<"grid" | "charts">("grid");
	const [authorityPreference, setAuthorityPreference] =
		createSignal<AuthorityPreference>("automatic");
	const [selectedAuthority, setSelectedAuthority] = createSignal<AuthoringAuthority>("saved");
	const [catalogGeneration, setCatalogGeneration] = createSignal(0);
	const [attemptedLiveUpgrade, setAttemptedLiveUpgrade] = createSignal<string>();
	const [rowEditor, setRowEditor] = createSignal<RowEditor>();
	const canApplyDraft = createMemo(() => {
		const pipeline = session()?.pipeline;
		return pipeline !== undefined && pipeline.kind === "draft" && pipeline.canApply;
	});
	const canReconcileApply = createMemo(() => {
		const pipeline = session()?.pipeline;
		return (
			pipeline !== undefined &&
			pipeline.kind === "indeterminate" &&
			pipeline.operation === "apply"
		);
	});
	const canSavePackages = createMemo(() => {
		const pipeline = session()?.pipeline;
		return (
			pipeline !== undefined &&
			(pipeline.kind === "applied" ||
				(pipeline.kind === "indeterminate" && pipeline.operation === "save"))
		);
	});
	const activeTableReadOnly = createMemo(
		() => readySnapshot()?.table.kind === "composite_data_table"
	);
	const applyDraftChanges = () => {
		const currentSession = session();
		if (!currentSession) return;
		if (
			!window.confirm(
				`Apply ${currentSession.commandCount} ${currentSession.commandCount === 1 ? "change" : "changes"} to the live editor? Packages are not saved until you choose Save packages.`
			)
		)
			return;
		runSessionOperation(props.client.applySession(currentSession.sessionId));
	};
	const authorityAvailable = (authority: AuthoringAuthority): boolean => {
		const current = state();
		if (current.status === "ready" && authorityForSnapshot(current.snapshot) === authority)
			return true;
		const catalog = catalogState();
		if (current.status !== "ready" || catalog.status !== "ready") return false;
		return (
			catalog.tables
				.find((table) => table.objectPath === current.snapshot.table.objectPath)
				?.authorities.includes(authority) ?? false
		);
	};

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
		setSessionNotice(applyNotice(result.view));
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
			setSelectedAuthority(authorityForSnapshot(result.snapshot));
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
		replaceSessionSelection();
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
				if (result.status === "ready") setCatalogGeneration((generation) => generation + 1);
			}
		});
	};

	const preferredCatalogAuthority = (objectPath: string): AuthoringAuthority => {
		const preference = authorityPreference();
		if (preference !== "automatic") return preference;
		const catalog = catalogState();
		const hasLiveAuthority =
			catalog.status === "ready" &&
			catalog.tables
				.find((table) => table.objectPath === objectPath)
				?.authorities.includes("live") === true;
		return hasLiveAuthority ? "live" : "saved";
	};

	const openCatalogTable = (
		objectPath: string,
		authority: AuthoringAuthority = preferredCatalogAuthority(objectPath)
	) => {
		const currentState = state();
		const isDifferentTable =
			currentState.status !== "ready" ||
			currentState.snapshot.table.objectPath !== objectPath;
		if (
			session()?.dirty &&
			(isDifferentTable || authority !== selectedAuthority()) &&
			!window.confirm(
				"Switch tables? The active dirty draft will remain persisted under Recent drafts."
			)
		)
			return;
		replaceSessionSelection();
		setIsReplacing(true);
		const preserveCurrent = state().status === "ready";
		loadAction.run(props.client.openCatalogTable(objectPath, authority), {
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

	const switchAuthority = (authority: AuthoringAuthority) => {
		const current = state();
		if (current.status !== "ready") return;
		setAuthorityPreference(authority);
		openCatalogTable(current.snapshot.table.objectPath, authority);
	};

	createEffect(() => {
		const current = state();
		const catalog = catalogState();
		if (
			authorityPreference() !== "automatic" ||
			isReplacing() ||
			session()?.dirty ||
			current.status !== "ready" ||
			current.snapshot.authority.kind !== "project_files" ||
			catalog.status !== "ready"
		)
			return;
		const availableLive = catalog.tables
			.find((table) => table.objectPath === current.snapshot.table.objectPath)
			?.authorities.includes("live");
		const attemptKey = `${catalogGeneration()}:${current.snapshot.table.objectPath}`;
		if (!availableLive || attemptedLiveUpgrade() === attemptKey) return;
		setAttemptedLiveUpgrade(attemptKey);
		openCatalogTable(current.snapshot.table.objectPath, "live");
	});

	const runSessionOperation = (effect: Effect.Effect<AuthoringSessionResult, unknown>): void => {
		if (isPersisting()) return;
		const ownsView = captureSessionOwner();
		setIsPersisting(true);
		sessionAction.run(effect, {
			onFailure: (cause) => {
				if (ownsView()) setSessionNotice(Cause.pretty(cause));
				refreshSessions();
				setIsPersisting(false);
			},
			onSuccess: (result) => {
				// A mutation can finish after navigation. Its durable session still belongs
				// in Recent drafts, but its result must not replace the newly selected table.
				if (ownsView()) acceptSessionResult(result);
				else refreshSessions();
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
		if (isPersisting()) return;
		replaceSessionSelection();
		loadAction.cancel();
		setIsReplacing(false);
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
		const ownsView = captureSessionOwner();
		setIsPersisting(true);
		sessionAction.run(props.client.discardSession(draft.id), {
			onFailure: (cause) => {
				if (ownsView()) setSessionNotice(Cause.pretty(cause));
				setIsPersisting(false);
			},
			onSuccess: (result) => {
				setSessions(result);
				setIsPersisting(false);
				if (result.status === "failed") {
					if (ownsView())
						setSessionNotice(`${result.error.message} ${result.error.recovery}`);
					return;
				}
				if (ownsView() && session()?.sessionId === draft.id) {
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
			<header {...stylex.props(styles.routeHeader)}>
				<div {...stylex.props(styles.routeHeading)}>
					<h1 {...stylex.props(styles.routeTitle)}>Data authoring</h1>
					<p {...stylex.props(styles.routeIntro)}>
						Edit DataTable rows with validation, then apply changes through a live
						session.
					</p>
				</div>
				<div {...stylex.props(styles.routeActions)}>
					<Show when={state().status === "ready"}>
						{(() => {
							const current = state();
							if (current.status !== "ready") return null;
							const isLive = current.snapshot.authority.kind === "live_editor";
							return (
								<div
									aria-label="Table source"
									role="group"
									{...stylex.props(styles.authoritySwitch)}
								>
									<Button
										type="button"
										disabled={
											isReplacing() || !isLive || !authorityAvailable("saved")
										}
										onClick={() => switchAuthority("saved")}
										tone="quiet"
									>
										Saved package
									</Button>
									<Button
										type="button"
										disabled={
											isReplacing() || isLive || !authorityAvailable("live")
										}
										onClick={() => switchAuthority("live")}
										tone="quiet"
									>
										Live editor
									</Button>
								</div>
							);
						})()}
					</Show>
					<Button
						type="button"
						tone="secondary"
						disabled={isReplacing()}
						onClick={() => {
							setAuthorityPreference("saved");
							void load(true);
						}}
					>
						{isReplacing() ? "Opening…" : "Open table"}
					</Button>
					<Button
						type="button"
						tone="quiet"
						disabled={isReplacing()}
						onClick={() => {
							setAuthorityPreference("saved");
							void load(false);
						}}
					>
						Reload table
					</Button>
					<Show when={canReconcileApply()}>
						<Button
							type="button"
							tone="secondary"
							disabled={isPersisting() || activeTableReadOnly()}
							onClick={() => {
								const currentSession = session();
								if (!currentSession) return;
								runSessionOperation(
									props.client.reconcileSession(currentSession.sessionId)
								);
							}}
						>
							Check apply status
						</Button>
					</Show>
					<Show when={canSavePackages()}>
						<Button
							type="button"
							tone="secondary"
							disabled={isPersisting()}
							onClick={() => {
								const currentSession = session();
								if (!currentSession) return;
								runSessionOperation(
									props.client.saveSession(currentSession.sessionId)
								);
							}}
						>
							Save packages
						</Button>
					</Show>
					<Show when={canApplyDraft()}>
						<Button
							type="button"
							tone="primary"
							disabled={isPersisting() || activeTableReadOnly()}
							onClick={applyDraftChanges}
						>
							Apply changes
						</Button>
					</Show>
				</div>
			</header>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.emptyState)}>
						<span {...stylex.props(styles.pulse)} /> Loading table…
					</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.coldStart)}>
						<CatalogPanel
							disabled={isReplacing()}
							onOpen={openCatalogTable}
							onQueryChange={setCatalogQuery}
							onRefresh={loadCatalog}
							query={catalogQuery()}
							progress={catalogProgress()}
							state={catalogState()}
						/>
						<div {...stylex.props(styles.emptyState)}>
							<strong>No table open.</strong>
							<span>
								Choose a DataTable from the list, or open a package outside the
								configured project root.
							</span>
							<button
								type="button"
								onClick={() => {
									setAuthorityPreference("saved");
									void load(true);
								}}
								{...stylex.props(styles.inlineButton)}
							>
								Choose file…
							</button>
						</div>
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.emptyState)}>
						No table was selected. The current table is unchanged.
					</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						const parts = noticeParts(current.error.message);
						return (
							<div {...stylex.props(styles.errorState)}>
								<strong>The table did not load.</strong>
								<span>{parts.headline}</span>
								<span {...stylex.props(styles.errorRecovery)}>
									{current.error.recovery}
								</span>
								<Show when={current.error.retrySafe}>
									<button
										type="button"
										onClick={() => void load(false)}
										{...stylex.props(styles.inlineButton)}
									>
										Retry
									</button>
								</Show>
								<Show when={parts.technical}>
									<details {...stylex.props(styles.technicalDetails)}>
										<summary>Technical details</summary>
										<code>{parts.technical}</code>
									</details>
								</Show>
							</div>
						);
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					<Show when={readySnapshot()}>
						{(snapshot) => {
							const columns = createMemo(() => tableColumns(snapshot()));
							const readOnlyTable = createMemo(
								() => snapshot().table.kind === "composite_data_table"
							);
							const visibleRows = createMemo(() =>
								filterRows(snapshot().table.rows, query())
							);
							const selected = createMemo(() => {
								const target = selection();
								if (!target) return undefined;
								const row = snapshot().table.rows.find(
									(item) => item.id === target.rowId
								);
								const field = row ? fieldInRow(row, target.fieldName) : undefined;
								return row && field ? { field, row } : undefined;
							});
							const selectedRow = createMemo(() =>
								snapshot().table.rows.find((row) => row.id === selection()?.rowId)
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
										aria-label="Table summary"
									>
										<div {...stylex.props(styles.assetIdentity)}>
											<span {...stylex.props(styles.assetBadge)}>
												{authorityLabel(snapshot())}
											</span>
											<strong>
												{shortObjectName(snapshot().table.objectPath)}
											</strong>
											<small>{snapshot().table.objectPath}</small>
										</div>
										<div {...stylex.props(styles.metric)}>
											<strong>{snapshot().table.rows.length}</strong>
											<span>Rows</span>
										</div>
										<div {...stylex.props(styles.metric)}>
											<strong>{columns().length}</strong>
											<span>Fields</span>
										</div>
										<div {...stylex.props(styles.metric)}>
											<strong>{sentenceCase(snapshot().completeness)}</strong>
											<span>Snapshot</span>
										</div>
										<div {...stylex.props(styles.readOnlyFlag)}>
											<span>{session()?.dirty ? "●" : "○"}</span>
											<div {...stylex.props(styles.draftState)}>
												<strong>
													{session()?.dirty
														? "Draft"
														: session()?.lastApply?.status ===
															  "committed"
															? "Applied"
															: "Saved snapshot"}
												</strong>
												<small {...stylex.props(styles.draftStateDetail)}>
													{session()
														? `${session()?.commandCount ?? 0} ${session()?.commandCount === 1 ? "change" : "changes"} · ${session()?.review.validation.errorCount ?? 0} ${session()?.review.validation.errorCount === 1 ? "error" : "errors"}`
														: "Opening session…"}
												</small>
											</div>
										</div>
									</section>

									<Show when={snapshot().diagnostics.length > 0}>
										<section {...stylex.props(styles.diagnostics)}>
											<strong>Package warnings</strong>
											<For each={snapshot().diagnostics}>
												{(diagnostic) => <span>{diagnostic.message}</span>}
											</For>
										</section>
									</Show>
									<Show when={readOnlyTable()}>
										<section {...stylex.props(styles.diagnostics)}>
											<strong>Read-only table</strong>
											<span>
												CompositeDataTable rows come from their parent
												tables. Open a parent table to make changes.
											</span>
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
										{(notice) => {
											const parts = noticeParts(notice());
											return (
												<div {...stylex.props(styles.replacementNotice)}>
													<span>{parts.headline}</span>
													<Show when={parts.technical}>
														<details
															{...stylex.props(
																styles.technicalDetails
															)}
														>
															<summary>Technical details</summary>
															<code>{parts.technical}</code>
														</details>
													</Show>
												</div>
											);
										}}
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
													<strong
														{...stylex.props(styles.rowEditorTitle)}
													>
														{editor().kind === "add_row"
															? "Add row"
															: editor().kind === "duplicate_row"
																? "Duplicate row"
																: "Rename row"}
													</strong>
													<label {...stylex.props(styles.rowEditorLabel)}>
														Row name
														<input
															autofocus
															aria-label="Row name"
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
											Table
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
											Relationships
										</button>
									</div>

									<Show
										when={workspaceMode() === "table"}
										fallback={
											<AuthoringCombinedView
												catalogTablePaths={catalogTablePaths()}
												client={props.client}
												initialSnapshot={snapshot()}
												onOpenForEditing={(objectPath) => {
													setWorkspaceMode("table");
													openCatalogTable(objectPath);
												}}
											/>
										}
									>
										<div {...stylex.props(styles.contentGrid)}>
											<CatalogPanel
												activeObjectPath={snapshot().table.objectPath}
												disabled={isReplacing()}
												onOpen={(objectPath) =>
													void openCatalogTable(objectPath)
												}
												onQueryChange={setCatalogQuery}
												onRefresh={() => void loadCatalog()}
												query={catalogQuery()}
												progress={catalogProgress()}
												state={catalogState()}
											/>
											<section {...stylex.props(styles.sheet)}>
												<div {...stylex.props(styles.sheetTools)}>
													<input
														aria-label="Filter table rows"
														value={query()}
														onInput={(event) =>
															setQuery(event.currentTarget.value)
														}
														placeholder="Filter rows…"
														{...stylex.props(styles.search)}
													/>
													<span {...stylex.props(styles.visibleCount)}>
														{visibleRows().length} /{" "}
														{snapshot().table.rows.length} rows
													</span>
													<div
														role="tablist"
														aria-label="Table projection"
														{...stylex.props(styles.viewTabs)}
													>
														<button
															type="button"
															role="tab"
															aria-selected={
																tableProjection() === "grid"
															}
															onClick={() =>
																setTableProjection("grid")
															}
															{...stylex.props(
																styles.viewTab,
																tableProjection() === "grid" &&
																	styles.viewTabActive
															)}
														>
															Grid
														</button>
														<button
															type="button"
															role="tab"
															aria-selected={
																tableProjection() === "charts"
															}
															onClick={() =>
																setTableProjection("charts")
															}
															{...stylex.props(
																styles.viewTab,
																tableProjection() === "charts" &&
																	styles.viewTabActive
															)}
														>
															Charts
														</button>
													</div>
													<span {...stylex.props(styles.rowStruct)}>
														Row struct · {snapshot().table.rowStruct}
													</span>
													<Show when={session()}>
														{(currentSession) => (
															<div
																{...stylex.props(styles.rowActions)}
															>
																<button
																	type="button"
																	disabled={
																		isPersisting() ||
																		readOnlyTable()
																	}
																	onClick={() =>
																		setRowEditor({
																			atIndex:
																				snapshot().table
																					.rows.length,
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
																	Add row
																</button>
																<button
																	type="button"
																	disabled={
																		!selectedRow() ||
																		isPersisting() ||
																		readOnlyTable()
																	}
																	onClick={() => {
																		const row = selectedRow();
																		if (!row) return;
																		setRowEditor({
																			atIndex:
																				snapshot().table.rows.indexOf(
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
																	Duplicate row
																</button>
																<button
																	type="button"
																	disabled={
																		!selectedRow() ||
																		isPersisting() ||
																		readOnlyTable()
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
																	Rename row
																</button>
																<button
																	type="button"
																	disabled={
																		!selectedRow() ||
																		isPersisting() ||
																		readOnlyTable()
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
																	Delete row
																</button>
																<button
																	type="button"
																	disabled={
																		!selectedRow() ||
																		query().trim().length > 0 ||
																		isPersisting() ||
																		readOnlyTable()
																	}
																	onClick={() =>
																		moveSelectedRow(-1)
																	}
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
																		isPersisting() ||
																		readOnlyTable()
																	}
																	onClick={() =>
																		moveSelectedRow(1)
																	}
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
															</div>
														)}
													</Show>
												</div>
												<Show
													when={tableProjection() === "grid"}
													fallback={
														<AuthoringAnalysisView
															rows={visibleRows()}
															snapshot={snapshot()}
														/>
													}
												>
													<AuthoringTableGrid
														columns={columns()}
														disabled={
															!session() ||
															isPersisting() ||
															readOnlyTable()
														}
														dirtyCells={
															session()?.review.tables.find(
																(table) =>
																	table.objectPath ===
																	snapshot().table.objectPath
															)?.dirtyCells
														}
														dirtyRowIds={
															session()?.review.tables.find(
																(table) =>
																	table.objectPath ===
																	snapshot().table.objectPath
															)?.dirtyRowIds
														}
														onEditFailure={setSessionNotice}
														onGesture={handleGridGesture}
														onSelectionChange={setSelection}
														rows={visibleRows()}
													/>
												</Show>
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
													<button
														type="button"
														onClick={() => setInspectorTab("sessions")}
														{...stylex.props(
															styles.inspectorTab,
															inspectorTab() === "sessions" &&
																styles.inspectorTabActive
														)}
													>
														Sessions
													</button>
												</div>
												<Show when={inspectorTab() === "cell"}>
													<Show
														when={selected()}
														fallback={
															<div
																{...stylex.props(
																	styles.inspectorEmpty
																)}
															>
																Select a cell to inspect its value.
															</div>
														}
													>
														{(target) => (
															<>
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
																	{...stylex.props(
																		styles.valueHero
																	)}
																>
																	<small>
																		{valueSummary(
																			target().field.value
																		)}
																	</small>
																	<strong>
																		{formatAuthoringValue(
																			target().field.value
																		)}
																	</strong>
																</div>
																<div
																	{...stylex.props(
																		styles.detailList
																	)}
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
																			Unreal type
																		</span>
																		<strong>
																			{
																				target().field
																					.typeName
																			}
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
																			Value kind
																		</span>
																		<strong>
																			{
																				target().field.value
																					.kind
																			}
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
																			Row key
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
																			authority={selectedAuthority()}
																			client={props.client}
																			disabled={
																				isPersisting() ||
																				!session() ||
																				readOnlyTable()
																			}
																			onStage={(nextValue) =>
																				stageRowReference({
																					fieldName:
																						target()
																							.field
																							.name,
																					rowId: target()
																						.row.id,
																					value: nextValue
																				})
																			}
																			sourceKey={`${snapshot().table.objectPath}:${target().row.id}:${target().field.name}`}
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
														<strong
															{...stylex.props(styles.reviewTitle)}
														>
															{(session()?.review
																.activeCommandCount ?? 0) === 0
																? "No staged changes"
																: session()?.review.validation.valid
																	? "Ready to apply"
																	: "Needs attention"}
														</strong>
														<small>
															{session()?.review.validation
																.errorCount ?? 0}{" "}
															{session()?.review.validation
																.errorCount === 1
																? "error"
																: "errors"}{" "}
															·{" "}
															{session()?.review.validation
																.warningCount ?? 0}{" "}
															{session()?.review.validation
																.warningCount === 1
																? "warning"
																: "warnings"}{" "}
															·{" "}
															{session()?.review.commandGroups.filter(
																(group) => group.active
															).length ?? 0}{" "}
															edits
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
																		{reviewChangeSummary(
																			change
																		)}
																	</small>
																</div>
															)}
														</For>
														<Show
															when={
																(session()?.review
																	.activeCommandCount ?? 0) === 0
															}
														>
															<div
																{...stylex.props(
																	styles.inspectorEmpty
																)}
															>
																No staged changes.
															</div>
														</Show>
													</div>
													<For
														each={
															session()?.review.validation
																.diagnostics ?? []
														}
													>
														{(diagnostic) => (
															<div
																{...stylex.props(
																	styles.reviewDiagnostic
																)}
															>
																<strong>
																	{sentenceCase(
																		diagnostic.severity
																	)}
																</strong>
																<span>{diagnostic.message}</span>
															</div>
														)}
													</For>
												</Show>
												<Show when={inspectorTab() === "sessions"}>
													<SessionShelf
														disabled={isReplacing() || isPersisting()}
														onDiscardSession={discardPersistedSession}
														onOpenSession={openPersistedSession}
														sessions={sessions()}
													/>
												</Show>
											</aside>
										</div>
									</Show>
								</div>
							);
						}}
					</Show>
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
		backgroundColor: tokens.colorCanvas
	},
	routeHeader: {
		alignItems: "flex-start",
		display: "flex",
		flexWrap: "wrap",
		gap: tokens.space4,
		justifyContent: "space-between",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		paddingBottom: tokens.space4,
		marginBottom: tokens.space5
	},
	routeHeading: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2
	},
	routeTitle: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em",
		lineHeight: 1.25
	},
	routeIntro: {
		margin: 0,
		maxWidth: 560,
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.5
	},
	routeActions: {
		alignItems: "center",
		display: "flex",
		flexWrap: "wrap",
		gap: tokens.space2
	},
	authoritySwitch: { display: "flex", gap: 2 },
	coldStart: {
		display: "grid",
		gridTemplateColumns: {
			default: "240px minmax(0, 1fr)",
			"@media (max-width: 700px)": "minmax(0, 1fr)"
		},
		gap: tokens.space3
	},
	emptyState: {
		minHeight: 360,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		gap: tokens.space3,
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.5,
		padding: tokens.space5
	},
	errorState: {
		minHeight: 280,
		maxWidth: 560,
		margin: "0 auto",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		gap: tokens.space2,
		padding: tokens.space5
	},
	errorRecovery: { color: tokens.colorTextMuted, fontSize: 13 },
	inlineButton: {
		marginTop: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "6px 12px",
		cursor: "pointer",
		fontSize: 13
	},
	pulse: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		backgroundColor: tokens.colorAccent
	},
	technicalDetails: {
		width: "100%",
		maxWidth: 520,
		marginTop: tokens.space2,
		textAlign: "left"
	},
	workspace: { display: "flex", flexDirection: "column", gap: tokens.space3 },
	viewTabs: {
		display: "flex",
		alignItems: "center",
		width: "fit-content",
		gap: 2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		padding: 4
	},
	viewTab: {
		borderStyle: "none",
		borderWidth: 0,
		borderRadius: tokens.radiusBadge,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		padding: "6px 12px",
		fontSize: 13
	},
	viewTabActive: {
		backgroundColor: tokens.colorSurfaceHover,
		color: tokens.colorTextStrong
	},
	manifest: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(300px, 1.7fr) repeat(3, minmax(105px, .42fr)) minmax(220px, .8fr)",
			"@media (max-width: 1000px)":
				"minmax(220px, 1.4fr) repeat(3, minmax(65px, .35fr)) minmax(160px, .8fr)",
			"@media (max-width: 700px)": "repeat(3, minmax(0, 1fr))"
		},
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	assetIdentity: {
		display: "flex",
		flexDirection: "column",
		gridColumn: { default: "auto", "@media (max-width: 700px)": "1 / -1" },
		gap: tokens.space1,
		padding: "12px 16px"
	},
	assetBadge: {
		width: "fit-content",
		padding: "1px 8px",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "flex-end",
		textAlign: "right",
		gap: 2,
		padding: "10px 16px",
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1
	},
	readOnlyFlag: {
		display: "flex",
		alignItems: "center",
		gridColumn: { default: "auto", "@media (max-width: 700px)": "1 / -1" },
		gap: tokens.space2,
		padding: "10px 16px",
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		color: tokens.colorText
	},
	draftState: { minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
	draftStateDetail: { color: tokens.colorTextSubtle, fontSize: 11, lineHeight: 1.35 },
	diagnostics: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		gap: tokens.space4,
		padding: "10px 16px",
		borderColor: "rgba(242, 153, 74, 0.35)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(242, 153, 74, 0.08)",
		color: tokens.colorWarning,
		fontSize: 12
	},
	replacementNotice: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		gap: tokens.space2,
		padding: "9px 12px",
		borderColor: "rgba(242, 153, 74, 0.35)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(242, 153, 74, 0.08)",
		color: tokens.colorWarning,
		fontSize: 12
	},
	noticeDismiss: {
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: "transparent",
		color: tokens.colorWarning,
		cursor: "pointer",
		fontSize: 12
	},
	contentGrid: {
		display: "grid",
		gridTemplateColumns: {
			default: "240px minmax(0, 1fr) 300px",
			"@media (max-width: 1050px)": "minmax(0, 1fr)"
		},
		gap: tokens.space3
	},
	catalog: {
		minHeight: 480,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	catalogHeading: {
		height: 48,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "0 12px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	catalogName: { color: tokens.colorTextStrong, fontSize: 13, fontWeight: 600 },
	catalogRefresh: {
		borderStyle: "none",
		borderWidth: 0,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontSize: 12,
		padding: "4px 8px"
	},
	catalogSearch: {
		boxSizing: "border-box",
		width: "calc(100% - 24px)",
		margin: 12,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "7px 9px",
		outlineColor: tokens.colorAccent,
		fontSize: 13
	},
	catalogStatus: { padding: 16, color: tokens.colorTextMuted, fontSize: 12, lineHeight: 1.6 },
	catalogProgressBlock: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: 16,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.4
	},
	catalogProgressLabel: {
		display: "flex",
		justifyContent: "space-between",
		gap: 8,
		color: tokens.colorText
	},
	catalogProgress: {
		width: "100%",
		height: 4,
		accentColor: tokens.colorAccent
	},
	catalogList: {
		maxHeight: "calc(100vh - 350px)",
		overflowY: "auto",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	catalogItem: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 3,
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderLeftColor: "transparent",
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "10px 12px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 12
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
	catalogItemKind: { color: tokens.colorTextFaint, fontSize: 11 },
	catalogDivergence: { color: tokens.colorWarning, fontSize: 11 },
	catalogWarning: {
		borderBottomColor: "rgba(242, 153, 74, 0.35)",
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: "rgba(242, 153, 74, 0.08)",
		color: tokens.colorWarning,
		fontSize: 11,
		padding: "8px 12px"
	},
	sessionShelf: {
		minHeight: 0,
		margin: -24,
		overflowY: "auto"
	},
	draftShelfHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "8px 12px 4px",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 600,
		letterSpacing: ".02em"
	},
	draftCount: {
		minWidth: 20,
		textAlign: "right",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	pendingSaveHeading: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorWarning,
		fontSize: 11,
		fontWeight: 600,
		padding: "12px 12px 4px"
	},
	draftItem: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 28px",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	draftOpen: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 2,
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "9px 12px",
		textAlign: "left",
		cursor: "pointer"
	},
	draftDiscard: {
		borderStyle: "none",
		borderWidth: 0,
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(235, 87, 87, 0.12)" },
		color: tokens.colorDanger,
		cursor: "pointer",
		fontSize: 15
	},
	sheet: {
		minWidth: 0,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	sheetTools: {
		minHeight: 44,
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: tokens.space2,
		padding: "8px 12px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	search: {
		width: { default: 220, "@media (max-width: 700px)": "100%" },
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "6px 10px",
		outlineColor: tokens.colorAccent,
		fontSize: 13
	},
	visibleCount: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textAlign: "right"
	},
	rowStruct: {
		marginLeft: "auto",
		maxWidth: 360,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	rowActions: {
		width: "100%",
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: tokens.space1,
		paddingTop: 8,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	sheetAction: {
		borderColor: "transparent",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.06)",
			":disabled": "transparent"
		},
		color: { default: tokens.colorText, ":disabled": tokens.colorTextFaint },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontSize: 12,
		padding: "5px 8px"
	},
	dangerAction: { color: tokens.colorDanger },
	inspector: {
		minHeight: 480,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		padding: 16,
		overflow: "hidden"
	},
	inspectorTabs: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		margin: "-16px -16px 16px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	inspectorTab: {
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: "transparent",
		borderBottomStyle: "solid",
		borderBottomWidth: 2,
		backgroundColor: { default: tokens.colorSurface, ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		padding: "12px 8px",
		fontSize: 12
	},
	inspectorTabActive: { borderBottomColor: tokens.colorAccent, color: tokens.colorTextStrong },
	inspectorEmpty: { color: tokens.colorTextMuted, fontSize: 12, lineHeight: 1.6 },
	inspectorTitle: {
		margin: "0 0 4px",
		fontFamily: tokens.fontDisplay,
		fontSize: 18,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	inspectorPath: { margin: 0, color: tokens.colorTextSubtle, fontSize: 12 },
	valueHero: {
		marginTop: 16,
		minHeight: 110,
		display: "flex",
		flexDirection: "column",
		justifyContent: "space-between",
		gap: 8,
		padding: 12,
		borderLeftColor: tokens.colorAccent,
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		wordBreak: "break-word"
	},
	detailList: { display: "flex", flexDirection: "column", marginTop: 16 },
	detailItem: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		padding: "9px 0",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		fontSize: 12,
		wordBreak: "break-word"
	},
	detailLabel: { color: tokens.colorTextSubtle, fontSize: 11 },
	referencePicker: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
		marginTop: 20,
		paddingTop: 14,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	referenceHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8
	},
	referenceStatus: {
		padding: "2px 7px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPill,
		backgroundColor: "rgba(255, 255, 255, 0.05)",
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	referenceField: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	referenceSelect: {
		width: "100%",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		padding: "8px 10px"
	},
	referenceMessage: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		padding: "9px 10px",
		borderLeftColor: tokens.colorBorderStrong,
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.45
	},
	referenceError: { borderLeftColor: tokens.colorDanger, color: tokens.colorDanger },
	referenceRetry: {
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: "transparent",
		color: tokens.colorAccent,
		cursor: "pointer",
		fontSize: 12
	},
	referenceStage: {
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":disabled": "transparent"
		},
		color: { default: tokens.colorText, ":disabled": tokens.colorTextFaint },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontSize: 12,
		padding: "8px 12px"
	},
	reviewSummary: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		paddingBottom: 14,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	reviewTitle: { fontFamily: tokens.fontDisplay, fontSize: 15, fontWeight: 590 },
	reviewList: { maxHeight: "calc(100vh - 410px)", overflowY: "auto" },
	reviewChange: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: "11px 0",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		fontSize: 12
	},
	reviewDiagnostic: {
		display: "grid",
		gridTemplateColumns: "54px 1fr",
		gap: 8,
		padding: "9px 0",
		borderTopColor: "rgba(242, 153, 74, 0.35)",
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorWarning,
		fontSize: 12,
		lineHeight: 1.45
	},
	rowEditorBackdrop: {
		position: "fixed",
		inset: 0,
		zIndex: 20,
		display: "grid",
		placeItems: "center",
		backgroundColor: "rgba(8, 9, 10, 0.8)"
	},
	rowEditor: {
		width: "min(420px, calc(100vw - 40px))",
		display: "flex",
		flexDirection: "column",
		gap: 18,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: tokens.shadowOverlay,
		padding: 22
	},
	rowEditorTitle: { fontFamily: tokens.fontDisplay, fontSize: 16, fontWeight: 590 },
	rowEditorLabel: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	rowEditorInput: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "9px 11px",
		outlineColor: tokens.colorAccent,
		fontSize: 13
	},
	rowEditorActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
	dialogButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		cursor: "pointer",
		padding: "7px 12px",
		fontSize: 12
	},
	dialogPrimary: {
		borderColor: tokens.colorAccent,
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		color: tokens.colorAccentText
	}
});
