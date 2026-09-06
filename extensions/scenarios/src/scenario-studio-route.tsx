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
	type ScenarioRunnerStatus,
	type ScenarioTrack
} from "@ue-shed/scenarios/browser";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Option, Schedule, Schema } from "effect";
import {
	For,
	Match,
	Show,
	Switch,
	batch,
	createMemo,
	createSignal,
	onCleanup,
	onMount
} from "solid-js";
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
		copy: "Green lanes run in Unreal; gray lanes stay preview-only.",
		label: "Author",
		title: "Read the scenario"
	},
	{
		copy: "Start UE 5.7 PIE through the public runner.",
		label: "Execute",
		title: "Run Movement Gym"
	},
	{
		copy: "Isolation, game time, the landing wait, and the cache probe.",
		label: "Verify",
		title: "Follow the live run"
	},
	{
		copy: "Read the result, then repeat the same run from the CLI.",
		label: "Headless",
		title: "Repeat it anywhere"
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

function trackLiveSupport(track: ScenarioTrack): "Runs live" | "Preview only" {
	return track.kind === "semantic_actions" || track.kind === "world_conditions"
		? "Runs live"
		: "Preview only";
}

function capitalize(value: string): string {
	return value.replace(/^./u, (character) => character.toLocaleUpperCase());
}

type FailureParts = {
	readonly summary: string;
	readonly technical: string | undefined;
};

// A producer failure carries either one sentence or a pretty-printed Cause. Show the first line and
// keep the rest behind a disclosure so a failed run never reads as a stack trace.
function failureParts(message: string): FailureParts {
	if (message.length <= 160 && !message.includes("\n")) {
		return { summary: message, technical: undefined };
	}
	const [firstLine] = message.split("\n");
	return { summary: (firstLine ?? message).slice(0, 160).trim(), technical: message };
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

export interface ScenarioStudioDraft {
	readonly document: ScenarioDocument;
	readonly savedPath: string | undefined;
	readonly savedJson: string | undefined;
}
export function ScenarioStudioRoute(
	props: ScenarioStudioRouteProps & {
		readonly initialDraft?: ScenarioStudioDraft | undefined;
		readonly onDraftChange?: (draft: ScenarioStudioDraft) => void;
	}
) {
	const playbackAction = createEffectAction();
	const settingsAction = createEffectAction();
	const liveRunAction = createEffectAction();
	const cancelRunAction = createEffectAction();
	const liveStatusSubscription = createEffectSubscription();
	const initialDocument = props.initialDraft?.document ?? movementGymScenario;
	const demoPreview = props.initialDraft === undefined;
	const [document, setDocument] = createSignal<ScenarioDocument>(initialDocument);
	const fileAction = createEffectAction();
	const [savedPath, setSavedPath] = createSignal(props.initialDraft?.savedPath);
	const [savedJson, setSavedJson] = createSignal(props.initialDraft?.savedJson);
	const [fileMessage, setFileMessage] = createSignal("");
	const dirty = createMemo(() => savedJson() !== JSON.stringify(document()));
	onCleanup(() =>
		props.onDraftChange?.({
			document: document(),
			savedPath: savedPath(),
			savedJson: savedJson()
		})
	);
	const [runs, setRuns] = createSignal<readonly ScenarioRun[]>(
		demoPreview ? movementGymRuns : []
	);
	const [activeRun, setActiveRun] = createSignal<ScenarioRun | undefined>(
		demoPreview ? firstMovementGymRun() : undefined
	);
	const [selectedId, setSelectedId] = createSignal<ScenarioElementId | undefined>(
		demoPreview ? makeScenarioElementId("action_jump") : clipsInScenario(initialDocument)[0]?.id
	);
	const [playheadMs, setPlayheadMs] = createSignal(demoPreview ? 3370 : 0);
	const [transport, setTransport] = createSignal<TransportState>("paused");
	const [liveRunState, setLiveRunState] = createSignal<LiveRunState>({ status: "preview" });
	const [demoGuideOpen, setDemoGuideOpen] = createSignal(props.showDemoGuide ?? false);
	const [endpoint, setEndpoint] = createSignal("");
	const seekPlan = createMemo(() =>
		planScenarioSeek({ document: document(), targetMs: playheadMs() })
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
	const selectedClip = createMemo(() => {
		const id = selectedId();
		return id ? findScenarioClip(document(), id) : undefined;
	});
	const selectedEvidence = createMemo(() =>
		activeRun()?.evidence.find((evidence) => evidence.markerId === selectedId())
	);
	const evidenceAtPlayhead = createMemo(
		() =>
			[...(activeRun()?.evidence ?? [])].sort(
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
	const headlessCommand = createMemo(() =>
		savedPath() && !dirty()
			? "pnpm ue-shed scenarios run '" +
				endpoint().trim().replaceAll("'", "''") +
				"' --document '" +
				savedPath()?.replaceAll("'", "''") +
				"'"
			: "Save the draft to generate its PowerShell replay command."
	);
	const formatClientFailure = (cause: Cause.Cause<unknown>): string => {
		const error = Cause.findErrorOption(cause);
		if (Option.isSome(error) && error.value instanceof Object) {
			const value = error.value;
			if ("message" in value && Schema.is(Schema.String)(value.message)) {
				const recovery =
					"recovery" in value && Schema.is(Schema.String)(value.recovery)
						? ` ${value.recovery}`
						: "";
				return `${value.message}${recovery}`;
			}
		}
		return Cause.pretty(cause);
	};
	const saveDocument = () => {
		const client = props.client;
		if (!client?.saveDocument) return;
		const saving = document();
		fileAction.run(client.saveDocument(saving), {
			onFailure: (cause) => setFileMessage(formatClientFailure(cause)),
			onSuccess: (result) => {
				if (result.status === "failed")
					setFileMessage(result.message + " " + result.recovery);
				if (result.status === "completed") {
					setSavedPath(result.path);
					setSavedJson(JSON.stringify(result.document));
					setFileMessage("Saved " + result.path);
				}
			}
		});
	};
	const openDocument = () => {
		const client = props.client;
		if (!client?.openDocument) return;
		fileAction.run(client.openDocument(), {
			onFailure: (cause) => setFileMessage(formatClientFailure(cause)),
			onSuccess: (result) => {
				if (result.status === "failed")
					setFileMessage(result.message + " " + result.recovery);
				if (result.status === "completed") {
					playbackAction.cancel();
					liveRunAction.cancel();
					cancelRunAction.cancel();
					liveStatusSubscription.cancel();
					setTransport("paused");
					batch(() => {
						setDocument(result.document);
						setSelectedId(clipsInScenario(result.document)[0]?.id);
						setPlayheadMs(0);
						setDragState(undefined);
						setTimelineScale(1);
						setRuns([]);
						setActiveRun(undefined);
						setLiveRunState({ status: "preview" });
					});
					setSavedPath(result.path);
					setSavedJson(JSON.stringify(result.document));
					setFileMessage("Opened " + result.path);
				}
			}
		});
	};
	const acceptTerminalRun = (run: ScenarioRun) => {
		setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
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
		}
	};
	const seekFromPointer = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
		const target = Math.round(ratio * document().durationMs);
		setPlayheadMs(target);
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
		}
	};

	return (
		<main {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.commandBar)}>
				<div {...stylex.props(styles.documentIdentity)}>
					<span {...stylex.props(styles.scenarioGlyph)}>SCN</span>
					<div>
						<h1 {...stylex.props(styles.title)}>Scenario Studio</h1>
						<div {...stylex.props(styles.documentName)}>{document().title}</div>
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
						Demo guide
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
								? activeRun()?.status === "completed_with_divergence"
									? "Differences found"
									: activeRun()?.status === "cancelled"
										? "Cancelled"
										: activeRun()?.status === "failed"
											? "Run failed"
											: "Live result"
								: liveRunState().status === "connecting"
									? "Starting PIE…"
									: liveRunState().status === "active"
										? capitalize(liveProducerState() ?? "")
										: liveRunState().status === "cancelling"
											? "Cancelling…"
											: liveRunState().status === "unavailable"
												? "Run failed"
												: "Preview only"}
						</strong>
						<small>
							{liveRunState().status === "unavailable"
								? "The run console below has the details"
								: props.client === undefined
									? "Unreal client not provided"
									: liveRunState().status === "terminal"
										? (activeRun()?.failure?.message ?? "Structured PIE result")
										: liveGameTimeMs() === undefined
											? "Ready for a structured PIE result"
											: `${formatTime(liveGameTimeMs()!)} game time`}
						</small>
					</div>
				</div>
			</header>

			<section aria-label="Live execution controls" {...stylex.props(styles.runConsole)}>
				<label {...stylex.props(styles.endpointField)}>
					<span>Remote Control endpoint</span>
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
					<For each={["Connect", "Isolate", "Run", "Wait", "Result"]}>
						{(phase) => (
							<span
								{...stylex.props(
									styles.lifecyclePhase,
									((phase === "Connect" &&
										liveRunState().status === "connecting") ||
										(phase === "Isolate" &&
											liveRunState().status === "active" &&
											["accepted", "isolating"].includes(
												liveProducerState() ?? "accepted"
											)) ||
										(phase === "Run" &&
											((liveRunState().status === "active" &&
												liveProducerState() === "running") ||
												liveRunState().status === "cancelling")) ||
										(phase === "Wait" &&
											liveRunState().status === "active" &&
											liveProducerState() === "waiting") ||
										(phase === "Result" &&
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
							Cancel run
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
							? "Starting…"
							: liveRunState().status === "cancelling"
								? "Cancelling…"
								: liveRunState().status === "active"
									? "Running"
									: "Run in Unreal"}
					</button>
				</div>
			</section>

			<Show when={liveFailureMessage()}>
				{(message) => {
					const parts = createMemo(() => failureParts(message()));
					return (
						<section role="alert" {...stylex.props(styles.runFailure)}>
							<strong {...stylex.props(styles.runFailureTitle)}>
								Couldn’t run this scenario in Unreal
							</strong>
							<p {...stylex.props(styles.runFailureMessage)}>{parts().summary}</p>
							<Show when={parts().technical}>
								{(technical) => (
									<details {...stylex.props(styles.runFailureDetails)}>
										<summary>Technical details</summary>
										<code>{technical()}</code>
									</details>
								)}
							</Show>
						</section>
					);
				}}
			</Show>

			<Show when={demoGuideOpen()}>
				<section aria-label="Movement Gym demo guide" {...stylex.props(styles.demoGuide)}>
					<header {...stylex.props(styles.demoGuideHeading)}>
						<strong>Movement Gym</strong>
						<small>One scenario, run from the Workbench or the CLI</small>
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
										{index() + 1}
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
						<span>Same runner, headless</span>
						<code {...stylex.props(styles.headlessCommand)}>{headlessCommand()}</code>
					</div>
				</section>
			</Show>

			<section {...stylex.props(styles.workspace)}>
				<aside aria-label="Scenario takes" {...stylex.props(styles.takeRail)}>
					<div {...stylex.props(styles.railHeading)}>
						<span>Takes</span>
						<button aria-label="Add take" {...stylex.props(styles.addButton)}>
							+
						</button>
					</div>
					<div {...stylex.props(styles.takeList)}>
						<For each={runs()}>
							{(run, index) => (
								<button
									onClick={() => setActiveRun(run)}
									{...stylex.props(
										styles.take,
										activeRun()?.id === run.id && styles.takeActive
									)}
								>
									<span {...stylex.props(styles.takeNumber)}>
										{String(runs().length - index()).padStart(2, "0")}
									</span>
									<span {...stylex.props(styles.takeCopy)}>
										<strong>{run.label.split(" · ")[1] ?? run.label}</strong>
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
											: "Clean"}
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
							<span {...stylex.props(styles.runState)}>
								{dirty() ? "Unsaved" : "Saved"}
							</span>
						</button>
					</div>

					<Show when={props.client?.saveDocument}>
						<div {...stylex.props(styles.documentFacts)}>
							<button
								type="button"
								disabled={liveBusy()}
								onClick={saveDocument}
								{...stylex.props(styles.take)}
							>
								Save draft…
							</button>
							<button
								type="button"
								disabled={liveBusy()}
								onClick={openDocument}
								{...stylex.props(styles.take)}
							>
								Open draft…
							</button>
							<span role="status">{fileMessage()}</span>
						</div>
					</Show>
					<div {...stylex.props(styles.documentFacts)}>
						<div {...stylex.props(styles.fact)}>
							<span>Map</span>
							<strong>{document().mapPath.split("/").at(-1)}</strong>
						</div>
						<div {...stylex.props(styles.fact)}>
							<span>Clock</span>
							<strong>Game time</strong>
						</div>
						<div {...stylex.props(styles.fact)}>
							<span>Seed</span>
							<strong>{document().seed}</strong>
						</div>
						<div {...stylex.props(styles.isolationFact)}>
							<span {...stylex.props(styles.lockMark)}>◆</span>
							<div>
								<strong>
									{liveRunState().status === "terminal" &&
									activeRun()?.inputIsolation?.established &&
									activeRun()?.inputIsolation?.restored
										? "Isolation verified"
										: liveRunState().status === "active" ||
											  liveRunState().status === "cancelling"
											? "Isolation active"
											: liveRunState().status === "connecting"
												? "Isolation required"
												: "Live input not blocked"}
								</strong>
								<small>
									{liveRunState().status === "terminal" &&
									activeRun()?.inputIsolation?.restored
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
							<h2 {...stylex.props(styles.sectionTitle)}>Timeline</h2>
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
								<div {...stylex.props(styles.rulerLabel)}>Game time</div>
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
																"Runs live" &&
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
									<span {...stylex.props(styles.clipType)}>
										{clipKindLabel(clip)}
									</span>
									<h2>{clip.label}</h2>
									<code>{operationName(clip)}</code>
								</header>

								<section {...stylex.props(styles.inspectorSection)}>
									<h3>Timing</h3>
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
									<h3>Input handling</h3>
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
											<h3>Input values</h3>
											<div {...stylex.props(styles.keyframeList)}>
												<For each={action.keyframes}>
													{(keyframe) => (
														<div {...stylex.props(styles.keyframe)}>
															<span>
																{formatTime(keyframe.offsetMs)}
															</span>
															<code>
																{keyframe.value instanceof Object
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
					<h2 {...stylex.props(styles.sectionTitle)}>Run results</h2>
					<p>Captures and game checks from this run, at {formatTime(playheadMs())}.</p>
					<Show when={liveRunState().status === "terminal"}>
						<div {...stylex.props(styles.runReceiptSummary)}>
							<span>
								{capitalize(activeRun()?.status.replaceAll("_", " ") ?? "Not run")}
							</span>
							<strong>UE {activeRun()?.engineVersion}</strong>
							<small>
								{activeRun()?.inputIsolation?.restored
									? "Input restored"
									: "Restore not proven"}
							</small>
						</div>
					</Show>
				</div>
				<div {...stylex.props(styles.frameCard)}>
					<Show
						when={presentedEvidence()}
						fallback={
							<div {...stylex.props(styles.emptyEvidence)}>
								<strong>No capture here</strong>
								<p>
									This run recorded nothing at the selected point. Move the
									playhead to a capture marker to see one.
								</p>
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
											<span>
												{capitalize(evidence.type.replaceAll("_", " "))}
											</span>
											<time>{formatTime(evidence.atMs)}</time>
										</div>
										<strong>{evidence.label}</strong>
										<p>{evidence.summary}</p>
										<small>
											{capitalize(evidence.status)} · recorded by the run
										</small>
									</div>
								}
							>
								<div {...stylex.props(styles.frame)}>
									<div {...stylex.props(styles.frameHorizon)} />
									<div {...stylex.props(styles.frameBridge)} />
									<div {...stylex.props(styles.framePawn)}>↑</div>
									<span {...stylex.props(styles.frameBadge)}>Player camera</span>
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
						<span>Captures</span>
						<small>{activeRun()?.evidence.length ?? 0} saved</small>
					</header>
					<For each={activeRun()?.evidence}>
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
						<span>Differences</span>
						<small>{activeRun()?.divergences.length ?? 0} found</small>
					</header>
					<Show
						when={(activeRun()?.divergences.length ?? 0) > 0}
						fallback={
							<p {...stylex.props(styles.cleanRun)}>
								{activeRun()
									? "No differences found in this take."
									: "Run this scenario to collect results."}
							</p>
						}
					>
						<For each={activeRun()?.divergences}>
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
				<span>Schema v{document().schemaVersion}</span>
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
		backgroundColor: tokens.colorCanvas,
		backgroundImage:
			"radial-gradient(circle at 54% -10%, rgba(228, 242, 34, 0.03), transparent 32%), linear-gradient(90deg, #ffffff04 1px, transparent 1px)",
		backgroundSize: "auto, 64px 100%",
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	commandBar: {
		height: 70,
		display: "grid",
		gridTemplateColumns: "minmax(320px, 1fr) auto minmax(300px, 1fr)",
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorCanvasTranslucent,
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
		backgroundColor: tokens.colorAccent,
		color: tokens.colorAccentText,
		fontSize: 11,
		fontWeight: 590,
		clipPath: "polygon(0 0, 82% 0, 100% 18%, 100% 100%, 0 100%)"
	},
	documentName: { color: tokens.colorTextMuted, fontSize: 12, marginTop: 2 },
	title: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 17,
		fontWeight: 590,
		letterSpacing: "-.01em"
	},
	transport: { display: "flex", alignItems: "center" },
	iconButton: {
		width: 34,
		height: 34,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		cursor: "pointer"
	},
	playButton: {
		width: 42,
		height: 42,
		marginLeft: 7,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: "50%",
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		boxShadow: "none",
		color: tokens.colorTextStrong,
		cursor: "pointer",
		fontSize: 13
	},
	liveRunButton: {
		borderColor: tokens.colorAccent,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorAccent,
		color: tokens.colorAccentText,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 500,
		padding: "9px 12px",
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		transition: `background-color ${tokens.motionFast}, transform ${tokens.motionFast}`,
		":active": { transform: "scale(.97)" },
		":disabled": { cursor: "default", opacity: 0.5 }
	},
	cancelRunButton: {
		borderColor: tokens.colorDanger,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: {
			default: "rgba(235, 87, 87, 0.08)",
			":hover": "rgba(235, 87, 87, 0.14)"
		},
		color: tokens.colorDanger,
		fontFamily: tokens.fontBody,
		fontSize: 11,
		fontWeight: 500,
		padding: "9px 11px",
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		transition: `background-color ${tokens.motionFast}, transform ${tokens.motionFast}`,
		":active": { transform: "scale(.97)" }
	},
	playing: { backgroundColor: tokens.colorAccentWash },
	timecode: {
		marginLeft: 14,
		color: tokens.colorTextStrong,
		fontSize: 14,
		fontWeight: 590
	},
	duration: { color: tokens.colorTextFaint, fontSize: 11 },
	runtimeStatus: {
		display: "flex",
		alignItems: "center",
		justifySelf: "end",
		gap: 10,
		paddingRight: 22,
		color: tokens.colorTextMuted
	},
	demoGuideToggle: {
		marginRight: 4,
		padding: "6px 8px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: "transparent",
		color: tokens.colorTextSubtle,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		transition: `transform ${tokens.motionFast} cubic-bezier(.23, 1, .32, 1)`,
		":active": { transform: "scale(.97)" }
	},
	demoGuideToggleActive: {
		borderColor: tokens.colorAccent,
		backgroundColor: "rgba(228, 242, 34, 0.08)",
		color: tokens.colorAccent
	},
	offlineDot: { width: 7, height: 7, borderRadius: "50%", backgroundColor: tokens.colorWarning },
	liveDot: {
		backgroundColor: tokens.colorAccent,
		boxShadow: "0 0 10px rgba(228, 242, 34, 0.35)"
	},
	terminalDot: { backgroundColor: tokens.colorSuccess },
	runtimeStatusStrong: {},
	runConsole: {
		height: 58,
		display: "grid",
		gridTemplateColumns: "minmax(250px, 360px) minmax(360px, 1fr) auto",
		alignItems: "center",
		gap: 20,
		padding: "0 18px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceInset
	},
	endpointField: {
		display: "grid",
		gridTemplateColumns: "auto 1fr",
		alignItems: "center",
		gap: 10,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	endpointInput: {
		width: "100%",
		minWidth: 0,
		padding: "7px 9px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		borderRadius: tokens.radiusControl,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorBorderStrong}` },
		":disabled": { color: tokens.colorTextSubtle, opacity: 0.5 }
	},
	lifecycle: { display: "flex", alignItems: "center", justifyContent: "center", gap: 18 },
	lifecyclePhase: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	lifecycleCurrent: { color: tokens.colorAccent },
	phaseDot: { width: 5, height: 5, borderRadius: "50%", backgroundColor: "currentColor" },
	runActions: { display: "flex", alignItems: "center", gap: 8 },
	demoGuide: {
		display: "grid",
		gridTemplateColumns: {
			default: "180px minmax(620px, 1fr) minmax(270px, 350px)",
			"@media (max-width: 1180px)": "150px minmax(600px, 1fr)"
		},
		minHeight: 88,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurface
	},
	demoGuideHeading: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 4,
		padding: "14px 18px",
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
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
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		color: tokens.colorTextFaint
	},
	demoStepComplete: { color: tokens.colorTextMuted },
	demoStepCurrent: {
		backgroundColor: "rgba(228, 242, 34, 0.03)",
		boxShadow: `inset 0 -2px ${tokens.colorAccent}`,
		color: tokens.colorText
	},
	demoStepNumber: {
		alignSelf: "start",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontDisplay,
		fontSize: 17
	},
	demoStepBody: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
	demoStepLabel: { color: "currentColor", fontSize: 11 },
	demoStepTitle: { color: "currentColor", fontSize: 12, lineHeight: 1.2 },
	demoStepCopy: { margin: 0, color: tokens.colorTextSubtle, fontSize: 11, lineHeight: 1.35 },
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
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	headlessCommand: {
		overflowWrap: "anywhere",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		letterSpacing: 0,
		lineHeight: 1.45
	},
	workspace: {
		display: "grid",
		gridTemplateColumns: "196px minmax(680px, 1fr) 268px",
		minHeight: 530,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	takeRail: {
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		backgroundColor: tokens.colorSurfaceInset
	},
	railHeading: {
		height: 48,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "0 14px 0 16px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	addButton: {
		width: 23,
		height: 23,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
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
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderLeftColor: "transparent",
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left"
	},
	takeActive: {
		borderLeftColor: tokens.colorAccent,
		backgroundColor: "rgba(255, 255, 255, 0.07)"
	},
	draftTake: {
		borderLeftColor: tokens.colorBorderStrong,
		backgroundColor: tokens.colorSurfaceInset
	},
	takeNumber: { color: tokens.colorTextSubtle, fontFamily: tokens.fontDisplay, fontSize: 16 },
	takeCopy: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
	runState: { color: tokens.colorTextSubtle, fontSize: 11 },
	runStateWarning: { color: tokens.colorWarning },
	documentFacts: { marginTop: 28, padding: "0 16px" },
	fact: {
		display: "flex",
		justifyContent: "space-between",
		padding: "8px 0",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	isolationFact: {
		display: "flex",
		alignItems: "center",
		gap: 9,
		marginTop: 16,
		padding: "10px",
		borderRadius: tokens.radiusPanel,
		borderColor: "rgba(228, 242, 34, 0.2)",
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: "rgba(228, 242, 34, 0.03)"
	},
	lockMark: { color: tokens.colorAccent, fontSize: 11 },
	timelinePanel: { minWidth: 0, backgroundColor: tokens.colorSurface },
	timelineHeader: {
		height: 74,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "0 18px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	sectionTitle: {
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 590,
		letterSpacing: "-.01em",
		margin: 0
	},
	runFailure: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorText,
		padding: "14px 18px"
	},
	runFailureTitle: { color: tokens.colorTextStrong, fontSize: 14, fontWeight: 590 },
	runFailureMessage: {
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.55,
		margin: "4px 0 0",
		maxWidth: 720
	},
	runFailureDetails: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		marginTop: tokens.space2,
		whiteSpace: "pre-wrap"
	},
	timelineTools: {
		display: "flex",
		alignItems: "center",
		gap: 9,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	timelineScroller: {
		overflowX: "auto",
		scrollbarColor: `${tokens.colorBorder} ${tokens.colorSurfaceInset}`
	},
	rulerRow: { display: "grid", gridTemplateColumns: "190px 1fr", height: 38 },
	rulerLabel: {
		display: "flex",
		alignItems: "center",
		paddingLeft: 16,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	ruler: {
		position: "relative",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	tick: {
		position: "absolute",
		top: 0,
		height: 38,
		padding: "9px 0 0 6px",
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	checkpoint: {
		position: "absolute",
		bottom: 1,
		color: tokens.colorAccent,
		fontSize: 11,
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
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceInset
	},
	trackKind: { color: tokens.colorTextFaint, fontSize: 11 },
	trackMeta: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
	trackSupport: {
		padding: "2px 4px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusBadge,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	trackSupportLive: {
		borderColor: tokens.colorAccent,
		backgroundColor: "rgba(228, 242, 34, 0.03)",
		color: tokens.colorAccent
	},
	trackBody: {
		position: "relative",
		minHeight: 72,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
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
		borderRadius: tokens.radiusBadge,
		color: tokens.colorText,
		cursor: "grab",
		textAlign: "left",
		transition: `filter ${tokens.motionFast}, box-shadow ${tokens.motionFast}`
	},
	semantic_action: {
		borderColor: "rgba(228, 242, 34, 0.45)",
		backgroundColor: tokens.colorAccentWash
	},
	raw_input: {
		top: 16,
		height: 39,
		borderColor: "rgba(2, 184, 204, 0.45)",
		backgroundColor: "rgba(2, 184, 204, 0.1)",
		opacity: 0.78
	},
	world_condition: {
		borderColor: "rgba(242, 153, 74, 0.45)",
		backgroundColor: "rgba(242, 153, 74, 0.1)"
	},
	intervention: {
		borderColor: "rgba(235, 87, 87, 0.45)",
		backgroundColor: "rgba(235, 87, 87, 0.1)"
	},
	evidence: {
		top: 17,
		height: 38,
		minWidth: 18,
		padding: "5px 7px",
		borderColor: tokens.colorBorderStrong,
		backgroundColor: tokens.colorSurfaceRaised
	},
	clipSelected: {
		filter: "brightness(1.32)",
		boxShadow: "0 0 0 1px rgba(228, 242, 34, 0.55), 0 0 18px rgba(228, 242, 34, 0.09)",
		zIndex: 3
	},
	curve: { position: "absolute", right: 7, bottom: 2, color: tokens.colorAccent, fontSize: 16 },
	playhead: {
		position: "absolute",
		top: 0,
		bottom: 0,
		width: 2,
		backgroundColor: tokens.colorAccent,
		boxShadow: "0 0 8px rgba(228, 242, 34, 0.35)",
		pointerEvents: "none",
		zIndex: 7
	},
	seekReadout: {
		height: 45,
		display: "flex",
		alignItems: "center",
		gap: 11,
		padding: "0 16px",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	seekIcon: { color: tokens.colorAccent, fontSize: 14 },
	inspector: {
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		backgroundColor: tokens.colorSurfaceInset
	},
	inspectorHeader: {
		padding: "18px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	clipType: { float: "right", color: tokens.colorTextSubtle, fontSize: 11 },
	inspectorSection: {
		padding: "15px 18px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
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
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 12
	},
	evidenceDesk: {
		display: "grid",
		gridTemplateColumns: "196px minmax(300px, .8fr) minmax(310px, 1fr) minmax(310px, 1fr)",
		minHeight: 236,
		backgroundColor: tokens.colorSurfaceInset
	},
	evidenceHeading: {
		padding: "20px 16px",
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	runReceiptSummary: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginTop: 14,
		padding: "9px 10px",
		borderRadius: tokens.radiusPanel,
		borderColor: "rgba(228, 242, 34, 0.2)",
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: "rgba(228, 242, 34, 0.03)",
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	frameCard: {
		padding: 14,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	structuredEvidence: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 10,
		height: 178,
		padding: "16px 18px",
		borderRadius: tokens.radiusPanel,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: `inset 3px 0 ${tokens.colorSuccess}`
	},
	structuredEvidenceTopline: {
		display: "flex",
		justifyContent: "space-between",
		color: tokens.colorSuccess,
		fontSize: 11
	},
	emptyEvidence: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 9,
		height: 178,
		padding: "16px 18px",
		borderRadius: tokens.radiusPanel,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "dashed",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle
	},
	frame: {
		position: "relative",
		height: 130,
		overflow: "hidden",
		borderRadius: tokens.radiusPanel,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
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
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(8, 9, 10, 0.79)",
		color: tokens.colorAccent,
		fontSize: 11
	},
	frameTime: {
		position: "absolute",
		right: 8,
		bottom: 7,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	frameCaption: { marginTop: 9 },
	observationList: {
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	observation: {
		display: "grid",
		gridTemplateColumns: "30px 1fr auto",
		gap: 9,
		width: "100%",
		padding: "10px 14px",
		borderStyle: "none",
		borderWidth: 0,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left"
	},
	observationType: {
		display: "grid",
		placeItems: "center",
		width: 27,
		height: 24,
		borderRadius: tokens.radiusBadge,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	divergenceLedger: {},
	divergence: {
		display: "grid",
		gridTemplateColumns: "24px 1fr auto",
		gap: 9,
		width: "100%",
		padding: "10px 14px",
		borderStyle: "none",
		borderWidth: 0,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left"
	},
	delta: { color: tokens.colorWarning, fontFamily: tokens.fontDisplay, fontSize: 18 },
	cleanRun: { padding: 16, color: tokens.colorTextSubtle, fontSize: 12 },
	statusBar: {
		height: 31,
		display: "flex",
		alignItems: "center",
		gap: 24,
		padding: "0 16px",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 11
	}
});
