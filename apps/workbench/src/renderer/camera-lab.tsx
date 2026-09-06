import * as stylex from "@stylexjs/stylex";
import { CameraScheduleConfig, type CameraStatus } from "@ue-shed/protocol";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Exit, Schema } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { RendererCameraFrame, WorkbenchCameraMetrics } from "../shared/ipc-contracts.js";
import { workbenchRendererClient } from "./workbench-client.js";

interface TileTelemetry {
	readonly fps: number;
	readonly gap: number;
	readonly lastFrameAt: number;
	readonly presentationMs: number;
	readonly readbackMs: number;
	readonly sequence: number;
}

type CaptureResolution = CameraScheduleConfig["resolution"];

const resolutionDimensions = {
	"160x90": [160, 90],
	"320x180": [320, 180],
	"640x360": [640, 360],
	"960x540": [960, 540],
	"1280x720": [1280, 720],
	"1920x1080": [1920, 1080],
	"2560x1440": [2560, 1440]
} satisfies Readonly<Record<CaptureResolution, readonly [number, number]>>;

const resolutionOptions = Schema.decodeUnknownSync(
	Schema.Array(CameraScheduleConfig.fields.resolution)
)(Object.keys(resolutionDimensions));

const defaultConfig: CameraScheduleConfig = {
	activeCameraCount: 8,
	backgroundFps: 2,
	captureBudgetPerTick: 2,
	focusedCameraIndex: 0,
	focusedFps: 8,
	paused: false,
	pipelineMode: "full_pipeline",
	renderProfile: "full_fidelity",
	resolution: "320x180",
	viewMode: "overview"
};

interface FramePresenter {
	readonly present: (frame: RendererCameraFrame) => void;
}

function createCanvasPresenter(canvas: HTMLCanvasElement): FramePresenter | undefined {
	const context = canvas.getContext("2d", { alpha: false });
	if (!context) return undefined;
	let rgba = new Uint8ClampedArray(0);
	let imageData: ImageData | undefined;
	return {
		present: (frame) => {
			if (canvas.width !== frame.width || canvas.height !== frame.height) {
				canvas.width = frame.width;
				canvas.height = frame.height;
				rgba = new Uint8ClampedArray(frame.pixels.byteLength);
				imageData = new ImageData(rgba, frame.width, frame.height);
			}
			for (let offset = 0; offset < frame.pixels.byteLength; offset += 4) {
				rgba[offset] = frame.pixels[offset + 2] ?? 0;
				rgba[offset + 1] = frame.pixels[offset + 1] ?? 0;
				rgba[offset + 2] = frame.pixels[offset] ?? 0;
				rgba[offset + 3] = 255;
			}
			if (imageData) context.putImageData(imageData, 0, 0);
		}
	};
}

function CameraTile(props: {
	readonly focused: boolean;
	readonly frame: RendererCameraFrame | undefined;
	readonly index: number;
	readonly onFocus: () => void;
	readonly onTelemetry: (value: TileTelemetry) => void;
	readonly pipelineMode: CameraScheduleConfig["pipelineMode"];
}) {
	let canvas: HTMLCanvasElement | undefined;
	let presenter: FramePresenter | undefined;
	let lastSequence = 0;
	let lastFrameAt = 0;
	let smoothedFps = 0;
	createEffect(() => {
		const frame = props.frame;
		if (!frame || !canvas) return;
		const started = performance.now();
		presenter ??= createCanvasPresenter(canvas);
		if (!presenter) return;
		presenter.present(frame);
		const now = performance.now();
		const instantFps = lastFrameAt > 0 ? 1000 / (now - lastFrameAt) : 0;
		smoothedFps = smoothedFps === 0 ? instantFps : smoothedFps * 0.75 + instantFps * 0.25;
		const sequence = Number(frame.sequence);
		props.onTelemetry({
			fps: smoothedFps,
			gap: lastSequence > 0 ? Math.max(0, sequence - lastSequence - 1) : 0,
			lastFrameAt: now,
			presentationMs: now - started,
			readbackMs: frame.readbackLatencyMs,
			sequence
		});
		lastFrameAt = now;
		lastSequence = sequence;
	});
	return (
		<button
			type="button"
			onClick={props.onFocus}
			{...stylex.props(styles.tile, props.focused && styles.tileFocused)}
		>
			<canvas ref={(element) => (canvas = element)} {...stylex.props(styles.canvas)} />
			<div {...stylex.props(styles.tileTop)}>
				<span>Cam {String(props.index + 1).padStart(2, "0")}</span>
				<span {...stylex.props(styles.liveDot)}>
					{props.pipelineMode === "full_pipeline" ? "Live" : "Isolated"}
				</span>
			</div>
			<Show when={!props.frame}>
				<div {...stylex.props(styles.awaiting)}>
					<span>
						{props.pipelineMode === "full_pipeline" ? "No signal" : "Output muted"}
					</span>
					<small>
						{props.pipelineMode === "render_only"
							? "rendering without GPU readback"
							: props.pipelineMode === "schedule_only"
								? "measuring scheduler without rendering"
								: "waiting for Unreal producer"}
					</small>
				</div>
			</Show>
		</button>
	);
}

