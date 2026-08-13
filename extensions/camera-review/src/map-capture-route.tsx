import * as stylex from "@stylexjs/stylex";
import { savedMapPathToGameMapPath } from "@ue-shed/cameras/map-tiles";
import {
	SavedMapPicker,
	createEffectAction,
	createEffectSubscription,
	type SavedMapPickerOption
} from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
	MapCaptureClientShape,
	MapCaptureExecuteResult,
	MapCaptureLivePreviewResult,
	MapCaptureProgressEvent,
	MapCaptureSelectionResult
} from "./map-capture-client.js";
import {
	mapCaptureDraftGrid,
	mapCapturePlanDraft,
	validateMapCapturePlanDraft,
	type MapCapturePlanDraft
} from "./map-capture-plan-draft.js";
import { MapCaptureActorWorkspace } from "./map-capture-actor-workspace.js";

type ReadySelection = Extract<MapCaptureSelectionResult, { readonly status: "ready" }>;
type CompletedCapture = Extract<MapCaptureExecuteResult, { readonly status: "completed" }>;
type ReadyLivePreview = Extract<MapCaptureLivePreviewResult, { readonly status: "ready" }>;
type LivePreviewState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly message: string; readonly recovery: string; readonly status: "failed" }
	| ({ readonly status: "ready" } & Omit<ReadyLivePreview, "status">);

const tilePixelSizeOptions = [512, 1_024, 2_048, 4_096] as const;
const coarsestResolutionOptions = [
	{ label: "¼", value: 0.25 },
	{ label: "½", value: 0.5 },
	{ label: "1", value: 1 },
	{ label: "2", value: 2 },
	{ label: "4", value: 4 },
	{ label: "8", value: 8 },
	{ label: "16", value: 16 },
	{ label: "32", value: 32 },
	{ label: "64", value: 64 },
	{ label: "128", value: 128 },
	{ label: "256", value: 256 },
	{ label: "512", value: 512 },
	{ label: "1,024", value: 1_024 }
] as const;

