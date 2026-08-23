import * as stylex from "@stylexjs/stylex";
import { savedMapPathToGameMapPath } from "@ue-shed/cameras/map-tiles";
import {
	SavedMapPicker,
	createEffectAction,
	createEffectSubscription,
	type SavedMapPickerOption
} from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Schema } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
	MapCaptureClientApi,
	MapCaptureExecuteIntent,
	MapCaptureExecuteResult,
	MapCaptureLivePreviewResult,
	MapCaptureProgressEvent,
	MapCaptureSelectionResult
} from "./map-capture-client.js";
import {
	mapCaptureDraftCenter,
	mapCaptureDraftGrid,
	mapCaptureDraftSize,
	mapCapturePlanDraft,
	recenterMapCapturePlanDraft,
	resizeMapCapturePlanDraft,
	setMapCaptureDraftGridSize,
	setMapCaptureDraftTileSize,
	validateMapCapturePlanDraft,
	type MapCapturePlanDraft
} from "./map-capture-plan-draft.js";
import { MapCaptureActorWorkspace } from "./map-capture-actor-workspace.js";

type ReadySelection = Extract<MapCaptureSelectionResult, { readonly status: "ready" }>;
type CompletedCapture = Extract<MapCaptureExecuteResult, { readonly status: "completed" }>;
type ReadyLivePreview = Extract<MapCaptureLivePreviewResult, { readonly status: "ready" }>;
type CaptureBackend = MapCaptureExecuteIntent["captureBackend"];
const decodeRenderProfile = Schema.decodeUnknownSync(
	Schema.Literals(["full_fidelity", "seam_stable", "scene_capture_defaults", "observation"])
);
const decodeCaptureBackend = Schema.decodeUnknownSync(
	Schema.Literals(["scene_capture_tiles", "viewport_high_resolution"])
);
const decodeLodPolicy = Schema.decodeUnknownSync(
	Schema.Literals(["natural", "per_level_distance_scale"])
);
type LivePreviewState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly message: string; readonly recovery: string; readonly status: "failed" }
	| ({ readonly status: "ready" } & Omit<ReadyLivePreview, "status">);
type Notice = {
	readonly technical?: string;
	readonly text: string;
	readonly tone: "error" | "info" | "success";
};

