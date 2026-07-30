import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { DateTime, Effect, Schema } from "effect";
import {
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount
} from "solid-js";
import type {
	MapChange,
	PerforceMapHistory,
	PerforceMapRevision
} from "@ue-shed/map-history/contract";
import {
	ContentObservatoryHistoryRequest,
	type ContentObservatoryClientShape,
	type ContentObservatoryState
} from "./content-observatory-client.js";
import {
	actorKeyFromChange,
	actorKeyFromIdentity,
	changeMatchesActor,
	collectWorldLogActors,
	worldLogActorMatchesQuery,
	worldLogMapBounds,
	type WorldLogActor
} from "./world-log-actors.js";

type ViewState = { readonly status: "loading" } | ContentObservatoryState;
type ChangeKind = "all" | MapChange["kind"];

const decodeHistoryRequest = Schema.decodeUnknownEffect(ContentObservatoryHistoryRequest);

function changeTitle(change: MapChange): string {
	switch (change.kind) {
		case "actor_added":
			return change.after.label ?? shortActorPath(change.after.actorPath);
		case "actor_removed":
			return change.before.label ?? shortActorPath(change.before.actorPath);
		case "snapshot_coverage_changed":
			return "Snapshot coverage";
		default:
			return (
				change.after.label ?? change.before.label ?? shortActorPath(change.after.actorPath)
			);
	}
}

function changeDetail(change: MapChange): string {
	switch (change.kind) {
		case "actor_added":
			return "New saved actor";
		case "actor_removed":
			return "Removed from saved map";
		case "actor_moved":
			return `${point(change.beforeLocation)} → ${point(change.afterLocation)}`;
		case "actor_label_changed":
			return `${change.before.label ?? "No label"} → ${change.after.label ?? "No label"}`;
		case "actor_class_changed":
			return `${shortClass(change.before.classPath)} → ${shortClass(change.after.classPath)}`;
		case "actor_package_changed":
			return `${change.before.packageName} → ${change.after.packageName}`;
		case "actor_position_resolution_changed":
			return `${change.beforePosition.status} → ${change.afterPosition.status}`;
		case "snapshot_coverage_changed":
			return `${change.before.completeness} → ${change.after.completeness}`;
	}
}

function point(value: { readonly x: number; readonly y: number; readonly z: number }): string {
	return `${value.x.toFixed(0)}, ${value.y.toFixed(0)}, ${value.z.toFixed(0)}`;
}

function shortActorPath(path: string): string {
	return path.split(".").at(-1) ?? path;
}

function shortClass(path: string): string {
	return path.split(".").at(-1) ?? path;
}

function formatSubmittedAt(revision: PerforceMapRevision): string {
	return new Date(DateTime.toEpochMillis(revision.submittedAt)).toLocaleString();
}

function humanize(value: string): string {
	return value.replaceAll("_", " ");
}

function changeTone(kind: MapChange["kind"]): "added" | "removed" | "changed" | "warning" {
	if (kind === "actor_added") return "added";
	if (kind === "actor_removed") return "removed";
	if (kind === "snapshot_coverage_changed") return "warning";
	return "changed";
}

function QueryForm(props: {
	readonly disabled: boolean;
	readonly maps: ReadonlyArray<{ readonly label: string; readonly mapPath: string }>;
	readonly mapPath: string;
	readonly onMapPathChange: (path: string) => void;
	readonly onRun: () => void;
	readonly rangeDays: number;
	readonly setRangeDays: (days: number) => void;
}) {
	return (
		<section aria-label="Map history query" {...stylex.props(styles.queryPanel)}>
			<div {...stylex.props(styles.queryLead)}>
				<span {...stylex.props(styles.sectionKicker)}>TARGET / BOUNDED RANGE</span>
				<strong>Read a saved world, not a source-control browser.</strong>
				<p>
					Every result is one map scope reconstructed at submitted changelists.
					Unexplained package edits remain visible below.
				</p>
			</div>
			<label {...stylex.props(styles.mapInputLabel)}>
				<span>MAP PATH</span>
				<input
					disabled={props.disabled}
					value={props.mapPath}
					onInput={(event) => props.onMapPathChange(event.currentTarget.value)}
					placeholder="Content/Maps/L_MyMap.umap"
					{...stylex.props(styles.mapInput)}
				/>
			</label>
			<Show when={props.maps.length > 0}>
				<div {...stylex.props(styles.mapChoices)}>
					<For each={props.maps}>
						{(map) => (
							<button
								type="button"
								disabled={props.disabled}
								aria-pressed={map.mapPath === props.mapPath}
								onClick={() => props.onMapPathChange(map.mapPath)}
								{...stylex.props(
									styles.mapChoice,
									map.mapPath === props.mapPath && styles.mapChoiceActive
								)}
							>
								{map.label}
							</button>
						)}
					</For>
				</div>
			</Show>
			<div {...stylex.props(styles.rangeControls)}>
				<span>LOOK BACK</span>
				<For each={[1, 7, 30]}>
					{(days) => (
						<button
							type="button"
							disabled={props.disabled}
							aria-pressed={days === props.rangeDays}
							onClick={() => props.setRangeDays(days)}
							{...stylex.props(
								styles.rangeButton,
								days === props.rangeDays && styles.rangeButtonActive
							)}
						>
							{days}D
						</button>
					)}
				</For>
				<button
					type="button"
					disabled={props.disabled || props.mapPath.trim().length === 0}
					onClick={props.onRun}
					{...stylex.props(styles.runButton)}
				>
					READ HISTORY <span>↗</span>
				</button>
			</div>
		</section>
	);
}