function formatMeasurement(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function isTilePixelSizeOption(value: number): boolean {
	return tilePixelSizeOptions.some((option) => option === value);
}

function isCoarsestResolutionOption(value: number): boolean {
	return coarsestResolutionOptions.some((option) => option.value === value);
}

function causeMessage(cause: Cause.Cause<unknown>): string {
	return Cause.pretty(cause);
}

function capturePhaseLabel(phase: MapCaptureProgressEvent["phase"]): string {
	switch (phase) {
		case "opening_map":
			return "OPENING TARGET MAP";
		case "capturing":
			return "CAPTURING TILES";
		case "publishing":
			return "VERIFYING + PUBLISHING";
		case "loading_preview":
			return "LOADING PREVIEW";
	}
}

function MapCaptureLiveCanvas(props: { readonly preview: ReadyLivePreview }) {
	const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
	let rgba = new Uint8ClampedArray(0);
	let imageData: ImageData | undefined;
	createEffect(() => {
		const element = canvas();
		const current = props.preview;
		if (
			element === undefined ||
			current.bytes.byteLength !== current.width * current.height * 4
		) {
			return;
		}
		const context = element.getContext("2d", { alpha: false });
		if (context === null) return;
		if (
			element.width !== current.width ||
			element.height !== current.height ||
			rgba.byteLength !== current.bytes.byteLength
		) {
			element.width = current.width;
			element.height = current.height;
			rgba = new Uint8ClampedArray(current.bytes.byteLength);
			imageData = new ImageData(rgba, current.width, current.height);
		}
		for (let offset = 0; offset < current.bytes.byteLength; offset += 4) {
			rgba[offset] = current.bytes[offset + 2] ?? 0;
			rgba[offset + 1] = current.bytes[offset + 1] ?? 0;
			rgba[offset + 2] = current.bytes[offset] ?? 0;
			rgba[offset + 3] = 255;
		}
		if (imageData !== undefined) context.putImageData(imageData, 0, 0);
	});
	return (
		<canvas
			ref={setCanvas}
			aria-label="Live top-down map framing preview"
			{...stylex.props(styles.liveCanvas)}
		/>
	);
}

export function MapCaptureRoute(props: { readonly client: MapCaptureClientShape }) {
	const newAction = createEffectAction();
	const chooseAction = createEffectAction();
	const saveAction = createEffectAction();
	const openAction = createEffectAction();
	const captureAction = createEffectAction();
	const previewAction = createEffectAction();
	const progressSubscription = createEffectSubscription();
	const liveFrameSubscription = createEffectSubscription();
	const [selection, setSelection] = createSignal<ReadySelection>();
	const [draft, setDraft] = createSignal<MapCapturePlanDraft>();
	const [savedPlanJson, setSavedPlanJson] = createSignal<string>();
	const [capture, setCapture] = createSignal<CompletedCapture>();
	const [activeCaptureOperationId, setActiveCaptureOperationId] = createSignal<string>();
	const [captureProgress, setCaptureProgress] = createSignal<MapCaptureProgressEvent>();
	const [livePreview, setLivePreview] = createSignal<LivePreviewState>({ status: "idle" });
	const [previewRefresh, setPreviewRefresh] = createSignal(0);
	const [notice, setNotice] = createSignal<{
		readonly tone: "error" | "info" | "success";
		readonly text: string;
	}>({ tone: "info", text: "Create a plan or open a portable plan file to begin." });
	const validation = createMemo(() => {
		const current = draft();
		return current === undefined ? undefined : validateMapCapturePlanDraft(current);
	});
	const plan = createMemo(() => {
		const result = validation();
		return result?.status === "valid" ? result.plan : undefined;
	});
	const validationErrors = createMemo(() => {
		const result = validation();
		return result?.status === "invalid" ? result.errors : [];
	});
	const grid = createMemo(() => {
		const result = validation();
		return result === undefined ? undefined : mapCaptureDraftGrid(result);
	});
	const coarsestLevel = createMemo(() => grid()?.grid.levels[0]);
	const isDirty = createMemo(() => {
		const current = draft();
		return current !== undefined && JSON.stringify(current) !== savedPlanJson();
	});
	const previewUrls = createMemo(
		() =>
			new Map(capture()?.previewTiles.map((tile) => [tile.relativePath, tile.dataUrl]) ?? [])
	);
	const isCapturing = createMemo(() => activeCaptureOperationId() !== undefined);
	const readyLivePreview = createMemo(() => {
		const current = livePreview();
		return current.status === "ready" ? current : undefined;
	});
	const failedLivePreview = createMemo(() => {
		const current = livePreview();
		return current.status === "failed" ? current : undefined;
	});
	const livePreviewBoundary = createMemo(() => {
		const bounds = grid()?.grid.snappedBounds;
		const preview = readyLivePreview();
		if (bounds === undefined) return { height: "94%", width: "94%" };
		const renderAspect = (preview?.width ?? 640) / (preview?.height ?? 360);
		const xSpan = bounds.maxX - bounds.minX;
		const ySpan = bounds.maxY - bounds.minY;
		const frameWorldWidth = Math.max(ySpan, xSpan * renderAspect);
		const frameWorldHeight = frameWorldWidth / renderAspect;
		return {
			height: `${(94 * xSpan) / frameWorldHeight}%`,
			width: `${(94 * ySpan) / frameWorldWidth}%`
		};
	});
	let captureSequence = 0;

	onMount(() => {
		progressSubscription.subscribe(props.client.progress, {
			onValue: (progress) => {
				if (progress.operationId === activeCaptureOperationId()) {
					setCaptureProgress(progress);
				}
			}
		});
		liveFrameSubscription.subscribe(props.client.liveFrames, {
			onValue: (frame) => {
				setLivePreview((current) => {
					if (
						current.status !== "ready" ||
						current.cameraId !== frame.cameraId ||
						current.cameraIndex !== frame.cameraIndex
					) {
						return current;
					}
					return {
						...current,
						bytes: frame.pixels,
						height: frame.height,
						width: frame.width
					};
				});
			}
		});
	});
	createEffect(() => {
		previewRefresh();
		const current = plan();
		if (current === undefined || capture() !== undefined || isCapturing()) {
			previewAction.cancel();
			setLivePreview({ status: "idle" });
			return;
		}
		setLivePreview({ status: "loading" });
		previewAction.run(
			Effect.sleep("350 millis").pipe(Effect.andThen(props.client.preview(current))),
			{
				onFailure: (cause) =>
					setLivePreview({
						message: causeMessage(cause),
						recovery: "Reconnect Unreal and open the target map.",
						status: "failed"
					}),
				onSuccess: (result) =>
					setLivePreview(
						result.status === "ready"
							? result
							: {
									message: result.message,
									recovery: result.recovery,
									status: "failed"
								}
					)
			}
		);
	});
	onCleanup(() => {
		previewAction.cancel();
		liveFrameSubscription.cancel();
		progressSubscription.cancel();
	});
	const mapOptions = createMemo<ReadonlyArray<SavedMapPickerOption>>(() =>
		(selection()?.maps ?? []).flatMap((map) => {
			const mapPath = savedMapPathToGameMapPath(map.mapPath);
			return mapPath === undefined ? [] : [{ label: map.label, mapPath }];
		})
	);

	function acceptSelection(result: MapCaptureSelectionResult) {
		if (result.status === "ready") {
			setSelection(result);
			setDraft(mapCapturePlanDraft(result.plan));
			setSavedPlanJson(result.source === "opened" ? JSON.stringify(result.plan) : undefined);
			setCapture(undefined);
			setNotice({
				tone: "success",
				text:
					result.source === "new"
						? "New Map Capture Plan ready to author."
						: `${result.tileCount.toLocaleString()} deterministic tiles loaded.`
			});
		} else if (result.status === "failed") {
			setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
		}
	}

	function newPlan() {
		setNotice({ tone: "info", text: "Creating a plan from the selected project…" });
		newAction.run(props.client.newPlan(), {
			onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
			onSuccess: acceptSelection
		});
	}

	function choosePlan() {
		setNotice({ tone: "info", text: "Reading plan and completed run evidence…" });
		chooseAction.run(props.client.choosePlan(), {
			onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
			onSuccess: acceptSelection
		});
	}

	function updateDraft(change: (current: MapCapturePlanDraft) => MapCapturePlanDraft) {
		setDraft((current) => (current === undefined ? current : change(current)));
		setCapture(undefined);
		setNotice({ tone: "info", text: "Plan changed. Validate and save before sharing it." });
	}

	function updateRender(
		change: (
			render: MapCapturePlanDraft["capture"]["render"]
		) => MapCapturePlanDraft["capture"]["render"]
	) {
		updateDraft((current) => ({
			...current,
			capture: { ...current.capture, render: change(current.capture.render) }
		}));
	}

	function updateLevelCount(count: number) {
		updateDraft((current) => {
			const render = current.capture.render;
			return {
				...current,
				capture: {
					...current.capture,
					render:
						render.lodPolicy === "per_level_distance_scale"
							? {
									...render,
									lodDistanceScaleByZoom: Array.from(
										{
											length: Number.isInteger(count) && count > 0 ? count : 0
										},
										(_, zoom) => render.lodDistanceScaleByZoom?.[zoom] ?? 1
									)
								}
							: render
				},
				levels: { ...current.levels, count }
			};
		});
	}

	function setLodPolicy(mode: "natural" | "per_level_distance_scale") {
		updateRender((render) => {
			if (mode === "natural") {
				const { lodDistanceScaleByZoom: _scales, ...natural } = render;
				return { ...natural, lodPolicy: "natural" };
			}
			return {
				...render,
				lodDistanceScaleByZoom:
					render.lodDistanceScaleByZoom ??
					Array.from({ length: draft()?.levels.count ?? 1 }, () => 1),
				lodPolicy: "per_level_distance_scale"
			};
		});
	}

	function setLodScale(zoom: number, value: number) {
		updateRender((render) => {
			const scales = [...(render.lodDistanceScaleByZoom ?? [])];
			scales[zoom] = value;
			return { ...render, lodDistanceScaleByZoom: scales };
		});
	}

	function savePlan(saveAs: boolean) {
		const current = plan();
		if (current === undefined) return;
		const currentPlanPath = selection()?.planPath;
		setNotice({ tone: "info", text: saveAs ? "Choosing a plan destination…" : "Saving plan…" });
		saveAction.run(
			props.client.savePlan({
				plan: current,
				...(currentPlanPath === undefined ? {} : { planPath: currentPlanPath }),
				saveAs
			}),
			{
				onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
				onSuccess: (result) => {
					if (result.status === "failed") {
						setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
						return;
					}
					if (result.status === "cancelled") {
						setNotice({
							tone: "info",
							text: "Save cancelled; the draft is still in memory."
						});
						return;
					}
					setDraft(mapCapturePlanDraft(result.plan));
					setSavedPlanJson(JSON.stringify(result.plan));
					setSelection((currentSelection) =>
						currentSelection === undefined
							? currentSelection
							: { ...currentSelection, plan: result.plan, planPath: result.planPath }
					);
					setNotice({
						tone: "success",
						text: `Saved portable plan to ${result.planPath}.`
					});
				}
			}
		);
	}

	function openMap() {
		const current = plan();
		if (current === undefined) return;
		setNotice({ tone: "info", text: `Asking Unreal to open ${current.project.mapPath}…` });
		openAction.run(props.client.openMap(current), {
			onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
			onSuccess: (result) => {
				if (result.status === "failed") {
					setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
					return;
				}
				setNotice(
					result.response.outcome === "rejected"
						? {
								tone: "error",
								text: `${result.response.message} ${result.response.recovery}`
							}
						: {
								tone: "success",
								text:
									result.response.outcome === "opened"
										? "Target map opened without player input."
										: "The target map was already open."
							}
				);
				if (result.response.outcome !== "rejected") {
					setPreviewRefresh((value) => value + 1);
				}
			}
		});
	}

	function runCapture(openMapFirst: boolean) {
		const current = plan();
		if (current === undefined || isCapturing()) return;
		captureSequence += 1;
		const operationId = `map-capture-${Date.now().toString(36)}-${captureSequence}`;
		const totalTiles = grid()?.tileCount ?? 1;
		setActiveCaptureOperationId(operationId);
		setCapture(undefined);
		setCaptureProgress({
			failedTiles: 0,
			operationId,
			phase: openMapFirst ? "opening_map" : "capturing",
			processedTiles: 0,
			totalTiles
		});
		setNotice({
			tone: "info",
			text: openMapFirst
				? "Safely opening the target map, then capturing bounded batches…"
				: "Capturing the currently open target map in bounded batches…"
		});
		captureAction.run(
			props.client.capture({ openMap: openMapFirst, operationId, plan: current }),
			{
				onFailure: (cause) => {
					setActiveCaptureOperationId(undefined);
					setCaptureProgress(undefined);
					setNotice({ tone: "error", text: causeMessage(cause) });
				},
				onSuccess: (result) => {
					setActiveCaptureOperationId(undefined);
					setCaptureProgress(undefined);
					if (result.status === "failed") {
						setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
						return;
					}
					setCapture(result);
					const previewNote = result.previewTruncated
						? ` Previewing ${result.previewTiles.length.toLocaleString()} of ${result.manifest.tiles.length.toLocaleString()} tiles in Workbench.`
						: "";
					setNotice({
						tone: result.published ? "success" : "error",
						text: result.published
							? `Published immutable run ${result.manifest.runId}.${previewNote}`
							: `Capture remained a ${result.manifest.state} attempt; inspect its failures.${previewNote}`
					});
				}
			}
		);
	}

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.hero)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>MAP CAPTURE / PLAN AUTHORING</p>
					<h1 {...stylex.props(styles.title)}>Build the world from above.</h1>
				</div>
				<p {...stylex.props(styles.intro)}>
					Author a portable plan. Preview deterministic geometry. Capture without saving
					actors.
				</p>
				<div {...stylex.props(styles.heroActions)}>
					<button type="button" onClick={newPlan} {...stylex.props(styles.primaryButton)}>
						NEW PLAN
					</button>
					<button
						type="button"
						onClick={choosePlan}
						{...stylex.props(styles.headerButton)}
					>
						OPEN PLAN
					</button>
				</div>
			</header>

			<div {...stylex.props(styles.layout)}>
				<aside {...stylex.props(styles.controls)}>
					<Show
						when={draft()}
						fallback={
							<div {...stylex.props(styles.emptyPanel)}>
								<span>01</span>
								<strong>CREATE OR OPEN A PLAN</strong>
								<p>
									New plans begin from the selected project and its first saved
									map.
								</p>
							</div>
						}
					>
						{(current) => (
							<>
								<section {...stylex.props(styles.panel)}>
									<div {...stylex.props(styles.sectionHeading)}>
										<p {...stylex.props(styles.sectionLabel)}>
											IDENTITY + TARGET
										</p>
										<span
											{...stylex.props(
												styles.dirtyFlag,
												isDirty() && styles.dirty
											)}
										>
											{isDirty() ? "UNSAVED" : "SAVED"}
										</span>
									</div>
									<div {...stylex.props(styles.fieldGrid)}>
										<TextField
											label="PLAN ID"
											value={current().id}
											onInput={(id) =>
												updateDraft((value) => ({ ...value, id }))
											}
										/>
										<TextField
											label="PROJECT ID"
											value={current().project.id}
											onInput={(id) =>
												updateDraft((value) => ({
													...value,
													project: { ...value.project, id }
												}))
											}
										/>
									</div>
									<SavedMapPicker
										allowCustomPath
										ariaLabel="Map capture target map"
										customPathPlaceholder="/Game/Maps/L_MyMap"
										label="TARGET MAP"
										maps={mapOptions()}
										mapPath={current().project.mapPath}
										onMapPathChange={(mapPath) =>
											updateDraft((value) => ({
												...value,
												project: { ...value.project, mapPath }
											}))
										}
									/>
								</section>

								<section {...stylex.props(styles.panel)}>
									<p {...stylex.props(styles.sectionLabel)}>WORLD GRID</p>
									<div {...stylex.props(styles.boundsGrid)}>
										<NumberField
											label="MIN X"
											value={current().requestedBounds.minX}
											onInput={(minX) =>
												updateDraft((value) => ({
													...value,
													requestedBounds: {
														...value.requestedBounds,
														minX
													}
												}))
											}
										/>
										<NumberField
											label="MAX X"
											value={current().requestedBounds.maxX}
											onInput={(maxX) =>
												updateDraft((value) => ({
													...value,
													requestedBounds: {
														...value.requestedBounds,
														maxX
													}
												}))
											}
										/>
										<NumberField
											label="MIN Y"
											value={current().requestedBounds.minY}
											onInput={(minY) =>
												updateDraft((value) => ({
													...value,
													requestedBounds: {
														...value.requestedBounds,
														minY
													}
												}))
											}
										/>
										<NumberField
											label="MAX Y"
											value={current().requestedBounds.maxY}
											onInput={(maxY) =>
												updateDraft((value) => ({
													...value,
													requestedBounds: {
														...value.requestedBounds,
														maxY
													}
												}))
											}
										/>
									</div>
									<div {...stylex.props(styles.metrics)}>
										<Metric
											label="TOTAL TILES"
											value={grid()?.tileCount ?? "—"}
										/>
										<Metric
											label="Z0 GRID"
											value={
												coarsestLevel() === undefined
													? "—"
													: `${coarsestLevel()!.rows} × ${coarsestLevel()!.columns}`
											}
										/>
										<Metric
											label="Z0 IMAGE"
											value={
												coarsestLevel() === undefined
													? "—"
													: `${formatMeasurement(
															coarsestLevel()!.columns *
																current().tilePixelSize
														)} × ${formatMeasurement(
															coarsestLevel()!.rows *
																current().tilePixelSize
														)} PX`
											}
										/>
									</div>
									<div {...stylex.props(styles.tileSizeControl)}>
										<div {...stylex.props(styles.controlLabel)}>
											<span>PNG TILE SIZE</span>
											<small>OUTPUT CHUNK · SQUARE</small>
										</div>
										<div
											role="group"
											aria-label="PNG tile size"
											{...stylex.props(styles.optionRail)}
										>
											<For each={tilePixelSizeOptions}>
												{(tilePixelSize) => (
													<button
														type="button"
														aria-label={`${formatMeasurement(tilePixelSize)} px`}
														aria-pressed={
															current().tilePixelSize ===
															tilePixelSize
														}
														onClick={() =>
															updateDraft((value) => ({
																...value,
																tilePixelSize
															}))
														}
														{...stylex.props(
															styles.optionButton,
															current().tilePixelSize ===
																tilePixelSize &&
																styles.optionButtonSelected
														)}
													>
														<strong>
															{formatMeasurement(tilePixelSize)}
														</strong>
														<small>PX</small>
													</button>
												)}
											</For>
										</div>
										<Show
											when={!isTilePixelSizeOption(current().tilePixelSize)}
										>
											<p {...stylex.props(styles.customValueNotice)}>
												This opened plan uses a custom{" "}
												{current().tilePixelSize} px tile. Choose a standard
												output size above to replace it.
											</p>
										</Show>
									</div>
									<label {...stylex.props(styles.resolutionControl)}>
										<div {...stylex.props(styles.controlLabel)}>
											<span>COARSEST RESOLUTION</span>
											<small>1 PX = WORLD UNITS</small>
										</div>
										<select
											aria-label="Coarsest resolution"
											value={current().levels.coarsestUnitsPerPixel}
											onChange={(event) => {
												const coarsestUnitsPerPixel = Number(
													event.currentTarget.value
												);
												updateDraft((value) => ({
													...value,
													levels: {
														...value.levels,
														coarsestUnitsPerPixel
													}
												}));
											}}
											{...stylex.props(styles.resolutionSelect)}
										>
											<Show
												when={
													!isCoarsestResolutionOption(
														current().levels.coarsestUnitsPerPixel
													)
												}
											>
												<option
													value={current().levels.coarsestUnitsPerPixel}
												>
													CUSTOM · 1 PX ={" "}
													{formatMeasurement(
														current().levels.coarsestUnitsPerPixel
													)}{" "}
													UU
												</option>
											</Show>
											<For each={coarsestResolutionOptions}>
												{(option) => (
													<option value={option.value}>
														{option.label} UU/PX ·
														{` ${formatMeasurement(
															current().tilePixelSize * option.value
														)} UU PER TILE`}
													</option>
												)}
											</For>
										</select>
									</label>
									<div {...stylex.props(styles.resolutionReadout)}>
										<div>
											<small>ONE Z0 PNG COVERS</small>
											<strong>
												{formatMeasurement(
													current().tilePixelSize *
														current().levels.coarsestUnitsPerPixel
												)}{" "}
												×{" "}
												{formatMeasurement(
													current().tilePixelSize *
														current().levels.coarsestUnitsPerPixel
												)}{" "}
												UU
											</strong>
										</div>
										<code>
											{formatMeasurement(current().tilePixelSize)} PX ×{" "}
											{formatMeasurement(
												current().levels.coarsestUnitsPerPixel
											)}{" "}
											UU/PX
										</code>
									</div>
									<div {...stylex.props(styles.fieldGrid)}>
										<NumberField
											label="GUTTER PX"
											min={0}
											max={32}
											step={1}
											value={current().gutterPixels}
											onInput={(gutterPixels) =>
												updateDraft((value) => ({ ...value, gutterPixels }))
											}
										/>
										<NumberField
											label="LEVEL COUNT"
											min={1}
											max={24}
											step={1}
											value={current().levels.count}
											onInput={updateLevelCount}
										/>
									</div>
									<div {...stylex.props(styles.levelLadder)}>
										<For each={grid()?.grid.levels.slice(0, 3) ?? []}>
											{(level) => (
												<div {...stylex.props(styles.levelStep)}>
													<small>Z{level.zoom}</small>
													<strong>
														{formatMeasurement(level.unitsPerPixel)}{" "}
														UU/PX
													</strong>
													<span>
														{formatMeasurement(level.tileWorldSize)}{" "}
														UU/TILE
													</span>
												</div>
											)}
										</For>
										<Show when={current().levels.count > 3}>
											<span {...stylex.props(styles.moreLevels)}>
												+{current().levels.count - 3} FINER LEVELS
											</span>
										</Show>
									</div>
								</section>

								<section {...stylex.props(styles.panel)}>
									<div {...stylex.props(styles.sectionHeading)}>
										<p {...stylex.props(styles.sectionLabel)}>CAPTURE</p>
										<select
											aria-label="Render profile"
											value={current().capture.render.profile}
											onChange={(event) =>
												updateRender((render) => ({
													...render,
													profile: event.currentTarget.value as
														| "full_fidelity"
														| "observation"
												}))
											}
											{...stylex.props(styles.select)}
										>
											<option value="full_fidelity">FULL FIDELITY</option>
											<option value="observation">OBSERVATION</option>
										</select>
									</div>
									<NumberField
										label="CAPTURE Z"
										value={current().capture.z}
										onInput={(z) =>
											updateDraft((value) => ({
												...value,
												capture: { ...value.capture, z }
											}))
										}
									/>
									<Toggle
										checked={current().capture.render.effects.fog}
										label="Fog"
										onChange={(fog) =>
											updateRender((render) => ({
												...render,
												effects: { ...render.effects, fog }
											}))
										}
									/>
									<Toggle
										checked={current().capture.render.effects.volumetricFog}
										label="Volumetric fog"
										onChange={(volumetricFog) =>
											updateRender((render) => ({
												...render,
												effects: { ...render.effects, volumetricFog }
											}))
										}
									/>
								</section>

								<section {...stylex.props(styles.panel)}>
									<div {...stylex.props(styles.sectionHeading)}>
										<p {...stylex.props(styles.sectionLabel)}>LOD BY LEVEL</p>
										<select
											aria-label="LOD policy"
											value={
												current().capture.render.lodPolicy ===
												"per_level_distance_scale"
													? "per_level_distance_scale"
													: "natural"
											}
											onChange={(event) =>
												setLodPolicy(
													event.currentTarget.value as
														| "natural"
														| "per_level_distance_scale"
												)
											}
											{...stylex.props(styles.select)}
										>
											<option value="natural">NATURAL</option>
											<option value="per_level_distance_scale">
												PER LEVEL
											</option>
										</select>
									</div>
									<Show
										when={
											current().capture.render.lodPolicy ===
											"per_level_distance_scale"
										}
									>
										<div {...stylex.props(styles.levels)}>
											<For each={grid()?.grid.levels ?? []}>
												{(level) => (
													<NumberField
														label={`Z${level.zoom} · ${level.unitsPerPixel} UU/PX`}
														min={0.1}
														max={100}
														step={0.1}
														value={
															current().capture.render
																.lodDistanceScaleByZoom?.[
																level.zoom
															] ?? 1
														}
														onInput={(value) =>
															setLodScale(level.zoom, value)
														}
													/>
												)}
											</For>
										</div>
									</Show>
									<p {...stylex.props(styles.hint)}>
										Orientation, PNG output, immutable publication, and
										unchanged data layers are fixed v1 invariants in this
										editor.
									</p>
								</section>

								<Show when={validation()?.status === "invalid"}>
									<section {...stylex.props(styles.validationPanel)}>
										<strong>PLAN NEEDS ATTENTION</strong>
										<For each={validationErrors()}>
											{(error) => <p>{error}</p>}
										</For>
									</section>
								</Show>

								<div {...stylex.props(styles.saveActions)}>
									<button
										type="button"
										disabled={plan() === undefined || !isDirty()}
										onClick={() => savePlan(false)}
										{...stylex.props(styles.secondaryButton)}
									>
										SAVE
									</button>
									<button
										type="button"
										disabled={plan() === undefined}
										onClick={() => savePlan(true)}
										{...stylex.props(styles.secondaryButton)}
									>
										SAVE AS
									</button>
								</div>
								<div {...stylex.props(styles.actions)}>
									<button
										type="button"
										onClick={openMap}
										disabled={plan() === undefined || isCapturing()}
										{...stylex.props(styles.secondaryButton)}
									>
										OPEN TARGET MAP
									</button>
									<button
										type="button"
										onClick={() => runCapture(true)}
										disabled={plan() === undefined || isCapturing()}
										{...stylex.props(styles.captureButton)}
									>
										OPEN + CAPTURE
									</button>
								</div>
							</>
						)}
					</Show>
				</aside>

				<section aria-busy={isCapturing()} {...stylex.props(styles.stage)}>
					<Show
						when={capture()}
						fallback={
							<div {...stylex.props(styles.gridPreview)}>
								<Show when={readyLivePreview()}>
									{(preview) => <MapCaptureLiveCanvas preview={preview()} />}
								</Show>
								<div {...stylex.props(styles.previewShade)} />
								<div {...stylex.props(styles.north)}>+X / NORTH</div>
								<div
									style={livePreviewBoundary()}
									{...stylex.props(styles.captureBoundary)}
								/>
								<div {...stylex.props(styles.previewStatus)}>
									<Show when={livePreview().status === "loading"}>
										<span {...stylex.props(styles.previewPulse)} />
										<strong>CONNECTING TOP CAMERA</strong>
									</Show>
									<Show when={readyLivePreview()}>
										{(preview) => (
											<>
												<span {...stylex.props(styles.previewLive)} />
												<strong>
													{preview().previewContext === "editor_live"
														? "EDITOR LIVE"
														: "PLAY LIVE"}
												</strong>
												<small>OBSERVATION FRAMING</small>
											</>
										)}
									</Show>
								</div>
								<Show when={failedLivePreview()}>
									{(failed) => (
										<div {...stylex.props(styles.previewFailure)}>
											<strong>LIVE FRAMING UNAVAILABLE</strong>
											<p>{failed().message}</p>
											<button
												type="button"
												onClick={() =>
													setPreviewRefresh((value) => value + 1)
												}
												{...stylex.props(styles.previewRetry)}
											>
												RETRY
											</button>
										</div>
									)}
								</Show>
								<div {...stylex.props(styles.gridReadout)}>
									<span>
										{readyLivePreview()
											? "SNAPPED CAPTURE EXTENT"
											: "LIVE PLAN GEOMETRY"}
									</span>
									<strong>
										{grid()?.tileCount.toLocaleString() ?? "—"} TILES
									</strong>
									<small>
										Z0 → Z{Math.max(0, (draft()?.levels.count ?? 1) - 1)}
									</small>
								</div>
							</div>
						}
					>
						{(completed) => (
							<MapCaptureActorWorkspace
								loadActors={() =>
									props.client.actors(completed().manifest.project.mapPath)
								}
								manifest={completed().manifest}
								tileUrl={(_key, relativePath) =>
									previewUrls().get(relativePath) ?? ""
								}
							/>
						)}
					</Show>
					<Show when={captureProgress()}>
						{(progress) => {
							const processed = () =>
								Math.min(progress().processedTiles, progress().totalTiles);
							const percent = () =>
								Math.round((processed() / progress().totalTiles) * 100);
							const capturedTiles = () =>
								Math.max(0, processed() - progress().failedTiles);
							return (
								<section
									aria-live="polite"
									{...stylex.props(styles.captureProgress)}
								>
									<header {...stylex.props(styles.progressHeader)}>
										<div {...stylex.props(styles.progressPhase)}>
											<span {...stylex.props(styles.progressPulse)} />
											<strong>{capturePhaseLabel(progress().phase)}</strong>
										</div>
										<code>{percent()}%</code>
									</header>
									<div
										role="progressbar"
										aria-label="Map capture progress"
										aria-valuemin={0}
										aria-valuemax={progress().totalTiles}
										aria-valuenow={processed()}
										aria-valuetext={`${processed()} of ${progress().totalTiles} tiles processed`}
										{...stylex.props(styles.progressTrack)}
									>
										<div
											style={{ width: `${percent()}%` }}
											{...stylex.props(styles.progressFill)}
										/>
									</div>
									<footer {...stylex.props(styles.progressMeta)}>
										<span>
											{processed().toLocaleString()} /{" "}
											{progress().totalTiles.toLocaleString()} PROCESSED
										</span>
										<span>{capturedTiles().toLocaleString()} CAPTURED</span>
										<Show when={progress().failedTiles > 0}>
											<span {...stylex.props(styles.progressFailures)}>
												{progress().failedTiles.toLocaleString()} FAILED
											</span>
										</Show>
									</footer>
								</section>
							);
						}}
					</Show>
					<footer {...stylex.props(styles.status, styles[notice().tone])}>
						<span>{notice().tone.toUpperCase()}</span>
						<p>{notice().text}</p>
						<code>{selection()?.planPath ?? "NEW / NOT YET SAVED"}</code>
					</footer>
				</section>
			</div>
		</main>
	);
}

