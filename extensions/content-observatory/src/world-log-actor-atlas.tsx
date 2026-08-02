import * as stylex from "@stylexjs/stylex";
import type { PerforceMapHistoryDocument } from "@ue-shed/map-history/contract";
import type { MapHistoryPlaybackFrame } from "@ue-shed/map-history/playback";
import { ActorExplorer, type ActorExplorerFilters } from "@ue-shed/ui";
import {
	PointMapCanvas,
	pointMapColorForClass,
	type PointMapController,
	type PointMapPoint
} from "@ue-shed/ui/point-map";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
	collectWorldLogActors,
	noWorldLogActorViewFilters,
	worldLogActorLifecycle,
	worldLogActorMatchesViewFilters,
	worldLogActorMovementEvents,
	type WorldLogActorEvent,
	type WorldLogActor
} from "./world-log-actors.js";
import {
	changeDetail,
	changeTitle,
	formatSubmittedAt,
	humanize,
	point,
	shortActorPath,
	shortClass
} from "./world-log-format.js";
import { styles } from "./world-log-styles.js";

function actorTitle(actor: WorldLogActor["actor"]): string {
	return actor.label ?? shortActorPath(actor.actorPath);
}

function frameTitle(frame: MapHistoryPlaybackFrame): string {
	return frame.kind === "range_start" ? "RANGE START" : `AFTER CL ${frame.revision.change}`;
}

function movementTrail(event: WorldLogActorEvent): string | undefined {
	if (event.change.kind !== "actor_moved") return undefined;
	return `${point(event.change.beforeLocation)} → ${point(event.change.afterLocation)}`;
}

