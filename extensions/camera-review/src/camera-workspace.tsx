import * as stylex from "@stylexjs/stylex";
import {
	ArrangementCameraId,
	ReviewViewId,
	cameraActorIdentity,
	CameraOperationId,
	effectiveCameraArrangementSettings,
	type CameraPanelAction,
	type CameraArrangementCommand,
	type CameraEditScope,
	type CameraLayout
} from "@ue-shed/cameras/browser";
import type {
	CameraWorkspaceRequest,
	CameraWorkspaceResult
} from "@ue-shed/cameras/review-contracts";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Schedule, Stream } from "effect";
import { For, Show, createMemo, createSignal, createEffect, onSettled } from "solid-js";
import { createStore, reconcile, snapshot } from "solid-js";
import type { ObservedActor } from "@ue-shed/observatory/browser";
import type { MapReviewClientApi } from "./map-review-client.js";

const fields = [
	{ key: "fieldOfViewDegrees", label: "FOV", unit: "°", min: 5, max: 170, step: 1 },
	{ key: "distanceScale", label: "Distance", unit: "×", min: 0.01, max: 100, step: 0.01 },
	{ key: "heightOffset", label: "Height", unit: "cm", min: -100000, max: 100000, step: 1 },
	{ key: "elevationDegrees", label: "Elevation", unit: "°", min: -89, max: 89, step: 1 },
	{ key: "yawOffset", label: "Yaw", unit: "°", min: -360, max: 360, step: 1 },
	{ key: "margin", label: "Margin", unit: "", min: 0, max: 0.45, step: 0.01 }
] as const;
const presets: readonly { name: string; layout: CameraLayout }[] = [
	{
		name: "Single",
		layout: { kind: "single", count: 1, startDegrees: 0, spanDegrees: 0, orientation: "world" }
	},
	{
		name: "Cardinals",
		layout: { kind: "orbit", count: 4, startDegrees: 0, spanDegrees: 360, orientation: "world" }
	},
	{
		name: "Front arc",
		layout: { kind: "arc", count: 3, startDegrees: -45, spanDegrees: 90, orientation: "world" }
	},
	{
		name: "Orbit",
		layout: { kind: "orbit", count: 8, startDegrees: 0, spanDegrees: 360, orientation: "world" }
	}
];