function actorTitle(actor: WorldLogActor): string {
	return actor.actor.label ?? shortActorPath(actor.actor.actorPath);
}

function ActorAtlas(props: {
	readonly history: PerforceMapHistory;
	readonly onSelectActor: (key: string | undefined) => void;
	readonly selectedActorKey: string | undefined;
}) {
	const [query, setQuery] = createSignal("");
	const actors = createMemo(() => collectWorldLogActors(props.history));
	const visibleActors = createMemo(() =>
		actors().filter((actor) => worldLogActorMatchesQuery(actor, query()))
	);
	const plottedActors = createMemo(() =>
		visibleActors().filter(
			(actor) => actor.presentAtRangeEnd && actor.actor.position.status === "resolved"
		)
	);
	const bounds = createMemo(() => worldLogMapBounds(visibleActors()));
	const viewBox = createMemo(() => {
		const current = bounds();
		if (current === undefined) return "0 0 1 1";
		return `${current.minX} ${current.minY} ${current.maxX - current.minX} ${current.maxY - current.minY}`;
	});
	const selectedActor = createMemo(() =>
		props.selectedActorKey === undefined
			? undefined
			: actors().find((actor) => actor.key === props.selectedActorKey)
	);
	const selectedActorPosition = createMemo(() => {
		const position = selectedActor()?.actor.position;
		return position?.status === "resolved" ? point(position.location) : undefined;
	});
	const snapshot = () => props.history.rangeEndSnapshot;
	const selectActor = (key: string) =>
		props.onSelectActor(props.selectedActorKey === key ? undefined : key);
	const onPointKeyDown = (event: KeyboardEvent, key: string) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		selectActor(key);
	};

	return (
		<section aria-label="Saved actor map at range end" {...stylex.props(styles.actorAtlas)}>
			<header {...stylex.props(styles.actorAtlasHeader)}>
				<div>
					<span {...stylex.props(styles.sectionKicker)}>RANGE-END ACTOR SNAPSHOT</span>
					<h2>Point map, then changelist evidence.</h2>
				</div>
				<div {...stylex.props(styles.snapshotSummary)}>
					<strong>{snapshot()?.summary.resolvedActors ?? 0}</strong>
					<span>RESOLVED ACTORS</span>
					<small>
						{snapshot() === undefined
							? "MAP NOT YET CREATED"
							: `${snapshot()!.completeness} / ${snapshot()!.mapPackage}`}
					</small>
				</div>
			</header>
			<Show
				when={snapshot()}
				fallback={
					<div {...stylex.props(styles.snapshotUnavailable)}>
						No saved map existed at the end of this requested range. The submitted
						changelist record remains available below.
					</div>
				}
			>
				<div {...stylex.props(styles.actorAtlasWorkspace)}>
					<aside
						aria-label="Saved actor outliner"
						{...stylex.props(styles.actorOutliner)}
					>
						<label {...stylex.props(styles.actorSearch)}>
							<span>FIND ACTOR / CLASS / PATH</span>
							<input
								value={query()}
								onInput={(event) => setQuery(event.currentTarget.value)}
								placeholder="precise saved actor search"
								aria-label="Find World Log actor"
								{...stylex.props(styles.actorSearchInput)}
							/>
						</label>
						<div {...stylex.props(styles.outlinerCount)}>
							<span>{visibleActors().length} INDEXED</span>
							<Show when={actors().some((actor) => !actor.presentAtRangeEnd)}>
								<span>REMOVED ACTORS RETAINED</span>
							</Show>
						</div>
						<ul aria-label="Saved actors" {...stylex.props(styles.actorList)}>
							<For each={visibleActors()}>
								{(actor) => (
									<li {...stylex.props(styles.actorListItem)}>
										<button
											type="button"
											aria-pressed={props.selectedActorKey === actor.key}
											onClick={() => selectActor(actor.key)}
											{...stylex.props(
												styles.actorRow,
												props.selectedActorKey === actor.key &&
													styles.actorRowSelected,
												!actor.presentAtRangeEnd &&
													styles.actorRowHistorical
											)}
										>
											<span {...stylex.props(styles.actorEventCount)}>
												{actor.changeCount}
											</span>
											<span {...stylex.props(styles.actorRowCopy)}>
												<strong>{actorTitle(actor)}</strong>
												<small>{shortClass(actor.actor.classPath)}</small>
											</span>
											<Show when={!actor.presentAtRangeEnd}>
												<em>REMOVED</em>
											</Show>
										</button>
									</li>
								)}
							</For>
						</ul>
					</aside>
					<div {...stylex.props(styles.pointMapFrame)}>
						<div {...stylex.props(styles.northMarker)}>N ↑</div>
						<div {...stylex.props(styles.pointMapLegend)}>
							<span>
								<i {...stylex.props(styles.changedDot)} />
								CHANGED IN RANGE
							</span>
							<span>
								<i {...stylex.props(styles.staticDot)} />
								UNCHANGED
							</span>
						</div>
						<Show
							when={bounds()}
							fallback={
								<div {...stylex.props(styles.noResolvedActors)}>
									No saved actors with resolved positions match this search.
								</div>
							}
						>
							{(currentBounds) => (
								<svg
									viewBox={viewBox()}
									preserveAspectRatio="xMidYMid meet"
									role="application"
									aria-label="Top-down saved actor points map"
									{...stylex.props(styles.pointMap)}
								>
									<rect
										x={currentBounds().minX}
										y={currentBounds().minY}
										width={currentBounds().maxX - currentBounds().minX}
										height={currentBounds().maxY - currentBounds().minY}
										fill="url(#world-log-grid)"
									/>
									<defs>
										<pattern
											id="world-log-grid"
											width="100"
											height="100"
											patternUnits="userSpaceOnUse"
										>
											<path
												d="M 100 0 L 0 0 0 100"
												fill="none"
												stroke="#9eb5b52d"
												stroke-width="1"
											/>
										</pattern>
									</defs>
									<g
										transform={`translate(0 ${currentBounds().minY + currentBounds().maxY}) scale(1 -1)`}
									>
										<For each={plottedActors()}>
											{(actor) => {
												const location = () =>
													actor.actor.position.status === "resolved"
														? actor.actor.position.location
														: undefined;
												return (
													<circle
														cx={location()?.x}
														cy={location()?.y}
														r={
															props.selectedActorKey === actor.key
																? 17
																: actor.changeCount > 0
																	? 12
																	: 8
														}
														role="button"
														tabIndex={0}
														aria-label={`${actorTitle(actor)}, ${actor.changeCount} changes in range`}
														onClick={() => selectActor(actor.key)}
														onKeyDown={(event) =>
															onPointKeyDown(event, actor.key)
														}
														{...stylex.props(
															styles.mapPoint,
															actor.changeCount > 0
																? styles.mapPointChanged
																: styles.mapPointStatic,
															props.selectedActorKey === actor.key &&
																styles.mapPointSelected
														)}
													>
														<title>{actorTitle(actor)}</title>
													</circle>
												);
											}}
										</For>
									</g>
								</svg>
							)}
						</Show>
					</div>
					<aside
						aria-label="Selected saved actor"
						{...stylex.props(styles.actorInspector)}
					>
						<Show
							when={selectedActor()}
							fallback={
								<div {...stylex.props(styles.actorInspectorEmpty)}>
									<span>SELECT A POINT</span>
									<p>
										Choose a saved actor to narrow the submitted record to its
										evidence.
									</p>
								</div>
							}
						>
							{(actor) => (
								<>
									<span {...stylex.props(styles.sectionKicker)}>
										ACTOR HISTORY
									</span>
									<h3>{actorTitle(actor())}</h3>
									<code>{actor().actor.classPath}</code>
									<dl {...stylex.props(styles.actorFacts)}>
										<div>
											<dt>EVENTS</dt>
											<dd>{actor().changeCount}</dd>
										</div>
										<div>
											<dt>STATUS</dt>
											<dd>
												{actor().presentAtRangeEnd
													? "AT RANGE END"
													: "REMOVED"}
											</dd>
										</div>
										<Show when={selectedActorPosition()}>
											{(position) => (
												<div>
													<dt>POSITION</dt>
													<dd>{position()}</dd>
												</div>
											)}
										</Show>
									</dl>
									<button
										type="button"
										onClick={() => props.onSelectActor(undefined)}
										{...stylex.props(styles.clearActorSelection)}
									>
										CLEAR ACTOR FILTER
									</button>
								</>
							)}
						</Show>
					</aside>
				</div>
			</Show>
		</section>
	);
}

