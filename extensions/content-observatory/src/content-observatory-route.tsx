import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import type { ActorIdentity } from "@ue-shed/map-history/contract";
import { mapHistoryPlaybackFrameAt } from "@ue-shed/map-history/playback";
import type { SavedWorldActor } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import {
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount
} from "solid-js";
import {
	ContentObservatoryHistoryRequest,
	type ContentObservatoryTargetCatalog,
	type ContentObservatoryClientApi,
	type ContentObservatoryState
} from "./content-observatory-client.js";
import { WorldLogScene, type WorldLogSceneView } from "./world-log-actor-atlas.js";
import { actorKeyFromIdentity, actorKeyFromSavedActor } from "./world-log-actors.js";
import { humanize } from "./world-log-format.js";
import {
	WorldLogQueryForm,
	type WorldLogFastTargetKind,
	type WorldLogHistoryMode,
	type WorldLogScanLimits
} from "./world-log-query-form.js";
import {
	actorKeyOfSelection,
	changeSelectionOf,
	changelistSelectionOf,
	noWorldLogSelection,
	reduceWorldLogEvent,
	type WorldLogEvent,
	type WorldLogSelection
} from "./world-log-selection.js";
import { styles } from "./world-log-styles.js";
import { WorldLogTimeline, type WorldLogChangeFilter } from "./world-log-timeline.js";

type ViewState = { readonly status: "loading" } | ContentObservatoryState;
type StateUpdateSource = "mutation" | "poll";
interface RawHistoryRequestFields {
	readonly limits: WorldLogScanLimits;
	readonly mapPath: string;
	readonly range: { readonly since: string; readonly until: string };
}
type RawHistoryRequest = RawHistoryRequestFields &
	(
		| { readonly mode: "deep" }
		| {
				readonly mode: "fast";
				readonly target:
					| { readonly identity: ActorIdentity; readonly kind: "actor" }
					| { readonly classPath: string; readonly kind: "actor_class" };
		  }
	);
type WorldLogLens = "world" | "changelists";

const decodeHistoryRequest = Schema.decodeUnknownEffect(ContentObservatoryHistoryRequest);
const defaultWorldLogScanLimits: WorldLogScanLimits = {
	maxChangelists: 250,
	maxConcurrency: 4,
	maxDurationMs: 120000,
	maxMaterializedFiles: 4000,
	maxPackages: 4000
};

function rangeLengthDays(range: {
	readonly since: unknown;
	readonly until: unknown;
}): number | undefined {
	const since = Date.parse(String(range.since));
	const until = Date.parse(String(range.until));
	if (!Number.isFinite(since) || !Number.isFinite(until)) return undefined;
	return Math.round((until - since) / (24 * 60 * 60 * 1000));
}

function isJobState(
	state: ViewState
): state is Exclude<ContentObservatoryState, { readonly status: "not_configured" | "ready" }> {
	return "jobId" in state;
}

function shouldApplyPolledState(current: ViewState, next: ContentObservatoryState): boolean {
	if (!isJobState(current) || !isJobState(next)) return true;
	if (current.jobId !== next.jobId) return false;
	return current.status === "running" || next.status !== "running";
}

const zeroActorGuid = /^0{8}-0{8}-0{8}-0{8}$/;

function actorIdentityOfTarget(actor: SavedWorldActor): ActorIdentity {
	if (
		actor.actorGuid !== undefined &&
		actor.actorGuid.length > 0 &&
		!zeroActorGuid.test(actor.actorGuid)
	) {
		return { actorGuid: actor.actorGuid, kind: "actor_guid" };
	}
	return {
		actorPath: actor.actorPath,
		kind: "object_path",
		packageName: actor.packageName
	};
}

/**
 * The route owns only presentation state. Perforce acquisition, progress, cancellation, and
 * temporary reconstruction authority remain behind the injected browser client.
 */