export function CameraLab() {
	const configureAction = createEffectAction();
	const launchAction = createEffectAction();
	const budgetAction = createEffectAction();
	const frameSubscription = createEffectSubscription();
	const metricsSubscription = createEffectSubscription();
	const statusSubscription = createEffectSubscription();
	const [config, setConfig] = createSignal(defaultConfig);
	const [frames, setFrames] = createSignal<ReadonlyMap<number, RendererCameraFrame>>(new Map());
	const [telemetry, setTelemetry] = createSignal<ReadonlyMap<number, TileTelemetry>>(new Map());
	const [metrics, setMetrics] = createSignal<WorkbenchCameraMetrics>();
	const [presentationBudget, setPresentationBudget] = createSignal(80);
	const [status, setStatus] = createSignal<CameraStatus>();
	const [controlState, setControlState] = createSignal<"connected" | "unavailable" | "updating">(
		"unavailable"
	);
	const [fixtureLaunch, setFixtureLaunch] = createSignal<
		| { readonly status: "idle" }
		| { readonly status: "launching" }
		| { readonly status: "failed"; readonly message: string }
	>({ status: "idle" });
	const activeFeeds = createMemo(
		() => [...frames().keys()].filter((index) => index < config().activeCameraCount).length
	);
	const visibleCameraIndices = createMemo(() => {
		const discovered = status()?.cameras.map((camera) => camera.index) ?? [];
		const candidates =
			discovered.length > 0
				? discovered
				: Array.from({ length: config().activeCameraCount }, (_, index) => index);
		return candidates.filter((index) => index < config().activeCameraCount).slice(0, 8);
	});
	const totalFps = createMemo(() =>
		[...telemetry().values()].reduce((sum, value) => sum + value.fps, 0)
	);
	const throughput = createMemo(() => {
		const value = metrics();
		if (!value) return 0;
		return (
			value.bytesReceived /
			Math.max(1, (performance.now() - value.startedMonotonicMs) / 1000) /
			1_000_000
		);
	});
	const estimatedRawThroughput = createMemo(() => {
		const [width, height] = resolutionDimensions[config().resolution];
		const cameraCount = config().activeCameraCount;
		const aggregateFps =
			config().focusedCameraIndex === null
				? config().backgroundFps * cameraCount
				: config().focusedFps + config().backgroundFps * (cameraCount - 1);
		return (width * height * 4 * aggregateFps) / 1_000_000;
	});
	const averageCaptureBatch = createMemo(() => {
		const stats = status()?.stats;
		if (!stats || stats.captureBatchesSubmitted === 0) return "—";
		const batchCount = stats.captureBatchesSubmitted;
		return `${(stats.capturesRequested / batchCount).toFixed(1)} / ${(stats.totalCaptureBatchSubmissionMs / batchCount).toFixed(2)} ms`;
	});
	const maxCaptureBatch = createMemo(() => {
		const stats = status()?.stats;
		return stats
			? `${stats.maxCaptureBatchSize} / ${stats.maxCaptureBatchSubmissionMs.toFixed(1)} ms`
			: "—";
	});
	const captureCadence = createMemo(() => {
		const stats = status()?.stats;
		if (!stats || stats.camerasDue === 0) return "—";
		return `${stats.cadenceIntervalsSkipped} skip · ${(stats.totalCaptureLatenessMs / stats.camerasDue).toFixed(1)} / ${stats.maxCaptureLatenessMs.toFixed(1)} ms`;
	});
	const experimentRate = (count: number | undefined) => {
		const elapsedMs = status()?.stats.experimentElapsedMs ?? 0;
		return elapsedMs > 0 && count !== undefined ? (count * 1_000) / elapsedMs : 0;
	};

	const applyConfig = (next: CameraScheduleConfig) => {
		if (next.pipelineMode !== "full_pipeline") {
			setFrames(new Map());
			setTelemetry(new Map());
		}
		setConfig(next);
		setControlState("updating");
		configureAction.run(workbenchRendererClient.configure(next), {
			onFailure: () => setControlState("unavailable"),
			onSuccess: (nextStatus) => {
				setStatus(nextStatus);
				setConfig(nextStatus.config);
				setControlState("connected");
			}
		});
	};

	const launchFixture = () => {
		setFixtureLaunch({ status: "launching" });
		launchAction.run(
			Effect.gen(function* () {
				const launch = yield* workbenchRendererClient.launchFixture();
				if (launch.status === "failed") return { launch, status: "launch_failed" as const };
				const camera = yield* workbenchRendererClient.getStatus();
				return { camera, status: "ready" as const };
			}),
			{
				onFailure: (cause) =>
					setFixtureLaunch({
						message: `Unreal launched, but Camera Load Lab could not connect: ${Cause.pretty(cause)}`,
						status: "failed"
					}),
				onSuccess: (result) => {
					if (result.status === "launch_failed") {
						setFixtureLaunch({
							message: `${result.launch.message} ${result.launch.recovery}`,
							status: "failed"
						});
						return;
					}
					setStatus(result.camera);
					setConfig(result.camera.config);
					setControlState("connected");
					setFixtureLaunch({ status: "idle" });
				}
			}
		);
	};

	onMount(() => {
		frameSubscription.subscribe(workbenchRendererClient.frames, {
			onValue: (frame) =>
				setFrames((current) => {
					const next = new Map(current);
					next.set(frame.cameraIndex, frame);
					return next;
				})
		});
		metricsSubscription.subscribe(workbenchRendererClient.metrics, {
			onValue: (exit) => {
				if (Exit.isSuccess(exit)) setMetrics(exit.value);
			}
		});
		statusSubscription.subscribe(workbenchRendererClient.statuses, {
			onValue: (exit) => {
				if (controlState() === "updating") return;
				if (Exit.isFailure(exit)) {
					setControlState("unavailable");
					return;
				}
				setStatus(exit.value);
				setConfig(exit.value.config);
				setControlState("connected");
			}
		});
		budgetAction.run(workbenchRendererClient.setPresentationBudget(presentationBudget()), {
			onSuccess: () => undefined
		});
	});

	return (
		<main {...stylex.props(styles.shell)}>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.headerTitle)}>
					<h1 {...stylex.props(styles.title)}>Camera Lab</h1>
					<p {...stylex.props(styles.titleIntro)}>
						Schedule many live cameras against one editor and watch the delivery budget.
					</p>
				</div>
				<div {...stylex.props(styles.systemActions)}>
					<div {...stylex.props(styles.systemState)}>
						<span {...stylex.props(styles.pulse)} />
						{activeFeeds()}/{config().activeCameraCount} streaming ·{" "}
						{visibleCameraIndices().length} shown · {controlState()}
					</div>
					<Show when={controlState() === "unavailable"}>
						<button
							type="button"
							disabled={fixtureLaunch().status === "launching"}
							onClick={() => void launchFixture()}
							{...stylex.props(styles.launchButton)}
						>
							{fixtureLaunch().status === "launching"
								? "Launching fixture…"
								: "Launch camera fixture"}
						</button>
					</Show>
					<Show when={fixtureLaunch().status === "failed"}>
						<small {...stylex.props(styles.launchError)}>
							{(() => {
								const current = fixtureLaunch();
								return current.status === "failed" ? current.message : "";
							})()}
						</small>
					</Show>
				</div>
			</header>

			<section {...stylex.props(styles.instrumentBar)}>
				<Metric label="Aggregate FPS" value={totalFps().toFixed(1)} />
				<Metric label="Pipe throughput" value={`${throughput().toFixed(2)} MB/s`} />
				<Metric
					label="Electron private"
					value={`${metrics()?.electronPrivateMemoryMb.toFixed(0) ?? "—"} MB`}
					warn={(metrics()?.electronPrivateMemoryMb ?? 0) > 2_048}
				/>
				<Metric
					label="GPU process private"
					value={`${metrics()?.gpuProcessPrivateMemoryMb.toFixed(0) ?? "—"} MB`}
					warn={(metrics()?.gpuProcessPrivateMemoryMb ?? 0) > 1_536}
				/>
				<Metric label="Host frames" value={String(metrics()?.framesReceived ?? 0)} />
				<Metric
					label="Experiment scheduled"
					value={`${experimentRate(status()?.stats.experimentScheduledCaptures).toFixed(1)} /s`}
				/>
				<Metric
					label="Experiment rendered"
					value={`${experimentRate(status()?.stats.experimentRenderedCaptures).toFixed(1)} /s`}
				/>
				<Metric
					label="Experiment delivered"
					value={`${experimentRate(status()?.stats.experimentFramesDelivered).toFixed(1)} /s`}
				/>
				<Metric
					label="Experiment ticks"
					value={`${experimentRate(status()?.stats.experimentSchedulerTicks).toFixed(1)} /s`}
				/>
				<Metric
					label="Skip / drop / replace"
					value={`${status()?.stats.experimentCadenceIntervalsSkipped ?? 0} / ${status()?.stats.experimentReadbackDrops ?? 0} / ${status()?.stats.experimentTransportReplacements ?? 0}`}
					warn={
						(status()?.stats.experimentCadenceIntervalsSkipped ?? 0) > 0 ||
						(status()?.stats.experimentReadbackDrops ?? 0) > 0 ||
						(status()?.stats.experimentTransportReplacements ?? 0) > 0
					}
				/>
				<Metric
					label="Readback allocations"
					value={`${status()?.stats.experimentReadbackResourcesCreated ?? 0} window · ${status()?.stats.readbackResourcesCreated ?? 0} total`}
				/>
				<Metric label="Avg UE batch" value={averageCaptureBatch()} />
				<Metric label="Max UE batch" value={maxCaptureBatch()} />
				<Metric
					label="Cadence avg / max"
					value={captureCadence()}
					warn={(status()?.stats.cadenceIntervalsSkipped ?? 0) > 0}
				/>
				<Metric
					label="Malformed"
					value={String(metrics()?.malformedFrames ?? 0)}
					warn={(metrics()?.malformedFrames ?? 0) > 0}
				/>
				<Metric
					label="GPU/stage drops"
					value={String(
						status()?.stats.readbackDrops ?? frames().get(0)?.readbackDrops ?? 0
					)}
					warn={(status()?.stats.readbackDrops ?? 0) > 0}
				/>
			</section>

			<div {...stylex.props(styles.workspace)}>
				<section {...stylex.props(styles.wall)}>
					<For each={visibleCameraIndices()}>
						{(index) => {
							const tileStats = () => telemetry().get(index);
							return (
								<div {...stylex.props(styles.tileWrap)}>
									<CameraTile
										index={index}
										frame={frames().get(index)}
										focused={config().focusedCameraIndex === index}
										pipelineMode={config().pipelineMode}
										onFocus={() =>
											void applyConfig({
												...config(),
												focusedCameraIndex: index
											})
										}
										onTelemetry={(value) => {
											setTelemetry((current) =>
												new Map(current).set(index, value)
											);
										}}
									/>
									<div {...stylex.props(styles.tileStats)}>
										<span>{tileStats()?.fps.toFixed(1) ?? "—"} fps</span>
										<span>
											{tileStats()?.readbackMs.toFixed(1) ?? "—"} ms gpu→cpu
										</span>
										<span>
											{tileStats()?.presentationMs.toFixed(1) ?? "—"} ms paint
										</span>
										<span>gap {tileStats()?.gap ?? 0}</span>
									</div>
								</div>
							);
						}}
					</For>
				</section>

				<aside {...stylex.props(styles.controls)}>
					<p {...stylex.props(styles.panelLabel)}>Controls</p>
					<h2 {...stylex.props(styles.panelTitle)}>Camera load</h2>
					<Slider
						label="Active cameras"
						value={config().activeCameraCount}
						min={1}
						max={status()?.cameras.length ?? 32}
						suffix=""
						onInput={(value) =>
							void applyConfig({
								...config(),
								activeCameraCount: value,
								focusedCameraIndex:
									config().focusedCameraIndex === null
										? null
										: Math.min(config().focusedCameraIndex ?? 0, value - 1)
							})
						}
					/>
					<div {...stylex.props(styles.viewMode)}>
						<span>Pipeline isolation</span>
						<div>
							<For
								each={
									[
										["full_pipeline", "Full"],
										["render_only", "Render"],
										["schedule_only", "Schedule"]
									] as const
								}
							>
								{([pipelineMode, label]) => (
									<button
										type="button"
										onClick={() =>
											void applyConfig({ ...config(), pipelineMode })
										}
										{...stylex.props(
											styles.pipelineButton,
											config().pipelineMode === pipelineMode &&
												styles.modeButtonActive
										)}
									>
										{label}
									</button>
								)}
							</For>
						</div>
					</div>
					<Slider
						label="Focused rate"
						value={config().focusedFps}
						min={1}
						max={30}
						suffix="fps"
						onInput={(value) => void applyConfig({ ...config(), focusedFps: value })}
					/>
					<Slider
						label="Background rate"
						value={config().backgroundFps}
						min={0.5}
						max={30}
						step={0.5}
						suffix="fps"
						onInput={(value) => void applyConfig({ ...config(), backgroundFps: value })}
					/>
					<Slider
						label="Captures per tick"
						value={config().captureBudgetPerTick}
						min={1}
						max={32}
						suffix=""
						onInput={(value) =>
							void applyConfig({ ...config(), captureBudgetPerTick: value })
						}
					/>
					<Slider
						label="Display budget"
						value={presentationBudget()}
						min={25}
						max={500}
						step={25}
						suffix="MB/s"
						onInput={(value) => {
							setPresentationBudget(value);
							budgetAction.run(workbenchRendererClient.setPresentationBudget(value), {
								onSuccess: () => undefined
							});
						}}
					/>
					<div {...stylex.props(styles.resolution)}>
						<span>Frame size</span>
						<div>
							<For each={resolutionOptions}>
								{(resolution) => (
									<button
										type="button"
										onClick={() =>
											void applyConfig({ ...config(), resolution })
										}
										{...stylex.props(
											styles.resolutionButton,
											config().resolution === resolution &&
												styles.modeButtonActive
										)}
									>
										{resolution}
									</button>
								)}
							</For>
						</div>
					</div>
					<div {...stylex.props(styles.viewMode)}>
						<span>Render profile</span>
						<div>
							<button
								type="button"
								onClick={() =>
									void applyConfig({
										...config(),
										renderProfile: "full_fidelity"
									})
								}
								{...stylex.props(
									styles.modeButton,
									config().renderProfile === "full_fidelity" &&
										styles.modeButtonActive
								)}
							>
								Full fidelity
							</button>
							<button
								type="button"
								onClick={() =>
									void applyConfig({ ...config(), renderProfile: "observation" })
								}
								{...stylex.props(
									styles.modeButton,
									config().renderProfile === "observation" &&
										styles.modeButtonActive
								)}
							>
								OBSERVATION
							</button>
						</div>
					</div>
					<div {...stylex.props(styles.viewMode)}>
						<span>Viewpoint</span>
						<div>
							<button
								type="button"
								onClick={() =>
									void applyConfig({ ...config(), viewMode: "overview" })
								}
								{...stylex.props(
									styles.modeButton,
									config().viewMode === "overview" && styles.modeButtonActive
								)}
							>
								OVERVIEW
							</button>
							<button
								type="button"
								onClick={() =>
									void applyConfig({ ...config(), viewMode: "actor_pov" })
								}
								{...stylex.props(
									styles.modeButton,
									config().viewMode === "actor_pov" && styles.modeButtonActive
								)}
							>
								Actor POV
							</button>
						</div>
					</div>
					<button
						type="button"
						onClick={() => void applyConfig({ ...config(), paused: !config().paused })}
						{...stylex.props(styles.pause)}
					>
						{config().paused ? "Resume capture" : "Pause capture"}
					</button>
					<div {...stylex.props(styles.budgetNote)}>
						<strong>{config().resolution.replace("x", " × ")} · BGRA8</strong>
						<span>{estimatedRawThroughput().toFixed(2)} MB/s estimated raw</span>
						<span>{config().renderProfile.replace("_", " ")} render profile</span>
						<span>{config().pipelineMode.replaceAll("_", " ")} experiment</span>
						<span>revision {status()?.stats.experimentRevision ?? "—"}</span>
						<span>latest frame wins</span>
						<span>{metrics()?.presentationReplacements ?? 0} display coalesced</span>
						<span>2 staging slots / camera</span>
					</div>
					<div {...stylex.props(styles.legend)}>
						<span>
							<i {...stylex.props(styles.legendGood)} /> nominal
						</span>
						<span>
							<i {...stylex.props(styles.legendWarn)} /> saturation signal
						</span>
					</div>
				</aside>
			</div>
		</main>
	);
}

