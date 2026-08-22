import * as stylex from "@stylexjs/stylex";
import type {
	NiagaraPreviewArtifact,
	NiagaraPreviewFailure,
	NiagaraPreviewRunManifest
} from "@ue-shed/niagara/browser";
import { Button, createEffectAction, PageHeader } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Option, Schema } from "effect";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch
} from "solid-js";
import type { NiagaraPreviewClientApi } from "./niagara-preview-client.js";
import { NiagaraPreviewIntent as NiagaraPreviewIntentSchema } from "./niagara-preview-client.js";

const defaultSystem = "/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion";

type RouteState =
	| { readonly status: "idle" }
	| { readonly status: "running" }
	| { readonly status: "failed"; readonly error: NiagaraPreviewFailure }
	| {
			readonly status: "ready";
			readonly manifest: NiagaraPreviewRunManifest;
			readonly manifestPath: string;
	  };

type FrameState =
	| { readonly status: "idle" }
	| { readonly status: "loading"; readonly index: number }
	| { readonly status: "failed"; readonly error: NiagaraPreviewFailure }
	| { readonly status: "ready"; readonly index: number; readonly url: string };

interface CachedFrame {
	readonly bytes: number;
	readonly url: string;
}

const maximumPlaybackCacheBytes = 64 * 1024 * 1024;
const minimumPlaybackIntervalMilliseconds = 16;

function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatSeconds(seconds: number): string {
	return `${seconds.toFixed(seconds < 10 ? 3 : 2)}s`;
}

function clientFailure(cause: Cause.Cause<unknown>): NiagaraPreviewFailure {
	return {
		code: "process_failed",
		message: Cause.pretty(cause),
		recovery: "Restart Workbench, verify the selected project, and retry the preview.",
		retrySafe: true,
		stage: "capture"
	};
}

