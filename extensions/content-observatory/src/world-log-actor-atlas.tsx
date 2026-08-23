import * as stylex from "@stylexjs/stylex";
import type { PerforceMapHistoryDocument } from "@ue-shed/map-history/contract";
import type { MapHistoryPlaybackFrame } from "@ue-shed/map-history/playback";
import type { SavedWorld, SavedWorldActor } from "@ue-shed/protocol";
import { ActorExplorer, type ActorExplorerFilters } from "@ue-shed/ui";
import {
	PointMapCanvas,
	pointMapColorForClass,
	type PointMapController,
	type PointMapPoint
} from "@ue-shed/ui/point-map";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
	collectCurrentWorldLogActors,
	collectWorldLogActors,
	actorKeyFromSavedActor,
	noWorldLogActorViewFilters,
	worldLogActorLifecycle,
	worldLogActorMatchesViewFilters,
	worldLogActorMovementEvents,
	type WorldLogActor,
	type WorldLogActorEvent
} from "./world-log-actors.js";
import {
	worldLogChangelistMapOverlay,
	worldLogChangelistToneColor,
	type WorldLogChangelistTone
} from "./world-log-changelist.js";
import {
	changeDetail,
	changeTitle,
	formatSubmittedAt,
	humanize,
	point,
	shortActorPath,
	shortClass
} from "./world-log-format.js";
import type { WorldLogChangelistSelection, WorldLogEvent } from "./world-log-selection.js";
import { styles } from "./world-log-styles.js";

const changelistTones: readonly WorldLogChangelistTone[] = ["added", "removed", "moved", "changed"];

export type WorldLogSceneView =
	| { readonly kind: "current"; readonly world: SavedWorld }
	| {
			readonly frame: MapHistoryPlaybackFrame;
			readonly history: PerforceMapHistoryDocument;
			readonly kind: "history";
	  };

function actorTitle(actor: WorldLogActor["actor"]): string {
	return actor.label ?? shortActorPath(actor.actorPath);
}

function historyFrameTitle(frame: MapHistoryPlaybackFrame): string {
	return frame.kind === "range_start" ? "Range start" : `After CL ${frame.revision.change}`;
}

const cap = (value: string): string => value.replace(/^./, (c) => c.toUpperCase());

function movementTrail(event: WorldLogActorEvent): string | undefined {
	if (event.change.kind !== "actor_moved") return undefined;
	return `${point(event.change.beforeLocation)} → ${point(event.change.afterLocation)}`;
}

/**
 * The single World Log scene. The current saved map is the initial view; a completed history
 * replaces its data in place so the outliner, inspector, camera, and map selection stay shared.
 */
