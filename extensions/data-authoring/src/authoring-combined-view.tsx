import * as stylex from "@stylexjs/stylex";
import { buildJoinedView, type JoinedViewRow } from "@ue-shed/authoring/joined-views";
import type { AuthoringAuthority, AuthoringClientApi } from "@ue-shed/authoring-sdk";
import type { AuthoringRow, AuthoringTableSnapshot } from "@ue-shed/protocol";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect } from "effect";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { fieldInRow, formatAuthoringValue, tableColumns } from "./authoring-view.js";

interface CombinedViewProps {
	readonly catalogTablePaths: readonly string[];
	readonly client: AuthoringClientApi;
	readonly initialSnapshot: AuthoringTableSnapshot;
	readonly onOpenForEditing: (objectPath: string) => void;
}

type LoadState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "ready" }
	| { readonly message: string; readonly status: "failed" };

interface TableGroup {
	readonly columns: readonly string[];
	readonly objectPath: string;
	readonly role: "source" | "target";
	readonly snapshot?: AuthoringTableSnapshot;
}

function shortObjectName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function authorityForSnapshot(snapshot: AuthoringTableSnapshot): AuthoringAuthority {
	return snapshot.authority.kind === "project_files" ? "saved" : "live";
}

function referenceFieldNames(snapshot: AuthoringTableSnapshot): readonly string[] {
	const names = new Set<string>();
	if ("schema" in snapshot.table && snapshot.table.schema.status === "available") {
		for (const field of snapshot.table.schema.fields) {
			if (field.type.kind === "row_reference") names.add(field.name);
		}
	}
	for (const row of snapshot.table.rows) {
		for (const field of row.fields) {
			if (field.value.kind === "row_reference") names.add(field.name);
		}
	}
	return [...names].toSorted((left, right) => left.localeCompare(right));
}

function referencedTablePaths(
	snapshot: AuthoringTableSnapshot,
	fieldName: string
): readonly string[] {
	const paths = new Set<string>();
	for (const row of snapshot.table.rows) {
		const value = row.fields.find((field) => field.name === fieldName)?.value;
		if (value?.kind === "row_reference" && value.tableObjectPath !== null) {
			paths.add(value.tableObjectPath);
		}
	}
	return [...paths].toSorted((left, right) => left.localeCompare(right));
}

function tableCell(row: AuthoringRow | undefined, fieldName: string): string {
	if (!row) return "—";
	const field = fieldInRow(row, fieldName);
	return field ? formatAuthoringValue(field.value) : "—";
}

