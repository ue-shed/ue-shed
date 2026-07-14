import * as stylex from "@stylexjs/stylex";
import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { RendererCameraFrame, WorkbenchCameraMetrics } from "../main/preload.js";

interface TileTelemetry {
	readonly fps: number;
	readonly gap: number;
	readonly lastFrameAt: number;
	readonly presentationMs: number;
	readonly readbackMs: number;
	readonly sequence: number;
}

type CaptureResolution = CameraScheduleConfig["resolution"];

const resolutionDimensions: Readonly<Record<CaptureResolution, readonly [number, number]>> = {
	"160x90": [160, 90],
	"320x180": [320, 180],
	"640x360": [640, 360],
	"960x540": [960, 540],
	"1280x720": [1280, 720],
	"1920x1080": [1920, 1080],
	"2560x1440": [2560, 1440]
};

const resolutionOptions = Object.keys(resolutionDimensions) as ReadonlyArray<CaptureResolution>;

const defaultConfig: CameraScheduleConfig = {
	activeCameraCount: 8,
	backgroundFps: 2,
	captureBudgetPerTick: 2,
	focusedCameraIndex: 0,
	focusedFps: 8,
	paused: false,
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
				<span>CAM {String(props.index + 1).padStart(2, "0")}</span>
				<span {...stylex.props(styles.liveDot)}>LIVE</span>
			</div>
			<Show when={!props.frame}>
				<div {...stylex.props(styles.awaiting)}>
					<span>NO SIGNAL</span>
					<small>waiting for Unreal producer</small>
				</div>
			</Show>
		</button>
	);
}

