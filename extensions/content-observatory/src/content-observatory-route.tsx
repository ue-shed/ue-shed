import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import { mapHistoryPlaybackFrameAt } from "@ue-shed/map-history/playback";
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
	type ContentObservatoryClientShape,
	type ContentObservatoryState
} from "./content-observatory-client.js";
import { WorldLogActorAtlas } from "./world-log-actor-atlas.js";
import { WorldLogChangelistMap } from "./world-log-changelist-map.js";
import { humanize } from "./world-log-format.js";
import { WorldLogQueryForm, type WorldLogScanLimits } from "./world-log-query-form.js";
import {
	actorKeyOfSelection,
	changeSelectionOf,
	changelistSelectionOf,
	noWorldLogSelection,
	selectWorldLogActor,
	selectWorldLogChange,
	selectWorldLogChangelist,
	type WorldLogSelection
} from "./world-log-selection.js";
import { styles } from "./world-log-styles.js";
import { WorldLogTimeline, type WorldLogChangeFilter } from "./world-log-timeline.js";

type ViewState = { readonly status: "loading" } | ContentObservatoryState;

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

/**
 * The route owns only presentation state. Perforce acquisition, progress, cancellation, and
 * temporary reconstruction authority remain behind the injected browser client.
 */
export function ContentObservatoryRoute(props: { readonly client: ContentObservatoryClientShape }) {
	const action = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [mapPath, setMapPath] = createSignal("");
	const [rangeDays, setRangeDays] = createSignal(7);
	const [filter, setFilter] = createSignal<WorldLogChangeFilter>("all");
	const [limits, setLimits] = createSignal<WorldLogScanLimits>(defaultWorldLogScanLimits);
	const [frameRevision, setFrameRevision] = createSignal<number | undefined>(undefined);
	const [selection, setSelection] = createSignal<WorldLogSelection>(noWorldLogSelection);

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
	const resultIsStale = createMemo(() => {
		const complete = completeState();
		if (complete === undefined) return false;
		const completedRangeDays = rangeLengthDays(complete.history.query.range);
		return (
			mapPath().trim() !== complete.history.query.mapPath ||
			(completedRangeDays !== undefined && rangeDays() !== completedRangeDays)
		);
	});

	const apply = (next: ContentObservatoryState) => {
		setState(next);
		if (mapPath().length === 0) {
			setMapPath(
				next.status === "complete"
					? next.history.query.mapPath
					: next.status === "ready"
						? (next.maps[0]?.mapPath ?? "")
						: ""
			);
		}
		if (next.status === "complete") {
			setSelection(noWorldLogSelection);
			const completedRangeDays = rangeLengthDays(next.history.query.range);
			if (completedRangeDays !== undefined) setRangeDays(completedRangeDays);
			setFrameRevision(
				next.history.revisions.length === 0 ? undefined : next.history.revisions.length - 1
			);
		}
	};
	const refresh = () => action.run(props.client.status(), { onSuccess: apply });
	const selectActor = (actorKey: string | undefined) => {
		setSelection((current) => selectWorldLogActor(current, actorKey));
	};
	const selectChangelist = (revision: number) => {
		setFrameRevision(revision);
		setSelection((current) => selectWorldLogChangelist(current, revision));
	};
	const selectChange = (input: {
		readonly actorKey: string | undefined;
		readonly changeIndex: number;
		readonly revision: number;
	}) => {
		setFrameRevision(input.revision);
		setSelection((current) => selectWorldLogChange(current, input));
	};

	const run = () => {
		const until = new Date();
		const since = new Date(until.getTime() - rangeDays() * 24 * 60 * 60 * 1000);
		const request = {
			limits: limits(),
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
							<WorldLogQueryForm
								disabled={current().status === "running"}
								limits={limits()}
								maps={current().maps}
								mapPath={mapPath()}
								onLimitsChange={(next) =>
									setLimits((currentLimits) => ({ ...currentLimits, ...next }))
								}
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
										{(frame) => (
											<>
												<Show when={resultIsStale()}>
													<section
														aria-label="Stale World Log result"
														{...stylex.props(styles.staleResult)}
													>
														<span
															{...stylex.props(styles.sectionKicker)}
														>
															QUERY CHANGED
														</span>
														This retained result describes its completed
														map and time range. Read history again to
														update it for the current query.
													</section>
												</Show>
												<WorldLogActorAtlas
													frame={frame()}
													history={complete().history}
													onSelectActor={selectActor}
													onSelectActorEvent={selectChange}
													onSelectFrame={setFrameRevision}
													selectedActorKey={selectedActorKey()}
												/>
												<Show when={selectedChangelist()}>
													{(selected) => {
														const revision = () =>
															complete().history.revisions[
																selected().revision
															];
														return (
															<Show when={revision()}>
																{(currentRevision) => (
																	<WorldLogChangelistMap
																		onSelectActor={selectActor}
																		revision={currentRevision()}
																		selectedActorKey={selectedActorKey()}
																	/>
																)}
															</Show>
														);
													}}
												</Show>
												<WorldLogTimeline
													actorKey={selectedActorKey()}
													filter={filter()}
													history={complete().history}
													onSelect={selectChange}
													onSelectChangelist={selectChangelist}
													selectedChangelist={selectedChangelist()}
													selected={selectedChange()}
													setFilter={setFilter}
												/>
											</>
										)}
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