export function NiagaraPreviewRoute(props: { readonly client: NiagaraPreviewClientApi }) {
	const runAction = createEffectAction();
	const frameAction = createEffectAction();
	const [state, setState] = createSignal<RouteState>({ status: "idle" });
	const [frameState, setFrameState] = createSignal<FrameState>({ status: "idle" });
	const [systemObjectPath, setSystemObjectPath] = createSignal(defaultSystem);
	const [captureMode, setCaptureMode] = createSignal<"component_only" | "full_scene">(
		"component_only"
	);
	const [width, setWidth] = createSignal("512");
	const [height, setHeight] = createSignal("512");
	const [frameCount, setFrameCount] = createSignal("12");
	const [duration, setDuration] = createSignal("1");
	const [simulationFps, setSimulationFps] = createSignal("60");
	const [startSeconds, setStartSeconds] = createSignal("0");
	const [isPlaying, setIsPlaying] = createSignal(false);
	const [bufferingFrameIndex, setBufferingFrameIndex] = createSignal<number | undefined>();
	const frameCache = new Map<number, CachedFrame>();
	let cachedBytes = 0;

	const candidateIntent = createMemo(() =>
		Schema.decodeUnknownOption(NiagaraPreviewIntentSchema)({
			settings: {
				captureMode: captureMode(),
				durationSeconds: Number(duration()),
				frameCount: Number(frameCount()),
				height: Number(height()),
				simulationFramesPerSecond: Number(simulationFps()),
				startSeconds: Number(startSeconds()),
				width: Number(width())
			},
			systemObjectPath: systemObjectPath()
		})
	);
	const readyRun = createMemo(() => {
		const current = state();
		return current.status === "ready" ? current : undefined;
	});
	const selectedArtifact = createMemo(() => {
		const current = readyRun();
		const frame = frameState();
		if (current === undefined || frame.status === "idle" || frame.status === "failed") {
			return undefined;
		}
		return current.manifest.artifacts.find(({ index }) => index === frame.index);
	});

	const clearFrameCache = () => {
		for (const frame of frameCache.values()) URL.revokeObjectURL(frame.url);
		frameCache.clear();
		cachedBytes = 0;
	};
	onCleanup(clearFrameCache);

	const cacheFrame = (artifact: NiagaraPreviewArtifact, bytes: Uint8Array): string => {
		const existing = frameCache.get(artifact.index);
		if (existing !== undefined) return existing.url;
		const imageBuffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(imageBuffer).set(bytes);
		const url = URL.createObjectURL(new Blob([imageBuffer], { type: "image/png" }));
		frameCache.set(artifact.index, { bytes: artifact.bytes, url });
		cachedBytes += artifact.bytes;
		return url;
	};

	const trimFrameCache = (preserveIndex: number): void => {
		for (const [index, frame] of frameCache) {
			if (cachedBytes <= maximumPlaybackCacheBytes) return;
			if (index === preserveIndex) continue;
			URL.revokeObjectURL(frame.url);
			frameCache.delete(index);
			cachedBytes -= frame.bytes;
		}
	};

	const loadFrame = (
		manifestPath: string,
		artifact: NiagaraPreviewArtifact,
		keepCurrentVisible = false
	): void => {
		const cached = frameCache.get(artifact.index);
		if (cached !== undefined) {
			frameAction.cancel();
			setBufferingFrameIndex(undefined);
			setFrameState({ index: artifact.index, status: "ready", url: cached.url });
			return;
		}
		if (!keepCurrentVisible || frameState().status !== "ready") {
			setFrameState({ index: artifact.index, status: "loading" });
		}
		setBufferingFrameIndex(artifact.index);
		frameAction.run(props.client.frame({ manifestPath, relativePath: artifact.relativePath }), {
			onFailure: (cause) => {
				setBufferingFrameIndex(undefined);
				setIsPlaying(false);
				setFrameState({ error: clientFailure(cause), status: "failed" });
			},
			onSuccess: (result) => {
				setBufferingFrameIndex(undefined);
				if (result.status === "failed") {
					setIsPlaying(false);
					setFrameState({ error: result.error, status: "failed" });
					return;
				}
				const bytes = new Uint8Array(result.bytes);
				const url = cacheFrame(artifact, bytes);
				trimFrameCache(artifact.index);
				setFrameState({ index: artifact.index, status: "ready", url });
			}
		});
	};

	const loadPlayback = (
		manifestPath: string,
		artifacts: ReadonlyArray<NiagaraPreviewArtifact>
	): void => {
		const first = artifacts[0];
		if (first === undefined) return;
		const totalBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
		if (totalBytes > maximumPlaybackCacheBytes) {
			setIsPlaying(true);
			loadFrame(manifestPath, first);
			return;
		}

		setFrameState({ index: first.index, status: "loading" });
		setBufferingFrameIndex(first.index);
		frameAction.run(
			Effect.forEach(
				artifacts,
				(artifact) =>
					props.client
						.frame({ manifestPath, relativePath: artifact.relativePath })
						.pipe(Effect.map((result) => ({ artifact, result }))),
				{ concurrency: 4 }
			),
			{
				onFailure: (cause) => {
					setBufferingFrameIndex(undefined);
					setFrameState({ error: clientFailure(cause), status: "failed" });
				},
				onSuccess: (loaded) => {
					setBufferingFrameIndex(undefined);
					const failed = loaded.find(({ result }) => result.status === "failed");
					if (failed?.result.status === "failed") {
						setFrameState({ error: failed.result.error, status: "failed" });
						return;
					}
					for (const { artifact, result } of loaded) {
						if (result.status === "ready") {
							cacheFrame(artifact, new Uint8Array(result.bytes));
						}
					}
					const firstUrl = frameCache.get(first.index)?.url;
					if (firstUrl === undefined) return;
					setFrameState({ index: first.index, status: "ready", url: firstUrl });
					setIsPlaying(true);
				}
			}
		);
	};

	createEffect(() => {
		const currentRun = readyRun();
		const currentFrame = frameState();
		if (
			currentRun === undefined ||
			currentFrame.status !== "ready" ||
			!isPlaying() ||
			bufferingFrameIndex() !== undefined ||
			currentRun.manifest.artifacts.length < 2
		) {
			return;
		}
		const artifacts = currentRun.manifest.artifacts;
		const position = artifacts.findIndex(({ index }) => index === currentFrame.index);
		const next = artifacts[(position + 1) % artifacts.length];
		if (next === undefined) return;
		const interval = Math.max(
			minimumPlaybackIntervalMilliseconds,
			1000 / currentRun.manifest.effectiveSettings.playbackFramesPerSecond
		);
		const timeout = window.setTimeout(
			() => loadFrame(currentRun.manifestPath, next, true),
			interval
		);
		onCleanup(() => window.clearTimeout(timeout));
	});

	const run = () => {
		const decoded = candidateIntent();
		if (Option.isNone(decoded)) return;
		setState({ status: "running" });
		setIsPlaying(false);
		setBufferingFrameIndex(undefined);
		frameAction.cancel();
		setFrameState({ status: "idle" });
		clearFrameCache();
		runAction.run(props.client.run(decoded.value), {
			onFailure: (cause) => setState({ error: clientFailure(cause), status: "failed" }),
			onSuccess: (result) => {
				if (result.status === "failed") {
					setState({ error: result.error, status: "failed" });
					return;
				}
				setState({
					manifest: result.manifest,
					manifestPath: result.manifestPath,
					status: "ready"
				});
				loadPlayback(result.manifestPath, result.manifest.artifacts);
			}
		});
	};

	return (
		<main {...stylex.props(styles.page)}>
			<PageHeader
				eyebrow="Niagara Preview · portable render evidence"
				actions={
					<Button
						tone="primary"
						disabled={Option.isNone(candidateIntent()) || state().status === "running"}
						onClick={run}
					>
						{state().status === "running" ? "Rendering…" : "Capture preview"}
					</Button>
				}
			/>

			<section {...stylex.props(styles.hero)}>
				<div {...stylex.props(styles.heroCopy)}>
					<span {...stylex.props(styles.sequence)}>FX / FRAME EVIDENCE / 01</span>
					<h1 {...stylex.props(styles.heroTitle)}>Proof, outside the editor.</h1>
					<p {...stylex.props(styles.heroDescription)}>
						Render a saved Niagara Baker view into an immutable, hashed PNG sequence.
						The source system remains untouched.
					</p>
				</div>
				<div {...stylex.props(styles.promise)}>
					<span>CAPTURE CONTRACT</span>
					<strong>STRAIGHT ALPHA · sRGB</strong>
					<small>Isolated preview scene · deterministic desired age</small>
				</div>
			</section>

			<div {...stylex.props(styles.workspace)}>
				<aside aria-label="Niagara capture settings" {...stylex.props(styles.controls)}>
					<header {...stylex.props(styles.panelHeader)}>
						<span>INPUT / SYSTEM</span>
						<span>{Option.isSome(candidateIntent()) ? "VALID" : "CHECK INPUT"}</span>
					</header>
					<label {...stylex.props(styles.field, styles.systemField)}>
						<span>Niagara System object path</span>
						<input
							{...stylex.props(styles.input)}
							value={systemObjectPath()}
							onInput={(event) => setSystemObjectPath(event.currentTarget.value)}
							spellcheck={false}
						/>
					</label>
					<div {...stylex.props(styles.fieldGrid)}>
						<NumberField label="Width" value={width()} onInput={setWidth} />
						<NumberField label="Height" value={height()} onInput={setHeight} />
						<NumberField label="Frames" value={frameCount()} onInput={setFrameCount} />
						<NumberField
							label="Duration · s"
							value={duration()}
							onInput={setDuration}
						/>
						<NumberField
							label="Simulation · fps"
							value={simulationFps()}
							onInput={setSimulationFps}
						/>
						<NumberField
							label="Start · s"
							value={startSeconds()}
							onInput={setStartSeconds}
						/>
					</div>
					<label {...stylex.props(styles.field)}>
						<span>Scene policy</span>
						<select
							{...stylex.props(styles.input)}
							value={captureMode()}
							onChange={(event) =>
								setCaptureMode(
									event.currentTarget.value === "full_scene"
										? "full_scene"
										: "component_only"
								)
							}
						>
							<option value="component_only">Component only</option>
							<option value="full_scene">Full preview scene</option>
						</select>
					</label>
					<div {...stylex.props(styles.boundaryNote)}>
						<strong>SEPARATELY ENABLED</strong>
						<span>
							The selected project must expose the UEShedNiagara Editor plugin and a
							render-capable Unreal installation.
						</span>
					</div>
				</aside>

				<section aria-label="Niagara preview evidence" {...stylex.props(styles.stage)}>
					<Switch>
						<Match when={state().status === "idle"}>
							<EmptyStage />
						</Match>
						<Match when={state().status === "running"}>
							<div role="status" aria-live="polite" {...stylex.props(styles.running)}>
								<span {...stylex.props(styles.renderOrb)} />
								<strong>Advancing desired age.</strong>
								<p>
									Unreal is compiling and capturing offscreen. The completed run
									only appears after every artifact validates.
								</p>
							</div>
						</Match>
						<Match when={state().status === "failed"}>
							{(() => {
								const current = state();
								return current.status === "failed" ? (
									<FailurePanel error={current.error} />
								) : null;
							})()}
						</Match>
						<Match when={readyRun()}>
							{(current) => (
								<RunEvidence
									run={current()}
									frameState={frameState()}
									isPlaying={isPlaying()}
									bufferingFrameIndex={bufferingFrameIndex()}
									selectedArtifact={selectedArtifact()}
									onSelect={(artifact) =>
										loadFrame(current().manifestPath, artifact)
									}
									onTogglePlayback={() => setIsPlaying((playing) => !playing)}
									onRestart={() => {
										const first = current().manifest.artifacts[0];
										if (first !== undefined) {
											loadFrame(current().manifestPath, first);
											setIsPlaying(true);
										}
									}}
								/>
							)}
						</Match>
					</Switch>
				</section>
			</div>
		</main>
	);
}

