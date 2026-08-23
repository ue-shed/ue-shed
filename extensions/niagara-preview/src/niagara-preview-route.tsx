import * as stylex from "@stylexjs/stylex";
import type {
	NiagaraPreviewArtifact,
	NiagaraPreviewFailure,
	NiagaraPreviewRunManifest
} from "@ue-shed/niagara/browser";
import { Button, createEffectAction } from "@ue-shed/ui";
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

type FailureParts = {
	readonly summary: string;
	readonly technical: string | undefined;
};

// A capture failure carries either one sentence or a pretty-printed Cause. Show the first line and
// keep the rest behind a disclosure so a failure never reads as a stack trace.
function failureParts(message: string): FailureParts {
	if (message.length <= 160 && !message.includes("\n")) {
		return { summary: message, technical: undefined };
	}
	const [firstLine] = message.split("\n");
	return { summary: (firstLine ?? message).slice(0, 160).trim(), technical: message };
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
	const failedRun = createMemo(() => {
		const current = state();
		return current.status === "failed" ? current : undefined;
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
			<header {...stylex.props(styles.header)}>
				<div>
					<h1 {...stylex.props(styles.title)}>Niagara preview</h1>
					<p {...stylex.props(styles.intro)}>
						Bake a saved Baker view into a hashed PNG sequence you can scrub and share
						without opening the editor.
					</p>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<Button
						tone="primary"
						disabled={Option.isNone(candidateIntent()) || state().status === "running"}
						onClick={run}
					>
						{state().status === "running" ? "Rendering…" : "Capture preview"}
					</Button>
				</div>
			</header>

			<div {...stylex.props(styles.workspace)}>
				<aside aria-label="Niagara capture settings" {...stylex.props(styles.controls)}>
					<header {...stylex.props(styles.panelHeader)}>
						<h2 {...stylex.props(styles.panelTitle)}>Capture settings</h2>
						<span
							{...stylex.props(
								styles.panelStatus,
								Option.isNone(candidateIntent()) && styles.panelStatusCheck
							)}
						>
							{Option.isSome(candidateIntent()) ? "Ready" : "Check these values"}
						</span>
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
							label="Duration (s)"
							value={duration()}
							onInput={setDuration}
						/>
						<NumberField
							label="Simulation (fps)"
							value={simulationFps()}
							onInput={setSimulationFps}
						/>
						<NumberField
							label="Start (s)"
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
						<strong {...stylex.props(styles.boundaryTitle)}>Plugin required</strong>
						<span>
							The selected project must expose the UEShedNiagara editor plugin and a
							render-capable Unreal install.
						</span>
					</div>
					<p {...stylex.props(styles.contractNote)}>
						Frames come out straight-alpha sRGB, rendered in an isolated preview scene
						at a deterministic age. The source system is never modified.
					</p>
				</aside>

				<section aria-label="Niagara preview frames" {...stylex.props(styles.stage)}>
					<Switch>
						<Match when={state().status === "idle"}>
							<EmptyStage />
						</Match>
						<Match when={state().status === "running"}>
							<div role="status" aria-live="polite" {...stylex.props(styles.running)}>
								<span {...stylex.props(styles.renderOrb)} />
								<strong {...stylex.props(styles.runningTitle)}>
									Rendering frames
								</strong>
								<p {...stylex.props(styles.runningDetail)}>
									Unreal is capturing offscreen. Frames appear once every one of
									them validates.
								</p>
							</div>
						</Match>
						<Match when={failedRun()}>
							{(failed) => <FailurePanel error={failed().error} onRetry={run} />}
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
			<h2 {...stylex.props(styles.emptyTitle)}>No frames yet</h2>
			<p {...stylex.props(styles.emptyDetail)}>
				Point at a saved Niagara System, choose how many frames you want, and capture a
				preview.
			</p>
		</div>
	);
}

function FailurePanel(props: {
	readonly error: NiagaraPreviewFailure;
	readonly onRetry: () => void;
}) {
	const parts = createMemo(() => failureParts(props.error.message));
	return (
		<div role="alert" {...stylex.props(styles.failure)}>
			<strong {...stylex.props(styles.failureTitle)}>Couldn’t capture this preview</strong>
			<p {...stylex.props(styles.failureMessage)}>{parts().summary}</p>
			<p {...stylex.props(styles.failureRecovery)}>{props.error.recovery}</p>
			<Show
				when={props.error.retrySafe}
				fallback={
					<p {...stylex.props(styles.failureRecovery)}>
						Check the cause below before capturing again.
					</p>
				}
			>
				<div {...stylex.props(styles.failureActions)}>
					<Button tone="secondary" onClick={props.onRetry}>
						Retry
					</Button>
				</div>
			</Show>
			<details {...stylex.props(styles.failureDetails)}>
				<summary>Technical details</summary>
				<code>
					{props.error.stage} · {props.error.code}
					{parts().technical === undefined ? "" : `\n${parts().technical}`}
				</code>
			</details>
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
				<div {...stylex.props(styles.evidenceIdentity)}>
					<strong {...stylex.props(styles.evidenceSystem)}>
						{props.run.manifest.systemObjectPath}
					</strong>
					<code {...stylex.props(styles.evidenceRunId)}>
						Run {props.run.manifest.runId.slice(0, 8)}
					</code>
				</div>
				<span {...stylex.props(styles.verified)}>Verified</span>
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
						{props.isPlaying ? "Pause" : "Play"}
					</button>
					<button
						type="button"
						aria-label="Restart preview"
						onClick={props.onRestart}
						{...stylex.props(styles.transportButton)}
					>
						Restart
					</button>
					<Show when={props.bufferingFrameIndex !== undefined}>
						<span {...stylex.props(styles.bufferingReadout)}>
							Buffering{" "}
							{String((props.bufferingFrameIndex ?? 0) + 1).padStart(2, "0")}
						</span>
					</Show>
				</div>
				<Switch>
					<Match when={props.frameState.status === "loading"}>
						<div role="status" {...stylex.props(styles.frameLoading)}>
							Reading frame…
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
					<span>
						Frame{" "}
						<code {...stylex.props(styles.readoutValue)}>
							{String(props.selectedArtifact?.index ?? 0).padStart(4, "0")}
						</code>
					</span>
					<code {...stylex.props(styles.readoutValue)}>
						{formatSeconds(props.selectedArtifact?.timeSeconds ?? 0)}
					</code>
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
								<code {...stylex.props(styles.diagnosticCode)}>
									{diagnostic.code}
								</code>{" "}
								{diagnostic.message}
							</p>
						)}
					</For>
				</div>
			</Show>
			<footer {...stylex.props(styles.manifestPath)}>
				<span>Manifest</span>
				<code>{props.run.manifestPath}</code>
			</footer>
		</div>
	);
}