export function AuthoringCombinedView(props: CombinedViewProps) {
	const sourceAction = createEffectAction();
	const targetAction = createEffectAction();
	const [sourceSnapshot, setSourceSnapshot] = createSignal(props.initialSnapshot);
	const [referenceFieldName, setReferenceFieldName] = createSignal(
		referenceFieldNames(props.initialSnapshot)[0] ?? ""
	);
	const [targetSnapshots, setTargetSnapshots] = createSignal<readonly AuthoringTableSnapshot[]>(
		[]
	);
	const [loadState, setLoadState] = createSignal<LoadState>({ status: "idle" });
	const [visiblePaths, setVisiblePaths] = createSignal<ReadonlySet<string>>(
		new Set([props.initialSnapshot.table.objectPath])
	);
	let relationshipKey = "";

	const catalogPaths = createMemo(() => {
		const paths = new Set(props.catalogTablePaths);
		paths.add(sourceSnapshot().table.objectPath);
		return [...paths].toSorted((left, right) => left.localeCompare(right));
	});
	const referenceFields = createMemo(() => referenceFieldNames(sourceSnapshot()));
	const targetPaths = createMemo(() =>
		referencedTablePaths(sourceSnapshot(), referenceFieldName())
	);
	const participantPaths = createMemo(() => [
		sourceSnapshot().table.objectPath,
		...targetPaths().filter((path) => path !== sourceSnapshot().table.objectPath)
	]);
	const snapshotByPath = createMemo(
		() =>
			new Map([
				[sourceSnapshot().table.objectPath, sourceSnapshot()] as const,
				...targetSnapshots().map(
					(snapshot) => [snapshot.table.objectPath, snapshot] as const
				)
			])
	);
	const joinedView = createMemo(() =>
		buildJoinedView({
			query: {
				referenceFieldName: referenceFieldName(),
				sourceTableObjectPath: sourceSnapshot().table.objectPath
			},
			snapshots: [sourceSnapshot(), ...targetSnapshots()]
		})
	);
	const rows = createMemo<readonly JoinedViewRow[]>(() => {
		const view = joinedView();
		return view.status === "ready" ? view.rows : [];
	});
	const groups = createMemo<readonly TableGroup[]>(() =>
		participantPaths()
			.map((objectPath, index) => {
				const snapshot = snapshotByPath().get(objectPath);
				const role: TableGroup["role"] = index === 0 ? "source" : "target";
				return {
					columns: snapshot ? tableColumns(snapshot).map((column) => column.name) : [],
					objectPath,
					role,
					...(snapshot ? { snapshot } : undefined)
				};
			})
			.filter((group) => visiblePaths().has(group.objectPath))
	);

	const loadSource = (objectPath: string) => {
		if (objectPath === sourceSnapshot().table.objectPath) return;
		sourceAction.cancel();
		targetAction.cancel();
		setLoadState({ status: "loading" });
		sourceAction.run(
			props.client.openCatalogTable(objectPath, authorityForSnapshot(sourceSnapshot())),
			{
				onFailure: (cause) =>
					setLoadState({ message: Cause.pretty(cause), status: "failed" }),
				onSuccess: (result) => {
					if (result.status !== "ready") {
						const message =
							result.status === "failed"
								? `${result.error.message} ${result.error.recovery}`
								: "The selected source table is unavailable.";
						setLoadState({ message, status: "failed" });
						return;
					}
					setSourceSnapshot(result.snapshot);
					setTargetSnapshots([]);
					setReferenceFieldName(referenceFieldNames(result.snapshot)[0] ?? "");
					setLoadState({ status: "ready" });
				}
			}
		);
	};

	createEffect(() => {
		const source = sourceSnapshot();
		const fieldName = referenceFieldName();
		const paths = targetPaths();
		const nextKey = `${source.table.objectPath}\u0000${fieldName}`;
		if (nextKey === relationshipKey) return;
		relationshipKey = nextKey;
		targetAction.cancel();
		setTargetSnapshots([]);
		setVisiblePaths(new Set([source.table.objectPath, ...paths]));
		if (fieldName.length === 0 || paths.length === 0) {
			setLoadState({ status: "ready" });
			return;
		}
		setLoadState({ status: "loading" });
		targetAction.run(
			Effect.forEach(
				paths.filter((path) => path !== source.table.objectPath),
				(path) => props.client.openCatalogTable(path, authorityForSnapshot(source)),
				{ concurrency: 4 }
			),
			{
				onFailure: (cause) =>
					setLoadState({ message: Cause.pretty(cause), status: "failed" }),
				onSuccess: (results) => {
					setTargetSnapshots(
						results.flatMap((result) =>
							result.status === "ready" ? [result.snapshot] : []
						)
					);
					const unavailable = results.filter(
						(result) => result.status !== "ready"
					).length;
					setLoadState(
						unavailable === 0
							? { status: "ready" }
							: {
									message: `${unavailable} referenced table${unavailable === 1 ? " is" : "s are"} unavailable.`,
									status: "failed"
								}
					);
				}
			}
		);
	});

	const setTableVisible = (objectPath: string, visible: boolean) => {
		const next = new Set(visiblePaths());
		if (visible) next.add(objectPath);
		else next.delete(objectPath);
		setVisiblePaths(next);
	};

	return (
		<section aria-label="Relationship view" {...stylex.props(styles.shell)}>
			<header {...stylex.props(styles.heading)}>
				<div>
					<h2 {...stylex.props(styles.title)}>Related tables</h2>
					<p {...stylex.props(styles.description)}>
						Each column stays with its own table. The toggles below only change what you
						see here.
					</p>
				</div>
				<div {...stylex.props(styles.readOnlyStamp)}>
					<strong>Read-only</strong>
					<small>edit rows in the table view</small>
				</div>
			</header>

			<div {...stylex.props(styles.controls)}>
				<label {...stylex.props(styles.control)}>
					<span>Source table</span>
					<select
						aria-label="Combined view source table"
						value={sourceSnapshot().table.objectPath}
						onChange={(event) => loadSource(event.currentTarget.value)}
						{...stylex.props(styles.select)}
					>
						<For each={catalogPaths()}>
							{(path) => <option value={path}>{shortObjectName(path)}</option>}
						</For>
					</select>
					<small>{sourceSnapshot().table.objectPath}</small>
				</label>
				<label {...stylex.props(styles.control)}>
					<span>Relationship field</span>
					<select
						aria-label="Combined view relationship field"
						disabled={referenceFields().length === 0}
						value={referenceFieldName()}
						onChange={(event) => setReferenceFieldName(event.currentTarget.value)}
						{...stylex.props(styles.select)}
					>
						<Show when={referenceFields().length === 0}>
							<option value="">No row-reference fields</option>
						</Show>
						<For each={referenceFields()}>{(field) => <option>{field}</option>}</For>
					</select>
					<small>{rows().length} source rows shown</small>
				</label>
				<button
					type="button"
					onClick={() => props.onOpenForEditing(sourceSnapshot().table.objectPath)}
					{...stylex.props(styles.editButton)}
				>
					Open source editor
				</button>
			</div>

			<div {...stylex.props(styles.switchboard)}>
				<div {...stylex.props(styles.switchboardHeading)}>
					<span {...stylex.props(styles.switchboardLabel)}>Visible tables</span>
					<strong {...stylex.props(styles.switchboardCount)}>
						{visiblePaths().size} / {participantPaths().length}
					</strong>
					<div {...stylex.props(styles.switchboardActions)}>
						<button
							type="button"
							onClick={() => setVisiblePaths(new Set(participantPaths()))}
							{...stylex.props(styles.minorButton)}
						>
							Show all
						</button>
						<button
							type="button"
							onClick={() => setVisiblePaths(new Set())}
							{...stylex.props(styles.minorButton)}
						>
							Hide all
						</button>
					</div>
				</div>
				<div {...stylex.props(styles.tableToggles)}>
					<For each={participantPaths()}>
						{(path, index) => (
							<div
								{...stylex.props(
									styles.tableToggle,
									visiblePaths().has(path) && styles.tableToggleVisible
								)}
							>
								<label {...stylex.props(styles.toggleLabel)}>
									<input
										type="checkbox"
										checked={visiblePaths().has(path)}
										onChange={(event) =>
											setTableVisible(path, event.currentTarget.checked)
										}
									/>
									<span>
										<small>{index() === 0 ? "Source" : "Target"}</small>
										<strong>{shortObjectName(path)}</strong>
									</span>
								</label>
								<button
									type="button"
									aria-label={`Isolate ${shortObjectName(path)}`}
									onClick={() => setVisiblePaths(new Set([path]))}
									{...stylex.props(styles.isolateButton)}
								>
									Isolate
								</button>
							</div>
						)}
					</For>
				</div>
			</div>

			<Show when={loadState().status === "loading"}>
				<div {...stylex.props(styles.loadingLine)}>Loading referenced tables…</div>
			</Show>
			<Show when={loadState().status === "failed"}>
				{(() => {
					const state = loadState();
					const message =
						state.status === "failed"
							? state.message
							: "Referenced tables could not be loaded.";
					const [firstLine] = message.split("\n");
					return (
						<div {...stylex.props(styles.noticeError)}>
							<strong>Some tables did not load.</strong>
							<span>{firstLine?.slice(0, 160) ?? message}</span>
							<details {...stylex.props(styles.technicalDetails)}>
								<summary>Technical details</summary>
								<code>{message}</code>
							</details>
						</div>
					);
				})()}
			</Show>

			<Show
				when={referenceFields().length > 0}
				fallback={
					<div {...stylex.props(styles.empty)}>
						<strong>No row-reference field on this table.</strong>
						<span>Pick another source table to follow its relationships.</span>
					</div>
				}
			>
				<Show
					when={groups().length > 0}
					fallback={
						<div {...stylex.props(styles.empty)}>
							<strong>All tables are hidden.</strong>
							<span>Show all, or turn one table back on above.</span>
						</div>
					}
				>
					<div {...stylex.props(styles.matrixWrap)}>
						<table {...stylex.props(styles.matrix)}>
							<thead>
								<tr>
									<th rowSpan={2} {...stylex.props(styles.linkHeading)}>
										Link
									</th>
									<For each={groups()}>
										{(group) => (
											<th
												colSpan={Math.max(1, group.columns.length + 1)}
												{...stylex.props(
													styles.groupHeading,
													group.role === "source"
														? styles.sourceHeading
														: styles.targetHeading
												)}
											>
												<small>{group.role}</small>
												{shortObjectName(group.objectPath)}
											</th>
										)}
									</For>
								</tr>
								<tr>
									<For each={groups()}>
										{(group) => (
											<>
												<th {...stylex.props(styles.columnHeading)}>Row</th>
												<Show
													when={group.snapshot}
													fallback={
														<th {...stylex.props(styles.columnHeading)}>
															Status
														</th>
													}
												>
													<For each={group.columns}>
														{(column) => (
															<th
																{...stylex.props(
																	styles.columnHeading
																)}
															>
																{column}
															</th>
														)}
													</For>
												</Show>
											</>
										)}
									</For>
								</tr>
							</thead>
							<tbody>
								<For each={rows()}>
									{(row) => (
										<tr>
											<th {...stylex.props(styles.linkCell)}>
												<strong>{row.source.rowName}</strong>
												<small data-status={row.status}>
													{row.status === "resolved"
														? "resolved"
														: row.reason}
												</small>
											</th>
											<For each={groups()}>
												{(group) => {
													const projectedRow =
														group.role === "source"
															? row.sourceRow
															: row.status === "resolved" &&
																  row.target.tableObjectPath ===
																		group.objectPath
																? row.targetRow
																: undefined;
													return (
														<>
															<td {...stylex.props(styles.rowName)}>
																{projectedRow?.name ?? "—"}
															</td>
															<Show
																when={group.snapshot}
																fallback={<td>unavailable</td>}
															>
																<For each={group.columns}>
																	{(column) => (
																		<td>
																			{tableCell(
																				projectedRow,
																				column
																			)}
																		</td>
																	)}
																</For>
															</Show>
														</>
													);
												}}
											</For>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</div>
				</Show>
			</Show>
		</section>
	);
}

const styles = stylex.create({
	shell: {
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	heading: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		flexWrap: "wrap",
		gap: tokens.space4,
		padding: "16px 20px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	title: {
		margin: "0 0 6px",
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 18,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	description: {
		maxWidth: 560,
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.5
	},
	readOnlyStamp: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		width: "fit-content",
		padding: "6px 12px",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset
	},
	controls: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(260px, 1.2fr) minmax(220px, .8fr) auto",
			"@media (max-width: 800px)": "1fr"
		},
		alignItems: "end",
		gap: tokens.space3,
		padding: 12,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	control: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	select: {
		width: "100%",
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "8px 10px",
		fontSize: 13
	},
	editButton: {
		height: 34,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		cursor: "pointer",
		padding: "0 12px",
		fontSize: 12
	},
	switchboard: {
		display: "grid",
		gridTemplateColumns: {
			default: "180px minmax(0, 1fr)",
			"@media (max-width: 700px)": "1fr"
		},
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	switchboardHeading: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: 12,
		borderRight: `1px solid ${tokens.colorBorder}`
	},
	switchboardLabel: { color: tokens.colorTextSubtle, fontSize: 11, fontWeight: 600 },
	switchboardCount: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		textAlign: "right"
	},
	switchboardActions: { display: "flex", gap: 6 },
	minorButton: {
		border: `1px solid transparent`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.06)" },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		padding: "4px 8px",
		fontSize: 11
	},
	tableToggles: {
		display: "flex",
		alignItems: "stretch",
		gap: 8,
		overflowX: "auto",
		padding: 10
	},
	tableToggle: {
		minWidth: 190,
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		alignItems: "center",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		borderTop: `2px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden",
		opacity: 0.55
	},
	tableToggleVisible: {
		borderTopColor: tokens.colorAccent,
		backgroundColor: tokens.colorSurfaceRaised,
		opacity: 1
	},
	toggleLabel: {
		minWidth: 0,
		display: "flex",
		alignItems: "center",
		gap: 9,
		padding: "9px 10px",
		cursor: "pointer"
	},
	isolateButton: {
		alignSelf: "stretch",
		border: 0,
		borderLeft: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		padding: "0 8px",
		fontSize: 11
	},
	loadingLine: {
		textAlign: "center",
		color: tokens.colorTextMuted,
		fontSize: 12,
		padding: "12px 0"
	},
	noticeError: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		margin: 12,
		padding: "10px 14px",
		border: "1px solid rgba(235, 87, 87, 0.35)",
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 12
	},
	technicalDetails: { fontSize: 12 },
	empty: {
		minHeight: 260,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		gap: 6,
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	matrixWrap: { width: "100%", overflow: "auto", maxHeight: "calc(100vh - 405px)" },
	matrix: {
		width: "max-content",
		minWidth: "100%",
		borderCollapse: "collapse",
		color: tokens.colorText,
		fontSize: 12
	},
	linkHeading: {
		position: "sticky",
		left: 0,
		zIndex: 3,
		minWidth: 150,
		padding: "8px 11px",
		borderRight: `2px solid ${tokens.colorBorderStrong}`,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 600,
		textAlign: "left"
	},
	columnHeading: {
		padding: "7px 11px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 500,
		textAlign: "left"
	},
	groupHeading: {
		minWidth: 180,
		padding: "10px 12px",
		borderLeft: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextStrong,
		textAlign: "left",
		fontFamily: tokens.fontDisplay,
		fontSize: 13,
		fontWeight: 600,
		lineHeight: 1.3
	},
	sourceHeading: {
		borderTop: `2px solid ${tokens.colorAccent}`,
		backgroundColor: tokens.colorSurfaceRaised
	},
	targetHeading: { borderTop: "2px solid #02b8cc", backgroundColor: tokens.colorSurface },
	linkCell: {
		position: "sticky",
		left: 0,
		zIndex: 2,
		display: "flex",
		flexDirection: "column",
		gap: 4,
		borderRight: `2px solid ${tokens.colorBorderStrong}`,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		padding: "9px 11px",
		textAlign: "left"
	},
	rowName: { color: tokens.colorTextStrong, fontWeight: 590 }
});
