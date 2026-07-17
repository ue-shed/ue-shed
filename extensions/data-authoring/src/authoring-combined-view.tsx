import * as stylex from "@stylexjs/stylex";
import { buildJoinedView, type JoinedViewRow } from "@ue-shed/authoring/joined-views";
import type { AuthoringClientShape } from "@ue-shed/authoring-sdk";
import type { AuthoringRow, AuthoringTableSnapshot } from "@ue-shed/protocol";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect } from "effect";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { fieldInRow, formatAuthoringValue, tableColumns } from "./authoring-view.js";

interface CombinedViewProps {
	readonly catalogTablePaths: readonly string[];
	readonly client: AuthoringClientShape;
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
					...(snapshot ? { snapshot } : {})
				};
			})
			.filter((group) => visiblePaths().has(group.objectPath))
	);

	const loadSource = (objectPath: string) => {
		if (objectPath === sourceSnapshot().table.objectPath) return;
		sourceAction.cancel();
		targetAction.cancel();
		setLoadState({ status: "loading" });
		sourceAction.run(props.client.openCatalogTable(objectPath), {
			onFailure: (cause) => setLoadState({ message: Cause.pretty(cause), status: "failed" }),
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
		});
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
				(path) => props.client.openCatalogTable(path),
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
					<span {...stylex.props(styles.eyebrow)}>READ-ONLY RELATIONSHIP EVIDENCE</span>
					<h2 {...stylex.props(styles.title)}>Cross-table lens</h2>
					<p {...stylex.props(styles.description)}>
						Each column stays attached to its canonical table. Hidden columns remain in
						the projection; this switchboard only changes what you see.
					</p>
				</div>
				<div {...stylex.props(styles.readOnlyStamp)}>
					<span>◇</span>
					<strong>READ ONLY</strong>
					<small>NO DRAFT AUTHORITY</small>
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
					<small>{rows().length} source rows in the projection</small>
				</label>
				<button
					type="button"
					onClick={() => props.onOpenForEditing(sourceSnapshot().table.objectPath)}
					{...stylex.props(styles.editButton)}
				>
					Open source editor ↗
				</button>
			</div>

			<div {...stylex.props(styles.switchboard)}>
				<div {...stylex.props(styles.switchboardHeading)}>
					<div>
						<span {...stylex.props(styles.eyebrow)}>TABLE SWITCHBOARD</span>
						<strong>
							{visiblePaths().size} / {participantPaths().length} visible
						</strong>
					</div>
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
										<small>{index() === 0 ? "SOURCE" : "TARGET"}</small>
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
				<div {...stylex.props(styles.notice)}>Resolving referenced tables…</div>
			</Show>
			<Show when={loadState().status === "failed"}>
				<div {...stylex.props(styles.notice, styles.noticeError)}>
					{(() => {
						const state = loadState();
						return state.status === "failed" ? state.message : "Table loading failed.";
					})()}
				</div>
			</Show>

			<Show
				when={referenceFields().length > 0}
				fallback={
					<div {...stylex.props(styles.empty)}>
						<strong>No row-reference field found.</strong>
						<span>Choose another source table from the project index above.</span>
					</div>
				}
			>
				<Show
					when={groups().length > 0}
					fallback={
						<div {...stylex.props(styles.empty)}>
							<strong>All participating tables are hidden.</strong>
							<span>Use Show all or reveal one table in the switchboard.</span>
						</div>
					}
				>
					<div {...stylex.props(styles.matrixWrap)}>
						<table {...stylex.props(styles.matrix)}>
							<thead>
								<tr>
									<th rowSpan={2} {...stylex.props(styles.linkHeading)}>
										LINK
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
												<th>ROW</th>
												<Show
													when={group.snapshot}
													fallback={<th>STATUS</th>}
												>
													<For each={group.columns}>
														{(column) => <th>{column}</th>}
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
														? "↗ resolved"
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
		border: "1px solid #39403b",
		backgroundColor: "#0d100e",
		boxShadow: "inset 0 1px #ffffff05"
	},
	heading: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		flexWrap: "wrap",
		gap: 24,
		padding: "22px 24px",
		borderBottom: "1px solid #303632",
		backgroundImage: "linear-gradient(115deg, #171c18 0%, #0d100e 58%)"
	},
	eyebrow: { color: "#839274", fontSize: 7, letterSpacing: ".16em" },
	title: {
		margin: "7px 0 5px",
		color: "#e0e5dd",
		fontFamily: "Georgia, serif",
		fontSize: 25,
		fontWeight: 400
	},
	description: { maxWidth: 680, margin: 0, color: "#7e8880", fontSize: 10, lineHeight: 1.6 },
	readOnlyStamp: {
		minWidth: 132,
		display: "grid",
		gridTemplateColumns: "24px 1fr",
		alignItems: "center",
		gap: "2px 8px",
		border: "1px solid #685a3d",
		backgroundColor: "#1a1710",
		color: "#d6a363",
		padding: "10px 12px"
	},
	controls: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(260px, 1.2fr) minmax(220px, .8fr) auto",
			"@media (max-width: 800px)": "1fr"
		},
		alignItems: "end",
		gap: 12,
		padding: 14,
		borderBottom: "1px solid #303632"
	},
	control: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: "#849087",
		fontSize: 8,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	select: {
		width: "100%",
		border: "1px solid #3a443c",
		borderRadius: 0,
		backgroundColor: "#090c0a",
		color: "#d9e0d9",
		padding: "9px 10px",
		fontSize: 10
	},
	editButton: {
		height: 36,
		border: "1px solid #536456",
		backgroundColor: { default: "#172019", ":hover": "#223026" },
		color: "#dce5dc",
		cursor: "pointer",
		padding: "0 13px",
		fontSize: 8,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	switchboard: {
		display: "grid",
		gridTemplateColumns: {
			default: "180px minmax(0, 1fr)",
			"@media (max-width: 700px)": "1fr"
		},
		borderBottom: "1px solid #303632",
		backgroundColor: "#101411"
	},
	switchboardHeading: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "space-between",
		gap: 12,
		padding: 14,
		borderRight: "1px solid #303632"
	},
	switchboardActions: { display: "flex", gap: 6 },
	minorButton: {
		border: "1px solid #39413b",
		backgroundColor: { default: "#111512", ":hover": "#202720" },
		color: "#9da89f",
		cursor: "pointer",
		padding: "5px 7px",
		fontSize: 7,
		textTransform: "uppercase"
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
		border: "1px solid #303632",
		borderTop: "2px solid #414943",
		backgroundColor: "#0b0e0c",
		opacity: 0.55
	},
	tableToggleVisible: {
		borderTopColor: tokens.colorAccent,
		backgroundColor: "#151b16",
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
		borderLeft: "1px solid #303632",
		backgroundColor: { default: "transparent", ":hover": "#202720" },
		color: "#829087",
		cursor: "pointer",
		padding: "0 8px",
		fontSize: 7,
		textTransform: "uppercase"
	},
	notice: {
		padding: "8px 14px",
		borderBottom: "1px solid #3d493f",
		color: "#93a196",
		fontSize: 9
	},
	noticeError: { borderColor: "#665337", backgroundColor: "#1a1710", color: "#d6a363" },
	empty: {
		minHeight: 260,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		color: "#737d75",
		fontSize: 10
	},
	matrixWrap: { width: "100%", overflow: "auto", maxHeight: "calc(100vh - 405px)" },
	matrix: {
		width: "max-content",
		minWidth: "100%",
		borderCollapse: "collapse",
		color: "#b9c1ba",
		fontSize: 9
	},
	linkHeading: {
		position: "sticky",
		left: 0,
		zIndex: 3,
		minWidth: 150,
		borderRight: "2px solid #495149",
		backgroundColor: "#111512",
		color: "#8d998f",
		letterSpacing: ".12em"
	},
	groupHeading: {
		minWidth: 180,
		padding: "11px 12px",
		borderLeft: "1px solid #303632",
		color: "#dce3d8",
		textAlign: "left",
		fontFamily: "Georgia, serif",
		fontSize: 15,
		fontWeight: 400
	},
	sourceHeading: { borderTop: `2px solid ${tokens.colorAccent}`, backgroundColor: "#141b15" },
	targetHeading: { borderTop: "2px solid #6e8da0", backgroundColor: "#12181b" },
	linkCell: {
		position: "sticky",
		left: 0,
		zIndex: 2,
		display: "flex",
		flexDirection: "column",
		gap: 4,
		borderRight: "2px solid #495149",
		borderBottom: "1px solid #2a302c",
		backgroundColor: "#111512",
		color: "#d4dcd4",
		padding: "9px 11px",
		textAlign: "left"
	},
	rowName: { color: "#dce3d8", fontWeight: 600 }
});