export function WorldLogScene(props: {
	readonly onEvent: (event: WorldLogEvent) => void;
	readonly selectedActorKey: string | undefined;
	readonly selectedChangelist: WorldLogChangelistSelection | undefined;
	readonly view: WorldLogSceneView;
}) {
	let pointMap: PointMapController | undefined;
	const [viewFilters, setViewFilters] = createSignal(noWorldLogActorViewFilters);
	const historyView = createMemo(() => {
		const view = props.view;
		return view.kind === "history" ? view : undefined;
	});
	const historyFrame = createMemo(() => historyView()?.frame);
	const historyRevisionIndex = createMemo(() => {
		const frame = historyFrame();
		return frame?.kind === "revision" ? frame.revisionIndex : undefined;
	});
	const isHistory = createMemo(() => historyView() !== undefined);
	const actors = createMemo(() => {
		const view = props.view;
		return view.kind === "history"
			? collectWorldLogActors(view.history)
			: collectCurrentWorldLogActors(view.world);
	});
	const visibleActors = createMemo(() =>
		actors().filter((actor) => worldLogActorMatchesViewFilters(actor, viewFilters()))
	);
	const actorFilters = createMemo<ActorExplorerFilters>(() => {
		const filters = viewFilters();
		return {
			classPaths: filters.classPath === undefined ? undefined : [filters.classPath],
			query: filters.query
		};
	});
	const classPaths = createMemo(() =>
		[...new Set(actors().map((actor) => actor.actor.classPath))].toSorted((left, right) =>
			shortClass(left).localeCompare(shortClass(right))
		)
	);
	const frameActorsByKey = createMemo(() => {
		const view = props.view;
		const frameActors =
			view.kind === "history"
				? view.frame.actors.map((entry) => [entry.key, entry.actor] as const)
				: view.world.actors.map((actor) => [actorKeyFromSavedActor(actor), actor] as const);
		return new Map<string, SavedWorldActor>(frameActors);
	});
	const explorerItems = createMemo(() =>
		visibleActors().map((actor) => {
			const actorAtFrame = frameActorsByKey().get(actor.key);
			const displayActor = actorAtFrame ?? actor.actor;
			return {
				badges: isHistory()
					? [
							...(actor.presentAtRangeEnd ? [] : ["Removed"]),
							...(actorAtFrame === undefined ? ["Not at frame"] : [])
						]
					: [],
				classLabel: shortClass(displayActor.classPath),
				classPath: actor.actor.classPath,
				key: actor.key,
				label: actorTitle(displayActor),
				packageName: displayActor.packageName,
				path: displayActor.actorPath,
				secondary: shortActorPath(displayActor.actorPath),
				searchFields: {
					class: actor.actor.classPath,
					guid: actor.actor.actorGuid,
					label: actor.actor.label,
					package: actor.actor.packageName,
					path: actor.actor.actorPath
				}
			};
		})
	);
	const plottedActors = createMemo(() =>
		visibleActors().flatMap((actor) => {
			const frameActor = frameActorsByKey().get(actor.key);
			return frameActor === undefined ? [] : [{ actor, frameActor }];
		})
	);
	const basePoints = createMemo<readonly PointMapPoint[]>(() =>
		plottedActors().flatMap(({ actor, frameActor }) => {
			if (frameActor.transform.status !== "resolved") return [];
			return [
				{
					className: shortClass(frameActor.classPath),
					key: actor.key,
					x: frameActor.transform.location.x,
					y: frameActor.transform.location.y
				}
			];
		})
	);
	const selectedRevision = createMemo(() => {
		const view = historyView();
		const selection = props.selectedChangelist;
		return view === undefined || selection === undefined
			? undefined
			: view.history.revisions[selection.revision];
	});
	const selectedOverlay = createMemo(() => {
		const revision = selectedRevision();
		return revision === undefined ? undefined : worldLogChangelistMapOverlay(revision);
	});
	const plottedPoints = createMemo<readonly PointMapPoint[]>(() => [
		...basePoints(),
		...(selectedOverlay()?.points ?? [])
	]);
	const pointClasses = createMemo(() => {
		const counts = new Map<string, number>();
		for (const point of basePoints()) {
			counts.set(point.className, (counts.get(point.className) ?? 0) + 1);
		}
		return [...counts].toSorted(([left], [right]) => left.localeCompare(right));
	});
	const selectedActor = createMemo(() =>
		props.selectedActorKey === undefined
			? undefined
			: actors().find((actor) => actor.key === props.selectedActorKey)
	);
	const selectedActorAtFrame = createMemo(() => {
		const actor = selectedActor();
		return actor === undefined ? undefined : frameActorsByKey().get(actor.key);
	});
	const selectedActorPosition = createMemo(() => {
		const transform = selectedActorAtFrame()?.transform;
		return transform?.status === "resolved" ? point(transform.location) : undefined;
	});
	const selectedActorEvents = createMemo(() => selectedActor()?.events ?? []);
	const selectedActorMovements = createMemo(() =>
		selectedActor() === undefined ? [] : worldLogActorMovementEvents(selectedActor()!)
	);
	const frameResolvedActorCount = createMemo(() => {
		const view = props.view;
		return view.kind === "history"
			? view.frame.actors.filter((actor) => actor.actor.transform.status === "resolved")
					.length
			: view.world.actors.filter((actor) => actor.transform.status === "resolved").length;
	});
	const frameActorCount = createMemo(() => {
		const view = props.view;
		return view.kind === "history" ? view.frame.actors.length : view.world.actors.length;
	});
	const frameTitle = createMemo(() =>
		props.view.kind === "history" ? historyFrameTitle(props.view.frame) : "Current map"
	);
	const mapPath = createMemo(() =>
		props.view.kind === "history" ? props.view.history.query.mapPath : props.view.world.mapPath
	);
	const frameCompleteness = createMemo(() =>
		props.view.kind === "history"
			? props.view.frame.completeness
			: props.view.world.completeness
	);
	const frameHasNoMap = createMemo(() => {
		const view = props.view;
		return (
			view.kind === "history" &&
			view.frame.kind === "range_start" &&
			view.history.baseline.status === "map_not_yet_created"
		);
	});
	const unclassifiedPackageChangeCount = createMemo(
		() => historyFrame()?.unclassifiedPackageChanges.length ?? 0
	);
	const selectActor = (key: string | undefined) =>
		props.onEvent({
			actorKey: props.selectedActorKey === key ? undefined : key,
			type: "actor_selected"
		});
	const setChangedOnly = () =>
		setViewFilters((current) => ({ ...current, changedOnly: !current.changedOnly }));
	const setPresence = (presence: "all" | "present" | "removed") =>
		setViewFilters((current) => ({ ...current, presence }));
	const setResolution = (resolution: "all" | "resolved" | "unresolved") =>
		setViewFilters((current) => ({ ...current, resolution }));
	const extraFilters = (
		<div aria-label="Historical actor filters" {...stylex.props(styles.actorFilterBar)}>
			<button
				type="button"
				aria-pressed={viewFilters().changedOnly}
				onClick={setChangedOnly}
				{...stylex.props(
					styles.actorFilterButton,
					viewFilters().changedOnly && styles.actorFilterButtonActive
				)}
			>
				Changed
			</button>
			<For each={["all", "present", "removed"] as const}>
				{(presence) => (
					<button
						type="button"
						aria-pressed={viewFilters().presence === presence}
						onClick={() => setPresence(presence)}
						{...stylex.props(
							styles.actorFilterButton,
							viewFilters().presence === presence && styles.actorFilterButtonActive
						)}
					>
						{cap(presence)}
					</button>
				)}
			</For>
			<For each={["all", "resolved", "unresolved"] as const}>
				{(resolution) => (
					<button
						type="button"
						aria-pressed={viewFilters().resolution === resolution}
						onClick={() => setResolution(resolution)}
						{...stylex.props(
							styles.actorFilterButton,
							viewFilters().resolution === resolution &&
								styles.actorFilterButtonActive
						)}
					>
						{resolution === "all" ? "Any position" : cap(resolution)}
					</button>
				)}
			</For>
		</div>
	);

	return (
		<section aria-label="Saved actor point map" {...stylex.props(styles.actorAtlas)}>
			<header {...stylex.props(styles.actorAtlasHeader)}>
				<div>
					<h2 {...stylex.props(styles.atlasTitle)}>{frameTitle()}</h2>
					<code {...stylex.props(styles.actorAtlasPath)}>{mapPath()}</code>
				</div>
				<div {...stylex.props(styles.snapshotSummary)}>
					<span>
						<b>{frameResolvedActorCount().toLocaleString()}</b> resolved actors
					</span>
					<small>
						{isHistory()
							? `${frameCompleteness()} coverage at this frame`
							: `${frameActorCount().toLocaleString()} actors · ${frameCompleteness()}`}
					</small>
				</div>
			</header>
			<Show when={historyView()}>
				<nav aria-label="Frames" {...stylex.props(styles.playbackFrames)}>
					<button
						type="button"
						aria-label="Show state at range start"
						aria-pressed={historyFrame()?.kind === "range_start"}
						onClick={() =>
							props.onEvent({ revisionIndex: undefined, type: "frame_selected" })
						}
						{...stylex.props(
							styles.playbackFrameButton,
							historyFrame()?.kind === "range_start" &&
								styles.playbackFrameButtonActive
						)}
					>
						Range start
					</button>
					<For each={historyView()?.history.revisions ?? []}>
						{(revision, revisionIndex) => (
							<button
								type="button"
								aria-label={`Show state after CL ${revision.change}`}
								aria-pressed={
									historyFrame()?.kind === "revision" &&
									historyRevisionIndex() === revisionIndex()
								}
								onClick={() =>
									props.onEvent({
										revisionIndex: revisionIndex(),
										type: "frame_selected"
									})
								}
								{...stylex.props(
									styles.playbackFrameButton,
									historyFrame()?.kind === "revision" &&
										historyRevisionIndex() === revisionIndex() &&
										styles.playbackFrameButtonActive
								)}
							>
								After CL {revision.change}
							</button>
						)}
					</For>
				</nav>
			</Show>
			<Show when={frameHasNoMap()}>
				<div {...stylex.props(styles.frameNotice)}>
					This range begins before the map existed. There is no saved state to show at
					this frame.
				</div>
			</Show>
			<Show when={frameCompleteness() === "partial"}>
				<div {...stylex.props(styles.frameNotice, styles.frameNoticePartial)}>
					Partial coverage at this frame. Actor state is limited to the packages that
					could be read.
				</div>
			</Show>
			<Show when={unclassifiedPackageChangeCount() > 0}>
				<div {...stylex.props(styles.frameNotice, styles.frameNoticeUnclassified)}>
					{unclassifiedPackageChangeCount()} unclassified package change
					{unclassifiedPackageChangeCount() === 1 ? "" : "s"} at this frame.
				</div>
			</Show>
			<div {...stylex.props(styles.actorAtlasWorkspace)}>
				<ActorExplorer
					ariaLabel="Saved actor outliner"
					classOptions={classPaths().map((classPath) => ({
						classPath,
						count: actors().filter((actor) => actor.actor.classPath === classPath)
							.length,
						label: shortClass(classPath)
					}))}
					classSelection="single"
					extraControls={<Show when={isHistory()}>{extraFilters}</Show>}
					filters={actorFilters()}
					itemListLabel="Saved actors"
					items={explorerItems()}
					label="Filters"
					onClassPathsChange={(classPaths) =>
						setViewFilters((current) => ({
							...current,
							classPath: classPaths?.[0]
						}))
					}
					onFiltersChange={(filters) =>
						setViewFilters((current) => ({ ...current, query: filters.query }))
					}
					onFocus={(key) => pointMap?.focusKey(key)}
					onSelect={selectActor}
					queryAriaLabel="Find an actor"
					role="complementary"
					selectedClassPath={undefined}
					selectedKey={props.selectedActorKey}
					title={isHistory() ? "Actors in this range" : "Actors in the current map"}
				/>
				<div {...stylex.props(styles.pointMapFrame)}>
					<div {...stylex.props(styles.northMarker)}>N ↑</div>
					<div {...stylex.props(styles.pointMapLegend)}>
						<For each={pointClasses()}>
							{([className, count]) => (
								<span title={className}>
									<i
										{...stylex.props(styles.pointMapClassDot)}
										style={{
											"background-color": pointMapColorForClass(className)
										}}
									/>
									{className} <b>{count}</b>
								</span>
							)}
						</For>
					</div>
					<Show when={selectedRevision()}>
						{(revision) => {
							const summary = () => selectedOverlay()?.summary;
							return (
								<div
									aria-label="Selected changelist map overlay"
									{...stylex.props(styles.pointMapOverlayLegend)}
								>
									<strong>CL {revision().change} diff</strong>
									<For each={changelistTones}>
										{(tone) => (
											<span>
												<i
													{...stylex.props(styles.pointMapClassDot)}
													style={{
														"background-color":
															worldLogChangelistToneColor(tone)
													}}
												/>
												{cap(tone)} <b>{summary()?.[tone] ?? 0}</b>
											</span>
										)}
									</For>
								</div>
							);
						}}
					</Show>
					<Show
						when={plottedPoints().length > 0}
						fallback={
							<div {...stylex.props(styles.noResolvedActors)}>
								No actors with resolved positions match these filters at this frame.
							</div>
						}
					>
						<PointMapCanvas
							ariaLabel="Top-down saved actor points map"
							class={stylex.props(styles.pointMap).className}
							connections={selectedOverlay()?.connections}
							onController={(controller) => {
								pointMap = controller;
							}}
							onSelect={selectActor}
							points={plottedPoints()}
							resetKey={mapPath()}
							selectedKey={props.selectedActorKey}
							title="Scroll to zoom, drag to pan, click an actor or history point to inspect it"
						/>
					</Show>
					<button
						type="button"
						onClick={() => pointMap?.resetView()}
						{...stylex.props(styles.pointMapReset)}
					>
						Reset view
					</button>
				</div>
				<aside aria-label="Selected saved actor" {...stylex.props(styles.actorInspector)}>
					<Show
						when={selectedActor()}
						fallback={
							<div {...stylex.props(styles.actorInspectorEmpty)}>
								<strong>No actor selected</strong>
								<p>
									Choose a point on the map or a row in the outliner to inspect
									its saved state.
								</p>
							</div>
						}
					>
						{(actor) => (
							<>
								<h3>{actorTitle(selectedActorAtFrame() ?? actor().actor)}</h3>
								<code>{(selectedActorAtFrame() ?? actor().actor).classPath}</code>
								<dl {...stylex.props(styles.actorFacts)}>
									<div>
										<dt>Events</dt>
										<dd>{actor().changeCount}</dd>
									</div>
									<div>
										<dt>Frame</dt>
										<dd>{frameTitle()}</dd>
									</div>
									<div>
										<dt>{isHistory() ? "At frame" : "Presence"}</dt>
										<dd>
											{isHistory()
												? selectedActorAtFrame() === undefined
													? "Not at frame"
													: "Present"
												: "Current"}
										</dd>
									</div>
									<Show when={isHistory()}>
										<div>
											<dt>Range end</dt>
											<dd>
												{actor().presentAtRangeEnd ? "Present" : "Removed"}
											</dd>
										</div>
										<div>
											<dt>Lifecycle</dt>
											<dd>{humanize(worldLogActorLifecycle(actor()))}</dd>
										</div>
									</Show>
									<div>
										<dt>Position</dt>
										<dd>
											{selectedActorAtFrame() === undefined
												? "Not at frame"
												: selectedActorAtFrame()!.transform.status ===
													  "resolved"
													? "Resolved"
													: "Unresolved"}
										</dd>
									</div>
									<Show when={selectedActorPosition()}>
										{(position) => (
											<div>
												<dt>Position at frame</dt>
												<dd>{position()}</dd>
											</div>
										)}
									</Show>
								</dl>
								<Show when={selectedActorMovements().length > 0}>
									<section {...stylex.props(styles.actorEventSection)}>
										<span {...stylex.props(styles.sectionLabel)}>Movement</span>
										<ol {...stylex.props(styles.actorEventList)}>
											<For each={selectedActorMovements()}>
												{(event) => (
													<li>
														CL {event.revision.change} /{" "}
														{movementTrail(event)}
													</li>
												)}
											</For>
										</ol>
									</section>
								</Show>
								<Show
									when={isHistory()}
									fallback={
										<section {...stylex.props(styles.actorEventSection)}>
											<p>
												This is the actor's state read from the current
												saved map.
											</p>
										</section>
									}
								>
									<section {...stylex.props(styles.actorEventSection)}>
										<span {...stylex.props(styles.sectionLabel)}>Events</span>
										<ol {...stylex.props(styles.actorEventList)}>
											<For each={selectedActorEvents()}>
												{(event) => (
													<li>
														<button
															type="button"
															onClick={() =>
																props.onEvent({
																	actorKey: actor().key,
																	changeIndex: event.changeIndex,
																	revision: event.revisionIndex,
																	type: "actor_event_selected"
																})
															}
															{...stylex.props(
																styles.actorEventButton
															)}
														>
															<span>CL {event.revision.change}</span>
															<strong>
																{changeTitle(event.change)}
															</strong>
															<small>
																{formatSubmittedAt(event.revision)}{" "}
																/ {changeDetail(event.change)}
															</small>
														</button>
													</li>
												)}
											</For>
										</ol>
									</section>
								</Show>
								<button
									type="button"
									onClick={() =>
										props.onEvent({
											actorKey: undefined,
											type: "actor_selected"
										})
									}
									{...stylex.props(styles.clearActorSelection)}
								>
									Clear selection
								</button>
							</>
						)}
					</Show>
				</aside>
			</div>
		</section>
	);
}