export function CameraLab() {
	const [config, setConfig] = createSignal(defaultConfig);
	const [frames, setFrames] = createSignal<ReadonlyMap<number, RendererCameraFrame>>(new Map());
	const [telemetry, setTelemetry] = createSignal<ReadonlyMap<number, TileTelemetry>>(new Map());
	const [metrics, setMetrics] = createSignal<WorkbenchCameraMetrics>();
	const [presentationBudget, setPresentationBudget] = createSignal(80);
	const [status, setStatus] = createSignal<CameraStatus>();
	const [controlState, setControlState] = createSignal<"connected" | "unavailable" | "updating">(
		"unavailable"
	);
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

	const applyConfig = async (next: CameraScheduleConfig) => {
		setConfig(next);
		setControlState("updating");
		try {
			const nextStatus = await window.ueShed.configure(next);
			setStatus(nextStatus);
			setConfig(nextStatus.config);
			setControlState("connected");
		} catch {
			setControlState("unavailable");
		}
	};

	onMount(() => {
		const unsubscribe = window.ueShed.onFrame((frame) => {
			setFrames((current) => {
				const next = new Map(current);
				next.set(frame.cameraIndex, frame);
				return next;
			});
		});
		const timer = window.setInterval(
			() => void window.ueShed.getMetrics().then(setMetrics),
			750
		);
		void window.ueShed
			.getStatus()
			.then((value) => {
				setStatus(value);
				setConfig(value.config);
				setControlState("connected");
			})
			.catch(() => setControlState("unavailable"));
		void window.ueShed.setPresentationBudget(presentationBudget());
		onCleanup(() => {
			unsubscribe();
			window.clearInterval(timer);
		});
	});

	return (
		<main {...stylex.props(styles.shell)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>UE SHED / OBSERVATION SYSTEMS</p>
					<h1 {...stylex.props(styles.title)}>CAMERA LOAD LAB</h1>
				</div>
				<div {...stylex.props(styles.systemState)}>
					<span {...stylex.props(styles.pulse)} />
					{activeFeeds()}/{config().activeCameraCount} streaming ·{" "}
					{visibleCameraIndices().length} shown · {controlState()}
				</div>
			</header>

			<section {...stylex.props(styles.instrumentBar)}>
				<Metric label="AGGREGATE FPS" value={totalFps().toFixed(1)} />
				<Metric label="PIPE THROUGHPUT" value={`${throughput().toFixed(2)} MB/s`} />
				<Metric
					label="ELECTRON PRIVATE"
					value={`${metrics()?.electronPrivateMemoryMb.toFixed(0) ?? "—"} MB`}
					warn={(metrics()?.electronPrivateMemoryMb ?? 0) > 2_048}
				/>
				<Metric
					label="GPU PROCESS PRIVATE"
					value={`${metrics()?.gpuProcessPrivateMemoryMb.toFixed(0) ?? "—"} MB`}
					warn={(metrics()?.gpuProcessPrivateMemoryMb ?? 0) > 1_536}
				/>
				<Metric label="HOST FRAMES" value={String(metrics()?.framesReceived ?? 0)} />
				<Metric
					label="MALFORMED"
					value={String(metrics()?.malformedFrames ?? 0)}
					warn={(metrics()?.malformedFrames ?? 0) > 0}
				/>
				<Metric
					label="GPU/STAGE DROPS"
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
					<p {...stylex.props(styles.panelLabel)}>LOAD ENVELOPE</p>
					<h2 {...stylex.props(styles.panelTitle)}>Tune until it bends.</h2>
					<Slider
						label="ACTIVE CAMERAS"
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
					<Slider
						label="FOCUSED RATE"
						value={config().focusedFps}
						min={1}
						max={30}
						suffix="fps"
						onInput={(value) => void applyConfig({ ...config(), focusedFps: value })}
					/>
					<Slider
						label="BACKGROUND RATE"
						value={config().backgroundFps}
						min={0.5}
						max={30}
						step={0.5}
						suffix="fps"
						onInput={(value) => void applyConfig({ ...config(), backgroundFps: value })}
					/>
					<Slider
						label="CAPTURES / TICK"
						value={config().captureBudgetPerTick}
						min={1}
						max={32}
						suffix=""
						onInput={(value) =>
							void applyConfig({ ...config(), captureBudgetPerTick: value })
						}
					/>
					<Slider
						label="DISPLAY BUDGET"
						value={presentationBudget()}
						min={25}
						max={500}
						step={25}
						suffix="MB/s"
						onInput={(value) => {
							setPresentationBudget(value);
							void window.ueShed.setPresentationBudget(value);
						}}
					/>
					<div {...stylex.props(styles.resolution)}>
						<span>FRAME SIZE</span>
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
						<span>VIEWPOINT</span>
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
								ACTOR POV
							</button>
						</div>
					</div>
					<button
						type="button"
						onClick={() => void applyConfig({ ...config(), paused: !config().paused })}
						{...stylex.props(styles.pause)}
					>
						{config().paused ? "RESUME CAPTURE" : "PAUSE CAPTURE"}
					</button>
					<div {...stylex.props(styles.budgetNote)}>
						<strong>{config().resolution.replace("x", " × ")} · BGRA8</strong>
						<span>{estimatedRawThroughput().toFixed(2)} MB/s estimated raw</span>
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
		backgroundColor: "#0b0d0d",
		backgroundImage:
			"linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px)",
		backgroundSize: "24px 24px",
		padding: "24px 28px 30px"
	},
	header: {
		display: "flex",
		alignItems: "flex-end",
		justifyContent: "space-between",
		borderBottom: "1px solid #3b413e",
		paddingBottom: "18px"
	},
	eyebrow: { color: "#8f9992", fontSize: "10px", letterSpacing: "0.2em", margin: "0 0 7px" },
	title: {
		color: "#f0f2ed",
		fontFamily: "Workbench Mono, monospace",
		fontSize: "30px",
		fontWeight: 500,
		letterSpacing: "0.045em",
		lineHeight: 1,
		margin: 0
	},
	systemState: {
		alignItems: "center",
		color: "#b8c2ba",
		display: "flex",
		fontSize: "11px",
		gap: "9px",
		textTransform: "uppercase"
	},
	pulse: {
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		backgroundColor: "#b9f227",
		boxShadow: "0 0 14px #b9f227"
	},
	instrumentBar: {
		display: "grid",
		gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
		borderBottom: "1px solid #303532"
	},
	metric: {
		borderRight: "1px solid #303532",
		padding: "13px 14px",
		display: "flex",
		flexDirection: "column",
		gap: "5px",
		color: "#7d8780",
		fontSize: "9px",
		letterSpacing: ".12em"
	},
	metricWarn: { backgroundColor: "rgba(255, 110, 54, .1)", color: "#ff8c62" },
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
		border: "1px solid #303633",
		padding: 0,
		backgroundColor: "#101313",
		color: "#eef1eb",
		position: "relative",
		overflow: "hidden",
		cursor: "pointer",
		textAlign: "left",
		transition: "border-color 160ms ease, transform 160ms ease",
		":hover": { borderColor: "#717c74", transform: "translateY(-1px)" }
	},
	tileFocused: {
		borderColor: "#b9f227",
		boxShadow: "inset 0 0 0 1px #b9f227, 0 0 24px rgba(185,242,39,.08)"
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
		fontSize: "10px",
		backgroundImage: "linear-gradient(#080a0acc, transparent)"
	},
	liveDot: { color: "#b9f227", letterSpacing: ".12em" },
	awaiting: {
		position: "absolute",
		inset: 0,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: "8px",
		color: "#778079",
		backgroundImage:
			"repeating-linear-gradient(-45deg, transparent, transparent 8px, rgba(255,255,255,.018) 8px, rgba(255,255,255,.018) 9px)",
		fontSize: "12px",
		letterSpacing: ".15em"
	},
	tileStats: {
		display: "grid",
		gridTemplateColumns: "repeat(4, 1fr)",
		color: "#869088",
		border: "1px solid #292e2b",
		borderTop: 0,
		fontSize: "9px",
		padding: "7px 9px",
		gap: "8px"
	},
	controls: {
		border: "1px solid #343a36",
		backgroundColor: "#111413",
		padding: "18px",
		alignSelf: "start",
		position: "sticky",
		top: "18px"
	},
	panelLabel: { color: "#b9f227", fontSize: "9px", letterSpacing: ".18em", margin: "0 0 7px" },
	panelTitle: { fontSize: "18px", fontWeight: 500, lineHeight: 1.25, margin: "0 0 24px" },
	slider: {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
		marginBottom: "21px",
		color: "#aab2ac",
		fontSize: "10px",
		letterSpacing: ".08em"
	},
	viewMode: {
		display: "flex",
		flexDirection: "column",
		gap: "9px",
		marginBottom: "20px",
		color: "#aab2ac",
		fontSize: "10px",
		letterSpacing: ".08em"
	},
	resolution: {
		display: "flex",
		flexDirection: "column",
		gap: "9px",
		marginBottom: "20px",
		color: "#aab2ac",
		fontSize: "10px",
		letterSpacing: ".08em"
	},
	resolutionButton: {
		width: "25%",
		border: "1px solid #3a413d",
		backgroundColor: "transparent",
		color: "#7f8982",
		padding: "8px 2px",
		cursor: "pointer",
		fontSize: "8px",
		":hover": { color: "#e8ebe5", borderColor: "#717c74" }
	},
	modeButton: {
		width: "50%",
		border: "1px solid #3a413d",
		backgroundColor: "transparent",
		color: "#7f8982",
		padding: "9px 5px",
		cursor: "pointer",
		fontSize: "9px",
		":hover": { color: "#e8ebe5", borderColor: "#717c74" }
	},
	modeButtonActive: {
		color: "#0b0d0d",
		backgroundColor: "#b9f227",
		borderColor: "#b9f227",
		":hover": { color: "#0b0d0d", borderColor: "#b9f227" }
	},
	pause: {
		width: "100%",
		border: "1px solid #b9f227",
		color: "#b9f227",
		backgroundColor: "transparent",
		padding: "11px",
		cursor: "pointer",
		fontSize: "10px",
		letterSpacing: ".12em",
		":hover": { backgroundColor: "rgba(185,242,39,.08)" }
	},
	budgetNote: {
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		borderTop: "1px solid #323834",
		marginTop: "20px",
		paddingTop: "16px",
		color: "#7f8982",
		fontSize: "10px"
	},
	legend: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		marginTop: "18px",
		color: "#7f8982",
		fontSize: "9px"
	},
	legendGood: {
		display: "inline-block",
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		backgroundColor: "#b9f227",
		marginRight: "7px"
	},
	legendWarn: {
		display: "inline-block",
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		backgroundColor: "#ff713b",
		marginRight: "7px"
	}
});
