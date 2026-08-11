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
	type ScenarioRunHandle,
	type ScenarioSeekPlan,
	type ScenarioRunnerStatus,
	type ScenarioTrack
} from "@ue-shed/scenarios";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Option, Schedule } from "effect";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import type { ScenarioStudioClient } from "./client.js";

type TransportState = "paused" | "playing" | "recording";
type LiveRunState =
	| { readonly status: "preview" }
	| { readonly status: "connecting" }
	| {
			readonly status: "active";
			readonly handle: ScenarioRunHandle;
			readonly producerState: Extract<
				ScenarioRunnerStatus,
				{ readonly _tag: "Active" }
			>["state"];
			readonly gameTimeMs: number;
	  }
	| {
			readonly status: "cancelling";
			readonly handle: ScenarioRunHandle;
			readonly gameTimeMs: number;
	  }
	| { readonly status: "terminal"; readonly run: ScenarioRun }
	| { readonly status: "unavailable"; readonly message: string };

export interface ScenarioStudioRouteProps {
	readonly client?: ScenarioStudioClient;
	readonly showDemoGuide?: boolean;
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
const DEMO_STEPS = [
	{
		copy: "Green lanes run; gray lanes stay preview-only.",
		label: "AUTHOR",
		title: "Inspect the intent"
	},
	{
		copy: "Start UE 5.7 PIE through the public runner.",
		label: "EXECUTE",
		title: "Run Movement Gym"
	},
	{
		copy: "Isolation · game time · landing wait · cache probe.",
		label: "VERIFY",
		title: "Follow live proof"
	},
	{
		copy: "Read the receipt; repeat the same run from the CLI.",
		label: "HEADLESS",
		title: "Prove portability"
	}
] as const;

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

function trackLiveSupport(track: ScenarioTrack): "LIVE SLICE" | "PREVIEW ONLY" {
	return track.kind === "semantic_actions" || track.kind === "world_conditions"
		? "LIVE SLICE"
		: "PREVIEW ONLY";
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
			return "pre-evaluation value";
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
	const settingsAction = createEffectAction();
	const liveRunAction = createEffectAction();
	const cancelRunAction = createEffectAction();
	const liveStatusSubscription = createEffectSubscription();
	const [document, setDocument] = createSignal<ScenarioDocument>(movementGymScenario);
	const [activeRun, setActiveRun] = createSignal<ScenarioRun>(firstMovementGymRun());
	const [selectedId, setSelectedId] = createSignal<ScenarioElementId>(
		makeScenarioElementId("action_jump")
	);
	const [playheadMs, setPlayheadMs] = createSignal(3370);
	const [transport, setTransport] = createSignal<TransportState>("paused");
	const [liveRunState, setLiveRunState] = createSignal<LiveRunState>({ status: "preview" });
	const [demoGuideOpen, setDemoGuideOpen] = createSignal(props.showDemoGuide ?? false);
	const [endpoint, setEndpoint] = createSignal("");
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
	const presentedEvidence = createMemo(() => selectedEvidence() ?? evidenceAtPlayhead());
	const liveBusy = createMemo(() =>
		["connecting", "active", "cancelling"].includes(liveRunState().status)
	);
	const liveGameTimeMs = createMemo(() => {
		const state = liveRunState();
		return state.status === "active" || state.status === "cancelling"
			? state.gameTimeMs
			: undefined;
	});
	const liveProducerState = createMemo(() => {
		const state = liveRunState();
		return state.status === "active" ? state.producerState : undefined;
	});
	const liveFailureMessage = createMemo(() => {
		const state = liveRunState();
		return state.status === "unavailable" ? state.message : undefined;
	});
	const demoStepIndex = createMemo(() => {
		const state = liveRunState();
		if (state.status === "terminal") return 3;
		if (state.status === "active" || state.status === "cancelling") return 2;
		if (state.status === "connecting" || state.status === "unavailable") return 1;
		return 0;
	});
	const headlessCommand = createMemo(
		() => `pnpm ue-shed scenarios run ${endpoint().trim() || "<remote-control-endpoint>"}`
	);
	const formatClientFailure = (cause: Cause.Cause<unknown>): string => {
		const error = Cause.findErrorOption(cause);
		if (Option.isSome(error) && typeof error.value === "object" && error.value !== null) {
			const value = error.value as {
				readonly message?: unknown;
				readonly recovery?: unknown;
			};
			if (typeof value.message === "string") {
				return `${value.message}${typeof value.recovery === "string" ? ` ${value.recovery}` : ""}`;
			}
		}
		return Cause.pretty(cause);
	};
	const acceptTerminalRun = (run: ScenarioRun) => {
		setActiveRun(run);
		setPlayheadMs(run.durationMs);
		setLiveRunState({ run, status: "terminal" });
	};

	onMount(() => {
		if (props.client === undefined) return;
		settingsAction.run(props.client.settings(), {
			onFailure: (cause) =>
				setLiveRunState({ message: formatClientFailure(cause), status: "unavailable" }),
			onSuccess: (settings) => setEndpoint(settings.endpoint)
		});
	});

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
		if (props.client === undefined || liveBusy() || endpoint().trim() === "") return;
		stopPlayback();
		setLiveRunState({ status: "connecting" });
		liveRunAction.run(
			props.client.start({ document: document(), endpoint: endpoint().trim() }),
			{
				onFailure: (cause) => {
					setLiveRunState({ message: formatClientFailure(cause), status: "unavailable" });
				},
				onSuccess: (handle) => {
					setLiveRunState({
						gameTimeMs: 0,
						handle,
						producerState: "accepted",
						status: "active"
					});
					liveStatusSubscription.subscribe(props.client!.watch(handle), {
						onFailure: (cause) =>
							setLiveRunState({
								message: formatClientFailure(cause),
								status: "unavailable"
							}),
						onValue: (value) => {
							if (value._tag === "Terminal") {
								acceptTerminalRun(value.result);
								return;
							}
							setLiveRunState({
								gameTimeMs: value.gameTimeMs,
								handle,
								producerState: value.state,
								status: "active"
							});
						}
					});
				}
			}
		);
	};
	const cancelLive = () => {
		const state = liveRunState();
		if (props.client === undefined || state.status !== "active") return;
		liveStatusSubscription.cancel();
		setLiveRunState({
			gameTimeMs: state.gameTimeMs,
			handle: state.handle,
			status: "cancelling"
		});
		cancelRunAction.run(props.client.cancel(state.handle), {
			onFailure: (cause) =>
				setLiveRunState({ message: formatClientFailure(cause), status: "unavailable" }),
			onSuccess: acceptTerminalRun
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
				<div {...stylex.props(styles.runtimeStatus)}>
					<button
						aria-expanded={demoGuideOpen()}
						onClick={() => setDemoGuideOpen((open) => !open)}
						{...stylex.props(
							styles.demoGuideToggle,
							demoGuideOpen() && styles.demoGuideToggleActive
						)}
					>
						DEMO GUIDE
					</button>
					<span
						{...stylex.props(
							styles.offlineDot,
							liveBusy() && styles.liveDot,
							liveRunState().status === "terminal" && styles.terminalDot
						)}
					/>
					<div>
						<strong>
							{liveRunState().status === "terminal"
								? activeRun().status === "completed_with_divergence"
									? "DIVERGENCE"
									: activeRun().status === "cancelled"
										? "CANCELLED"
										: activeRun().status === "failed"
											? "RUN FAILED"
											: "LIVE RESULT"
								: liveRunState().status === "connecting"
									? "NEGOTIATING / PREPARING PIE"
									: liveRunState().status === "active"
										? liveProducerState()?.toUpperCase()
										: liveRunState().status === "cancelling"
											? "CANCELLING"
											: liveRunState().status === "unavailable"
												? "RUN FAILED"
												: "PREVIEW ONLY"}
						</strong>
						<small>
							{liveRunState().status === "unavailable"
								? liveFailureMessage()
								: props.client === undefined
									? "Unreal client not provided"
									: liveRunState().status === "terminal"
										? (activeRun().failure?.message ?? "Structured PIE result")
										: liveGameTimeMs() === undefined
											? "Ready for a structured PIE result"
											: `${formatTime(liveGameTimeMs()!)} game time`}
						</small>
					</div>
				</div>
			</header>

			<section aria-label="Live execution controls" {...stylex.props(styles.runConsole)}>
				<label {...stylex.props(styles.endpointField)}>
					<span>REMOTE CONTROL ENDPOINT</span>
					<input
						aria-label="Remote Control endpoint"
						disabled={liveBusy()}
						onInput={(event) => setEndpoint(event.currentTarget.value)}
						placeholder="http://127.0.0.1:30010"
						spellcheck={false}
						value={endpoint()}
						{...stylex.props(styles.endpointInput)}
					/>
				</label>
				<div aria-label="Live run lifecycle" {...stylex.props(styles.lifecycle)}>
					<For each={["CONNECT", "ISOLATE", "RUN", "WAIT", "RESULT"]}>
						{(phase) => (
							<span
								{...stylex.props(
									styles.lifecyclePhase,
									((phase === "CONNECT" &&
										liveRunState().status === "connecting") ||
										(phase === "ISOLATE" &&
											liveRunState().status === "active" &&
											["accepted", "isolating"].includes(
												liveProducerState() ?? "accepted"
											)) ||
										(phase === "RUN" &&
											((liveRunState().status === "active" &&
												liveProducerState() === "running") ||
												liveRunState().status === "cancelling")) ||
										(phase === "WAIT" &&
											liveRunState().status === "active" &&
											liveProducerState() === "waiting") ||
										(phase === "RESULT" &&
											liveRunState().status === "terminal")) &&
										styles.lifecycleCurrent
								)}
							>
								<i {...stylex.props(styles.phaseDot)} /> {phase}
							</span>
						)}
					</For>
				</div>
				<div {...stylex.props(styles.runActions)}>
					<Show when={liveRunState().status === "active"}>
						<button onClick={cancelLive} {...stylex.props(styles.cancelRunButton)}>
							CANCEL RUN
						</button>
					</Show>
					<button
						disabled={
							props.client === undefined || liveBusy() || endpoint().trim() === ""
						}
						onClick={runLive}
						{...stylex.props(styles.liveRunButton)}
					>
						{liveRunState().status === "connecting"
							? "STARTING…"
							: liveRunState().status === "cancelling"
								? "CANCELLING…"
								: liveRunState().status === "active"
									? "RUNNING"
									: "RUN IN UNREAL"}
					</button>
				</div>
			</section>

			<Show when={demoGuideOpen()}>
				<section aria-label="Movement Gym demo guide" {...stylex.props(styles.demoGuide)}>
					<header {...stylex.props(styles.demoGuideHeading)}>
						<span {...stylex.props(styles.sectionKicker)}>LIVE PROOF</span>
						<strong>MOVEMENT GYM</strong>
						<small>One portable scenario · two public clients</small>
					</header>
					<ol {...stylex.props(styles.demoSteps)}>
						<For each={DEMO_STEPS}>
							{(step, index) => (
								<li
									aria-current={index() === demoStepIndex() ? "step" : undefined}
									{...stylex.props(
										styles.demoStep,
										index() < demoStepIndex() && styles.demoStepComplete,
										index() === demoStepIndex() && styles.demoStepCurrent
									)}
								>
									<span {...stylex.props(styles.demoStepNumber)}>
										{String(index() + 1).padStart(2, "0")}
									</span>
									<div {...stylex.props(styles.demoStepBody)}>
										<small {...stylex.props(styles.demoStepLabel)}>
											{step.label}
										</small>
										<strong {...stylex.props(styles.demoStepTitle)}>
											{step.title}
										</strong>
										<p {...stylex.props(styles.demoStepCopy)}>{step.copy}</p>
									</div>
								</li>
							)}
						</For>
					</ol>
					<div {...stylex.props(styles.headlessHandoff)}>
						<span>SAME PUBLIC RUNNER</span>
						<code {...stylex.props(styles.headlessCommand)}>{headlessCommand()}</code>
					</div>
				</section>
			</Show>

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
									{liveRunState().status === "terminal" &&
									activeRun().inputIsolation?.established &&
									activeRun().inputIsolation?.restored
										? "ISOLATION VERIFIED"
										: liveRunState().status === "active" ||
											  liveRunState().status === "cancelling"
											? "ISOLATION ACTIVE"
											: liveRunState().status === "connecting"
												? "ISOLATION REQUIRED"
												: "LIVE INPUT NOT BLOCKED"}
								</strong>
								<small>
									{liveRunState().status === "terminal" &&
									activeRun().inputIsolation?.restored
										? "Slate blocker was restored"
										: liveRunState().status === "active" ||
											  liveRunState().status === "cancelling"
											? "Producer verified the Slate blocker"
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
												<div {...stylex.props(styles.trackMeta)}>
													<span {...stylex.props(styles.trackKind)}>
														{trackKindLabel(track)}
													</span>
													<span
														{...stylex.props(
															styles.trackSupport,
															trackLiveSupport(track) ===
																"LIVE SLICE" &&
																styles.trackSupportLive
														)}
													>
														{trackLiveSupport(track)}
													</span>
												</div>
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
												? "Enhanced Input evaluation"
												: "check only"}
										</span>
									</div>
									<p>
										{clip.kind === "semantic_action"
											? "UE receives the raw action value before modifiers and triggers; gameplay observes the evaluated action normally."
											: "This clip observes game state and does not inject input."}
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
					<p>Bounded captures and game checks from this run.</p>
					<Show when={liveRunState().status === "terminal"}>
						<div {...stylex.props(styles.runReceiptSummary)}>
							<span>{activeRun().status.replaceAll("_", " ")}</span>
							<strong>UE {activeRun().engineVersion}</strong>
							<small>
								{activeRun().inputIsolation?.restored
									? "INPUT RESTORED"
									: "RESTORE NOT PROVEN"}
							</small>
						</div>
					</Show>
				</div>
				<div {...stylex.props(styles.frameCard)}>
					<Show
						when={presentedEvidence()}
						fallback={
							<div {...stylex.props(styles.emptyEvidence)}>
								<span>NO PRODUCER EVIDENCE</span>
								<strong>Nothing was fabricated.</strong>
								<p>This run returned no capture at the selected point.</p>
							</div>
						}
						keyed
					>
						{(evidence) => (
							<Show
								when={evidence.type === "screenshot"}
								fallback={
									<div {...stylex.props(styles.structuredEvidence)}>
										<div {...stylex.props(styles.structuredEvidenceTopline)}>
											<span>{evidence.type.replaceAll("_", " ")}</span>
											<time>{formatTime(evidence.atMs)}</time>
										</div>
										<strong>{evidence.label}</strong>
										<p>{evidence.summary}</p>
										<small>{evidence.status} · bounded producer evidence</small>
									</div>
								}
							>
								<div {...stylex.props(styles.frame)}>
									<div {...stylex.props(styles.frameHorizon)} />
									<div {...stylex.props(styles.frameBridge)} />
									<div {...stylex.props(styles.framePawn)}>↑</div>
									<span {...stylex.props(styles.frameBadge)}>
										CAPTURED · PLAYER CAMERA
									</span>
									<span {...stylex.props(styles.frameTime)}>
										{formatTime(evidence.atMs)}
									</span>
								</div>
								<div {...stylex.props(styles.frameCaption)}>
									<strong>{evidence.label}</strong>
									<p>{evidence.summary}</p>
								</div>
							</Show>
						)}
					</Show>
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
		gridTemplateColumns: "minmax(320px, 1fr) auto minmax(300px, 1fr)",
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
		transition: "background-color 120ms, transform 80ms",
		":active": { transform: "scale(.97)" },
		":disabled": { cursor: "default", opacity: 0.45 }
	},
	cancelRunButton: {
		border: "1px solid #70483f",
		backgroundColor: { default: "#251714", ":hover": "#33201b" },
		color: "#e2a997",
		fontFamily: tokens.fontBody,
		fontSize: 9,
		fontWeight: 700,
		letterSpacing: ".08em",
		padding: "9px 11px",
		cursor: "pointer",
		transition: "background-color 120ms, transform 80ms",
		":active": { transform: "scale(.97)" }
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
	demoGuideToggle: {
		marginRight: 4,
		padding: "6px 8px",
		border: "1px solid #303833",
		backgroundColor: "transparent",
		color: "#6f7972",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 7,
		fontWeight: 700,
		letterSpacing: ".11em",
		transition: "transform 120ms cubic-bezier(.23, 1, .32, 1)",
		":active": { transform: "scale(.97)" }
	},
	demoGuideToggleActive: {
		borderColor: "#6d8b50",
		backgroundColor: "#182017",
		color: "#c9ef91"
	},
	offlineDot: { width: 7, height: 7, borderRadius: "50%", backgroundColor: "#d7894a" },
	liveDot: { backgroundColor: "#b7e26d", boxShadow: "0 0 10px #b7e26d66" },
	terminalDot: { backgroundColor: "#7fc8aa" },
	runtimeStatusStrong: {},
	runConsole: {
		height: 58,
		display: "grid",
		gridTemplateColumns: "minmax(250px, 360px) minmax(360px, 1fr) auto",
		alignItems: "center",
		gap: 20,
		padding: "0 18px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#0b0e0d"
	},
	endpointField: {
		display: "grid",
		gridTemplateColumns: "auto 1fr",
		alignItems: "center",
		gap: 10,
		color: "#667069",
		fontSize: 7,
		letterSpacing: ".12em"
	},
	endpointInput: {
		width: "100%",
		minWidth: 0,
		padding: "7px 9px",
		border: "1px solid #303833",
		backgroundColor: "#111613",
		color: "#d5dcd6",
		fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
		fontSize: 9,
		outline: { default: "none", ":focus": "1px solid #71994d" },
		":disabled": { color: "#758078", opacity: 0.72 }
	},
	lifecycle: { display: "flex", alignItems: "center", justifyContent: "center", gap: 18 },
	lifecyclePhase: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		color: "#4f5852",
		fontSize: 7,
		letterSpacing: ".11em"
	},
	lifecycleCurrent: { color: "#c9ef91" },
	phaseDot: { width: 5, height: 5, borderRadius: "50%", backgroundColor: "currentColor" },
	runActions: { display: "flex", alignItems: "center", gap: 8 },
	demoGuide: {
		display: "grid",
		gridTemplateColumns: {
			default: "180px minmax(620px, 1fr) minmax(270px, 350px)",
			"@media (max-width: 1180px)": "150px minmax(600px, 1fr)"
		},
		minHeight: 88,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#0d110f"
	},
	demoGuideHeading: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 4,
		padding: "14px 18px",
		borderRight: "1px solid #29302b"
	},
	demoSteps: {
		display: "grid",
		gridTemplateColumns: "repeat(4, minmax(125px, 1fr))",
		margin: 0,
		padding: 0,
		listStyle: "none"
	},
	demoStep: {
		display: "grid",
		gridTemplateColumns: "26px 1fr",
		alignItems: "center",
		gap: 7,
		minWidth: 0,
		padding: "12px 10px",
		borderRight: "1px solid #242a26",
		color: "#59635c"
	},
	demoStepComplete: { color: "#788779" },
	demoStepCurrent: {
		backgroundColor: "#b7e26d0b",
		boxShadow: "inset 0 -2px #b7e26d",
		color: "#d9e6d3"
	},
	demoStepNumber: {
		alignSelf: "start",
		color: "#70805f",
		fontFamily: tokens.fontDisplay,
		fontSize: 17
	},
	demoStepBody: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
	demoStepLabel: { color: "currentColor", fontSize: 6, letterSpacing: ".1em" },
	demoStepTitle: { color: "currentColor", fontSize: 9, lineHeight: 1.2 },
	demoStepCopy: { margin: 0, color: "#69736c", fontSize: 7, lineHeight: 1.35 },
	headlessHandoff: {
		display: {
			default: "flex",
			"@media (max-width: 1180px)": "none"
		},
		flexDirection: "column",
		justifyContent: "center",
		gap: 7,
		minWidth: 0,
		padding: "12px 16px",
		backgroundColor: "#090c0a",
		color: "#68736b",
		fontSize: 7,
		letterSpacing: ".11em"
	},
	headlessCommand: {
		overflowWrap: "anywhere",
		color: "#b6c4b8",
		fontSize: 8,
		letterSpacing: 0,
		lineHeight: 1.45
	},
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
	trackMeta: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
	trackSupport: {
		padding: "2px 4px",
		border: "1px solid #303632",
		color: "#505a53",
		fontSize: 6,
		letterSpacing: ".08em"
	},
	trackSupportLive: {
		borderColor: "#506740",
		backgroundColor: "#b7e26d08",
		color: "#9fbd76"
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
	runReceiptSummary: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginTop: 14,
		padding: "9px 10px",
		border: "1px solid #40513a",
		backgroundColor: "#b7e26d08",
		color: "#9eaa9f",
		fontSize: 7,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	frameCard: { padding: 14, borderRight: "1px solid #303632" },
	structuredEvidence: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 10,
		height: 178,
		padding: "16px 18px",
		border: "1px solid #506a59",
		backgroundColor: "#111a16",
		boxShadow: "inset 3px 0 #7fc8aa"
	},
	structuredEvidenceTopline: {
		display: "flex",
		justifyContent: "space-between",
		color: "#7fc8aa",
		fontSize: 7,
		letterSpacing: ".11em",
		textTransform: "uppercase"
	},
	emptyEvidence: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 9,
		height: 178,
		padding: "16px 18px",
		border: "1px dashed #3b433e",
		backgroundColor: "#101311",
		color: "#778078"
	},
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