function formatMeasurement(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function causeMessage(cause: Cause.Cause<unknown>): string {
	return Cause.pretty(cause);
}

function capturePhaseLabel(phase: MapCaptureProgressEvent["phase"]): string {
	switch (phase) {
		case "opening_map":
			return "Opening target map";
		case "capturing":
			return "Capturing tiles";
		case "publishing":
			return "Verifying and publishing";
		case "loading_preview":
			return "Loading preview";
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

export function MapCaptureRoute(props: { readonly client: MapCaptureClientApi }) {
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
	const [captureBackend, setCaptureBackend] = createSignal<CaptureBackend>("scene_capture_tiles");
	const [activeCaptureOperationId, setActiveCaptureOperationId] = createSignal<string>();
	const [captureProgress, setCaptureProgress] = createSignal<MapCaptureProgressEvent>();
	const [livePreview, setLivePreview] = createSignal<LivePreviewState>({ status: "idle" });
	const [previewRefresh, setPreviewRefresh] = createSignal(0);
	const [notice, setNotice] = createSignal<Notice>({
		tone: "info",
		text: "Create a plan or open a saved plan file to begin."
	});
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
	const captureCenter = createMemo(() => {
		const current = draft();
		return current === undefined ? undefined : mapCaptureDraftCenter(current);
	});
	const captureSize = createMemo(() => {
		const current = draft();
		return current === undefined ? undefined : mapCaptureDraftSize(current);
	});
	const isDirty = createMemo(() => {
		const current = draft();
		return current !== undefined && JSON.stringify(current) !== savedPlanJson();
	});
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
	const requestedPreviewBoundary = createMemo(() => {
		const currentGrid = grid()?.grid;
		if (currentGrid === undefined)
			return { height: "100%", left: "0%", top: "0%", width: "100%" };
		const requested = currentGrid.requestedBounds;
		const snapped = currentGrid.snappedBounds;
		const xSpan = snapped.maxX - snapped.minX;
		const ySpan = snapped.maxY - snapped.minY;
		return {
			height: `${(100 * (requested.maxX - requested.minX)) / xSpan}%`,
			left: `${(100 * (requested.minY - snapped.minY)) / ySpan}%`,
			top: `${(100 * (snapped.maxX - requested.maxX)) / xSpan}%`,
			width: `${(100 * (requested.maxY - requested.minY)) / ySpan}%`
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
						? "New plan ready to edit."
						: `${result.tileCount.toLocaleString()} tiles loaded from the saved plan.`
			});
		} else if (result.status === "failed") {
			setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
		}
	}

	function newPlan() {
		setNotice({ tone: "info", text: "Creating a plan from the selected project…" });
		newAction.run(props.client.newPlan(), {
			onFailure: (cause) =>
				setNotice({
					text: "Couldn't create a plan.",
					technical: causeMessage(cause),
					tone: "error"
				}),
			onSuccess: acceptSelection
		});
	}

	function choosePlan() {
		setNotice({ tone: "info", text: "Reading plan file…" });
		chooseAction.run(props.client.choosePlan(), {
			onFailure: (cause) =>
				setNotice({
					text: "Couldn't read the plan file.",
					technical: causeMessage(cause),
					tone: "error"
				}),
			onSuccess: acceptSelection
		});
	}

	function updateDraft(change: (current: MapCapturePlanDraft) => MapCapturePlanDraft) {
		setDraft((current) => (current === undefined ? current : change(current)));
		setCapture(undefined);
		setNotice({ tone: "info", text: "Plan changed. Save it to share the new version." });
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

	function updateCaptureCenter(axis: "x" | "y", coordinate: number) {
		updateDraft((current) => {
			const center = mapCaptureDraftCenter(current);
			return recenterMapCapturePlanDraft(current, { ...center, [axis]: coordinate });
		});
	}

	function updateCaptureSize(size: number) {
		updateDraft((current) => resizeMapCapturePlanDraft(current, size));
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
		setNotice({ tone: "info", text: saveAs ? "Choosing where to save…" : "Saving plan…" });
		saveAction.run(
			props.client.savePlan({
				plan: current,
				...(currentPlanPath === undefined ? undefined : { planPath: currentPlanPath }),
				saveAs
			}),
			{
				onFailure: (cause) =>
					setNotice({
						text: "Couldn't save the plan.",
						technical: causeMessage(cause),
						tone: "error"
					}),
				onSuccess: (result) => {
					if (result.status === "failed") {
						setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
						return;
					}
					if (result.status === "cancelled") {
						setNotice({
							tone: "info",
							text: "Save cancelled; your edits are still here."
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
						text: `Saved plan to ${result.planPath}.`
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
			onFailure: (cause) =>
				setNotice({
					text: "Couldn't open the target map.",
					technical: causeMessage(cause),
					tone: "error"
				}),
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
			text:
				captureBackend() === "viewport_high_resolution"
					? "Opening the map, then rendering each zoom with Unreal's viewport high-resolution screenshot…"
					: openMapFirst
						? "Opening the target map, then capturing tiles in batches…"
						: "Capturing the currently open map in batches…"
		});
		captureAction.run(
			props.client.capture({
				captureBackend: captureBackend(),
				openMap: openMapFirst,
				operationId,
				plan: current
			}),
			{
				onFailure: (cause) => {
					setActiveCaptureOperationId(undefined);
					setCaptureProgress(undefined);
					setNotice({
						text: "Capture failed before it could finish.",
						technical: causeMessage(cause),
						tone: "error"
					});
				},
				onSuccess: (result) => {
					setActiveCaptureOperationId(undefined);
					setCaptureProgress(undefined);
					if (result.status === "failed") {
						setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
						return;
					}
					setCapture(result);
					setNotice({
						tone: result.published ? "success" : "error",
						text: result.published
							? `Run ${result.manifest.runId} published. Tiles load on demand below.`
							: `Capture stayed a ${result.manifest.state} attempt; check failed tiles below.`
					});
				}
			}
		);
	}

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.headerCopy)}>
					<h1 {...stylex.props(styles.title)}>Map capture</h1>
					<p {...stylex.props(styles.subtitle)}>
						Publish multiresolution tiles of a saved map through a versioned plan.
					</p>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<button type="button" onClick={newPlan} {...stylex.props(styles.quietButton)}>
						New plan
					</button>
					<button
						type="button"
						disabled={plan() === undefined || isCapturing()}
						onClick={() => runCapture(true)}
						{...stylex.props(styles.primaryButton)}
					>
						Capture
					</button>
				</div>
			</header>

			<div {...stylex.props(styles.layout)}>
				<aside {...stylex.props(styles.controls)}>
					<Show
						when={draft()}
						fallback={
							<p {...stylex.props(styles.controlsEmpty)}>
								No plan yet. Use <strong>New plan</strong> above to start one from
								the connected project.
							</p>
						}
					>
						{(current) => (
							<>
								<section {...stylex.props(styles.card)}>
									<div {...stylex.props(styles.cardHeading)}>
										<h2 {...stylex.props(styles.sectionTitle)}>Plan</h2>
										<span
											{...stylex.props(
												styles.dirtyFlag,
												isDirty() && styles.dirtyFlagActive
											)}
										>
											{isDirty() ? "Unsaved" : "Saved"}
										</span>
									</div>
									<div {...stylex.props(styles.fieldGrid)}>
										<TextField
											label="Plan ID"
											value={current().id}
											onInput={(id) =>
												updateDraft((value) => ({ ...value, id }))
											}
										/>
										<TextField
											label="Project ID"
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
										label="Target map"
										maps={mapOptions()}
										mapPath={current().project.mapPath}
										onMapPathChange={(mapPath) =>
											updateDraft((value) => ({
												...value,
												project: { ...value.project, mapPath }
											}))
										}
									/>
									<div {...stylex.props(styles.planActions)}>
										<button
											type="button"
											disabled={plan() === undefined || !isDirty()}
											onClick={() => savePlan(false)}
											{...stylex.props(styles.quietButton)}
										>
											Save
										</button>
										<button
											type="button"
											disabled={plan() === undefined}
											onClick={() => savePlan(true)}
											{...stylex.props(styles.quietButton)}
										>
											Save as
										</button>
										<button
											type="button"
											onClick={choosePlan}
											{...stylex.props(styles.quietButton)}
										>
											Open plan
										</button>
									</div>
								</section>

								<section {...stylex.props(styles.card)}>
									<div {...stylex.props(styles.cardHeading)}>
										<h2 {...stylex.props(styles.sectionTitle)}>Tiles</h2>
									</div>
									<div {...stylex.props(styles.fieldGridThree)}>
										<NumberField
											label="Center X"
											value={captureCenter()?.x ?? 0}
											onInput={(x) => updateCaptureCenter("x", x)}
										/>
										<NumberField
											label="Center Y"
											value={captureCenter()?.y ?? 0}
											onInput={(y) => updateCaptureCenter("y", y)}
										/>
										<NumberField
											commit
											label="Size · UU"
											min={1}
											step={100}
											title="Square capture width and height in Unreal units."
											value={captureSize() ?? 0}
											onInput={updateCaptureSize}
										/>
									</div>
									<div {...stylex.props(styles.readout)}>
										<small>Requested edges</small>
										<code>
											S {formatMeasurement(current().requestedBounds.minX)} ·
											N {formatMeasurement(current().requestedBounds.maxX)} ·
											W {formatMeasurement(current().requestedBounds.minY)} ·
											E {formatMeasurement(current().requestedBounds.maxY)}
										</code>
									</div>
									<Show when={grid()?.grid}>
										{(currentGrid) => {
											const bounds = () => currentGrid().snappedBounds;
											return (
												<div
													{...stylex.props(
														styles.readout,
														styles.readoutAccent
													)}
												>
													<small>Snapped tile output</small>
													<code>
														Center{" "}
														{formatMeasurement(
															(bounds().minX + bounds().maxX) / 2
														)}
														,{" "}
														{formatMeasurement(
															(bounds().minY + bounds().maxY) / 2
														)}{" "}
														· S {formatMeasurement(bounds().minX)} · N{" "}
														{formatMeasurement(bounds().maxX)} · W{" "}
														{formatMeasurement(bounds().minY)} · E{" "}
														{formatMeasurement(bounds().maxY)}
													</code>
												</div>
											);
										}}
									</Show>
									<div {...stylex.props(styles.metricsGrid)}>
										<Metric
											label="Total tiles"
											value={grid()?.tileCount.toLocaleString() ?? "—"}
										/>
										<Metric
											label="Level 0 image"
											value={
												coarsestLevel() === undefined
													? "—"
													: `${formatMeasurement(
															coarsestLevel()!.columns *
																current().tilePixelSize
														)} × ${formatMeasurement(
															coarsestLevel()!.rows *
																current().tilePixelSize
														)} px`
											}
										/>
									</div>
									<div {...stylex.props(styles.fieldGridThree)}>
										<NumberField
											commit
											label="Base grid"
											min={1}
											step={1}
											title="Level 0 tile count on each axis; enter 1, 2, 4, or any positive whole number."
											value={coarsestLevel()?.rows ?? 1}
											onInput={(tilesPerAxis) =>
												updateDraft((value) =>
													setMapCaptureDraftGridSize(value, tilesPerAxis)
												)
											}
										/>
										<NumberField
											commit
											label="Resolution · UU/PX"
											min={0.01}
											step={0.25}
											title="Level 0 world units per pixel; the same resolution is used on X and Y."
											value={current().levels.coarsestUnitsPerPixel}
											onInput={(coarsestUnitsPerPixel) =>
												updateDraft((value) => ({
													...value,
													levels: {
														...value.levels,
														coarsestUnitsPerPixel
													}
												}))
											}
										/>
										<NumberField
											commit
											label="Tile size · PX"
											min={64}
											max={4_096}
											step={64}
											title="Square PNG size. Changing it preserves tile world coverage by adjusting resolution."
											value={current().tilePixelSize}
											onInput={(tilePixelSize) =>
												updateDraft((value) =>
													setMapCaptureDraftTileSize(value, tilePixelSize)
												)
											}
										/>
									</div>
									<div {...stylex.props(styles.readout, styles.readoutAccent)}>
										<small>Each level 0 tile covers</small>
										<strong {...stylex.props(styles.readoutStrong)}>
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
										<code>
											{formatMeasurement(current().tilePixelSize)} px ×{" "}
											{formatMeasurement(
												current().levels.coarsestUnitsPerPixel
											)}{" "}
											UU/PX
										</code>
									</div>
									<div {...stylex.props(styles.fieldGrid)}>
										<NumberField
											label="Seam overdraw · PX"
											min={0}
											max={32}
											step={1}
											title="Extra pixels rendered past each tile edge, then cropped to prevent seams."
											value={current().gutterPixels}
											onInput={(gutterPixels) =>
												updateDraft((value) => ({ ...value, gutterPixels }))
											}
										/>
										<NumberField
											label="Zoom levels"
											min={1}
											max={24}
											step={1}
											title="Each added level doubles resolution on X and Y."
											value={current().levels.count}
											onInput={updateLevelCount}
										/>
									</div>
									<div {...stylex.props(styles.levelLadder)}>
										<For each={grid()?.grid.levels.slice(0, 3) ?? []}>
											{(level) => (
												<div {...stylex.props(styles.levelStep)}>
													<small>
														{level.zoom === 0
															? "Z0 · widest"
															: `Z${level.zoom}`}
													</small>
													<strong>
														{level.rows} × {level.columns}
													</strong>
													<span>
														{formatMeasurement(level.unitsPerPixel)}{" "}
														UU/PX
													</span>
												</div>
											)}
										</For>
										<Show when={current().levels.count > 3}>
											<span {...stylex.props(styles.moreLevels)}>
												+{current().levels.count - 3} finer levels
											</span>
										</Show>
									</div>
								</section>

								<section {...stylex.props(styles.card)}>
									<div {...stylex.props(styles.cardHeading)}>
										<h2 {...stylex.props(styles.sectionTitle)}>Render</h2>
										<select
											aria-label="Render profile"
											value={current().capture.render.profile}
											onChange={(event) =>
												updateRender((render) => ({
													...render,
													profile: decodeRenderProfile(
														event.currentTarget.value
													)
												}))
											}
											{...stylex.props(styles.select)}
										>
											<option value="full_fidelity">Full fidelity</option>
											<option value="seam_stable">Seam stable</option>
											<option value="scene_capture_defaults">
												Scene capture defaults
											</option>
											<option value="observation">Observation</option>
										</select>
									</div>
									<Show
										when={
											current().capture.render.profile ===
											"scene_capture_defaults"
										}
									>
										<p {...stylex.props(styles.note)}>
											Comparison baseline using the previous tiled
											SceneCapture renderer defaults.
										</p>
									</Show>
									<Show when={current().capture.render.profile === "seam_stable"}>
										<p {...stylex.props(styles.note)}>
											Projects lighting with fixed exposure, spatial AA, and
											view-independent Lumen fallbacks. Renders 2× then
											downsamples.
										</p>
									</Show>
									<NumberField
										label="Capture Z"
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
									<label
										for="map-capture-backend"
										{...stylex.props(styles.field, styles.engineField)}
									>
										<span>Capture engine</span>
										<select
											id="map-capture-backend"
											aria-label="Capture engine"
											value={captureBackend()}
											onChange={(event) =>
												setCaptureBackend(
													decodeCaptureBackend(event.currentTarget.value)
												)
											}
											{...stylex.props(styles.select)}
										>
											<option value="scene_capture_tiles">
												Tiled scene capture
											</option>
											<option value="viewport_high_resolution">
												Viewport high resolution · experimental
											</option>
										</select>
										<Show
											when={captureBackend() === "viewport_high_resolution"}
										>
											<p {...stylex.props(styles.note)}>
												Renders one complete zoom through Unreal&apos;s
												active editor viewport, then cuts that image into
												tiles. Unreal forces LOD0. Tested limit: 8 × 8 tiles
												per zoom.
											</p>
										</Show>
									</label>
								</section>

								<section {...stylex.props(styles.card)}>
									<div {...stylex.props(styles.cardHeading)}>
										<h2 {...stylex.props(styles.sectionTitle)}>
											Detail levels
										</h2>
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
													decodeLodPolicy(event.currentTarget.value)
												)
											}
											{...stylex.props(styles.select)}
										>
											<option value="natural">Natural</option>
											<option value="per_level_distance_scale">
												Per level
											</option>
										</select>
									</div>
									<Show
										when={
											current().capture.render.lodPolicy ===
											"per_level_distance_scale"
										}
									>
										<div {...stylex.props(styles.levelsGrid)}>
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
								</section>

								<Show when={validation()?.status === "invalid"}>
									<section role="alert" {...stylex.props(styles.validationPanel)}>
										<strong>Plan needs attention</strong>
										<For each={validationErrors()}>
											{(error) => <p>{error}</p>}
										</For>
									</section>
								</Show>

								<button
									type="button"
									onClick={openMap}
									disabled={plan() === undefined || isCapturing()}
									{...stylex.props(styles.openMapButton)}
								>
									Open map
								</button>
							</>
						)}
					</Show>
				</aside>

				<section aria-busy={isCapturing()} {...stylex.props(styles.stage)}>
					<Show
						when={draft()}
						fallback={
							<div {...stylex.props(styles.emptyState)}>
								<strong>No plan loaded</strong>
								<span>
									A plan records which part of the map to capture and how tiles
									are sized and stacked. Create one from the connected project, or
									open a saved plan file.
								</span>
								<button
									type="button"
									onClick={choosePlan}
									{...stylex.props(styles.quietButton)}
								>
									Open plan
								</button>
							</div>
						}
					>
						<Show
							when={capture()}
							fallback={
								<div {...stylex.props(styles.gridPreview)}>
									<Show when={readyLivePreview()}>
										{(preview) => <MapCaptureLiveCanvas preview={preview()} />}
									</Show>
									<div {...stylex.props(styles.previewShade)} />
									<div {...stylex.props(styles.north)}>+X north</div>
									<div
										style={livePreviewBoundary()}
										{...stylex.props(styles.captureBoundary)}
									>
										<div
											style={requestedPreviewBoundary()}
											{...stylex.props(styles.requestedBoundary)}
										>
											<span {...stylex.props(styles.requestedBoundaryLabel)}>
												Requested area
											</span>
										</div>
									</div>
									<div {...stylex.props(styles.previewStatus)}>
										<Show when={livePreview().status === "loading"}>
											<span {...stylex.props(styles.previewPulse)} />
											<strong>Connecting camera…</strong>
										</Show>
										<Show when={readyLivePreview()}>
											{(preview) => (
												<>
													<span {...stylex.props(styles.previewLive)} />
													<strong>
														{preview().previewContext === "editor_live"
															? "Editor live"
															: "Play live"}
													</strong>
													<small>Live framing · not capture output</small>
												</>
											)}
										</Show>
									</div>
									<Show when={failedLivePreview()}>
										{(failed) => (
											<div
												role="alert"
												{...stylex.props(styles.previewFailure)}
											>
												<strong>Preview unavailable</strong>
												<p>{failed().recovery}</p>
												<button
													type="button"
													onClick={() =>
														setPreviewRefresh((value) => value + 1)
													}
													{...stylex.props(styles.retryButton)}
												>
													Retry
												</button>
												<details {...stylex.props(styles.technical)}>
													<summary>Technical details</summary>
													<code>{failed().message}</code>
												</details>
											</div>
										)}
									</Show>
									<div {...stylex.props(styles.gridReadout)}>
										<span>
											{readyLivePreview()
												? "Snapped capture extent"
												: "Plan geometry"}
										</span>
										<strong>
											{grid()?.tileCount.toLocaleString() ?? "—"} tiles
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
									loadTile={(_key, relativePath) =>
										props.client
											.tile({
												manifestPath: completed().manifestPath,
												relativePath
											})
											.pipe(
												Effect.flatMap((result) =>
													result.status === "ready"
														? Effect.succeed(result.bytes)
														: Effect.fail(
																new Error(
																	`${result.message} ${result.recovery}`
																)
															)
												)
											)
									}
									manifest={completed().manifest}
								/>
							)}
						</Show>
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
											{progress().totalTiles.toLocaleString()} processed
										</span>
										<span>{capturedTiles().toLocaleString()} captured</span>
										<Show when={progress().failedTiles > 0}>
											<span {...stylex.props(styles.progressFailures)}>
												{progress().failedTiles.toLocaleString()} failed
											</span>
										</Show>
									</footer>
								</section>
							);
						}}
					</Show>
					<footer aria-live="polite" {...stylex.props(styles.statusBar)}>
						<span
							{...stylex.props(
								styles.statusDot,
								notice().tone === "success"
									? styles.dotSuccess
									: notice().tone === "error"
										? styles.dotError
										: styles.dotInfo
							)}
						/>
						<div {...stylex.props(styles.statusCopy)}>
							<p>{notice().text}</p>
							<Show when={notice().technical}>
								{(technical) => (
									<details {...stylex.props(styles.technical)}>
										<summary>Technical details</summary>
										<code>{technical()}</code>
									</details>
								)}
							</Show>
						</div>
						<code {...stylex.props(styles.statusPath)}>
							{selection()?.planPath ?? "Not saved yet"}
						</code>
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
	readonly commit?: boolean;
	readonly label: string;
	readonly max?: number;
	readonly min?: number;
	readonly step?: number;
	readonly title?: string;
	readonly value: number;
	readonly onInput: (value: number) => void;
}) {
	return (
		<label title={props.title} {...stylex.props(styles.field)}>
			<span>{props.label}</span>
			<input
				type="number"
				max={props.max}
				min={props.min}
				step={props.step}
				value={props.value}
				onBlur={(event) => {
					if (!Number.isFinite(event.currentTarget.valueAsNumber)) {
						event.currentTarget.value = String(props.value);
					}
				}}
				onChange={(event) => {
					if (props.commit && Number.isFinite(event.currentTarget.valueAsNumber)) {
						props.onInput(event.currentTarget.valueAsNumber);
					}
				}}
				onInput={(event) => {
					if (!props.commit && Number.isFinite(event.currentTarget.valueAsNumber)) {
						props.onInput(event.currentTarget.valueAsNumber);
					}
				}}
				{...stylex.props(styles.input, styles.inputMono)}
			/>
		</label>
	);
}

