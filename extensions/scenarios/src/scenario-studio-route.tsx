import * as stylex from "@stylexjs/stylex";
import {
	clipEndMs,
	clipsInScenario,
	findScenarioClip,
	makeScenarioElementId,
	movementGymRuns,
	movementGymScenario,
	moveScenarioClip,
	planScenarioSeek,
	type ScenarioClip,
	type ScenarioDocument,
	type ScenarioElementId,
	type ScenarioRun,
	type ScenarioSeekPlan,
	type ScenarioTrack
} from "@ue-shed/scenarios";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Option, Schedule } from "effect";
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import type { ScenarioStudioClient } from "./client.js";

type TransportState = "paused" | "playing" | "recording";
type LiveRunState = "preview" | "executing" | "completed" | "unavailable";

export interface ScenarioStudioRouteProps {
	readonly client?: ScenarioStudioClient;
}

interface DragState {
	readonly clipId: ScenarioElementId;
	readonly originalDocument: ScenarioDocument;
	readonly originalStartMs: number;
	readonly pointerId: number;
	readonly startX: number;
	readonly timelineWidth: number;
}

const TIME_TICKS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000] as const;

function formatTime(milliseconds: number): string {
	const seconds = milliseconds / 1000;
	return `${Math.floor(seconds / 60)
		.toString()
		.padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

function clipStart(clip: ScenarioClip): number {
	return clip.startMs;
}

function clipWidth(clip: ScenarioClip, durationMs: number): string {
	const duration = Math.max(clipEndMs(clip) - clip.startMs, 54);
	return `${Math.max((duration / durationMs) * 100, 1.2)}%`;
}

function clipLeft(clip: ScenarioClip, durationMs: number): string {
	return `${(clip.startMs / durationMs) * 100}%`;
}

function trackCaption(track: ScenarioTrack): string {
	switch (track.kind) {
		case "semantic_actions":
			return "pre-evaluation action values";
		case "raw_input":
			return "raw gamepad input";
		case "world_conditions":
			return "waits + checks";
		case "interventions":
			return "forced game state";
		case "evidence":
			return "screenshots + state checks";
	}
}

function trackKindLabel(track: ScenarioTrack): string {
	switch (track.kind) {
		case "semantic_actions":
			return "player actions";
		case "raw_input":
			return "raw input";
		case "world_conditions":
			return "game checks";
		case "interventions":
			return "overrides";
		case "evidence":
			return "captures";
	}
}

function clipDetail(clip: ScenarioClip): string {
	switch (clip.kind) {
		case "semantic_action":
			return clip.actionPath.split("/").at(-1) ?? clip.actionPath;
		case "raw_input":
			return clip.key.replace("Gamepad_", "");
		case "world_condition":
			return clip.mode === "wait" ? `≤ ${(clip.timeoutMs / 1000).toFixed(2)}s` : "check";
		case "intervention":
			return clip.operation;
		case "evidence":
			return clip.evidenceType.replaceAll("_", " ");
	}
}

function sourceLayer(clip: ScenarioClip): string {
	switch (clip.kind) {
		case "semantic_action":
			return "pre-evaluation action";
		case "raw_input":
			return "raw input";
		case "world_condition":
		case "intervention":
		case "evidence":
			return "game state";
	}
}

function clipKindLabel(clip: ScenarioClip): string {
	switch (clip.kind) {
		case "semantic_action":
			return "player action";
		case "raw_input":
			return "raw input";
		case "world_condition":
			return "game check";
		case "intervention":
			return "override";
		case "evidence":
			return "capture";
	}
}

function operationName(clip: ScenarioClip): string {
	switch (clip.kind) {
		case "semantic_action":
			return clip.actionPath;
		case "raw_input":
			return `${clip.device}:${clip.key}`;
		case "world_condition":
			return clip.operation;
		case "intervention":
			return clip.operation;
		case "evidence":
			return clip.request;
	}
}

function firstMovementGymRun(): ScenarioRun {
	const run = movementGymRuns[0];
	if (run === undefined) throw new Error("Movement Gym demo must include one saved run.");
	return run;
}

export function ScenarioStudioRoute(props: ScenarioStudioRouteProps) {
	const playbackAction = createEffectAction();
	const liveRunAction = createEffectAction();
	const [document, setDocument] = createSignal<ScenarioDocument>(movementGymScenario);
	const [activeRun, setActiveRun] = createSignal<ScenarioRun>(firstMovementGymRun());
	const [selectedId, setSelectedId] = createSignal<ScenarioElementId>(
		makeScenarioElementId("action_jump")
	);
	const [playheadMs, setPlayheadMs] = createSignal(3370);
	const [transport, setTransport] = createSignal<TransportState>("paused");
	const [liveRunState, setLiveRunState] = createSignal<LiveRunState>("preview");
	const [liveRunFailure, setLiveRunFailure] = createSignal<string>();
	const [seekPlan, setSeekPlan] = createSignal<ScenarioSeekPlan>(
		planScenarioSeek({ document: movementGymScenario, targetMs: 3370 })
	);
	const restorePlan = createMemo(() => {
		const plan = seekPlan();
		return plan.status === "restore" ? plan : undefined;
	});
	const replayPlan = createMemo(() => {
		const plan = seekPlan();
		return plan.status === "restore_and_replay" ? plan : undefined;
	});
	const unavailablePlan = createMemo(() => {
		const plan = seekPlan();
		return plan.status === "unavailable" ? plan : undefined;
	});
	const [timelineScale, setTimelineScale] = createSignal(1);
	const [dragState, setDragState] = createSignal<DragState | undefined>();
	const selectedClip = createMemo(() => findScenarioClip(document(), selectedId()));
	const selectedEvidence = createMemo(() =>
		activeRun().evidence.find((evidence) => evidence.markerId === selectedId())
	);
	const evidenceAtPlayhead = createMemo(
		() =>
			[...activeRun().evidence].sort(
				(left, right) =>
					Math.abs(left.atMs - playheadMs()) - Math.abs(right.atMs - playheadMs())
			)[0]
	);

	const stopPlayback = () => {
		playbackAction.cancel();
		setTransport("paused");
	};
	const play = () => {
		if (transport() === "playing") {
			stopPlayback();
			return;
		}
		setTransport("playing");
		const tickCount = Math.max(1, Math.ceil((document().durationMs - playheadMs()) / 40));
		const tick = Effect.sync(() =>
			setPlayheadMs((current) => Math.min(current + 40, document().durationMs))
		).pipe(Effect.delay("40 millis"));
		playbackAction.run(tick.pipe(Effect.repeat(Schedule.recurs(tickCount - 1))), {
			onSuccess: () => setTransport("paused")
		});
	};
	const restart = () => {
		stopPlayback();
		setPlayheadMs(0);
		setSeekPlan(planScenarioSeek({ document: document(), targetMs: 0 }));
	};
	const runLive = () => {
		if (props.client === undefined || liveRunState() === "executing") return;
		stopPlayback();
		setLiveRunFailure(undefined);
		setLiveRunState("executing");
		liveRunAction.run(props.client.run(document()), {
			onFailure: (cause) => {
				const error = Cause.findErrorOption(cause);
				setLiveRunFailure(
					Option.isSome(error)
						? `${error.value.message} ${error.value.recovery}`
						: Cause.pretty(cause)
				);
				setLiveRunState("unavailable");
			},
			onSuccess: (run) => {
				setActiveRun(run);
				setPlayheadMs(run.durationMs);
				setLiveRunState("completed");
			}
		});
	};
	const selectClip = (clip: ScenarioClip) => {
		setSelectedId(clip.id);
		setPlayheadMs(clip.startMs);
		setSeekPlan(planScenarioSeek({ document: document(), targetMs: clip.startMs }));
	};
	const moveSelected = (deltaMs: number) => {
		const clip = selectedClip();
		if (clip === undefined) return;
		const result = moveScenarioClip({
			document: document(),
			clipId: clip.id,
			startMs: clip.startMs + deltaMs
		});
		if (result.status === "updated") {
			setDocument(result.document);
			const newStart = findScenarioClip(result.document, clip.id)?.startMs ?? playheadMs();
			setPlayheadMs(newStart);
			setSeekPlan(planScenarioSeek({ document: result.document, targetMs: newStart }));
		}
	};
	const seekFromPointer = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
		const target = Math.round(ratio * document().durationMs);
		setPlayheadMs(target);
		setSeekPlan(planScenarioSeek({ document: document(), targetMs: target }));
	};
	const beginDrag = (
		event: PointerEvent & { currentTarget: HTMLButtonElement },
		clip: ScenarioClip
	) => {
		event.stopPropagation();
		selectClip(clip);
		const timeline = event.currentTarget.parentElement;
		if (timeline === null) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragState({
			clipId: clip.id,
			originalDocument: document(),
			originalStartMs: clip.startMs,
			pointerId: event.pointerId,
			startX: event.clientX,
			timelineWidth: timeline.clientWidth
		});
	};
	const moveDrag = (event: PointerEvent) => {
		const drag = dragState();
		if (drag === undefined || event.pointerId !== drag.pointerId) return;
		const delta = ((event.clientX - drag.startX) / drag.timelineWidth) * document().durationMs;
		const result = moveScenarioClip({
			document: drag.originalDocument,
			clipId: drag.clipId,
			startMs: drag.originalStartMs + delta
		});
		if (result.status === "updated") setDocument(result.document);
	};
	const finishDrag = (event: PointerEvent & { currentTarget: HTMLButtonElement }) => {
		const drag = dragState();
		if (drag === undefined || event.pointerId !== drag.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		setDragState(undefined);
		const moved = findScenarioClip(document(), drag.clipId);
		if (moved !== undefined) {
			setPlayheadMs(moved.startMs);
			setSeekPlan(planScenarioSeek({ document: document(), targetMs: moved.startMs }));
		}
	};

	return (
		<main {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.commandBar)}>
				<div {...stylex.props(styles.documentIdentity)}>
					<span {...stylex.props(styles.scenarioGlyph)}>SCN</span>
					<div>
						<div {...stylex.props(styles.breadcrumb)}>
							SCENARIOS / MOVEMENT GYM / DRAFT 04
						</div>
						<h1 {...stylex.props(styles.title)}>{document().title}</h1>
					</div>
				</div>
				<div {...stylex.props(styles.transport)}>
					<button
						aria-label="Restart preview"
						onClick={restart}
						{...stylex.props(styles.iconButton)}
					>
						↶
					</button>
					<button
						aria-label={transport() === "playing" ? "Pause preview" : "Play preview"}
						onClick={play}
						{...stylex.props(
							styles.playButton,
							transport() === "playing" && styles.playing
						)}
					>
						{transport() === "playing" ? "Ⅱ" : "▶"}
					</button>
					<span {...stylex.props(styles.timecode)}>{formatTime(playheadMs())}</span>
					<span {...stylex.props(styles.duration)}>
						{" "}
						/ {formatTime(document().durationMs)}
					</span>
				</div>
				<button
					disabled={props.client === undefined || liveRunState() === "executing"}
					onClick={runLive}
					{...stylex.props(styles.liveRunButton)}
				>
					{liveRunState() === "executing" ? "RUNNING…" : "RUN IN UNREAL"}
				</button>
				<div {...stylex.props(styles.runtimeStatus)}>
					<span {...stylex.props(styles.offlineDot)} />
					<div>
						<strong>
							{liveRunState() === "completed"
								? activeRun().status === "completed_with_divergence"
									? "DIVERGENCE"
									: activeRun().status === "cancelled"
										? "CANCELLED"
										: activeRun().status === "failed"
											? "RUN FAILED"
											: "LIVE RESULT"
								: liveRunState() === "executing"
									? "STARTING / ISOLATING"
									: liveRunState() === "unavailable"
										? "RUN FAILED"
										: "PREVIEW ONLY"}
						</strong>
						<small>
							{liveRunState() === "unavailable"
								? liveRunFailure()
								: props.client === undefined
									? "Unreal client not provided"
									: liveRunState() === "completed"
										? (activeRun().failure?.message ?? "Structured PIE result")
										: "Waiting for a structured PIE result"}
						</small>
					</div>
				</div>
			</header>

			<section {...stylex.props(styles.workspace)}>
				<aside aria-label="Scenario takes" {...stylex.props(styles.takeRail)}>
					<div {...stylex.props(styles.railHeading)}>
						<span>TAKES</span>
						<button aria-label="Add take" {...stylex.props(styles.addButton)}>
							+
						</button>
					</div>
					<div {...stylex.props(styles.takeList)}>
						<For each={movementGymRuns}>
							{(run, index) => (
								<button
									onClick={() => setActiveRun(run)}
									{...stylex.props(
										styles.take,
										activeRun().id === run.id && styles.takeActive
									)}
								>
									<span {...stylex.props(styles.takeNumber)}>0{3 - index()}</span>
									<span {...stylex.props(styles.takeCopy)}>
										<strong>{run.label.split(" · ")[1]}</strong>
										<small>{formatTime(run.durationMs)}</small>
									</span>
									<span
										{...stylex.props(
											styles.runState,
											run.divergences.length > 0 && styles.runStateWarning
										)}
									>
										{run.divergences.length > 0
											? `${run.divergences.length} changed`
											: "CLEAN"}
									</span>
								</button>
							)}
						</For>
						<button {...stylex.props(styles.take, styles.draftTake)}>
							<span {...stylex.props(styles.takeNumber)}>04</span>
							<span {...stylex.props(styles.takeCopy)}>
								<strong>Edited draft</strong>
								<small>not run</small>
							</span>
							<span {...stylex.props(styles.runState)}>DIRTY</span>
						</button>
					</div>

					<div {...stylex.props(styles.documentFacts)}>
						<div {...stylex.props(styles.fact)}>
							<span>MAP</span>
							<strong>L_MovementGym</strong>
						</div>
						<div {...stylex.props(styles.fact)}>
							<span>TIME</span>
							<strong>Game time</strong>
						</div>
						<div {...stylex.props(styles.fact)}>
							<span>SEED</span>
							<strong>{document().seed}</strong>
						</div>
						<div {...stylex.props(styles.isolationFact)}>
							<span {...stylex.props(styles.lockMark)}>◆</span>
							<div>
								<strong>
									{liveRunState() === "completed" &&
									activeRun().inputIsolation?.established &&
									activeRun().inputIsolation?.restored
										? "ISOLATION VERIFIED"
										: liveRunState() === "executing"
											? "ISOLATION REQUIRED"
											: "LIVE INPUT NOT BLOCKED"}
								</strong>
								<small>
									{liveRunState() === "completed" &&
									activeRun().inputIsolation?.restored
										? "Slate blocker was restored"
										: "Runs start only after Slate verification"}
								</small>
							</div>
						</div>
					</div>
				</aside>

				<section aria-label="Scenario timeline" {...stylex.props(styles.timelinePanel)}>
					<header {...stylex.props(styles.timelineHeader)}>
						<div>
							<span {...stylex.props(styles.sectionKicker)}>SCENARIO TIMELINE</span>
							<p>{document().description}</p>
						</div>
						<div {...stylex.props(styles.timelineTools)}>
							<button
								aria-label="Zoom timeline out"
								onClick={() =>
									setTimelineScale((scale) => Math.max(0.8, scale - 0.1))
								}
							>
								−
							</button>
							<span>{Math.round(timelineScale() * 100)}%</span>
							<button
								aria-label="Zoom timeline in"
								onClick={() =>
									setTimelineScale((scale) => Math.min(1.5, scale + 0.1))
								}
							>
								+
							</button>
						</div>
					</header>

					<div {...stylex.props(styles.timelineScroller)}>
						<div style={{ width: `${timelineScale() * 100}%`, "min-width": "900px" }}>
							<div {...stylex.props(styles.rulerRow)}>
								<div {...stylex.props(styles.rulerLabel)}>GAME TIME</div>
								<div {...stylex.props(styles.ruler)}>
									<For each={TIME_TICKS}>
										{(tick) => (
											<span
												style={{
													left: `${(tick / document().durationMs) * 100}%`
												}}
												{...stylex.props(styles.tick)}
											>
												{(tick / 1000).toFixed(0)}s
											</span>
										)}
									</For>
									<For each={document().checkpoints}>
										{(checkpoint) => (
											<span
												title={`Checkpoint: ${checkpoint.label}`}
												style={{
													left: `${(checkpoint.atMs / document().durationMs) * 100}%`
												}}
												{...stylex.props(styles.checkpoint)}
											>
												◆
											</span>
										)}
									</For>
								</div>
							</div>

							<div {...stylex.props(styles.trackStack)}>
								<For each={document().tracks}>
									{(track) => (
										<div {...stylex.props(styles.trackRow)}>
											<div {...stylex.props(styles.trackLabel)}>
												<span {...stylex.props(styles.trackKind)}>
													{trackKindLabel(track)}
												</span>
												<strong>{track.label}</strong>
												<small>{trackCaption(track)}</small>
											</div>
											<div
												onClick={seekFromPointer}
												{...stylex.props(styles.trackBody)}
											>
												<div {...stylex.props(styles.gridLines)} />
												<For each={track.clips}>
													{(clip) => (
														<button
															aria-label={`${clip.label} at ${formatTime(clip.startMs)}`}
															onClick={(event) => {
																event.stopPropagation();
																selectClip(
																	findScenarioClip(
																		document(),
																		clip.id
																	) ?? clip
																);
															}}
															onPointerDown={(event) =>
																beginDrag(event, clip)
															}
															onPointerMove={moveDrag}
															onPointerUp={finishDrag}
															onPointerCancel={finishDrag}
															style={{
																left: clipLeft(
																	clip,
																	document().durationMs
																),
																width: clipWidth(
																	clip,
																	document().durationMs
																)
															}}
															{...stylex.props(
																styles.clip,
																styles[clip.kind],
																selectedId() === clip.id &&
																	styles.clipSelected
															)}
														>
															<span>{clip.label}</span>
															<small>{clipDetail(clip)}</small>
															<Show
																when={
																	clip.kind ===
																		"semantic_action" &&
																	clip.keyframes.length > 2
																}
															>
																<i {...stylex.props(styles.curve)}>
																	⌁
																</i>
															</Show>
														</button>
													)}
												</For>
												<span
													style={{
														left: `${(playheadMs() / document().durationMs) * 100}%`
													}}
													{...stylex.props(styles.playhead)}
												/>
											</div>
										</div>
									)}
								</For>
							</div>
						</div>
					</div>

					<footer {...stylex.props(styles.seekReadout)}>
						<span {...stylex.props(styles.seekIcon)}>↳</span>
						<Switch>
							<Match when={restorePlan()} keyed>
								{(plan) => (
									<>
										<strong>Saved point</strong>
										<span>Start at {plan.checkpoint.label}</span>
									</>
								)}
							</Match>
							<Match when={replayPlan()} keyed>
								{(plan) => (
									<>
										<strong>Jump to time</strong>
										<span>
											Start at {plan.checkpoint.label}, then play forward{" "}
											{formatTime(plan.replayDurationMs)}
										</span>
										<Show when={plan.crossesNonSeekable}>
											<em>includes the jump</em>
										</Show>
									</>
								)}
							</Match>
							<Match when={unavailablePlan()} keyed>
								{(plan) => (
									<>
										<strong>Can't jump here</strong>
										<span>{plan.reason}</span>
									</>
								)}
							</Match>
						</Switch>
					</footer>
				</section>

				<aside aria-label="Clip inspector" {...stylex.props(styles.inspector)}>
					<Show when={selectedClip()} keyed>
						{(clip) => (
							<>
								<header {...stylex.props(styles.inspectorHeader)}>
									<span {...stylex.props(styles.sectionKicker)}>SELECTION</span>
									<span {...stylex.props(styles.clipType)}>
										{clipKindLabel(clip)}
									</span>
									<h2>{clip.label}</h2>
									<code>{operationName(clip)}</code>
								</header>

								<section {...stylex.props(styles.inspectorSection)}>
									<h3>TIMING</h3>
									<div {...stylex.props(styles.timingControl)}>
										<button
											aria-label="Nudge earlier"
											onClick={() => moveSelected(-100)}
										>
											−
										</button>
										<strong>{formatTime(clipStart(clip))}</strong>
										<button
											aria-label="Nudge later"
											onClick={() => moveSelected(100)}
										>
											+
										</button>
									</div>
									<small>100 ms nudge · drag the block for coarse timing</small>
								</section>

								<section {...stylex.props(styles.inspectorSection)}>
									<h3>INPUT HANDLING</h3>
									<div {...stylex.props(styles.layerFlow)}>
										<span>{sourceLayer(clip)}</span>
										<b>→</b>
										<span>
											{clip.kind === "semantic_action"
												? "replayed action"
												: "check only"}
										</span>
									</div>
									<p>
										This action is replayed directly. Input settings won't run
										twice.
									</p>
								</section>

								<Show
									when={clip.kind === "semantic_action" ? clip : undefined}
									keyed
								>
									{(action) => (
										<section {...stylex.props(styles.inspectorSection)}>
											<h3>INPUT VALUES</h3>
											<div {...stylex.props(styles.keyframeList)}>
												<For each={action.keyframes}>
													{(keyframe) => (
														<div {...stylex.props(styles.keyframe)}>
															<span>
																{formatTime(keyframe.offsetMs)}
															</span>
															<code>
																{typeof keyframe.value === "object"
																	? `${keyframe.value.x.toFixed(2)}, ${keyframe.value.y.toFixed(2)}`
																	: String(keyframe.value)}
															</code>
														</div>
													)}
												</For>
											</div>
											<p>{action.note}</p>
										</section>
									)}
								</Show>
							</>
						)}
					</Show>
				</aside>
			</section>

			<section aria-label="Run results" {...stylex.props(styles.evidenceDesk)}>
				<div {...stylex.props(styles.evidenceHeading)}>
					<span {...stylex.props(styles.sectionKicker)}>RUN RESULTS</span>
					<h2>At {formatTime(playheadMs())}</h2>
					<p>Screenshots and game checks from this run.</p>
				</div>
				<div {...stylex.props(styles.frameCard)}>
					<div {...stylex.props(styles.frame)}>
						<div {...stylex.props(styles.frameHorizon)} />
						<div {...stylex.props(styles.frameBridge)} />
						<div {...stylex.props(styles.framePawn)}>↑</div>
						<span {...stylex.props(styles.frameBadge)}>CAPTURED · PLAYER CAMERA</span>
						<span {...stylex.props(styles.frameTime)}>
							{formatTime(
								selectedEvidence()?.atMs ?? evidenceAtPlayhead()?.atMs ?? 3490
							)}
						</span>
					</div>
					<div {...stylex.props(styles.frameCaption)}>
						<strong>
							{selectedEvidence()?.label ??
								evidenceAtPlayhead()?.label ??
								"Closest capture"}
						</strong>
						<p>
							{selectedEvidence()?.summary ??
								evidenceAtPlayhead()?.summary ??
								"Nothing was saved at this point."}
						</p>
					</div>
				</div>
				<div {...stylex.props(styles.observationList)}>
					<header>
						<span>CAPTURES</span>
						<small>{activeRun().evidence.length} saved</small>
					</header>
					<For each={activeRun().evidence}>
						{(evidence) => (
							<button
								onClick={() => {
									setSelectedId(evidence.markerId);
									setPlayheadMs(evidence.atMs);
								}}
								{...stylex.props(styles.observation)}
							>
								<span {...stylex.props(styles.observationType)}>
									{evidence.type.slice(0, 3)}
								</span>
								<div>
									<strong>{evidence.label}</strong>
									<small>{evidence.summary}</small>
								</div>
								<time>{formatTime(evidence.atMs)}</time>
							</button>
						)}
					</For>
				</div>
				<div {...stylex.props(styles.divergenceLedger)}>
					<header>
						<span>DIFFERENCES</span>
						<small>{activeRun().divergences.length} found</small>
					</header>
					<Show
						when={activeRun().divergences.length > 0}
						fallback={
							<p {...stylex.props(styles.cleanRun)}>
								No differences found in this take.
							</p>
						}
					>
						<For each={activeRun().divergences}>
							{(divergence) => (
								<button
									onClick={() => setPlayheadMs(divergence.atMs)}
									{...stylex.props(styles.divergence)}
								>
									<span {...stylex.props(styles.delta)}>Δ</span>
									<div>
										<strong>{divergence.observed}</strong>
										<small>{divergence.explanation}</small>
									</div>
									<time>{formatTime(divergence.atMs)}</time>
								</button>
							)}
						</For>
					</Show>
				</div>
			</section>

			<footer {...stylex.props(styles.statusBar)}>
				<span>SCHEMA v{document().schemaVersion}</span>
				<span>{clipsInScenario(document()).length} timeline items</span>
				<span>{document().checkpoints.length} saved restart points</span>
				<code>{document().mapPath}</code>
			</footer>
		</main>
	);
}

const styles = stylex.create({
	route: {
		minHeight: "calc(100vh - 52px)",
		backgroundColor: "#0a0c0c",
		backgroundImage:
			"radial-gradient(circle at 54% -10%, #b7e26d0b, transparent 32%), linear-gradient(90deg, #ffffff04 1px, transparent 1px)",
		backgroundSize: "auto, 64px 100%",
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	commandBar: {
		height: 70,
		display: "grid",
		gridTemplateColumns: "minmax(320px, 1fr) auto minmax(270px, 1fr)",
		alignItems: "center",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#0e1110e8",
		backdropFilter: "blur(16px)",
		position: "sticky",
		top: 52,
		zIndex: 15
	},
	documentIdentity: { display: "flex", alignItems: "center", gap: 14, paddingLeft: 20 },
	scenarioGlyph: {
		display: "grid",
		placeItems: "center",
		width: 38,
		height: 38,
		backgroundColor: "#b7e26d",
		color: "#10140d",
		fontSize: 9,
		fontWeight: 900,
		letterSpacing: ".08em",
		clipPath: "polygon(0 0, 82% 0, 100% 18%, 100% 100%, 0 100%)"
	},
	breadcrumb: { color: "#667069", fontSize: 8, letterSpacing: ".13em" },
	title: {
		margin: "4px 0 0",
		fontFamily: tokens.fontDisplay,
		fontSize: 20,
		fontWeight: 400,
		letterSpacing: "-.01em"
	},
	transport: { display: "flex", alignItems: "center" },
	iconButton: {
		width: 34,
		height: 34,
		border: "1px solid #343b36",
		backgroundColor: "#151917",
		color: "#8b958e",
		cursor: "pointer"
	},
	playButton: {
		width: 42,
		height: 42,
		marginLeft: 7,
		border: 0,
		borderRadius: "50%",
		backgroundColor: { default: "#b7e26d", ":hover": "#c8f480" },
		boxShadow: "0 0 22px #b7e26d22",
		color: "#0d120b",
		cursor: "pointer",
		fontSize: 13
	},
	liveRunButton: {
		border: "1px solid #5c8d79",
		backgroundColor: "#18352b",
		color: "#bde7d5",
		fontFamily: tokens.fontBody,
		fontSize: 10,
		fontWeight: 700,
		letterSpacing: "0.08em",
		padding: "9px 12px",
		cursor: "pointer",
		":disabled": { cursor: "default", opacity: 0.45 }
	},
	playing: { backgroundColor: "#e7d77d" },
	timecode: { marginLeft: 14, color: "#f1f3ee", fontSize: 14, fontWeight: 700 },
	duration: { color: "#59625c", fontSize: 10 },
	runtimeStatus: {
		display: "flex",
		alignItems: "center",
		justifySelf: "end",
		gap: 10,
		paddingRight: 22,
		color: "#aab1ac"
	},
	offlineDot: { width: 7, height: 7, borderRadius: "50%", backgroundColor: "#d7894a" },
	runtimeStatusStrong: {},
	workspace: {
		display: "grid",
		gridTemplateColumns: "196px minmax(680px, 1fr) 268px",
		minHeight: 530,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	takeRail: { borderRight: `1px solid ${tokens.colorBorder}`, backgroundColor: "#0c0f0e" },
	railHeading: {
		height: 48,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "0 14px 0 16px",
		borderBottom: "1px solid #252a27",
		color: "#747e77",
		fontSize: 8,
		letterSpacing: ".14em"
	},
	addButton: {
		width: 23,
		height: 23,
		border: "1px solid #353b37",
		backgroundColor: "transparent",
		color: "#859087",
		cursor: "pointer"
	},
	takeList: { display: "flex", flexDirection: "column" },
	take: {
		display: "grid",
		gridTemplateColumns: "30px 1fr auto",
		alignItems: "center",
		gap: 9,
		minHeight: 58,
		padding: "8px 12px",
		border: 0,
		borderBottom: "1px solid #242925",
		borderLeft: "2px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "#151a17" },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left"
	},
	takeActive: { borderLeftColor: "#b7e26d", backgroundColor: "#171c18" },
	draftTake: { borderLeftColor: "#56644f", backgroundColor: "#101511" },
	takeNumber: { color: "#657069", fontFamily: tokens.fontDisplay, fontSize: 16 },
	takeCopy: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
	runState: { color: "#71816f", fontSize: 7, letterSpacing: ".08em" },
	runStateWarning: { color: "#d6a363" },
	documentFacts: { marginTop: 28, padding: "0 16px" },
	fact: {
		display: "flex",
		justifyContent: "space-between",
		padding: "8px 0",
		borderTop: "1px solid #222724"
	},
	isolationFact: {
		display: "flex",
		alignItems: "center",
		gap: 9,
		marginTop: 16,
		padding: "10px",
		border: "1px solid #33422e",
		backgroundColor: "#b7e26d08"
	},
	lockMark: { color: "#b7e26d", fontSize: 9 },
	timelinePanel: { minWidth: 0, backgroundColor: "#0e1110" },
	timelineHeader: {
		height: 74,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "0 18px",
		borderBottom: "1px solid #29302b"
	},
	sectionKicker: { color: "#7a847d", fontSize: 8, letterSpacing: ".15em" },
	timelineTools: { display: "flex", alignItems: "center", gap: 9, color: "#7d877f", fontSize: 8 },
	timelineScroller: { overflowX: "auto", scrollbarColor: "#3b443e #121614" },
	rulerRow: { display: "grid", gridTemplateColumns: "190px 1fr", height: 38 },
	rulerLabel: {
		display: "flex",
		alignItems: "center",
		paddingLeft: 16,
		borderRight: "1px solid #29302b",
		borderBottom: "1px solid #29302b",
		color: "#59635c",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	ruler: { position: "relative", borderBottom: "1px solid #29302b" },
	tick: {
		position: "absolute",
		top: 0,
		height: 38,
		padding: "9px 0 0 6px",
		borderLeft: "1px solid #303632",
		color: "#667069",
		fontSize: 8
	},
	checkpoint: {
		position: "absolute",
		bottom: 1,
		color: "#8fae62",
		fontSize: 8,
		transform: "translateX(-50%)"
	},
	trackStack: { display: "flex", flexDirection: "column" },
	trackRow: { display: "grid", gridTemplateColumns: "190px 1fr", minHeight: 72 },
	trackLabel: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 4,
		padding: "9px 16px",
		borderRight: "1px solid #29302b",
		borderBottom: "1px solid #252b27",
		backgroundColor: "#0c0f0e"
	},
	trackKind: {
		color: "#576159",
		fontSize: 7,
		letterSpacing: ".13em",
		textTransform: "uppercase"
	},
	trackBody: {
		position: "relative",
		minHeight: 72,
		borderBottom: "1px solid #252b27",
		overflow: "hidden",
		cursor: "crosshair"
	},
	gridLines: {
		position: "absolute",
		inset: 0,
		backgroundImage:
			"repeating-linear-gradient(90deg, transparent 0, transparent calc(10% - 1px), #ffffff08 calc(10% - 1px), #ffffff08 10%)"
	},
	clip: {
		position: "absolute",
		top: 11,
		height: 49,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 4,
		minWidth: 9,
		overflow: "hidden",
		padding: "7px 9px",
		borderStyle: "solid",
		borderWidth: 1,
		color: "#e5e9e3",
		cursor: "grab",
		textAlign: "left",
		transition: "filter 100ms, box-shadow 100ms"
	},
	semantic_action: { borderColor: "#76994f", backgroundColor: "#24311d" },
	raw_input: {
		top: 16,
		height: 39,
		borderColor: "#456f79",
		backgroundColor: "#17282c",
		opacity: 0.78
	},
	world_condition: { borderColor: "#b18751", backgroundColor: "#352a1c" },
	intervention: { borderColor: "#a05c4d", backgroundColor: "#34201d" },
	evidence: {
		top: 17,
		height: 38,
		minWidth: 18,
		padding: "5px 7px",
		borderColor: "#9183bc",
		backgroundColor: "#29243a"
	},
	clipSelected: {
		filter: "brightness(1.32)",
		boxShadow: "0 0 0 1px #e6ede0, 0 0 18px #b7e26d18",
		zIndex: 3
	},
	curve: { position: "absolute", right: 7, bottom: 2, color: "#a8cc78", fontSize: 16 },
	playhead: {
		position: "absolute",
		top: 0,
		bottom: 0,
		width: 1,
		backgroundColor: "#e76b49",
		boxShadow: "0 0 8px #e76b4988",
		pointerEvents: "none",
		zIndex: 7
	},
	seekReadout: {
		height: 45,
		display: "flex",
		alignItems: "center",
		gap: 11,
		padding: "0 16px",
		borderTop: "1px solid #2b312d",
		backgroundColor: "#111512",
		color: "#79837b",
		fontSize: 9
	},
	seekIcon: { color: "#b7e26d", fontSize: 14 },
	inspector: { borderLeft: `1px solid ${tokens.colorBorder}`, backgroundColor: "#0c0f0e" },
	inspectorHeader: { padding: "18px", borderBottom: "1px solid #282e2a" },
	clipType: {
		float: "right",
		color: "#71806f",
		fontSize: 7,
		letterSpacing: ".11em",
		textTransform: "uppercase"
	},
	inspectorSection: { padding: "15px 18px", borderBottom: "1px solid #282e2a" },
	timingControl: {
		display: "grid",
		gridTemplateColumns: "34px 1fr 34px",
		alignItems: "center",
		margin: "11px 0 7px"
	},
	layerFlow: {
		display: "grid",
		gridTemplateColumns: "1fr auto 1fr",
		alignItems: "center",
		gap: 8,
		margin: "11px 0"
	},
	keyframeList: { display: "flex", flexDirection: "column", marginTop: 9 },
	keyframe: {
		display: "flex",
		justifyContent: "space-between",
		padding: "6px 0",
		borderTop: "1px solid #252b27",
		color: "#7e8981",
		fontSize: 8
	},
	evidenceDesk: {
		display: "grid",
		gridTemplateColumns: "196px minmax(300px, .8fr) minmax(310px, 1fr) minmax(310px, 1fr)",
		minHeight: 236,
		backgroundColor: "#0b0e0d"
	},
	evidenceHeading: { padding: "20px 16px", borderRight: "1px solid #303632" },
	frameCard: { padding: 14, borderRight: "1px solid #303632" },
	frame: {
		position: "relative",
		height: 130,
		overflow: "hidden",
		border: "1px solid #46504a",
		backgroundColor: "#161d1a",
		backgroundImage: "linear-gradient(172deg, #2b493a 0 42%, #18221d 42% 56%, #4b3d2b 56%)"
	},
	frameHorizon: {
		position: "absolute",
		left: 0,
		right: 0,
		top: "43%",
		height: 1,
		backgroundColor: "#dce7b038"
	},
	frameBridge: {
		position: "absolute",
		left: "9%",
		right: "7%",
		bottom: "18%",
		height: "25%",
		backgroundColor: "#635642",
		clipPath:
			"polygon(0 55%, 38% 48%, 45% 100%, 54% 100%, 61% 47%, 100% 20%, 100% 100%, 0 100%)"
	},
	framePawn: {
		position: "absolute",
		left: "46%",
		top: "34%",
		color: "#dce8cc",
		textShadow: "0 0 7px #000",
		fontSize: 20
	},
	frameBadge: {
		position: "absolute",
		left: 8,
		top: 8,
		padding: "3px 5px",
		backgroundColor: "#0b0e0dc9",
		color: "#b7e26d",
		fontSize: 6,
		letterSpacing: ".08em"
	},
	frameTime: { position: "absolute", right: 8, bottom: 7, color: "#e7ebe4", fontSize: 8 },
	frameCaption: { marginTop: 9 },
	observationList: { borderRight: "1px solid #303632" },
	observation: {
		display: "grid",
		gridTemplateColumns: "30px 1fr auto",
		gap: 9,
		width: "100%",
		padding: "10px 14px",
		border: 0,
		borderTop: "1px solid #252b27",
		backgroundColor: { default: "transparent", ":hover": "#161a17" },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left"
	},
	observationType: {
		display: "grid",
		placeItems: "center",
		width: 27,
		height: 24,
		border: "1px solid #766b9a",
		color: "#b8abe3",
		fontSize: 7,
		textTransform: "uppercase"
	},
	divergenceLedger: {},
	divergence: {
		display: "grid",
		gridTemplateColumns: "24px 1fr auto",
		gap: 9,
		width: "100%",
		padding: "10px 14px",
		border: 0,
		borderTop: "1px solid #252b27",
		backgroundColor: { default: "transparent", ":hover": "#191713" },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left"
	},
	delta: { color: "#d6a363", fontFamily: tokens.fontDisplay, fontSize: 18 },
	cleanRun: { padding: 16, color: "#728077", fontSize: 9 },
	statusBar: {
		height: 31,
		display: "flex",
		alignItems: "center",
		gap: 24,
		padding: "0 16px",
		borderTop: "1px solid #303632",
		color: "#59635c",
		fontSize: 7,
		letterSpacing: ".09em"
	}
});