export function CameraWorkspace(props: {
	readonly client: Pick<MapReviewClientApi, "cameraWorkspace" | "liveFrames">;
	readonly focusRequest?: { readonly actor: ObservedActor; readonly nonce: number } | undefined;
	readonly onApproved: () => void;
	readonly onOpened?: (() => void) | undefined;
	readonly onCapture?: (() => void) | undefined;
	readonly onChooseReviewSet: () => void;
	readonly createRequest?: number;
	readonly reviewSetName?: string | undefined;
}) {
	const [state, setState] = createStore<CameraWorkspaceResult>({
		panel: null,
		sets: [],
		error: null
	});
	const action = createEffectAction();
	const polling = createEffectSubscription();
	const frames = createEffectSubscription();
	const [busy, setBusy] = createSignal(false);
	const [operationError, setOperationError] = createSignal<string | null>(null);
	const [library, setLibrary] = createSignal(true);
	const [creating, setCreating] = createSignal(false);
	const [name, setName] = createSignal("");
	const [createPreset, setCreatePreset] = createSignal(presets[1]!);
	const [wholeSet, setWholeSet] = createSignal(true);
	const [tab, setTab] = createSignal<"Framing" | "Layout" | "Visibility" | "Capture">("Framing");
	const [layout, setLayout] = createSignal<CameraLayout>(presets[1]!.layout);
	const [hasFrame, setHasFrame] = createSignal(false);
	let generation = 0;
	const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
	const camera = createMemo(() =>
		state.panel?.arrangement.cameras.find((item) => item.id === state.panel?.activeCameraId)
	);
	const effective = createMemo(() => {
		const c = camera();
		return c && state.panel
			? effectiveCameraArrangementSettings(state.panel.arrangement, c)
			: undefined;
	});
	const scope = (): CameraEditScope =>
		wholeSet()
			? { kind: "arrangement" }
			: { kind: "cameras", cameraIds: [state.panel!.activeCameraId] };
	const needsFixedExposure = () =>
		state.panel?.arrangement.output === "natural_and_authored" &&
		state.panel.renderPolicy.renderer.kind === "scene_capture" &&
		state.panel.renderPolicy.exposure.mode !== "fixed_ev100";
	let savedSignature: string | undefined;
	const receive = (result: CameraWorkspaceResult, refresh = true) => {
		const signature = result.savedViews ? JSON.stringify(result.savedViews) : undefined;
		const changed =
			savedSignature !== undefined &&
			signature !== undefined &&
			signature !== savedSignature &&
			result.savedViews!.length > 0;
		savedSignature = signature;
		setState(reconcile(result));
		if (refresh && changed) props.onApproved();
	};
	const run = (request: CameraWorkspaceRequest, saved = false) => {
		const invoke = props.client.cameraWorkspace;
		if (!invoke || busy()) return;
		generation++;
		setOperationError(null);
		setBusy(true);
		action.run(invoke(snapshot(request)), {
			onSuccess: (result) => {
				receive(result, !saved);
				setOperationError(result.error);
				setBusy(false);
				if (result.panel && request.kind === "open") {
					setLibrary(false);
					setCreating(false);
					setWholeSet(true);
					setHasFrame(false);
					props.onOpened?.();
				}
				if (request.kind === "close" && !result.error) setLibrary(true);
				if (saved && !result.error) props.onApproved();
			},
			onFailure: (cause) => {
				setOperationError(Cause.pretty(cause));
				setBusy(false);
			}
		});
	};
	const send = (value: CameraPanelAction, saved = false) => {
		const panel = state.panel;
		if (panel)
			run(
				{
					kind: "action",
					id: panel.arrangement.id,
					expectedRevision: panel.arrangement.revision,
					action: value
				},
				saved
			);
	};
	const base = () => ({
		arrangementId: state.panel!.arrangement.id,
		expectedRevision: state.panel!.arrangement.revision,
		operationId: CameraOperationId.make(crypto.randomUUID())
	});
	const command = (value: CameraArrangementCommand) => send({ kind: "command", command: value });
	const native = (
		operation: Extract<CameraWorkspaceRequest, { kind: "native" }>["operation"]
	) => {
		if (state.panel)
			run({ kind: "native", id: state.panel.arrangement.id, operation, scope: scope() });
	};
	const tune = (key: (typeof fields)[number]["key"], value: number | undefined) => {
		const c = camera();
		if (!c || !state.panel) return;
		if (wholeSet()) {
			if (value !== undefined)
				command({ ...base(), kind: "tune", settings: { [key]: value } });
		} else {
			const overrides = { ...c.overrides };
			if (value === undefined) delete overrides[key];
			else overrides[key] = value;
			command({ ...base(), kind: "override", cameraId: c.id, overrides });
		}
	};
	createEffect(
		() => props.createRequest,
		(request) => {
			if (request) {
				setCreating(true);
				setLibrary(false);
			}
		}
	);
	createEffect(
		() => props.focusRequest,
		(request) => {
			if (!request) return;
			const subject = state.panel?.arrangement.subject;
			const actorPath =
				subject?.kind === "actor_path" ? subject.actorPath : subject?.lastKnownActorPath;
			if (state.panel && actorPath !== request.actor.path) run({ kind: "close" });
			setLibrary(true);
			setName(request.actor.displayName);
		}
	);
	onSettled(() => {
		run({ kind: "list" });
		polling.subscribe(
			Stream.fromEffect(
				Effect.suspend(() => {
					const invoke = props.client.cameraWorkspace;
					const current = generation;
					return !invoke || busy()
						? Effect.void
						: invoke({ kind: "state" }).pipe(
								Effect.tap((result) =>
									Effect.sync(() => {
										if (current === generation && !busy()) receive(result);
									})
								)
							);
				})
			).pipe(Stream.repeat(Schedule.spaced("750 millis"))),
			{
				onValue: () => undefined,
				onFailure: (cause) => setState(reconcile({ ...state, error: Cause.pretty(cause) }))
			}
		);
		frames.subscribe(props.client.liveFrames, {
			onFailure: (cause) => setState(reconcile({ ...state, error: Cause.pretty(cause) })),
			onValue: (frame) => {
				const element = canvas();
				if (!element || !state.panel || frame.cameraIndex !== 0) return;
				const context = element.getContext("2d");
				if (!context) return;
				element.width = frame.width;
				element.height = frame.height;
				const rgba = new Uint8ClampedArray(frame.pixels.length);
				for (let i = 0; i < rgba.length; i += 4) {
					rgba[i] = frame.pixels[i + 2]!;
					rgba[i + 1] = frame.pixels[i + 1]!;
					rgba[i + 2] = frame.pixels[i]!;
					rgba[i + 3] = 255;
				}
				context.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
				setHasFrame(true);
			}
		});
	});
	return (
		<section aria-label="Camera workspace" {...stylex.attrs(styles.workspace)}>
			<header {...stylex.attrs(styles.row)}>
				<div {...stylex.attrs(styles.heading)}>
					<strong>{state.panel?.arrangement.displayName ?? "Camera sets"}</strong>
					<small>
						{busy()
							? "Updating…"
							: state.panel
								? state.panel.cameras.every((camera) => camera.approved)
									? "Views saved"
									: "Draft saved"
								: ""}
					</small>
				</div>
				<button
					{...stylex.attrs(styles.button)}
					onClick={() => setLibrary(!library())}
					aria-expanded={library() ? "true" : "false"}
				>
					{library() ? "Hide camera drafts" : "Open camera draft"}
				</button>
				<button {...stylex.attrs(styles.button)} onClick={() => setCreating(!creating())}>
					New camera set
				</button>
				<Show when={state.panel}>
					<button
						{...stylex.attrs(styles.primary)}
						disabled={busy() || needsFixedExposure()}
						onClick={() =>
							send(
								{
									kind: "approve",
									cameraIds: state.panel!.cameras.map((c) => c.id),
									removeRetiredViewIds: state.panel!.retiredViews.map((v) => v.id)
								},
								true
							)
						}
					>
						Save views
					</button>
					<Show when={props.onCapture}>
						<button
							{...stylex.attrs(styles.button)}
							disabled={
								busy() || !state.panel?.cameras.every((camera) => camera.approved)
							}
							onClick={props.onCapture}
						>
							Capture…
						</button>
					</Show>
					<button
						{...stylex.attrs(styles.button)}
						disabled={busy()}
						onClick={() => run({ kind: "close" })}
					>
						Close
					</button>
				</Show>
			</header>
			<Show when={needsFixedExposure()}>
				<div role="alert">Pure + Authored requires fixed exposure with SceneCapture.</div>
			</Show>
			<div {...stylex.attrs(styles.row)}>
				<span {...stylex.attrs(styles.hint)}>
					{props.reviewSetName
						? `Drafts autosave. Save views copies the current cameras into ${props.reviewSetName} for capture.`
						: "Create cameras from an actor. A Review Set for its map will be created automatically."}
				</span>
				<button {...stylex.attrs(styles.button)} onClick={props.onChooseReviewSet}>
					Choose capture collection…
				</button>
			</div>
			<Show when={operationError() ?? state.error}>
				<div role="alert" {...stylex.attrs(styles.error)}>
					{operationError() ?? state.error}
					<Show when={state.panel}>
						<button
							{...stylex.attrs(styles.button)}
							disabled={busy()}
							onClick={() =>
								run({ kind: "inspect_recovery", id: state.panel!.arrangement.id })
							}
						>
							Inspect pending camera edits
						</button>
					</Show>
				</div>
			</Show>
			<Show when={state.recovery}>
				{(proposal) => (
					<section aria-label="Camera edit recovery">
						<Show when={proposal().nativeCommitRevision !== undefined}>
							<p>
								These Unreal edits are already in saved revision{" "}
								{proposal().nativeCommitRevision}. Using them again will only
								acknowledge that commit.
							</p>
						</Show>
						<p>
							Review saved draft revision {proposal().expectedRevision} and pending
							Unreal edits. Choosing a version updates the draft; it does not publish
							views.
						</p>
						<For each={proposal().saved}>
							{(saved) => {
								const native = () =>
									proposal().native.cameras?.find(
										(camera) => camera.id === saved.id
									)?.pose ??
									(proposal().native.cameraId === saved.id
										? proposal().native.pose
										: undefined);
								return (
									<details>
										<summary>
											{saved.id}: saved FOV {saved.pose.fieldOfViewDegrees}°,
											Unreal FOV{" "}
											{native()?.fieldOfViewDegrees ?? "unavailable"}
										</summary>
										<pre>
											{JSON.stringify(
												{ saved: saved.pose, native: native() },
												null,
												2
											)}
										</pre>
									</details>
								);
							}}
						</For>
						<p>
							Added cameras:{" "}
							{proposal()
								.native.added?.map((camera) => camera.id)
								.join(", ") || "None"}
							. Removed cameras: {proposal().native.removed?.join(", ") || "None"}.
						</p>
						<button
							{...stylex.attrs(styles.button)}
							disabled={busy() || !proposal().native.pending}
							onClick={() =>
								run({
									kind: "resolve_recovery",
									proposal: proposal(),
									choice: "saved"
								})
							}
						>
							Keep saved draft
						</button>
						<button
							{...stylex.attrs(styles.button)}
							disabled={busy() || !proposal().native.pending}
							onClick={() =>
								run({
									kind: "resolve_recovery",
									proposal: proposal(),
									choice: "native"
								})
							}
						>
							Use pending Unreal edits
						</button>
					</section>
				)}
			</Show>
			<Show when={creating()}>
				<form
					aria-label="Create camera set"
					{...stylex.attrs(styles.row)}
					onSubmit={(event) => {
						event.preventDefault();
						run({
							kind: "open",
							layout: createPreset().layout,
							...(name().trim() ? { name: name().trim() } : undefined),
							...(props.focusRequest
								? { actorPath: props.focusRequest.actor.path }
								: undefined)
						});
					}}
				>
					<label {...stylex.attrs(styles.row)}>
						Camera preset
						<select
							aria-label="Camera preset"
							value={createPreset().name}
							onChange={(event) => {
								const preset = presets.find(
									(item) => item.name === event.currentTarget.value
								);
								if (preset) setCreatePreset(preset);
							}}
							{...stylex.attrs(styles.input)}
						>
							<For each={presets}>
								{(preset) => (
									<option value={preset.name}>
										{preset.name} · {preset.layout.count} cameras
									</option>
								)}
							</For>
						</select>
					</label>
					<input
						aria-label="Set name"
						placeholder="Set name"
						value={name()}
						onInput={(event) => setName(event.currentTarget.value)}
						{...stylex.attrs(styles.input, styles.nameInput)}
					/>
					<button disabled={busy()} {...stylex.attrs(styles.primary)}>
						{busy()
							? "Creating camera set…"
							: `Create from ${props.focusRequest?.actor.displayName ?? "Unreal selection"}`}
					</button>
				</form>
			</Show>
			<Show when={library()}>
				<p {...stylex.attrs(styles.hint)}>
					Saved camera drafts for this review. Select a set below to load its cameras for
					editing; this does not open a map.
				</p>
				<div {...stylex.attrs(styles.rail)}>
					<For
						each={state.sets}
						fallback={
							<span {...stylex.attrs(styles.hint)}>
								No editable camera sets here yet. Choose New camera set to start
								from an actor. Review sets contain published views, not necessarily
								editable camera drafts.
							</span>
						}
					>
						{(set) => (
							<button
								{...stylex.attrs(styles.card)}
								disabled={busy()}
								onClick={() => run({ kind: "open", id: set.id })}
							>
								<strong>{set.name}</strong>
								<span>{set.cameras} cameras</span>
								<small>{set.actorPath.split(".").at(-1)}</small>
								<span>Edit camera set →</span>
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={state.panel}>
				<div {...stylex.attrs(styles.rail)}>
					<For each={state.panel?.arrangement.cameras}>
						{(c) => (
							<button
								{...stylex.attrs(
									styles.card,
									c.id === state.panel?.activeCameraId && styles.selected
								)}
								disabled={busy()}
								aria-pressed={
									c.id === state.panel?.activeCameraId ? "true" : "false"
								}
								onClick={() => {
									setHasFrame(false);
									send({ kind: "activate", cameraId: c.id });
								}}
							>
								<strong>{c.displayName}</strong>
								<small>
									{c.manualPose ? "Manual" : "Fitted"} ·{" "}
									{state.panel?.cameras.find((item) => item.id === c.id)?.approved
										? "Saved"
										: "Draft"}
								</small>
							</button>
						)}
					</For>
				</div>
				<div {...stylex.attrs(styles.editor)}>
					<div {...stylex.attrs(styles.preview)}>
						<canvas
							ref={setCanvas}
							aria-label="Active camera preview"
							{...stylex.attrs(styles.canvas)}
						/>
						<span>{hasFrame() ? "Live" : "Connecting preview…"}</span>
						<div {...stylex.attrs(styles.row)}>
							<button
								{...stylex.attrs(styles.primary)}
								disabled={busy()}
								onClick={() => native("pilot")}
							>
								Edit in Unreal ↗
							</button>
							<button
								{...stylex.attrs(styles.button)}
								disabled={busy()}
								onClick={() => native("eject")}
							>
								Stop piloting
							</button>
						</div>
					</div>
					<div {...stylex.attrs(styles.inspector)}>
						<div {...stylex.attrs(styles.row)}>
							<button
								{...stylex.attrs(styles.button, wholeSet() && styles.selected)}
								aria-pressed={wholeSet() ? "true" : "false"}
								onClick={() => setWholeSet(true)}
							>
								Whole set
							</button>
							<button
								{...stylex.attrs(styles.button, !wholeSet() && styles.selected)}
								aria-pressed={!wholeSet() ? "true" : "false"}
								disabled={tab() === "Layout" || tab() === "Capture"}
								onClick={() => setWholeSet(false)}
							>
								This camera
							</button>
						</div>
						<nav {...stylex.attrs(styles.row)}>
							<For each={["Framing", "Layout", "Visibility", "Capture"] as const}>
								{(item) => (
									<button
										{...stylex.attrs(
											styles.tab,
											tab() === item && styles.selected
										)}
										aria-pressed={tab() === item ? "true" : "false"}
										onClick={() => {
											setTab(item);
											if (item === "Layout" || item === "Capture")
												setWholeSet(true);
										}}
									>
										{item}
									</button>
								)}
							</For>
						</nav>
						<Show when={tab() === "Framing"}>
							<Show when={!wholeSet()}>
								<label {...stylex.attrs(styles.field)}>
									Name
									<input
										aria-label="Camera name"
										{...stylex.attrs(styles.input)}
										value={camera()?.displayName ?? ""}
										disabled={busy()}
										onChange={(event) => {
											const displayName = event.currentTarget.value.trim();
											if (displayName)
												command({
													...base(),
													kind: "rename",
													cameraId: state.panel!.activeCameraId,
													displayName
												});
										}}
									/>
								</label>
							</Show>
							<For each={fields}>
								{(field) => (
									<label {...stylex.attrs(styles.field)}>
										<span>{field.label}</span>
										<input
											{...stylex.attrs(styles.input)}
											type="number"
											aria-label={field.label}
											min={field.min}
											max={field.max}
											step={field.step}
											disabled={
												busy() ||
												(!wholeSet() &&
													!!camera()?.manualPose &&
													field.key !== "fieldOfViewDegrees")
											}
											value={
												(wholeSet()
													? state.panel?.arrangement.settings[field.key]
													: effective()?.[field.key]) ?? 0
											}
											onChange={(event) => {
												if (event.currentTarget.validity.valid)
													tune(
														field.key,
														event.currentTarget.valueAsNumber
													);
											}}
										/>
										<small>{field.unit}</small>
										<Show
											when={
												!wholeSet() &&
												camera()?.overrides[field.key] !== undefined
											}
										>
											<button
												aria-label={`Reset ${field.label}`}
												{...stylex.attrs(styles.tab)}
												onClick={() => tune(field.key, undefined)}
											>
												↺
											</button>
										</Show>
									</label>
								)}
							</For>
							<Show when={!wholeSet()}>
								<details>
									<summary>Camera actions</summary>
									<div {...stylex.attrs(styles.row)}>
										<button
											{...stylex.attrs(styles.button)}
											disabled={busy()}
											onClick={() =>
												command({
													...base(),
													kind: "duplicate",
													cameraId: state.panel!.activeCameraId,
													newCameraId: ArrangementCameraId.make(
														crypto.randomUUID()
													),
													newViewId: ReviewViewId.make(
														crypto.randomUUID()
													)
												})
											}
										>
											Duplicate
										</button>
										<button
											{...stylex.attrs(styles.button)}
											disabled={busy() || state.panel!.cameras.length === 1}
											onClick={() =>
												send({
													kind: "remove",
													cameraIds: [state.panel!.activeCameraId]
												})
											}
										>
											Remove
										</button>
									</div>
								</details>
							</Show>
							<Show when={!wholeSet() && camera()?.manualPose}>
								<button
									{...stylex.attrs(styles.button)}
									disabled={busy()}
									onClick={() =>
										command({
											...base(),
											kind: "unpin",
											cameraId: state.panel!.activeCameraId
										})
									}
								>
									Reset to fitted
								</button>
							</Show>
						</Show>
						<Show when={tab() === "Layout"}>
							<div {...stylex.attrs(styles.row)}>
								<For each={presets}>
									{(preset) => (
										<button
											{...stylex.attrs(styles.button)}
											onClick={() => setLayout(preset.layout)}
										>
											{preset.name}
										</button>
									)}
								</For>
							</div>
							<label {...stylex.attrs(styles.field)}>
								Cameras
								<input
									{...stylex.attrs(styles.input)}
									type="number"
									min="1"
									max="256"
									value={layout().count}
									onChange={(e) => {
										if (e.currentTarget.validity.valid)
											setLayout({
												...layout(),
												count: e.currentTarget.valueAsNumber
											});
									}}
								/>
							</label>
							<label {...stylex.attrs(styles.field)}>
								Start °
								<input
									{...stylex.attrs(styles.input)}
									type="number"
									value={layout().startDegrees}
									onChange={(e) =>
										setLayout({
											...layout(),
											startDegrees: e.currentTarget.valueAsNumber
										})
									}
								/>
							</label>
							<button
								{...stylex.attrs(styles.primary)}
								disabled={busy()}
								onClick={() =>
									send({
										kind: "layout",
										layout: layout(),
										retainExisting: false
									})
								}
							>
								Preview layout
							</button>
						</Show>
						<Show when={tab() === "Visibility"}>
							<div {...stylex.attrs(styles.row)}>
								<button
									{...stylex.attrs(styles.button)}
									disabled={busy()}
									onClick={() => native("hide_selection")}
								>
									Hide Unreal selection
								</button>
								<button
									{...stylex.attrs(styles.button)}
									disabled={busy()}
									onClick={() => native("protect_selection")}
								>
									Protect Unreal selection
								</button>
							</div>
							<For each={["hide", "protect"] as const}>
								{(list) => (
									<div>
										<strong>{list === "hide" ? "Hidden" : "Protected"}</strong>
										<For
											each={
												(wholeSet()
													? state.panel?.arrangement.visibility
													: state.panel?.cameras.find(
															(item) =>
																item.id ===
																state.panel?.activeCameraId
														)?.visibility)?.[list] ?? []
											}
										>
											{(entry) => (
												<div {...stylex.attrs(styles.row)}>
													<span>{entry.label}</span>
													<Show
														when={
															wholeSet() ||
															camera()?.visibility?.[list].some(
																(local) =>
																	cameraActorIdentity(
																		local.locator
																	) ===
																	cameraActorIdentity(
																		entry.locator
																	)
															)
														}
														fallback={<small>Inherited</small>}
													>
														<button
															{...stylex.attrs(styles.tab)}
															aria-label={`Remove ${entry.label}`}
															disabled={busy()}
															onClick={() =>
																command({
																	...base(),
																	kind: "edit_visibility",
																	scope: scope(),
																	list,
																	operation: "remove",
																	entries: [entry]
																})
															}
														>
															×
														</button>
													</Show>
												</div>
											)}
										</For>
									</div>
								)}
							</For>
						</Show>
						<Show when={tab() === "Capture"}>
							<label {...stylex.attrs(styles.field)}>
								Exposure
								<select
									aria-label="Exposure"
									{...stylex.attrs(styles.input)}
									disabled={busy()}
									value={state.panel?.renderPolicy.exposure.mode}
									onChange={(event) => {
										const panel = state.panel;
										if (panel)
											command({
												...base(),
												kind: "render_policy",
												policy: {
													...panel.renderPolicy,
													exposure:
														event.currentTarget.value === "fixed_ev100"
															? {
																	mode: "fixed_ev100",
																	ev100: 10,
																	compensation: "project"
																}
															: { mode: "project_auto" }
												}
											});
									}}
								>
									<option value="project_auto">Auto</option>
									<option value="fixed_ev100">Fixed EV100</option>
								</select>
							</label>
							<Show when={state.panel?.renderPolicy.exposure.mode === "fixed_ev100"}>
								<label {...stylex.attrs(styles.field)}>
									EV100
									<input
										aria-label="EV100"
										{...stylex.attrs(styles.input)}
										type="number"
										min="-20"
										max="30"
										step="0.1"
										disabled={busy()}
										value={
											state.panel?.renderPolicy.exposure.mode ===
											"fixed_ev100"
												? state.panel.renderPolicy.exposure.ev100
												: 10
										}
										onChange={(event) => {
											const panel = state.panel;
											if (panel && event.currentTarget.validity.valid)
												command({
													...base(),
													kind: "render_policy",
													policy: {
														...panel.renderPolicy,
														exposure: {
															mode: "fixed_ev100",
															ev100: event.currentTarget
																.valueAsNumber,
															compensation: "project"
														}
													}
												});
										}}
									/>
								</label>
							</Show>
							<label {...stylex.attrs(styles.field)}>
								Output
								<select
									{...stylex.attrs(styles.input)}
									value={state.panel?.arrangement.output ?? "natural_only"}
									disabled={busy()}
									onChange={(event) => {
										const output = event.currentTarget.value;
										if (
											output === "natural_only" ||
											output === "authored_only" ||
											output === "natural_and_authored"
										)
											command({ ...base(), kind: "output", output });
									}}
								>
									<option value="natural_only">Pure</option>
									<option value="authored_only">Authored</option>
									<option value="natural_and_authored">Pure + Authored</option>
								</select>
							</label>
						</Show>
						<Show when={state.panel?.proposal}>
							<div role="dialog" aria-label="Replace camera layout">
								<strong>
									{state.panel?.proposal?.added.length} added ·{" "}
									{state.panel?.proposal?.removed.length} removed
								</strong>
								<p>
									{state.panel?.proposal?.customized.length} customized cameras
									affected
								</p>
								<button
									{...stylex.attrs(styles.primary)}
									disabled={busy()}
									onClick={() => send({ kind: "accept_proposal" })}
								>
									Apply layout
								</button>
								<button
									{...stylex.attrs(styles.button)}
									onClick={() => send({ kind: "cancel_proposal" })}
								>
									Cancel
								</button>
							</div>
						</Show>
						<Show when={state.panel?.notice}>
							<small role="status">{state.panel?.notice}</small>
						</Show>
					</div>
				</div>
			</Show>
		</section>
	);
}
const styles = stylex.create({
	hint: { color: tokens.colorTextMuted, fontSize: 12 },
	error: { color: tokens.colorDanger, fontSize: 13 },
	nameInput: { width: "min(320px, 100%)" },
	workspace: {
		display: "flex",
		flexDirection: "column",
		gap: 16,
		padding: 20,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusPanel,
		marginBottom: 24
	},
	row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
	heading: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginRight: "auto",
		fontSize: 16
	},
	button: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: 6,
		padding: "8px 12px",
		cursor: "pointer",
		opacity: { default: 1, ":disabled": 0.5 }
	},
	primary: {
		backgroundColor: tokens.colorAccent,
		color: tokens.colorAccentText,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "transparent",
		borderRadius: 6,
		padding: "8px 12px",
		cursor: "pointer",
		opacity: { default: 1, ":disabled": 0.5 }
	},
	tab: {
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "transparent",
		borderRadius: 4,
		padding: "6px 8px",
		cursor: "pointer"
	},
	selected: {
		borderColor: tokens.colorAccent,
		color: tokens.colorAccent,
		backgroundColor: tokens.colorAccentWash
	},
	rail: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 },
	card: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		minWidth: 140,
		textAlign: "left",
		padding: 14,
		backgroundColor: tokens.colorSurfaceRaised,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: 8,
		color: tokens.colorText,
		cursor: "pointer"
	},
	editor: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 350px",
			"@media (max-width: 1050px)": "1fr"
		},
		gap: 20
	},
	preview: { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 },
	canvas: {
		width: "100%",
		aspectRatio: "16 / 9",
		backgroundColor: "#000",
		objectFit: "contain",
		borderRadius: 8
	},
	inspector: { display: "flex", flexDirection: "column", gap: 16 },
	field: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" },
	input: {
		minWidth: 0,
		width: 120,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: 4,
		padding: 8
	}
});