export function ContentObservatoryRoute(props: { readonly client: ContentObservatoryClientApi }) {
	const action = createEffectAction();
	const targetAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [mapPath, setMapPath] = createSignal("");
	const [mode, setMode] = createSignal<WorldLogHistoryMode>("deep");
	const [targetCatalog, setTargetCatalog] = createSignal<ContentObservatoryTargetCatalog>();
	const [fastTargetKind, setFastTargetKind] = createSignal<WorldLogFastTargetKind>("actor");
	const [targetClassPath, setTargetClassPath] = createSignal<string | undefined>(undefined);
	const [targetKey, setTargetKey] = createSignal<string | undefined>(undefined);
	const [targetLoading, setTargetLoading] = createSignal(false);
	const [targetError, setTargetError] = createSignal<string | undefined>(undefined);
	const [rangeDays, setRangeDays] = createSignal(7);
	const [filter, setFilter] = createSignal<WorldLogChangeFilter>("all");
	const [lens, setLens] = createSignal<WorldLogLens>("world");
	const [limits, setLimits] = createSignal<WorldLogScanLimits>(defaultWorldLogScanLimits);
	const [frameRevision, setFrameRevision] = createSignal<number | undefined>(undefined);
	const [selection, setSelection] = createSignal<WorldLogSelection>(noWorldLogSelection);
	let appliedProjectRoot: string | undefined;
	let loadedCurrentMapKey = "";

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
	const selectedActorKey = createMemo(() => actorKeyOfSelection(selection()));
	const selectedChangelist = createMemo(() => changelistSelectionOf(selection()));
	const selectedChange = createMemo(() => changeSelectionOf(selection()));
	const playbackFrame = createMemo(() => {
		const complete = completeState();
		return complete === undefined
			? undefined
			: mapHistoryPlaybackFrameAt({
					history: complete.history,
					revisionIndex: frameRevision()
				});
	});
	const historyCounts = createMemo(() => {
		const complete = completeState();
		if (complete === undefined) return undefined;
		return complete.history.revisions.reduce(
			(counts, revision) => ({
				semantic: counts.semantic + revision.changes.length,
				unclassified: counts.unclassified + revision.unclassifiedPackageChanges.length
			}),
			{ semantic: 0, unclassified: 0 }
		);
	});
	const fastCoverageNotice = createMemo(() => {
		const complete = completeState();
		if (complete === undefined || complete.request.mode !== "fast") return undefined;
		const history = complete.history;
		if (!("coverage" in history)) return undefined;
		const target = history.coverage.investigationTarget;
		return target.kind === "actor"
			? {
					detail: "Other actors are outside this result. It does not claim complete map coverage or historical class coverage. Use Deep History when you need the full map.",
					headline: `This result follows actor ${target.actorPath} only.`
				}
			: {
					detail: "Deleted or historically reclassified actors are outside this result. It does not claim complete map coverage or historical class coverage. Use Deep History when you need the full map.",
					headline: `This result follows ${target.currentActorCount} current actor${target.currentActorCount === 1 ? "" : "s"} of ${target.classPath}.`
				};
	});
	const resultIsStale = createMemo(() => {
		const complete = completeState();
		if (complete === undefined) return false;
		const completedRangeDays = rangeLengthDays(complete.history.query.range);
		return (
			mapPath().trim() !== complete.history.query.mapPath ||
			(completedRangeDays !== undefined && rangeDays() !== completedRangeDays)
		);
	});
	const sceneView = createMemo<WorldLogSceneView | undefined>(() => {
		const complete = completeState();
		const frame = playbackFrame();
		const catalog = targetCatalog();
		if (
			complete !== undefined &&
			frame !== undefined &&
			(!resultIsStale() || catalog === undefined)
		) {
			return { frame, history: complete.history, kind: "history" };
		}
		return catalog === undefined ? undefined : { kind: "current", world: catalog };
	});

	const apply = (next: ContentObservatoryState, source: StateUpdateSource = "mutation") => {
		const shouldApply = source !== "poll" || shouldApplyPolledState(state(), next);
		if (!shouldApply) return;
		const projectChanged = "projectRoot" in next && next.projectRoot !== appliedProjectRoot;
		if (projectChanged) {
			appliedProjectRoot = next.projectRoot;
			setTargetCatalog(undefined);
			setTargetKey(undefined);
			setTargetClassPath(undefined);
			setTargetError(undefined);
			setMapPath(
				next.status === "complete"
					? next.history.query.mapPath
					: (next.maps[0]?.mapPath ?? "")
			);
		}
		setState(next);
		if ("request" in next) {
			setMode(next.request.mode);
			if (next.request.mode === "fast") {
				setFastTargetKind(next.request.target.kind);
				if (next.request.target.kind === "actor") {
					setTargetKey(actorKeyFromIdentity(next.request.target.identity));
					setTargetClassPath(undefined);
				} else {
					setTargetClassPath(next.request.target.classPath);
					setTargetKey(undefined);
				}
			}
		}
		if (!projectChanged && mapPath().length === 0) {
			setMapPath(
				next.status === "complete"
					? next.history.query.mapPath
					: next.status === "ready"
						? (next.maps[0]?.mapPath ?? "")
						: ""
			);
		}
		if (next.status === "complete") {
			setLens("world");
			setSelection(noWorldLogSelection);
			const completedRangeDays = rangeLengthDays(next.history.query.range);
			if (completedRangeDays !== undefined) setRangeDays(completedRangeDays);
			setFrameRevision(
				next.history.revisions.length === 0 ? undefined : next.history.revisions.length - 1
			);
		}
	};
	const refresh = () =>
		action.run(props.client.status(), { onSuccess: (next) => apply(next, "poll") });
	const dispatchWorldLogEvent = (event: WorldLogEvent) => {
		if (event.type === "frame_selected") setFrameRevision(event.revisionIndex);
		if (event.type === "actor_event_selected" || event.type === "changelist_selected") {
			setFrameRevision(event.revision);
			setLens("changelists");
		}
		setSelection((current) => reduceWorldLogEvent(current, event));
	};

	const run = () => {
		const until = new Date();
		const since = new Date(until.getTime() - rangeDays() * 24 * 60 * 60 * 1000);
		const baseRequest = {
			limits: limits(),
			mapPath: mapPath().trim(),
			range: { since: since.toISOString(), until: until.toISOString() }
		};
		const selectedTarget = targetCatalog()?.actors.find(
			(actor) => actorKeyFromSavedActor(actor) === targetKey()
		);
		let request: RawHistoryRequest;
		if (mode() === "fast") {
			if (fastTargetKind() === "actor" && selectedTarget === undefined) return;
			if (fastTargetKind() === "actor_class" && targetClassPath() === undefined) return;
			request = {
				...baseRequest,
				mode: "fast" as const,
				target:
					fastTargetKind() === "actor"
						? {
								kind: "actor" as const,
								identity: actorIdentityOfTarget(selectedTarget!)
							}
						: { classPath: targetClassPath()!, kind: "actor_class" as const }
			};
		} else {
			request = { ...baseRequest, mode: "deep" as const };
		}
		action.run(
			decodeHistoryRequest(request).pipe(
				Effect.flatMap((decoded) => props.client.start(decoded))
			),
			{ onSuccess: apply }
		);
	};
	const changeMapPath = (next: string) => {
		setMapPath(next);
		setTargetCatalog(undefined);
		setTargetKey(undefined);
		setTargetClassPath(undefined);
		setTargetError(undefined);
	};
	const changeMode = (next: WorldLogHistoryMode) => {
		setMode(next);
		if (next === "deep") setTargetError(undefined);
	};
	const changeFastTargetKind = (next: WorldLogFastTargetKind) => {
		setFastTargetKind(next);
		setTargetKey(undefined);
		setTargetClassPath(undefined);
	};
	const loadTargets = () => {
		const selectedMap = mapPath().trim();
		if (selectedMap.length === 0) return;
		const targets = props.client.targets;
		if (targets === undefined) {
			setTargetError("Current actor discovery is not available in this Workbench build.");
			return;
		}
		setTargetCatalog(undefined);
		setTargetLoading(true);
		setTargetError(undefined);
		targetAction.run(targets(selectedMap), {
			onFailure: (cause) => {
				setTargetLoading(false);
				const detail =
					cause instanceof Error
						? cause.message
						: cause instanceof Object && "message" in cause
							? String(cause.message)
							: undefined;
				setTargetError(
					detail === undefined
						? "Current actors could not be loaded. Use Deep History or verify the map."
						: `Current actors could not be loaded: ${detail}`
				);
			},
			onSuccess: (catalog) => {
				setTargetLoading(false);
				setTargetCatalog(catalog);
				setTargetKey(undefined);
				setTargetClassPath(undefined);
			}
		});
	};

	createEffect(() => {
		const current = readyState();
		const projectRoot = current?.projectRoot;
		const selectedMap = mapPath().trim();
		if (projectRoot === undefined || selectedMap.length === 0) return;
		const requestKey = `${projectRoot}\u0000${selectedMap}`;
		if (requestKey === loadedCurrentMapKey) return;
		loadedCurrentMapKey = requestKey;
		loadTargets();
	});

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
					<h1 {...stylex.props(styles.title)}>World Log</h1>
					<p {...stylex.props(styles.headerSubtitle)}>
						Saved actor history reconstructed at submitted changelists.
					</p>
				</div>
				<div {...stylex.props(styles.headerSignal)}>
					<span />
					PERFORCE · MAP SCOPED
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
							<WorldLogQueryForm
								disabled={current().status === "running"}
								mode={mode()}
								limits={limits()}
								maps={current().maps}
								mapPath={mapPath()}
								onLimitsChange={(next) =>
									setLimits((currentLimits) => ({ ...currentLimits, ...next }))
								}
								onMapPathChange={changeMapPath}
								onModeChange={changeMode}
								onLoadTargets={loadTargets}
								onRun={run}
								onFastTargetKindChange={changeFastTargetKind}
								onTargetClassChange={(classPath) => {
									setTargetClassPath(classPath);
									setTargetKey(undefined);
								}}
								onTargetChange={setTargetKey}
								rangeDays={rangeDays()}
								setRangeDays={setRangeDays}
								targetActors={targetCatalog()?.actors ?? []}
								targetError={targetError()}
								targetClassPath={targetClassPath()}
								targetKey={targetKey()}
								fastTargetKind={fastTargetKind()}
								targetLoading={targetLoading()}
							/>
							<Show when={targetLoading() && targetCatalog() === undefined}>
								<section
									aria-live="polite"
									{...stylex.props(styles.worldLogTargetLoading)}
								>
									<span {...stylex.props(styles.sectionKicker)}>
										CURRENT SAVED MAP
									</span>
									<strong>Reading the selected map…</strong>
									<p {...stylex.props(styles.worldLogTargetLoadingCopy)}>
										The current map stays available while history is
										reconstructed.
									</p>
								</section>
							</Show>
							<Show when={completeState()}>
								{(complete) => (
									<section
										aria-label="World Log investigation lenses"
										{...stylex.props(styles.investigationBar)}
									>
										<div
											role="tablist"
											aria-label="Investigation lens"
											{...stylex.props(styles.lensTabs)}
										>
											<button
												type="button"
												role="tab"
												id="world-log-world-tab"
												aria-controls="world-log-world-panel"
												aria-selected={lens() === "world"}
												onClick={() => setLens("world")}
												{...stylex.props(
													styles.lensTab,
													lens() === "world" && styles.lensTabActive
												)}
											>
												World state
											</button>
											<button
												type="button"
												role="tab"
												id="world-log-changelists-tab"
												aria-controls="world-log-changelists-panel"
												aria-selected={lens() === "changelists"}
												onClick={() => setLens("changelists")}
												{...stylex.props(
													styles.lensTab,
													lens() === "changelists" && styles.lensTabActive
												)}
											>
												Changelists
											</button>
										</div>
										<div {...stylex.props(styles.investigationFacts)}>
											<span>
												<b>{complete().history.revisions.length}</b>{" "}
												submitted CLs
											</span>
											<span>
												<b>{historyCounts()?.semantic ?? 0}</b> actor
												changes
											</span>
											<span
												{...stylex.props(
													(historyCounts()?.unclassified ?? 0) > 0 &&
														styles.investigationWarning
												)}
											>
												<b>{historyCounts()?.unclassified ?? 0}</b>{" "}
												unclassified
											</span>
											<span>{complete().history.completeness} coverage</span>
										</div>
									</section>
								)}
							</Show>
							<Show when={fastCoverageNotice()}>
								{(notice) => (
									<section
										aria-label="Fast History coverage"
										{...stylex.props(styles.fastCoverageNotice)}
									>
										<span {...stylex.props(styles.sectionKicker)}>
											FAST HISTORY / TARGETED
										</span>
										<strong>{notice().headline}</strong>
										<p>{notice().detail}</p>
									</section>
								)}
							</Show>
							<Show when={resultIsStale()}>
								<section
									aria-label="Stale World Log result"
									{...stylex.props(styles.staleResult)}
								>
									<span {...stylex.props(styles.sectionKicker)}>
										QUERY CHANGED
									</span>
									This retained result describes its completed map and time range.
									Read history again to update it for the current query.
								</section>
							</Show>
							<Show when={lens() === "world" ? sceneView() : undefined}>
								{(view) => (
									<div
										id="world-log-world-panel"
										role="tabpanel"
										aria-labelledby="world-log-world-tab"
									>
										<WorldLogScene
											onEvent={dispatchWorldLogEvent}
											selectedActorKey={selectedActorKey()}
											selectedChangelist={selectedChangelist()}
											view={view()}
										/>
									</div>
								)}
							</Show>
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
											<Show when={running().progress.savedWorld}>
												{(savedWorld) => (
													<small
														{...stylex.props(styles.runningSubprogress)}
													>
														{humanize(savedWorld().phase)} ·{" "}
														{savedWorld().processedPackages} /{" "}
														{savedWorld().totalPackages} packages ·{" "}
														{savedWorld().actorsFound} actors found
													</small>
												)}
											</Show>
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
									<Show
										when={playbackFrame()}
										fallback={
											<section {...stylex.props(styles.playbackUnavailable)}>
												The saved-state playback frame is unavailable for
												this result. Re-run the scan with a playback-capable
												Map History producer.
											</section>
										}
									>
										<>
											<Show when={lens() === "changelists"}>
												<div
													id="world-log-changelists-panel"
													role="tabpanel"
													aria-labelledby="world-log-changelists-tab"
												>
													<WorldLogTimeline
														actorKey={selectedActorKey()}
														filter={filter()}
														history={complete().history}
														onSelect={(input) =>
															dispatchWorldLogEvent({
																...input,
																type: "actor_event_selected"
															})
														}
														onSelectChangelist={(revision) =>
															dispatchWorldLogEvent({
																revision,
																type: "changelist_selected"
															})
														}
														selectedChangelist={selectedChangelist()}
														selected={selectedChange()}
														setFilter={setFilter}
													/>
												</div>
											</Show>
										</>
									</Show>
								)}
							</Show>
						</>
					)}
				</Match>
			</Switch>
		</main>
	);
}