function Metric(props: {
	readonly label: string;
	readonly value: string;
	readonly warn?: boolean;
}) {
	return (
		<div {...stylex.props(styles.metric, props.warn && styles.metricWarn)}>
			<span>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	);
}

function Slider(props: {
	readonly label: string;
	readonly max: number;
	readonly min: number;
	readonly onInput: (value: number) => void;
	readonly step?: number;
	readonly suffix: string;
	readonly value: number;
}) {
	return (
		<label {...stylex.props(styles.slider)}>
			<span>
				<b>{props.label}</b>
				<output>
					{props.value} {props.suffix}
				</output>
			</span>
			<input
				type="range"
				min={props.min}
				max={props.max}
				step={props.step ?? 1}
				value={props.value}
				onChange={(event) => props.onInput(event.currentTarget.valueAsNumber)}
			/>
		</label>
	);
}

const styles = stylex.create({
	shell: {
		minHeight: "100vh",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		backgroundImage:
			"linear-gradient(rgba(255,255,255,.014) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.014) 1px, transparent 1px)",
		backgroundSize: "24px 24px",
		padding: "24px 28px 32px"
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		paddingBottom: "16px"
	},
	headerTitle: { minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
	title: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 26,
		fontWeight: 590,
		letterSpacing: "-0.02em",
		color: tokens.colorTextStrong
	},
	titleIntro: { margin: 0, color: tokens.colorTextMuted, fontSize: 14 },
	systemState: {
		alignItems: "center",
		color: tokens.colorText,
		display: "flex",
		fontSize: 12,
		fontWeight: 500,
		gap: "9px"
	},
	systemActions: {
		display: "flex",
		alignItems: "flex-end",
		flexDirection: "column",
		gap: 8,
		maxWidth: 520
	},
	launchButton: {
		padding: "7px 12px",
		borderColor: "rgba(228, 242, 34, 0.45)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorAccentWash },
		color: tokens.colorAccent,
		fontSize: 13,
		fontWeight: 500,
		cursor: "pointer",
		transitionProperty: "background-color, transform",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.97)" }
	},
	launchError: { color: "#f2a9a1", textAlign: "right", fontSize: 12 },
	pulse: {
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		backgroundColor: tokens.colorSuccess,
		boxShadow: "0 0 10px rgba(76, 183, 130, 0.4)"
	},
	instrumentBar: {
		display: "grid",
		gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	metric: {
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		padding: "13px 14px",
		display: "flex",
		flexDirection: "column",
		gap: "5px",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 500
	},
	metricWarn: { backgroundColor: "rgba(235, 87, 87, 0.07)", color: "#f2a9a1" },
	workspace: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 276px",
		gap: "18px",
		paddingTop: "18px"
	},
	wall: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px" },
	tileWrap: { minWidth: 0 },
	tile: {
		width: "100%",
		aspectRatio: "16/9",
		borderColor: { default: tokens.colorBorder, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		padding: 0,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		position: "relative",
		overflow: "hidden",
		cursor: "pointer",
		textAlign: "left",
		transition: "border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease",
		":hover": { borderColor: "#4a4e54", transform: "translateY(-1px)" }
	},
	tileFocused: {
		borderColor: "rgba(228, 242, 34, 0.65)",
		boxShadow: `inset 0 0 0 1px rgba(228, 242, 34, 0.25), ${tokens.shadowOverlay}`
	},
	canvas: { width: "100%", height: "100%", display: "block", objectFit: "cover" },
	tileTop: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		display: "flex",
		justifyContent: "space-between",
		padding: "9px 10px",
		fontFamily: tokens.fontMono,
		fontSize: "11px",
		backgroundImage: "linear-gradient(rgba(8, 9, 10, 0.82), transparent)"
	},
	liveDot: { color: tokens.colorAccent },
	awaiting: {
		position: "absolute",
		inset: 0,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: "8px",
		color: tokens.colorTextSubtle,
		backgroundImage:
			"repeating-linear-gradient(-45deg, transparent, transparent 8px, rgba(255,255,255,.015) 8px, rgba(255,255,255,.015) 9px)",
		fontFamily: tokens.fontMono,
		fontSize: "11px",
		letterSpacing: ".08em"
	},
	tileStats: {
		display: "grid",
		gridTemplateColumns: "repeat(4, 1fr)",
		color: tokens.colorTextSubtle,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderTopWidth: 0,
		fontFamily: tokens.fontMono,
		fontSize: "11px",
		padding: "7px 9px",
		gap: "8px"
	},
	controls: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		boxShadow: tokens.shadowCard,
		padding: "16px",
		alignSelf: "start",
		position: "sticky",
		top: "16px"
	},
	panelLabel: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: "11px",
		margin: "0 0 6px"
	},
	panelTitle: {
		fontSize: "17px",
		fontWeight: 590,
		letterSpacing: "-0.01em",
		lineHeight: 1.25,
		margin: "0 0 22px",
		color: tokens.colorTextStrong
	},
	slider: {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
		marginBottom: "20px",
		color: tokens.colorTextMuted,
		fontSize: "11px",
		fontWeight: 500
	},
	viewMode: {
		display: "flex",
		flexDirection: "column",
		gap: "9px",
		marginBottom: "20px",
		color: tokens.colorTextMuted,
		fontSize: "11px",
		fontWeight: 500
	},
	resolution: {
		display: "flex",
		flexDirection: "column",
		gap: "9px",
		marginBottom: "20px",
		color: tokens.colorTextMuted,
		fontSize: "11px",
		fontWeight: 500
	},
	resolutionButton: {
		width: "25%",
		borderColor: { default: tokens.colorBorder, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		padding: "8px 2px",
		cursor: "pointer",
		fontSize: "11px",
		fontWeight: 500
	},
	modeButton: {
		width: "50%",
		borderColor: { default: tokens.colorBorder, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		padding: "9px 5px",
		cursor: "pointer",
		fontSize: "11px",
		fontWeight: 500
	},
	pipelineButton: {
		width: "33.333%",
		borderColor: { default: tokens.colorBorder, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		padding: "9px 2px",
		cursor: "pointer",
		fontSize: "11px",
		fontWeight: 500
	},
	modeButtonActive: {
		backgroundColor: "rgba(255, 255, 255, 0.08)",
		borderColor: "#4a4e54",
		color: tokens.colorTextStrong,
		":hover": { backgroundColor: "rgba(255, 255, 255, 0.08)", color: tokens.colorTextStrong }
	},
	pause: {
		width: "100%",
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorText,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)"
		},
		padding: "10px",
		cursor: "pointer",
		fontSize: "12px",
		fontWeight: 500
	},
	budgetNote: {
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		marginTop: "20px",
		paddingTop: "16px",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: "11px"
	},
	legend: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		marginTop: "18px",
		color: tokens.colorTextSubtle,
		fontSize: "11px"
	},
	legendGood: {
		display: "inline-block",
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		backgroundColor: tokens.colorSuccess,
		marginRight: "7px"
	},
	legendWarn: {
		display: "inline-block",
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		backgroundColor: tokens.colorWarning,
		marginRight: "7px"
	}
});