function Timeline(props: {
	readonly actorKey: string | undefined;
	readonly filter: ChangeKind;
	readonly history: Extract<ContentObservatoryState, { readonly status: "complete" }>["history"];
	readonly onSelect: (selection: {
		readonly actorKey: string | undefined;
		readonly changeIndex: number;
		readonly revision: number;
	}) => void;
	readonly selected: { readonly changeIndex: number; readonly revision: number } | undefined;
	readonly setFilter: (filter: ChangeKind) => void;
}) {
	const totalChanges = () =>
		props.history.revisions.reduce(
			(sum, revision) =>
				sum +
				revision.changes.filter(
					(change) =>
						(props.filter === "all" || change.kind === props.filter) &&
						changeMatchesActor(change, props.actorKey)
				).length,
			0
		);
	return (
		<div {...stylex.props(styles.timelineShell)}>
			<section aria-label="History timeline" {...stylex.props(styles.timeline)}>
				<header {...stylex.props(styles.timelineHeader)}>
					<div>
						<span {...stylex.props(styles.sectionKicker)}>SUBMITTED RECORD</span>
						<h2>
							{totalChanges()} explained actor changes
							{props.actorKey === undefined ? "" : " for selected actor"}
						</h2>
					</div>
					<span
						{...stylex.props(
							styles.completePill,
							props.history.completeness === "partial" && styles.partialPill
						)}
					>
						{props.history.completeness}
					</span>
				</header>
				<div
					role="toolbar"
					aria-label="Actor change filter"
					{...stylex.props(styles.filters)}
				>
					<For
						each={
							[
								"all",
								"actor_added",
								"actor_removed",
								"actor_moved",
								"actor_label_changed"
							] as const
						}
					>
						{(filter) => (
							<button
								type="button"
								aria-pressed={props.filter === filter}
								onClick={() => props.setFilter(filter)}
								{...stylex.props(
									styles.filterButton,
									props.filter === filter && styles.filterButtonActive
								)}
							>
								{filter === "all" ? "ALL" : humanize(filter.replace("actor_", ""))}
							</button>
						)}
					</For>
				</div>
				<div {...stylex.props(styles.timelineList)}>
					<For each={props.history.revisions}>
						{(revision, revisionIndex) => {
							const visibleChanges = () =>
								revision.changes
									.map((change, changeIndex) => ({ change, changeIndex }))
									.filter(
										({ change }) =>
											(props.filter === "all" ||
												change.kind === props.filter) &&
											changeMatchesActor(change, props.actorKey)
									);
							const visibleUnclassified = () =>
								revision.unclassifiedPackageChanges.filter(
									(entry) =>
										props.actorKey === undefined ||
										entry.actorIdentities.some(
											(identity) =>
												actorKeyFromIdentity(identity) === props.actorKey
										)
								);
							return (
								<Show
									when={
										visibleChanges().length > 0 ||
										visibleUnclassified().length > 0
									}
								>
									<article {...stylex.props(styles.revision)}>
										<div {...stylex.props(styles.changeMarker)}>
											<span>CL</span>
											<strong>{revision.change}</strong>
										</div>
										<div {...stylex.props(styles.revisionBody)}>
											<header {...stylex.props(styles.revisionHeader)}>
												<div>
													<strong>
														{revision.user ?? "unknown submitter"}
													</strong>
													<span>{formatSubmittedAt(revision)}</span>
												</div>
												<p>
													{revision.description ??
														"No changelist description."}
												</p>
											</header>
											<For each={visibleChanges()}>
												{({ change, changeIndex }) => (
													<button
														type="button"
														aria-pressed={
															props.selected?.revision ===
																revisionIndex() &&
															props.selected.changeIndex ===
																changeIndex
														}
														onClick={() =>
															props.onSelect({
																actorKey:
																	actorKeyFromChange(change),
																changeIndex,
																revision: revisionIndex()
															})
														}
														{...stylex.props(
															styles.changeRow,
															styles[changeTone(change.kind)],
															props.selected?.revision ===
																revisionIndex() &&
																props.selected.changeIndex ===
																	changeIndex &&
																styles.changeRowSelected
														)}
													>
														<span>
															{humanize(
																change.kind.replace("actor_", "")
															)}
														</span>
														<strong>{changeTitle(change)}</strong>
														<small>{changeDetail(change)}</small>
													</button>
												)}
											</For>
											<Show when={visibleUnclassified().length > 0}>
												<div {...stylex.props(styles.unclassifiedNotice)}>
													<span>UNCLASSIFIED PACKAGE EVIDENCE</span>
													<strong>{visibleUnclassified().length}</strong>
													<p>
														Changed bytes were retained because this
														projection cannot explain them as actor
														changes.
													</p>
												</div>
											</Show>
										</div>
									</article>
								</Show>
							);
						}}
					</For>
				</div>
			</section>
			<EvidencePanel history={props.history} selected={props.selected} />
		</div>
	);
}