function NumberField(props: {
	readonly label: string;
	readonly value: string;
	readonly onInput: (value: string) => void;
}) {
	return (
		<label {...stylex.props(styles.field)}>
			<span>{props.label}</span>
			<input
				{...stylex.props(styles.input)}
				type="number"
				value={props.value}
				onInput={(event) => props.onInput(event.currentTarget.value)}
			/>
		</label>
	);
}

function EmptyStage() {
	return (
		<div {...stylex.props(styles.emptyStage)}>
			<div {...stylex.props(styles.reticle)}>
				<i />
				<i />
			</div>
			<span>NO RUN SELECTED</span>
			<h2>The viewport is waiting for evidence.</h2>
			<p>Choose a saved system and capture a bounded frame sequence.</p>
		</div>
	);
}

function FailurePanel(props: { readonly error: NiagaraPreviewFailure }) {
	return (
		<div role="alert" {...stylex.props(styles.failure)}>
			<span>
				{props.error.stage.toUpperCase()} / {props.error.code}
			</span>
			<h2>{props.error.message}</h2>
			<p>{props.error.recovery}</p>
			<small>{props.error.retrySafe ? "SAFE TO RETRY" : "INSPECT BEFORE RETRY"}</small>
		</div>
	);
}

function RunEvidence(props: {
	readonly run: Extract<RouteState, { readonly status: "ready" }>;
	readonly frameState: FrameState;
	readonly isPlaying: boolean;
	readonly bufferingFrameIndex: number | undefined;
	readonly selectedArtifact: NiagaraPreviewArtifact | undefined;
	readonly onSelect: (artifact: NiagaraPreviewArtifact) => void;
	readonly onTogglePlayback: () => void;
	readonly onRestart: () => void;
}) {
	const settings = () => props.run.manifest.effectiveSettings;
	return (
		<div {...stylex.props(styles.evidence)}>
			<header {...stylex.props(styles.evidenceHeader)}>
				<div>
					<span>RUN / {props.run.manifest.runId.slice(0, 8)}</span>
					<strong>{props.run.manifest.systemObjectPath}</strong>
				</div>
				<span {...stylex.props(styles.verified)}>● VERIFIED</span>
			</header>
			<div {...stylex.props(styles.viewer)}>
				<div {...stylex.props(styles.playbackControls)}>
					<button
						type="button"
						aria-label={props.isPlaying ? "Pause preview" : "Play preview"}
						aria-pressed={props.isPlaying}
						onClick={props.onTogglePlayback}
						{...stylex.props(
							styles.transportButton,
							props.isPlaying && styles.transportActive
						)}
					>
						{props.isPlaying ? "Ⅱ PAUSE" : "▶ PLAY"}
					</button>
					<button
						type="button"
						aria-label="Restart preview"
						onClick={props.onRestart}
						{...stylex.props(styles.transportButton)}
					>
						↺ RESTART
					</button>
					<Show when={props.bufferingFrameIndex !== undefined}>
						<span {...stylex.props(styles.bufferingReadout)}>
							BUFFERING{" "}
							{String((props.bufferingFrameIndex ?? 0) + 1).padStart(2, "0")}
						</span>
					</Show>
				</div>
				<Switch>
					<Match when={props.frameState.status === "loading"}>
						<div role="status" {...stylex.props(styles.frameLoading)}>
							READING HASHED FRAME
						</div>
					</Match>
					<Match when={props.frameState.status === "failed"}>
						<div role="alert" {...stylex.props(styles.frameFailure)}>
							Frame validation failed. Select another frame or recapture the run.
						</div>
					</Match>
					<Match when={props.frameState.status === "ready"}>
						{(() => {
							const current = props.frameState;
							return current.status === "ready" ? (
								<img
									{...stylex.props(styles.previewImage)}
									src={current.url}
									alt={`Niagara preview frame ${current.index}`}
								/>
							) : null;
						})()}
					</Match>
				</Switch>
				<div {...stylex.props(styles.viewerReadout)}>
					<span>FRAME {String(props.selectedArtifact?.index ?? 0).padStart(4, "0")}</span>
					<span>{formatSeconds(props.selectedArtifact?.timeSeconds ?? 0)}</span>
				</div>
			</div>
			<div aria-label="Frame sequence" {...stylex.props(styles.timeline)}>
				<For each={props.run.manifest.artifacts}>
					{(artifact) => (
						<button
							type="button"
							aria-label={`Show frame ${artifact.index}`}
							onClick={() => props.onSelect(artifact)}
							{...stylex.props(
								styles.frameTick,
								props.selectedArtifact?.index === artifact.index &&
									styles.frameTickActive
							)}
						>
							<i
								style={{
									height: `${Math.max(8, artifact.nonTransparentPixelFraction * 100)}%`
								}}
							/>
							<span>{String(artifact.index + 1).padStart(2, "0")}</span>
						</button>
					)}
				</For>
			</div>
			<div {...stylex.props(styles.facts)}>
				<Fact label="Dimensions" value={`${settings().width} × ${settings().height}`} />
				<Fact label="Frames" value={String(settings().frameCount)} />
				<Fact
					label="Playback"
					value={`${settings().playbackFramesPerSecond.toFixed(1)} fps`}
				/>
				<Fact label="Engine" value={props.run.manifest.producer.engineVersion} />
				<Fact label="Projection" value={props.run.manifest.camera.projection} />
				<Fact
					label="Selected"
					value={props.selectedArtifact ? humanBytes(props.selectedArtifact.bytes) : "—"}
				/>
			</div>
			<Show when={props.run.manifest.diagnostics.length > 0}>
				<div {...stylex.props(styles.diagnostics)}>
					<For each={props.run.manifest.diagnostics}>
						{(diagnostic) => (
							<p>
								<strong>{diagnostic.code}</strong> · {diagnostic.message}
							</p>
						)}
					</For>
				</div>
			</Show>
			<footer {...stylex.props(styles.manifestPath)}>
				MANIFEST · {props.run.manifestPath}
			</footer>
		</div>
	);
}