function TextField(props: {
	readonly label: string;
	readonly value: string;
	readonly onInput: (value: string) => void;
}) {
	return (
		<label {...stylex.props(styles.field)}>
			<span>{props.label}</span>
			<input
				type="text"
				value={props.value}
				onInput={(event) => props.onInput(event.currentTarget.value)}
				{...stylex.props(styles.input)}
			/>
		</label>
	);
}

function NumberField(props: {
	readonly label: string;
	readonly max?: number;
	readonly min?: number;
	readonly step?: number;
	readonly value: number;
	readonly onInput: (value: number) => void;
}) {
	return (
		<label {...stylex.props(styles.field)}>
			<span>{props.label}</span>
			<input
				type="number"
				max={props.max}
				min={props.min}
				step={props.step}
				value={props.value}
				onInput={(event) => props.onInput(event.currentTarget.valueAsNumber)}
				{...stylex.props(styles.input)}
			/>
		</label>
	);
}

function Metric(props: { readonly label: string; readonly value: number | string }) {
	return (
		<div {...stylex.props(styles.metric)}>
			<small>{props.label}</small>
			<strong>{props.value}</strong>
		</div>
	);
}

function Toggle(props: {
	readonly checked: boolean;
	readonly label: string;
	readonly onChange: (checked: boolean) => void;
}) {
	return (
		<label {...stylex.props(styles.toggle)}>
			<span>{props.label}</span>
			<input
				type="checkbox"
				checked={props.checked}
				onChange={(event) => props.onChange(event.currentTarget.checked)}
				{...stylex.props(styles.checkbox)}
			/>
			<i {...stylex.props(styles.switchTrack, props.checked && styles.switchOn)} />
		</label>
	);
}