function Fact(props: { readonly label: string; readonly value: string }) {
	return (
		<div {...stylex.props(styles.fact)}>
			<span>{props.label}</span>
			<strong {...stylex.props(styles.factValue)}>{props.value}</strong>
		</div>
	);
}

const orbit = stylex.keyframes({ to: { transform: "rotate(360deg)" } });
const breathe = stylex.keyframes({ "0%, 100%": { opacity: 0.35 }, "50%": { opacity: 1 } });

const styles = stylex.create({
	page: {
		backgroundColor: tokens.colorCanvas,
		boxSizing: "border-box",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		minHeight: "calc(100vh - 52px)",
		padding: "20px 26px 30px"
	},
	header: {
		alignItems: "flex-start",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: tokens.space4,
		justifyContent: "space-between",
		marginBottom: tokens.space5,
		paddingBottom: tokens.space4
	},
	headerActions: { alignItems: "center", display: "flex", gap: tokens.space2 },
	title: {
		color: tokens.colorTextStrong,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em",
		margin: 0
	},
	intro: {
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.5,
		margin: "4px 0 0",
		maxWidth: 560
	},
	workspace: {
		display: "grid",
		gap: tokens.space4,
		gridTemplateColumns: "minmax(285px, 340px) minmax(0, 1fr)"
	},
	controls: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		overflow: "hidden"
	},
	panelHeader: {
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: tokens.space2,
		justifyContent: "space-between",
		padding: "12px 14px"
	},
	panelTitle: {
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 590,
		letterSpacing: "-0.01em",
		margin: 0
	},
	panelStatus: { color: tokens.colorTextSubtle, fontSize: 11, fontWeight: 500 },
	panelStatusCheck: { color: tokens.colorWarning },
	fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr" },
	field: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextMuted,
		display: "grid",
		fontSize: 11,
		fontWeight: 500,
		gap: 6,
		padding: 12
	},
	input: {
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: { default: tokens.colorBorder, ":focus": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		boxSizing: "border-box",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		minWidth: 0,
		outline: "none",
		padding: "7px 9px",
		width: "100%"
	},
	systemField: { paddingBottom: 14, paddingTop: 14 },
	boundaryNote: {
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		display: "grid",
		fontSize: 12,
		gap: 4,
		lineHeight: 1.5,
		margin: 12,
		padding: 12
	},
	boundaryTitle: { color: tokens.colorTextStrong, fontSize: 13, fontWeight: 590 },
	contractNote: {
		color: tokens.colorTextFaint,
		fontSize: 11,
		lineHeight: 1.55,
		margin: "0 12px 14px"
	},
	stage: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		minHeight: 620,
		overflow: "hidden"
	},
	emptyStage: {
		alignItems: "center",
		color: tokens.colorTextMuted,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		minHeight: 620,
		padding: 36,
		textAlign: "center"
	},
	emptyTitle: {
		color: tokens.colorTextStrong,
		fontSize: 17,
		fontWeight: 590,
		letterSpacing: "-0.01em",
		margin: 0
	},
	emptyDetail: { fontSize: 13, lineHeight: 1.6, margin: "8px 0 0", maxWidth: 380 },
	reticle: {
		borderColor: tokens.colorBorder,
		borderRadius: "50%",
		borderStyle: "solid",
		borderWidth: 1,
		height: 126,
		marginBottom: tokens.space5,
		position: "relative",
		width: 126
	},
	running: {
		alignItems: "center",
		color: tokens.colorTextMuted,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		minHeight: 620,
		padding: 36,
		textAlign: "center"
	},
	runningTitle: { color: tokens.colorTextStrong, fontSize: 15, fontWeight: 590 },
	runningDetail: { fontSize: 13, lineHeight: 1.6, margin: "8px 0 0", maxWidth: 380 },
	renderOrb: {
		animationDuration: "2.4s",
		animationIterationCount: "infinite",
		animationName: orbit,
		animationTimingFunction: "linear",
		borderColor: tokens.colorBorder,
		borderRadius: "50%",
		borderStyle: "solid",
		borderTopColor: tokens.colorAccent,
		borderWidth: 1,
		height: 92,
		marginBottom: tokens.space5,
		width: 92
	},
	failure: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorText,
		margin: "72px auto",
		maxWidth: 520,
		padding: 20
	},
	failureTitle: { color: tokens.colorTextStrong, fontSize: 15, fontWeight: 590 },
	failureMessage: { fontSize: 13, lineHeight: 1.6, margin: "6px 0 0" },
	failureRecovery: {
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.6,
		margin: "6px 0 0"
	},
	failureActions: { display: "flex", gap: tokens.space2, marginTop: tokens.space3 },
	failureDetails: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		marginTop: tokens.space3,
		whiteSpace: "pre-wrap"
	},
	evidence: { minHeight: 620 },
	evidenceHeader: {
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: tokens.space4,
		justifyContent: "space-between",
		padding: "12px 16px"
	},
	evidenceIdentity: { display: "grid", gap: 3, minWidth: 0 },
	evidenceSystem: {
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 590,
		overflowWrap: "anywhere"
	},
	evidenceRunId: { color: tokens.colorTextFaint, fontFamily: tokens.fontMono, fontSize: 11 },
	verified: { color: tokens.colorSuccess, fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" },
	viewer: {
		alignItems: "center",
		backgroundColor: tokens.colorSurfaceInset,
		backgroundImage:
			"linear-gradient(45deg, rgba(255, 255, 255, 0.03) 25%, transparent 25%), linear-gradient(-45deg, rgba(255, 255, 255, 0.03) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.03) 75%), linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.03) 75%)",
		backgroundPosition: "0 0, 0 9px, 9px -9px, -9px 0",
		backgroundSize: "18px 18px",
		display: "flex",
		height: 390,
		justifyContent: "center",
		position: "relative"
	},
	viewerReadout: {
		bottom: 10,
		color: tokens.colorTextSubtle,
		display: "flex",
		fontSize: 11,
		justifyContent: "space-between",
		left: 12,
		position: "absolute",
		right: 12
	},
	readoutValue: { color: tokens.colorTextMuted, fontFamily: tokens.fontMono, fontSize: 11 },
	playbackControls: {
		alignItems: "center",
		display: "flex",
		gap: 6,
		left: 12,
		position: "absolute",
		right: 12,
		top: 10,
		zIndex: 1
	},
	transportButton: {
		backgroundColor: {
			default: tokens.colorSurfaceRaised,
			":hover": tokens.colorSurfaceHover
		},
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorText,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 500,
		padding: "5px 10px"
	},
	transportActive: { borderColor: tokens.colorBorderStrong, color: tokens.colorTextStrong },
	bufferingReadout: {
		animationDuration: "1.3s",
		animationIterationCount: "infinite",
		animationName: breathe,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		marginLeft: "auto"
	},
	previewImage: { display: "block", maxHeight: "100%", maxWidth: "100%", objectFit: "contain" },
	frameLoading: {
		animationDuration: "1.3s",
		animationIterationCount: "infinite",
		animationName: breathe,
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	frameFailure: { color: tokens.colorDanger, fontSize: 13, padding: 18 },
	timeline: {
		alignItems: "stretch",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		display: "flex",
		gap: 3,
		height: 72,
		overflowX: "auto",
		padding: "8px 12px"
	},
	frameTick: {
		alignItems: "center",
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		borderColor: "transparent",
		borderRadius: tokens.radiusBadge,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextSubtle,
		cursor: "pointer",
		display: "flex",
		flexDirection: "column",
		fontFamily: tokens.fontMono,
		fontSize: 10,
		gap: 4,
		justifyContent: "flex-end",
		minWidth: 30,
		padding: "3px 4px"
	},
	frameTickActive: {
		backgroundColor: tokens.colorAccentWash,
		borderColor: tokens.colorAccent,
		color: tokens.colorTextStrong
	},
	facts: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "grid",
		gridTemplateColumns: "repeat(6, minmax(0, 1fr))"
	},
	fact: {
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		color: tokens.colorTextSubtle,
		display: "grid",
		fontSize: 11,
		gap: 3,
		minWidth: 0,
		padding: "10px 12px"
	},
	diagnostics: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorWarning,
		fontSize: 12,
		padding: "8px 14px"
	},
	factValue: { color: tokens.colorTextStrong, fontSize: 13, fontWeight: 500 },
	diagnosticCode: { fontFamily: tokens.fontMono, fontSize: 11 },
	manifestPath: {
		color: tokens.colorTextFaint,
		display: "flex",
		fontSize: 11,
		gap: tokens.space2,
		overflowWrap: "anywhere",
		padding: "10px 14px"
	}
});