export function WorldLogActorAtlas(props: {
	readonly frame: MapHistoryPlaybackFrame;
	readonly history: PerforceMapHistoryDocument;
	readonly onSelectActor: (key: string | undefined) => void;
	readonly onSelectActorEvent: (input: {
		readonly actorKey: string;
		readonly changeIndex: number;
		readonly revision: number;
	}) => void;
	readonly onSelectFrame: (revisionIndex: number | undefined) => void;
	readonly selectedActorKey: string | undefined;
}) {
	let pointMap: PointMapController | undefined;
	const [viewFilters, setViewFilters] = createSignal(noWorldLogActorViewFilters);
	const actors = createMemo(() => collectWorldLogActors(props.history));
	const visibleActors = createMemo(() =>
		actors().filter((actor) => worldLogActorMatchesViewFilters(actor, viewFilters()))
	);
	const actorFilters = createMemo<ActorExplorerFilters>(() => ({
		classPaths:
			viewFilters().classPath === undefined ? undefined : [viewFilters().classPath as string],
		query: viewFilters().query
	}));
	const classPaths = createMemo(() =>
		[...new Set(actors().map((actor) => actor.actor.classPath))].toSorted((left, right) =>
			shortClass(left).localeCompare(shortClass(right))
		)
	);
	const frameActorsByKey = createMemo(
		() => new Map(props.frame.actors.map((entry) => [entry.key, entry.actor]))
	);
	const explorerItems = createMemo(() =>
		visibleActors().map((actor) => {
			const actorAtFrame = frameActorsByKey().get(actor.key);
			return {
				badges: [
					...(actor.presentAtRangeEnd ? [] : ["REMOVED"]),
					...(actorAtFrame === undefined ? ["NOT AT FRAME"] : [])
				],
				classLabel: shortClass((actorAtFrame ?? actor.actor).classPath),
				classPath: actor.actor.classPath,
				key: actor.key,
				label: actorTitle(actorAtFrame ?? actor.actor),
				packageName: (actorAtFrame ?? actor.actor).packageName,
				path: (actorAtFrame ?? actor.actor).actorPath,
				secondary: shortActorPath((actorAtFrame ?? actor.actor).actorPath),
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
	const plottedPoints = createMemo<readonly PointMapPoint[]>(() =>
		plottedActors().flatMap(({ actor, frameActor }) => {
			if (frameActor.position.status !== "resolved") return [];
			return [
				{
					className: shortClass(frameActor.classPath),
					key: actor.key,
					x: frameActor.position.location.x,
					y: frameActor.position.location.y
				}
			];
		})
	);
	const pointClasses = createMemo(() => {
		const counts = new Map<string, number>();
		for (const point of plottedPoints()) {
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
		const position = selectedActorAtFrame()?.position;
		return position?.status === "resolved" ? point(position.location) : undefined;
	});
	const selectedActorEvents = createMemo(() => selectedActor()?.events ?? []);
	const selectedActorMovements = createMemo(() =>
		selectedActor() === undefined ? [] : worldLogActorMovementEvents(selectedActor()!)
	);
	const frameResolvedActorCount = createMemo(
		() =>
			props.frame.actors.filter((actor) => actor.actor.position.status === "resolved").length
	);
	const frameHasNoMap = () =>
		props.frame.kind === "range_start" &&
		props.history.baseline.status === "map_not_yet_created";
	const selectActor = (key: string) =>
		props.onSelectActor(props.selectedActorKey === key ? undefined : key);
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
				CHANGED
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
						{presence.toUpperCase()}
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
						{resolution === "all" ? "ANY POSITION" : resolution.toUpperCase()}
					</button>
				)}
			</For>
		</div>
	);

	return (
		<section aria-label="Saved actor point map" {...stylex.props(styles.actorAtlas)}>
			<header {...stylex.props(styles.actorAtlasHeader)}>
				<div>
					<span {...stylex.props(styles.sectionKicker)}>SAVED ACTOR STATE</span>
					<h2>{frameTitle(props.frame)} point map</h2>
				</div>
				<div {...stylex.props(styles.snapshotSummary)}>
					<strong>{frameResolvedActorCount()}</strong>
					<span>RESOLVED AT FRAME</span>
					<small>{props.frame.completeness} COVERAGE</small>
				</div>
			</header>
			<nav aria-label="Saved state scrubber" {...stylex.props(styles.playbackFrames)}>
				<button
					type="button"
					aria-label="Show state at range start"
					aria-pressed={props.frame.kind === "range_start"}
					onClick={() => props.onSelectFrame(undefined)}
					{...stylex.props(
						styles.playbackFrameButton,
						props.frame.kind === "range_start" && styles.playbackFrameButtonActive
					)}
				>
					RANGE START
				</button>
				<For each={props.history.revisions}>
					{(revision, revisionIndex) => (
						<button
							type="button"
							aria-label={`Show state after CL ${revision.change}`}
							aria-pressed={
								props.frame.kind === "revision" &&
								props.frame.revisionIndex === revisionIndex()
							}
							onClick={() => props.onSelectFrame(revisionIndex())}
							{...stylex.props(
								styles.playbackFrameButton,
								props.frame.kind === "revision" &&
									props.frame.revisionIndex === revisionIndex() &&
									styles.playbackFrameButtonActive
							)}
						>
							AFTER CL {revision.change}
						</button>
					)}
				</For>
			</nav>
			<Show when={frameHasNoMap()}>
				<div {...stylex.props(styles.frameNotice)}>
					This range begins before the map was created. The empty state is a saved
					baseline, not a failed reconstruction.
				</div>
			</Show>
			<Show when={props.frame.completeness === "partial"}>
				<div {...stylex.props(styles.frameNotice, styles.frameNoticePartial)}>
					Partial saved-world coverage at this frame. Actor state is limited to the
					packages that could be read.
				</div>
			</Show>
			<Show when={props.frame.unclassifiedPackageChanges.length > 0}>
				<div {...stylex.props(styles.frameNotice, styles.frameNoticeUnclassified)}>
					{props.frame.unclassifiedPackageChanges.length} unclassified package change
					{props.frame.unclassifiedPackageChanges.length === 1 ? "" : "s"} at this frame.
					Their changed bytes remain in the changelist evidence ledger.
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
					extraControls={extraFilters}
					filters={actorFilters()}
					itemListLabel="Saved actors"
					items={explorerItems()}
					label="ACTOR VIEW FILTERS"
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
					onSelect={(key) => props.onSelectActor(key)}
					queryAriaLabel="Find World Log actor"
					role="complementary"
					selectedClassPath={undefined}
					selectedKey={props.selectedActorKey}
					title="Actors in this history range"
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
					<Show
						when={plottedPoints().length > 0}
						fallback={
							<div {...stylex.props(styles.noResolvedActors)}>
								No saved actors with resolved positions match this View Filter at
								this submitted state.
							</div>
						}
					>
						<PointMapCanvas
							ariaLabel="Top-down saved actor points map"
							class={stylex.props(styles.pointMap).className}
							onController={(controller) => {
								pointMap = controller;
							}}
							onSelect={(key) =>
								key === undefined
									? props.onSelectActor(undefined)
									: selectActor(key)
							}
							points={plottedPoints()}
							resetKey={`${props.history.query.mapPath}:${props.history.query.range.since}:${props.history.query.range.until}:${props.frame.kind}:${props.frame.kind === "revision" ? props.frame.revisionIndex : "start"}`}
							selectedKey={props.selectedActorKey}
							title="Scroll to zoom, drag to pan, click a saved actor point to inspect it"
						/>
					</Show>
					<button
						type="button"
						onClick={() => pointMap?.resetView()}
						{...stylex.props(styles.pointMapReset)}
					>
						RESET VIEW
					</button>
				</div>
				<aside aria-label="Selected saved actor" {...stylex.props(styles.actorInspector)}>
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
								<span {...stylex.props(styles.sectionKicker)}>ACTOR HISTORY</span>
								<h3>{actorTitle(selectedActorAtFrame() ?? actor().actor)}</h3>
								<code>{(selectedActorAtFrame() ?? actor().actor).classPath}</code>
								<dl {...stylex.props(styles.actorFacts)}>
									<div>
										<dt>EVENTS</dt>
										<dd>{actor().changeCount}</dd>
									</div>
									<div>
										<dt>FRAME</dt>
										<dd>{frameTitle(props.frame)}</dd>
									</div>
									<div>
										<dt>FRAME STATUS</dt>
										<dd>
											{selectedActorAtFrame() === undefined
												? "NOT PRESENT"
												: "AT FRAME"}
										</dd>
									</div>
									<div>
										<dt>RANGE-END STATUS</dt>
										<dd>
											{actor().presentAtRangeEnd ? "AT RANGE END" : "REMOVED"}
										</dd>
									</div>
									<div>
										<dt>LIFECYCLE</dt>
										<dd>{humanize(worldLogActorLifecycle(actor()))}</dd>
									</div>
									<div>
										<dt>RESOLUTION</dt>
										<dd>
											{selectedActorAtFrame() === undefined
												? "NOT PRESENT"
												: selectedActorAtFrame()!.position.status ===
													  "resolved"
													? "RESOLVED"
													: "UNRESOLVED"}
										</dd>
									</div>
									<Show when={selectedActorPosition()}>
										{(position) => (
											<div>
												<dt>POSITION AT FRAME</dt>
												<dd>{position()}</dd>
											</div>
										)}
									</Show>
								</dl>
								<Show when={selectedActorMovements().length > 0}>
									<section {...stylex.props(styles.actorEventSection)}>
										<span {...stylex.props(styles.sectionKicker)}>
											MOVEMENT TRAIL
										</span>
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
								<section {...stylex.props(styles.actorEventSection)}>
									<span {...stylex.props(styles.sectionKicker)}>
										SEMANTIC EVENTS
									</span>
									<ol {...stylex.props(styles.actorEventList)}>
										<For each={selectedActorEvents()}>
											{(event) => (
												<li>
													<button
														type="button"
														onClick={() =>
															props.onSelectActorEvent({
																actorKey: actor().key,
																changeIndex: event.changeIndex,
																revision: event.revisionIndex
															})
														}
														{...stylex.props(styles.actorEventButton)}
													>
														<span>CL {event.revision.change}</span>
														<strong>{changeTitle(event.change)}</strong>
														<small>
															{formatSubmittedAt(event.revision)} /{" "}
															{changeDetail(event.change)}
														</small>
													</button>
												</li>
											)}
										</For>
									</ol>
								</section>
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
		</section>
	);
}