const styles = stylex.create({
	page: { minHeight: "calc(100vh - 52px)", backgroundColor: "#0c100e", color: tokens.colorText },
	hero: {
		display: "grid",
		gridTemplateColumns: "minmax(420px, 1fr) minmax(280px, .7fr) auto",
		alignItems: "end",
		gap: 36,
		padding: "34px 42px 28px",
		borderBottom: "1px solid #303831",
		backgroundImage: "linear-gradient(110deg, #152018 0%, #0c100e 55%, #182015 100%)"
	},
	eyebrow: { margin: 0, color: "#8da87a", fontSize: 9, letterSpacing: ".2em" },
	title: { margin: "8px 0 0", fontFamily: "Georgia, serif", fontSize: 36, fontWeight: 400 },
	intro: { margin: 0, color: "#879087", fontSize: 11, lineHeight: 1.7 },
	heroActions: { display: "flex", gap: 8 },
	layout: { display: "grid", gridTemplateColumns: "430px minmax(0, 1fr)", minHeight: 720 },
	controls: {
		maxHeight: "calc(100vh - 170px)",
		overflowY: "auto",
		borderRight: "1px solid #303831",
		backgroundColor: "#111613",
		padding: 22
	},
	panel: {
		marginBottom: 14,
		padding: 18,
		border: "1px solid #303831",
		backgroundColor: "#151b17"
	},
	emptyPanel: { padding: 28, border: "1px dashed #3d493f", color: "#7e897f" },
	sectionLabel: { margin: 0, color: "#79867a", fontSize: 8, letterSpacing: ".18em" },
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 12
	},
	dirtyFlag: { color: "#758077", fontSize: 8, letterSpacing: ".14em" },
	dirty: { color: "#e3b65d" },
	fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, margin: "14px 0" },
	boundsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 },
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: "#778179",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	input: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #3b473d",
		backgroundColor: "#0c100e",
		color: "#c7d0c8",
		padding: "7px 8px",
		fontSize: 10
	},
	metrics: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		gap: 1,
		marginTop: 16,
		backgroundColor: "#303831"
	},
	tileSizeControl: { display: "grid", gap: 9, marginTop: 16 },
	controlLabel: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		color: "#778179",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	optionRail: {
		display: "grid",
		gridTemplateColumns: "repeat(4, 1fr)",
		gap: 1,
		padding: 1,
		backgroundColor: "#3b473d"
	},
	optionButton: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "center",
		gap: 4,
		minWidth: 0,
		border: 0,
		backgroundColor: { default: "#0c100e", ":hover": "#192219" },
		color: "#879288",
		padding: "9px 4px",
		cursor: "pointer",
		fontSize: 9
	},
	optionButtonSelected: {
		backgroundColor: { default: "#29391f", ":hover": "#314526" },
		color: "#d9f2b7",
		boxShadow: "inset 0 -2px #b7e26d"
	},
	customValueNotice: {
		margin: 0,
		color: "#d1ae61",
		fontSize: 8,
		lineHeight: 1.5
	},
	resolutionControl: { display: "grid", gap: 8, marginTop: 16 },
	resolutionSelect: {
		width: "100%",
		border: "1px solid #3b473d",
		backgroundColor: "#0c100e",
		color: "#c7d0c8",
		padding: "9px 10px",
		fontSize: 10
	},
	resolutionReadout: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 14,
		marginTop: 8,
		padding: "11px 12px",
		borderLeft: "2px solid #b7e26d",
		backgroundColor: "#101512",
		color: "#758077",
		fontSize: 8
	},
	levelLadder: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 1,
		marginTop: 4,
		backgroundColor: "#303831"
	},
	levelStep: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		minWidth: 0,
		padding: "9px 8px",
		backgroundColor: "#101512",
		color: "#728074",
		fontSize: 7
	},
	moreLevels: {
		gridColumn: "1 / -1",
		padding: "7px 8px",
		backgroundColor: "#101512",
		color: "#788579",
		fontSize: 7,
		letterSpacing: ".1em"
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: 10,
		backgroundColor: "#101512"
	},
	select: {
		border: "1px solid #3b473d",
		backgroundColor: "#0c100e",
		color: "#bcc8bd",
		padding: "6px 8px",
		fontSize: 9
	},
	toggle: {
		position: "relative",
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: 14,
		fontSize: 11
	},
	checkbox: { position: "absolute", width: 1, height: 1, opacity: 0 },
	switchTrack: {
		width: 31,
		height: 16,
		borderRadius: 12,
		backgroundColor: "#384039",
		boxShadow: "inset 0 0 0 1px #4c554d"
	},
	switchOn: {
		backgroundColor: "#8ebd66",
		boxShadow: "inset 0 0 0 1px #b2db8d, 0 0 12px #8ebd6644"
	},
	levels: {
		display: "grid",
		gap: 8,
		marginTop: 12,
		paddingTop: 12,
		borderTop: "1px solid #303831"
	},
	hint: { margin: "12px 0 0", color: "#68726a", fontSize: 9, lineHeight: 1.5 },
	validationPanel: {
		marginBottom: 14,
		padding: 14,
		border: "1px solid #713f35",
		backgroundColor: "#241613",
		color: "#d58b79",
		fontSize: 9,
		lineHeight: 1.5
	},
	saveActions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 },
	actions: { display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 8 },
	primaryButton: {
		border: 0,
		backgroundColor: "#b7e26d",
		color: "#10140e",
		padding: "12px 18px",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	headerButton: {
		border: "1px solid #536154",
		backgroundColor: "#172019",
		color: "#bdc8be",
		padding: "12px 18px",
		fontSize: 9,
		fontWeight: 700,
		letterSpacing: ".1em"
	},
	secondaryButton: {
		border: "1px solid #4b594d",
		backgroundColor: "#151b17",
		color: "#aeb9af",
		padding: 12,
		fontSize: 9,
		letterSpacing: ".08em",
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	captureButton: {
		border: "1px solid #b7e26d",
		backgroundColor: "#26351e",
		color: "#d9f2b7",
		padding: 12,
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	stage: {
		position: "relative",
		minWidth: 0,
		padding: 24,
		backgroundImage: "radial-gradient(circle at 50% 45%, #26372755, transparent 42%)"
	},
	gridPreview: {
		position: "relative",
		minHeight: 360,
		aspectRatio: "16 / 9",
		overflow: "hidden",
		border: "1px solid #344037",
		backgroundColor: "#0e1510",
		backgroundImage:
			"linear-gradient(#6f89601b 1px, transparent 1px), linear-gradient(90deg, #6f89601b 1px, transparent 1px)",
		backgroundSize: "48px 48px"
	},
	liveCanvas: {
		position: "absolute",
		inset: 0,
		width: "100%",
		height: "100%",
		objectFit: "contain",
		backgroundColor: "#070b08",
		imageRendering: "auto"
	},
	previewShade: {
		position: "absolute",
		zIndex: 1,
		inset: 0,
		pointerEvents: "none",
		backgroundImage:
			"linear-gradient(180deg, #071008b8 0%, transparent 18%, transparent 68%, #071008d9 100%)"
	},
	captureBoundary: {
		position: "absolute",
		zIndex: 1,
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		boxSizing: "border-box",
		border: "1px solid #b7e26d66",
		boxShadow: "inset 0 0 54px #07100899, 0 0 30px #b7e26d12",
		pointerEvents: "none"
	},
	north: {
		position: "absolute",
		zIndex: 2,
		top: 18,
		left: 18,
		color: "#708174",
		fontSize: 8,
		letterSpacing: ".14em"
	},
	previewStatus: {
		position: "absolute",
		zIndex: 2,
		top: 17,
		right: 18,
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "6px 9px",
		border: "1px solid #536154aa",
		backgroundColor: "#0a100cdd",
		color: "#b8c5b9",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	previewPulse: {
		width: 6,
		height: 6,
		borderRadius: 99,
		backgroundColor: "#d1ae61",
		boxShadow: "0 0 10px #d1ae61"
	},
	previewLive: {
		width: 6,
		height: 6,
		borderRadius: 99,
		backgroundColor: "#b7e26d",
		boxShadow: "0 0 11px #b7e26d"
	},
	previewFailure: {
		position: "absolute",
		zIndex: 2,
		left: "50%",
		top: "50%",
		width: "min(340px, calc(100% - 64px))",
		transform: "translate(-50%, -50%)",
		padding: 18,
		border: "1px solid #765246",
		backgroundColor: "#160f0ddd",
		color: "#d6a18f",
		fontSize: 9,
		lineHeight: 1.5,
		textAlign: "center"
	},
	previewRetry: {
		border: "1px solid #92705e",
		backgroundColor: "#241611",
		color: "#e2b4a0",
		padding: "7px 11px",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	gridReadout: {
		position: "absolute",
		zIndex: 2,
		left: 28,
		bottom: 26,
		display: "flex",
		flexDirection: "column",
		gap: 5,
		paddingLeft: 14,
		borderLeft: "2px solid #b7e26d",
		color: "#8c9c8e",
		fontSize: 9
	},
	captureProgress: {
		position: "absolute",
		zIndex: 2,
		left: 48,
		right: 48,
		bottom: 82,
		padding: "15px 17px 13px",
		border: "1px solid #657956",
		backgroundColor: "#0d130ff2",
		boxShadow: "0 16px 48px #00000099, inset 0 0 28px #9acb7208",
		backdropFilter: "blur(7px)"
	},
	progressHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 10,
		color: "#cce6b4",
		fontSize: 9,
		letterSpacing: ".13em"
	},
	progressPhase: { display: "flex", alignItems: "center", gap: 9 },
	progressPulse: {
		width: 7,
		height: 7,
		borderRadius: 999,
		backgroundColor: "#b7e26d",
		boxShadow: "0 0 13px #b7e26d"
	},
	progressTrack: {
		height: 8,
		overflow: "hidden",
		border: "1px solid #344337",
		backgroundColor: "#080c09"
	},
	progressFill: {
		height: "100%",
		backgroundImage: "linear-gradient(90deg, #678d4d, #b7e26d)",
		boxShadow: "0 0 16px #b7e26d66",
		transitionProperty: "width",
		transitionDuration: "180ms",
		transitionTimingFunction: "ease-out"
	},
	progressMeta: {
		display: "flex",
		gap: 18,
		marginTop: 9,
		color: "#7f9182",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	progressFailures: { color: "#d98268" },
	status: {
		display: "grid",
		gridTemplateColumns: "80px 1fr minmax(180px, auto)",
		alignItems: "center",
		gap: 18,
		marginTop: 12,
		padding: "11px 14px",
		border: "1px solid #303831",
		color: "#7d887f",
		fontSize: 9
	},
	info: { borderLeftColor: "#718178" },
	success: { borderLeftColor: "#9acb72", color: "#a9c59f" },
	error: { borderLeftColor: "#d36b52", color: "#cf8b79" }
});