function Metric(props: { readonly label: string; readonly value: number | string }) {
	return (
		<div {...stylex.props(styles.metric)}>
			<small>{props.label}</small>
			<strong {...stylex.props(styles.metricValue)}>{props.value}</strong>
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
	page: {
		minHeight: "calc(100vh - 52px)",
		boxSizing: "border-box",
		padding: tokens.space5,
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		gap: tokens.space4,
		paddingBottom: tokens.space4,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		marginBottom: tokens.space5
	},
	headerCopy: { display: "flex", flexDirection: "column", gap: 6 },
	title: {
		margin: 0,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em",
		color: tokens.colorTextStrong
	},
	subtitle: {
		margin: 0,
		maxWidth: 560,
		fontSize: 14,
		lineHeight: 1.45,
		color: tokens.colorTextMuted
	},
	headerActions: { display: "flex", alignItems: "center", gap: tokens.space2 },
	layout: {
		display: "grid",
		gridTemplateColumns: "410px minmax(0, 1fr)",
		gap: tokens.space5,
		alignItems: "start"
	},
	controls: { display: "grid", minWidth: 0, gap: tokens.space3 },
	controlsEmpty: {
		margin: 0,
		padding: tokens.space4,
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.5
	},
	card: {
		display: "grid",
		gap: tokens.space3,
		padding: tokens.space4,
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	cardHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: tokens.space3,
		minHeight: 28
	},
	sectionTitle: {
		margin: 0,
		fontSize: 13,
		fontWeight: 600,
		color: tokens.colorTextStrong
	},
	dirtyFlag: {
		padding: "1px 8px",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusBadge,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 500
	},
	dirtyFlagActive: {
		borderColor: tokens.colorWarning,
		color: tokens.colorWarning
	},
	fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.space2 },
	fieldGridThree: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: tokens.space2
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	input: {
		width: "100%",
		boxSizing: "border-box",
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "6px 9px",
		fontSize: 13
	},
	inputMono: {
		fontFamily: tokens.fontMono,
		fontVariantNumeric: "tabular-nums"
	},
	select: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "5px 8px",
		fontSize: 12
	},
	readout: {
		display: "grid",
		gap: 4,
		marginTop: tokens.space1,
		padding: "8px 10px",
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle
	},
	readoutAccent: { boxShadow: `inset 2px 0 0 ${tokens.colorAccent}` },
	readoutStrong: {
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		fontWeight: 600
	},
	metricsGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: tokens.space2
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		padding: "8px 10px",
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle
	},
	metricValue: {
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 13
	},
	levelLadder: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: tokens.space2
	},
	levelStep: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		minWidth: 0,
		padding: "8px 10px",
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle
	},
	moreLevels: {
		gridColumn: "1 / -1",
		padding: "7px 10px",
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	note: {
		margin: 0,
		padding: `${tokens.space2}px ${tokens.space3}px`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorAccentWash,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.5
	},
	engineField: { marginTop: tokens.space1 },
	levelsGrid: { display: "grid", gap: tokens.space2 },
	toggle: {
		position: "relative",
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	checkbox: { position: "absolute", width: 1, height: 1, opacity: 0 },
	switchTrack: {
		width: 30,
		height: 16,
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorBorderStrong,
		transitionProperty: "background-color",
		transitionDuration: tokens.motionFast
	},
	switchOn: { backgroundColor: tokens.colorAccent },
	validationPanel: {
		display: "grid",
		gap: tokens.space2,
		padding: tokens.space3,
		border: `1px solid rgba(235, 87, 87, 0.45)`,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 12,
		lineHeight: 1.5
	},
	planActions: { display: "flex", gap: tokens.space2 },
	openMapButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "7px 12px",
		fontSize: 13,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	quietButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "6px 12px",
		fontSize: 13,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	primaryButton: {
		border: `1px solid ${tokens.colorAccent}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":disabled": tokens.colorAccentWash
		},
		color: { default: tokens.colorAccentText, ":disabled": tokens.colorAccent },
		padding: "6px 14px",
		fontWeight: 600,
		fontSize: 13,
		cursor: { default: "pointer", ":disabled": "wait" },
		transition: `transform ${tokens.motionStandard} cubic-bezier(.23,1,.32,1)`,
		transform: { default: "scale(1)", ":active": "scale(.97)" }
	},
	retryButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "4px 12px",
		fontSize: 12,
		cursor: "pointer"
	},
	stage: { position: "relative", minWidth: 0, display: "grid", gap: tokens.space3 },
	emptyState: {
		minHeight: 420,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: tokens.space3,
		padding: tokens.space6,
		border: `1px dashed ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		textAlign: "center"
	},
	gridPreview: {
		position: "relative",
		minHeight: 360,
		aspectRatio: "16 / 9",
		overflow: "hidden",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		backgroundImage:
			"linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px)",
		backgroundSize: "48px 48px"
	},
	liveCanvas: {
		position: "absolute",
		inset: 0,
		width: "100%",
		height: "100%",
		objectFit: "contain",
		backgroundColor: tokens.colorCanvas,
		imageRendering: "auto"
	},
	previewShade: {
		position: "absolute",
		zIndex: 1,
		inset: 0,
		pointerEvents: "none",
		backgroundImage:
			"linear-gradient(180deg, rgba(8, 9, 10, 0.72) 0%, transparent 18%, transparent 68%, rgba(8, 9, 10, 0.85) 100%)"
	},
	captureBoundary: {
		position: "absolute",
		zIndex: 1,
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		boxSizing: "border-box",
		border: "1px solid rgba(228, 242, 34, 0.4)",
		boxShadow: "inset 0 0 54px rgba(8, 9, 10, 0.6), 0 0 30px rgba(228, 242, 34, 0.07)",
		pointerEvents: "none"
	},
	requestedBoundary: {
		position: "absolute",
		boxSizing: "border-box",
		border: "1px dashed rgba(242, 153, 74, 0.8)",
		boxShadow: "inset 0 0 0 1px rgba(8, 9, 10, 0.4)"
	},
	requestedBoundaryLabel: {
		position: "absolute",
		left: 4,
		top: 4,
		padding: "2px 6px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(8, 9, 10, 0.73)",
		color: tokens.colorWarning,
		fontSize: 11,
		whiteSpace: "nowrap"
	},
	north: {
		position: "absolute",
		zIndex: 2,
		top: tokens.space3,
		left: tokens.space4,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	previewStatus: {
		position: "absolute",
		zIndex: 2,
		top: tokens.space3,
		right: tokens.space4,
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "5px 10px",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(12, 13, 14, 0.87)",
		color: tokens.colorText,
		fontSize: 11
	},
	previewPulse: {
		width: 6,
		height: 6,
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorWarning
	},
	previewLive: {
		width: 6,
		height: 6,
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorAccent
	},
	previewFailure: {
		position: "absolute",
		zIndex: 2,
		left: "50%",
		top: "50%",
		width: "min(360px, calc(100% - 64px))",
		transform: "translate(-50%, -50%)",
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		padding: tokens.space4,
		border: `1px solid rgba(235, 87, 87, 0.45)`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.5,
		textAlign: "left"
	},
	technical: {
		alignSelf: "stretch",
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	gridReadout: {
		position: "absolute",
		zIndex: 2,
		left: tokens.space4,
		bottom: tokens.space4,
		display: "flex",
		flexDirection: "column",
		gap: 3,
		paddingLeft: 10,
		borderLeft: `2px solid ${tokens.colorAccent}`,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	captureProgress: {
		position: "absolute",
		zIndex: 2,
		left: tokens.space6,
		right: tokens.space6,
		bottom: 76,
		padding: `${tokens.space3}px ${tokens.space4}px`,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(15, 16, 17, 0.95)",
		boxShadow: tokens.shadowOverlay,
		backdropFilter: "blur(7px)"
	},
	progressHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: tokens.space2,
		color: tokens.colorText,
		fontSize: 12
	},
	progressPhase: { display: "flex", alignItems: "center", gap: 8 },
	progressPulse: {
		width: 7,
		height: 7,
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorAccent
	},
	progressTrack: {
		height: 6,
		overflow: "hidden",
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorSurfaceInset
	},
	progressFill: {
		height: "100%",
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorAccent,
		transitionProperty: "width",
		transitionDuration: tokens.motionStandard,
		transitionTimingFunction: "ease-out"
	},
	progressMeta: {
		display: "flex",
		gap: tokens.space4,
		marginTop: tokens.space2,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums"
	},
	progressFailures: { color: tokens.colorDanger },
	statusBar: {
		display: "flex",
		alignItems: "flex-start",
		gap: tokens.space3,
		padding: `${tokens.space3}px ${tokens.space4}px`,
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	statusDot: {
		flexShrink: 0,
		width: 8,
		height: 8,
		marginTop: 5,
		borderRadius: tokens.radiusPill,
		backgroundColor: "currentColor"
	},
	dotInfo: { color: tokens.colorTextSubtle },
	dotSuccess: { color: tokens.colorSuccess },
	dotError: { color: tokens.colorDanger },
	statusCopy: {
		flex: 1,
		minWidth: 0,
		display: "grid",
		gap: tokens.space1
	},
	statusPath: {
		flexShrink: 0,
		maxWidth: 280,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	}
});