function EvidencePanel(props: {
	readonly history: Extract<ContentObservatoryState, { readonly status: "complete" }>["history"];
	readonly selected: { readonly changeIndex: number; readonly revision: number } | undefined;
}) {
	const revision = createMemo(() =>
		props.selected === undefined ? undefined : props.history.revisions[props.selected.revision]
	);
	const change = createMemo(() =>
		props.selected === undefined ? undefined : revision()?.changes[props.selected.changeIndex]
	);
	return (
		<aside aria-label="Selected change evidence" {...stylex.props(styles.evidencePanel)}>
			<header>
				<span {...stylex.props(styles.sectionKicker)}>EVIDENCE LEDGER</span>
				<h2>{change() === undefined ? "Select a change" : changeTitle(change()!)}</h2>
			</header>
			<Show
				when={change()}
				fallback={
					<p {...stylex.props(styles.evidenceEmpty)}>
						Choose a timeline entry to see the semantic evidence and exact package
						revisions.
					</p>
				}
			>
				{(selectedChange) => (
					<>
						<div {...stylex.props(styles.evidenceKind)}>
							<span>{humanize(selectedChange().kind)}</span>
							<strong>{changeDetail(selectedChange())}</strong>
						</div>
						<Show when={revision()}>
							{(selectedRevision) => (
								<dl {...stylex.props(styles.packageList)}>
									<For each={selectedRevision().files}>
										{(file) => (
											<div>
												<dt>{file.action}</dt>
												<dd>
													{file.depotPath}#{file.revision}
												</dd>
											</div>
										)}
									</For>
								</dl>
							)}
						</Show>
					</>
				)}
			</Show>
			<footer {...stylex.props(styles.coverageFooter)}>
				<span>BASELINE</span>
				<strong>
					{props.history.baseline.status === "available"
						? `CL ${props.history.baseline.change}`
						: "map not yet created"}
				</strong>
			</footer>
		</aside>
	);
}