function Fact(props: { readonly label: string; readonly value: string }) {
	return (
		<div {...stylex.props(styles.fact)}>
			<span>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	);
}

const orbit = stylex.keyframes({ to: { transform: "rotate(360deg)" } });
const breathe = stylex.keyframes({ "0%, 100%": { opacity: 0.35 }, "50%": { opacity: 1 } });

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: "24px 30px 38px",
		backgroundColor: "#090c0c",
		backgroundImage:
			"radial-gradient(circle at 72% 6%, #17323199 0, transparent 33%), linear-gradient(#60a4a00a 1px, transparent 1px), linear-gradient(90deg, #60a4a00a 1px, transparent 1px)",
		backgroundSize: "auto, 32px 32px, 32px 32px",
		color: tokens.colorText
	},
	hero: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, .6fr)",
		gap: 16,
		alignItems: "end",
		padding: "14px 0 24px",
		borderBottom: "1px solid #31504d"
	},
	heroCopy: { maxWidth: 760 },
	sequence: { color: "#61d4c7", fontSize: 8, fontWeight: 800, letterSpacing: ".22em" },
	heroTitle: {
		margin: "9px 0 7px",
		color: "#e7f2ef",
		fontFamily: tokens.fontDisplay,
		fontSize: 38,
		fontWeight: 400,
		letterSpacing: "-.035em"
	},
	heroDescription: { maxWidth: 620, margin: 0, color: "#829995", fontSize: 10, lineHeight: 1.7 },
	promise: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		padding: "14px 16px",
		borderLeft: "2px solid #61d4c7",
		backgroundColor: "#10201fcf",
		color: "#789590",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	workspace: {
		display: "grid",
		gridTemplateColumns: "minmax(285px, 340px) minmax(0, 1fr)",
		gap: 14,
		marginTop: 14
	},
	controls: { border: "1px solid #2c4441", backgroundColor: "#0d1312e8" },
	panelHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "10px 12px",
		borderBottom: "1px solid #2c4441",
		color: "#66847f",
		fontSize: 8,
		letterSpacing: ".14em"
	},
	fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr" },
	field: {
		display: "grid",
		gap: 7,
		padding: 12,
		borderBottom: "1px solid #21302e",
		color: "#708984",
		fontSize: 8,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	input: {
		width: "100%",
		minWidth: 0,
		boxSizing: "border-box",
		padding: "9px 10px",
		border: "1px solid #2c4441",
		borderRadius: 0,
		outline: { default: "none", ":focus": "1px solid #61d4c7" },
		backgroundColor: "#080d0c",
		color: "#cae0dc",
		fontFamily: tokens.fontBody,
		fontSize: 9
	},
	systemField: { paddingTop: 16, paddingBottom: 16 },
	boundaryNote: {
		display: "grid",
		gap: 7,
		margin: 12,
		padding: 12,
		border: "1px dashed #31504c",
		color: "#75918b",
		fontSize: 8,
		lineHeight: 1.55
	},
	stage: {
		minHeight: 620,
		border: "1px solid #2c4441",
		backgroundColor: "#080b0bea",
		overflow: "hidden"
	},
	emptyStage: {
		minHeight: 620,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		color: "#5f7773",
		textAlign: "center"
	},
	reticle: {
		position: "relative",
		width: 126,
		height: 126,
		marginBottom: 24,
		border: "1px solid #29413e",
		borderRadius: "50%",
		boxShadow: "0 0 80px #2d77702e"
	},
	running: {
		minHeight: 620,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		padding: 36,
		color: "#77918d",
		textAlign: "center"
	},
	renderOrb: {
		width: 92,
		height: 92,
		marginBottom: 26,
		border: "1px solid #315a55",
		borderTopColor: "#62dfcf",
		borderRightColor: "#62dfcf",
		borderRadius: "50%",
		boxShadow: "inset 0 0 34px #2fd8c51f, 0 0 64px #2fd8c51f",
		animationName: orbit,
		animationDuration: "2.4s",
		animationIterationCount: "infinite",
		animationTimingFunction: "linear"
	},
	failure: {
		maxWidth: 680,
		margin: "72px auto",
		padding: 26,
		borderLeft: "3px solid #d16b5e",
		backgroundColor: "#211110",
		color: "#d99a91"
	},
	evidence: { minHeight: 620 },
	evidenceHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 18,
		padding: "13px 16px",
		borderBottom: "1px solid #2c4441",
		color: "#6f8c87",
		fontSize: 8,
		letterSpacing: ".11em"
	},
	verified: { color: "#70ddca", whiteSpace: "nowrap" },
	viewer: {
		position: "relative",
		height: 390,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "#050706",
		backgroundImage:
			"linear-gradient(45deg, #111918 25%, transparent 25%), linear-gradient(-45deg, #111918 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #111918 75%), linear-gradient(-45deg, transparent 75%, #111918 75%)",
		backgroundSize: "18px 18px",
		backgroundPosition: "0 0, 0 9px, 9px -9px, -9px 0"
	},
	viewerReadout: {
		position: "absolute",
		left: 12,
		right: 12,
		bottom: 10,
		display: "flex",
		justifyContent: "space-between",
		color: "#63817c",
		fontSize: 8,
		letterSpacing: ".14em"
	},
	playbackControls: {
		position: "absolute",
		top: 10,
		left: 12,
		right: 12,
		zIndex: 1,
		display: "flex",
		alignItems: "center",
		gap: 6
	},
	transportButton: {
		padding: "7px 9px",
		border: "1px solid #31504d",
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "#09100fe6", ":hover": "#142623" },
		color: "#78958f",
		fontFamily: tokens.fontBody,
		fontSize: 7,
		fontWeight: 800,
		letterSpacing: ".12em",
		cursor: "pointer"
	},
	transportActive: { borderColor: "#4fb9ad", color: "#8be7dc" },
	bufferingReadout: {
		marginLeft: "auto",
		color: "#67b7ad",
		fontSize: 7,
		letterSpacing: ".14em",
		animationName: breathe,
		animationDuration: "1.3s",
		animationIterationCount: "infinite"
	},
	previewImage: { display: "block", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
	frameLoading: {
		color: "#67b7ad",
		fontSize: 9,
		letterSpacing: ".18em",
		animationName: breathe,
		animationDuration: "1.3s",
		animationIterationCount: "infinite"
	},
	frameFailure: { padding: 18, color: "#d58275" },
	timeline: {
		height: 72,
		display: "flex",
		alignItems: "stretch",
		gap: 3,
		padding: "8px 12px",
		borderTop: "1px solid #263b38",
		borderBottom: "1px solid #263b38",
		overflowX: "auto"
	},
	frameTick: {
		minWidth: 30,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "flex-end",
		gap: 4,
		padding: "3px 4px",
		border: "1px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "#13211f" },
		color: "#55716c",
		fontSize: 7,
		cursor: "pointer"
	},
	frameTickActive: { borderColor: "#4fb9ad", backgroundColor: "#112421", color: "#86e0d5" },
	facts: {
		display: "grid",
		gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
		borderBottom: "1px solid #263b38"
	},
	fact: {
		minWidth: 0,
		padding: "11px 12px",
		borderRight: "1px solid #263b38",
		color: "#607a75",
		fontSize: 7,
		letterSpacing: ".1em"
	},
	diagnostics: {
		padding: "8px 14px",
		borderBottom: "1px solid #263b38",
		color: "#d6a363",
		fontSize: 8
	},
	manifestPath: {
		padding: "10px 14px",
		color: "#415954",
		fontSize: 7,
		letterSpacing: ".06em",
		overflowWrap: "anywhere"
	}
});