export function ContentObservatoryRoute(props: { readonly client: ContentObservatoryClientShape }) {
	const action = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [mapPath, setMapPath] = createSignal("");
	const [rangeDays, setRangeDays] = createSignal(7);
	const [filter, setFilter] = createSignal<ChangeKind>("all");
	const [selectedActorKey, setSelectedActorKey] = createSignal<string>();
	const [selected, setSelected] = createSignal<{
		readonly changeIndex: number;
		readonly revision: number;
	}>();

	const readyState = createMemo(() => {
		const current = state();
		return current.status === "ready" ||
			current.status === "running" ||
			current.status === "complete" ||
			current.status === "failed" ||
			current.status === "cancelled"
			? current
			: undefined;
	});
	const runningState = createMemo(() => {
		const current = state();
		return current.status === "running" ? current : undefined;
	});
	const failedState = createMemo(() => {
		const current = state();
		return current.status === "failed" ? current : undefined;
	});
	const completeState = createMemo(() => {
		const current = state();
		return current.status === "complete" ? current : undefined;
	});

	const apply = (next: ContentObservatoryState) => {
		setState(next);
		if (next.status === "ready" && mapPath().length === 0)
			setMapPath(next.maps[0]?.mapPath ?? "");
		if (next.status === "complete") {
			setSelected(undefined);
			setSelectedActorKey(undefined);
		}
	};
	const refresh = () => action.run(props.client.status(), { onSuccess: apply });
	const selectActor = (key: string | undefined) => {
		setSelectedActorKey(key);
		setSelected(undefined);
	};
	const selectTimelineChange = (selection: {
		readonly actorKey: string | undefined;
		readonly changeIndex: number;
		readonly revision: number;
	}) => {
		setSelected({ changeIndex: selection.changeIndex, revision: selection.revision });
		if (selection.actorKey !== undefined) setSelectedActorKey(selection.actorKey);
	};

	const run = () => {
		const until = new Date();
		const since = new Date(until.getTime() - rangeDays() * 24 * 60 * 60 * 1000);
		const request = {
			limits: {
				maxChangelists: 250,
				maxConcurrency: 4,
				maxDurationMs: 120000,
				maxMaterializedFiles: 4000,
				maxPackages: 4000
			},
			mapPath: mapPath().trim(),
			range: { since: since.toISOString(), until: until.toISOString() }
		};
		action.run(
			decodeHistoryRequest(request).pipe(
				Effect.flatMap((decoded) => props.client.start(decoded))
			),
			{ onSuccess: apply }
		);
	};

	createEffect(() => {
		if (state().status !== "running") return;
		const timer = window.setInterval(() => refresh(), 450);
		onCleanup(() => window.clearInterval(timer));
	});

	onMount(refresh);

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.breadcrumb)}>
						Content Observatory / Saved actor history
					</nav>
					<h1>WORLD LOG</h1>
				</div>
				<div {...stylex.props(styles.headerSignal)}>
					<span />
					MAP-SCOPED / PERFORCE
				</div>
			</header>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.centerState)}>
						Opening a bounded map history workspace…
					</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<section {...stylex.props(styles.notConfigured)}>
						<span {...stylex.props(styles.sectionKicker)}>PROJECT REQUIRED</span>
						<h2>Content Observatory has no project root.</h2>
						<p>
							Set <code>UE_SHED_PROJECT_ROOT</code> for the Workbench process, then
							return to select a map and bounded time range.
						</p>
					</section>
				</Match>
				<Match when={readyState()}>
					{(current) => (
						<>
							<QueryForm
								disabled={current().status === "running"}
								maps={current().maps}
								mapPath={mapPath()}
								onMapPathChange={setMapPath}
								onRun={run}
								rangeDays={rangeDays()}
								setRangeDays={setRangeDays}
							/>
							<Show when={runningState()}>
								{(running) => (
									<section
										aria-live="polite"
										{...stylex.props(styles.runningState)}
									>
										<div>
											<span {...stylex.props(styles.sectionKicker)}>
												RECONSTRUCTING
											</span>
											<strong>{humanize(running().progress.phase)}</strong>
											<p>
												{running().progress.processedChangelists} /{" "}
												{running().progress.totalChangelists} changelists
											</p>
										</div>
										<button
											type="button"
											disabled={false}
											onClick={() =>
												action.run(props.client.cancel(), {
													onSuccess: apply
												})
											}
											{...stylex.props(styles.cancelButton)}
										>
											CANCEL
										</button>
									</section>
								)}
							</Show>
							<Show when={current().status === "cancelled"}>
								<div {...stylex.props(styles.notice)}>
									The historical reconstruction was cancelled and its temporary
									tree was released.
								</div>
							</Show>
							<Show when={failedState()}>
								{(failed) => (
									<section {...stylex.props(styles.errorState)}>
										<span>{failed().error.kind}</span>
										<strong>{failed().error.message}</strong>
										<p>{failed().error.recovery}</p>
									</section>
								)}
							</Show>
							<Show when={completeState()}>
								{(complete) => (
									<>
										<ActorAtlas
											history={complete().history}
											onSelectActor={selectActor}
											selectedActorKey={selectedActorKey()}
										/>
										<Timeline
											actorKey={selectedActorKey()}
											filter={filter()}
											history={complete().history}
											onSelect={selectTimelineChange}
											selected={selected()}
											setFilter={setFilter}
										/>
									</>
								)}
							</Show>
						</>
					)}
				</Match>
			</Switch>
		</main>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		boxSizing: "border-box",
		padding: "34px 40px 56px",
		backgroundColor: "#0b0f10",
		backgroundImage:
			"linear-gradient(90deg, #ffffff05 1px, transparent 1px), linear-gradient(#ffffff04 1px, transparent 1px), radial-gradient(circle at 88% 0%, #ecb85a1a, transparent 30%)",
		backgroundSize: "40px 40px, 40px 40px, auto",
		color: tokens.colorText
	},
	header: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		paddingBottom: 20,
		borderBottom: "1px solid #384145"
	},
	breadcrumb: {
		color: "#9aa7a7",
		fontSize: 9,
		letterSpacing: ".17em",
		textTransform: "uppercase"
	},
	headerSignal: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		color: "#d7b469",
		fontSize: 9,
		letterSpacing: ".13em"
	},
	sectionKicker: {
		display: "block",
		color: "#d7b469",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".15em",
		textTransform: "uppercase"
	},
	queryPanel: {
		display: "grid",
		gridTemplateColumns: "1.35fr minmax(250px, 1fr)",
		gap: 18,
		marginTop: 20,
		padding: 18,
		border: "1px solid #3d4648",
		backgroundColor: "#111719"
	},
	queryLead: {
		gridRow: "span 2",
		display: "flex",
		flexDirection: "column",
		gap: 9,
		paddingRight: 18,
		borderRight: "1px solid #334044",
		color: "#91a0a1",
		fontSize: 12,
		lineHeight: 1.55
	},
	mapInputLabel: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		color: "#aeb7b7",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	mapInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #445155",
		backgroundColor: "#0a0e0f",
		color: "#e2e8e4",
		padding: "10px 11px",
		fontFamily: "monospace",
		fontSize: 12,
		outline: { default: "none", ":focus": "1px solid #e1b85e" }
	},
	mapChoices: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: -10 },
	mapChoice: {
		border: "1px solid #3c484c",
		backgroundColor: { default: "transparent", ":hover": "#1b2426" },
		color: "#9ba9ab",
		padding: "5px 7px",
		fontSize: 9,
		letterSpacing: ".07em",
		cursor: "pointer"
	},
	mapChoiceActive: { borderColor: "#e1b85e", color: "#f0d79c", backgroundColor: "#312819" },
	rangeControls: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		color: "#839092",
		fontSize: 9,
		letterSpacing: ".1em"
	},
	rangeButton: {
		border: "1px solid #39464a",
		backgroundColor: { default: "transparent", ":hover": "#202a2d" },
		color: "#9aa6a8",
		padding: "7px 8px",
		fontSize: 9,
		cursor: "pointer"
	},
	rangeButtonActive: { borderColor: "#73c7d0", backgroundColor: "#153034", color: "#b7edf0" },
	runButton: {
		marginLeft: "auto",
		border: "1px solid #e1b85e",
		backgroundColor: { default: "#e1b85e", ":hover": "#f1d282", ":disabled": "#5d5131" },
		color: "#16130c",
		padding: "9px 12px",
		fontWeight: 900,
		fontSize: 9,
		letterSpacing: ".12em",
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	centerState: { minHeight: 420, display: "grid", placeItems: "center", color: "#96a2a2" },
	notConfigured: {
		maxWidth: 620,
		margin: "70px auto",
		padding: 28,
		borderLeft: "3px solid #d7b469",
		backgroundColor: "#151a1b",
		color: "#aeb8b9"
	},
	runningState: {
		marginTop: 14,
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "16px 18px",
		border: "1px solid #39747b",
		backgroundColor: "#0e2023",
		color: "#b7e4e6"
	},
	cancelButton: {
		border: "1px solid #d77d5d",
		backgroundColor: "transparent",
		color: "#e39a81",
		padding: "7px 9px",
		fontSize: 9,
		letterSpacing: ".11em",
		cursor: "pointer"
	},
	notice: {
		marginTop: 14,
		padding: "12px 14px",
		border: "1px solid #5d5131",
		backgroundColor: "#211d12",
		color: "#d7c184",
		fontSize: 12
	},
	errorState: {
		marginTop: 14,
		padding: 18,
		border: "1px solid #8e564d",
		backgroundColor: "#291919",
		color: "#f1b2a3"
	},
	actorAtlas: {
		marginTop: 14,
		border: "1px solid #3c4749",
		backgroundColor: "#0f1516",
		boxShadow: "inset 3px 0 #73c7d0"
	},
	actorAtlasHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 18,
		padding: "17px 18px 14px",
		borderBottom: "1px solid #344043"
	},
	snapshotSummary: {
		display: "grid",
		gridTemplateColumns: "auto auto",
		columnGap: 7,
		alignItems: "baseline",
		color: "#87a5a8",
		fontSize: 8,
		letterSpacing: ".1em",
		textAlign: "right"
	},
	snapshotUnavailable: {
		minHeight: 180,
		display: "grid",
		placeItems: "center",
		padding: 24,
		color: "#839193",
		fontSize: 12,
		lineHeight: 1.6,
		textAlign: "center"
	},
	actorAtlasWorkspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(210px, 260px) minmax(0, 1fr) minmax(220px, 270px)",
			"@media (max-width: 1020px)": "minmax(190px, .8fr) minmax(0, 1.4fr)",
			"@media (max-width: 720px)": "1fr"
		},
		minWidth: 0
	},
	actorOutliner: {
		minWidth: 0,
		borderRight: {
			default: "1px solid #2e3a3c",
			"@media (max-width: 720px)": 0
		},
		borderBottom: {
			default: 0,
			"@media (max-width: 720px)": "1px solid #2e3a3c"
		},
		backgroundColor: "#11191a"
	},
	actorSearch: {
		display: "grid",
		gap: 6,
		padding: 13,
		color: "#96a6a8",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	actorSearchInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #405053",
		backgroundColor: "#0a1011",
		color: "#e3edeb",
		padding: "8px 9px",
		fontFamily: "monospace",
		fontSize: 10,
		outline: { default: "none", ":focus": "1px solid #73c7d0" }
	},
	outlinerCount: {
		display: "flex",
		justifyContent: "space-between",
		gap: 7,
		padding: "0 13px 10px",
		color: "#708185",
		fontSize: 7,
		letterSpacing: ".09em"
	},
	actorList: {
		maxHeight: 340,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderTop: "1px solid #2e3a3c"
	},
	actorListItem: { margin: 0, padding: 0 },
	actorRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "25px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderBottom: "1px solid #273336",
		borderLeft: "2px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "#1b282a" },
		color: "#b4c0c0",
		padding: "8px 10px",
		textAlign: "left",
		cursor: "pointer"
	},
	actorRowSelected: { borderLeftColor: "#e1b85e", backgroundColor: "#263337", color: "#f0f5f1" },
	actorRowHistorical: { opacity: 0.62 },
	actorEventCount: {
		display: "grid",
		placeItems: "center",
		width: 20,
		height: 20,
		border: "1px solid #416a70",
		color: "#8ad6dc",
		fontSize: 8,
		fontWeight: 800
	},
	actorRowCopy: {
		display: "grid",
		minWidth: 0,
		gap: 2,
		fontSize: 10
	},
	pointMapFrame: {
		position: "relative",
		minHeight: 360,
		overflow: "hidden",
		backgroundColor: "#0a1112",
		backgroundImage:
			"radial-gradient(circle at 50% 45%, #2a56542b, transparent 46%), linear-gradient(135deg, #ffffff05 25%, transparent 25%)",
		backgroundSize: "auto, 18px 18px"
	},
	pointMap: { width: "100%", height: "100%", minHeight: 360, display: "block", outline: "none" },
	northMarker: {
		position: "absolute",
		top: 12,
		left: 14,
		zIndex: 2,
		color: "#73c7d0",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".12em"
	},
	pointMapLegend: {
		position: "absolute",
		display: "flex",
		gap: 10,
		alignItems: "center",
		right: 13,
		bottom: 12,
		zIndex: 2,
		border: "1px solid #3a4a4c",
		backgroundColor: "#101819df",
		color: "#a8b8b8",
		padding: "5px 7px",
		fontSize: 7,
		letterSpacing: ".08em"
	},
	changedDot: {
		display: "inline-block",
		width: 6,
		height: 6,
		marginRight: 4,
		borderRadius: "50%",
		backgroundColor: "#e1b85e"
	},
	staticDot: {
		display: "inline-block",
		width: 6,
		height: 6,
		marginRight: 4,
		borderRadius: "50%",
		backgroundColor: "#73c7d0"
	},
	mapPoint: {
		cursor: "pointer",
		stroke: "#d9ece9",
		strokeWidth: 2,
		outline: { ":focus": "2px solid #ffffff" }
	},
	mapPointChanged: { fill: "#e1b85e" },
	mapPointStatic: { fill: "#4d9fa7" },
	mapPointSelected: { fill: "#f4d47f", stroke: "#ffffff", strokeWidth: 3 },
	noResolvedActors: {
		minHeight: 360,
		display: "grid",
		placeItems: "center",
		padding: 24,
		color: "#819193",
		fontSize: 12,
		textAlign: "center"
	},
	actorInspector: {
		minWidth: 0,
		padding: 17,
		borderLeft: {
			default: "1px solid #2e3a3c",
			"@media (max-width: 1020px)": 0
		},
		borderTop: {
			default: 0,
			"@media (max-width: 1020px)": "1px solid #2e3a3c"
		},
		backgroundColor: "#11191a",
		color: "#c3cfcd",
		"@media (max-width: 1020px)": { gridColumn: "1 / -1" }
	},
	actorInspectorEmpty: {
		minHeight: 180,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		color: "#829193",
		fontSize: 10,
		lineHeight: 1.6
	},
	actorFacts: {
		display: "grid",
		gap: 8,
		margin: "17px 0",
		color: "#a7b7b6",
		fontSize: 9,
		fontFamily: "monospace"
	},
	clearActorSelection: {
		width: "100%",
		border: "1px solid #496165",
		backgroundColor: { default: "transparent", ":hover": "#1f2d2f" },
		color: "#a9cdcf",
		padding: "9px 10px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	timelineShell: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1.7fr) minmax(290px, .75fr)",
		gap: 14,
		marginTop: 14
	},
	timeline: { border: "1px solid #3c4749", backgroundColor: "#101617" },
	timelineHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "start",
		padding: "17px 18px 14px",
		borderBottom: "1px solid #374144"
	},
	completePill: {
		border: "1px solid #619270",
		color: "#a8dcaf",
		padding: "4px 6px",
		fontSize: 8,
		letterSpacing: ".1em",
		textTransform: "uppercase"
	},
	partialPill: { borderColor: "#d59457", color: "#f0c17f" },
	filters: {
		display: "flex",
		gap: 5,
		overflowX: "auto",
		padding: "11px 14px",
		borderBottom: "1px solid #303b3e"
	},
	filterButton: {
		flexShrink: 0,
		border: 0,
		backgroundColor: { default: "transparent", ":hover": "#202a2d" },
		color: "#859394",
		padding: "5px 6px",
		fontSize: 8,
		letterSpacing: ".11em",
		cursor: "pointer"
	},
	filterButtonActive: { color: "#f0d79c", boxShadow: "inset 0 -2px #e1b85e" },
	timelineList: { padding: 14 },
	revision: {
		display: "grid",
		gridTemplateColumns: "58px minmax(0, 1fr)",
		borderBottom: "1px solid #293438",
		paddingBottom: 16,
		marginBottom: 16
	},
	changeMarker: {
		display: "flex",
		flexDirection: "column",
		alignItems: "start",
		gap: 4,
		color: "#738588",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	revisionBody: { minWidth: 0 },
	revisionHeader: {
		display: "grid",
		gridTemplateColumns: "150px 1fr",
		gap: 10,
		marginBottom: 10,
		color: "#9ca9a9",
		fontSize: 11
	},
	changeRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "95px minmax(120px, .9fr) minmax(0, 1.4fr)",
		gap: 8,
		alignItems: "center",
		border: "1px solid #354145",
		borderLeftWidth: 3,
		backgroundColor: { default: "#141c1e", ":hover": "#1c272a" },
		color: "#a7b2b3",
		padding: "9px 10px",
		marginTop: 5,
		textAlign: "left",
		cursor: "pointer"
	},
	changeRowSelected: { backgroundColor: "#243034", borderColor: "#e1b85e", color: "#e9efec" },
	added: { borderLeftColor: "#6ebd88" },
	removed: { borderLeftColor: "#d77d6a" },
	changed: { borderLeftColor: "#73c7d0" },
	warning: { borderLeftColor: "#e1b85e" },
	unclassifiedNotice: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: "4px 8px",
		marginTop: 8,
		padding: "10px 11px",
		border: "1px dashed #a27c45",
		color: "#dfbd7a",
		fontSize: 10
	},
	evidencePanel: {
		alignSelf: "start",
		position: "sticky",
		top: 70,
		border: "1px solid #3b474a",
		backgroundColor: "#111819",
		padding: 18
	},
	evidenceEmpty: {
		minHeight: 180,
		display: "flex",
		alignItems: "center",
		color: "#849294",
		fontSize: 12,
		lineHeight: 1.6
	},
	evidenceKind: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		marginTop: 18,
		padding: "11px 0",
		borderTop: "1px solid #344043",
		borderBottom: "1px solid #344043",
		color: "#d7e0dd",
		fontSize: 12
	},
	packageList: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		margin: "16px 0",
		color: "#96a4a5",
		fontFamily: "monospace",
		fontSize: 10
	},
	coverageFooter: {
		display: "flex",
		justifyContent: "space-between",
		paddingTop: 12,
		borderTop: "1px solid #344043",
		color: "#9ba8a9",
		fontSize: 9,
		letterSpacing: ".1em"
	}
});
