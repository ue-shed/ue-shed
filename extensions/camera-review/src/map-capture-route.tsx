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

function formatMeasurement(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
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
		setNotice({ tone: "info", text: "Reading portable plan…" });
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
		setNotice({ tone: "info", text: saveAs ? "Choosing a plan destination…" : "Saving plan…" });
		saveAction.run(
			props.client.savePlan({
				plan: current,
				...(currentPlanPath === undefined ? undefined : { planPath: currentPlanPath }),
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
			text:
				captureBackend() === "viewport_high_resolution"
					? "Opening the map, then rendering each zoom with Unreal's viewport High Resolution Screenshot…"
					: openMapFirst
						? "Safely opening the target map, then capturing bounded batches…"
						: "Capturing the currently open target map in bounded batches…"
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
					setNotice({
						tone: result.published ? "success" : "error",
						text: result.published
							? `Published immutable run ${result.manifest.runId}. Exact tiles load on demand in Capture Proof.`
							: `Capture remained a ${result.manifest.state} attempt; inspect its failures in Capture Proof.`
					});
				}
			}
		);
	}

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.hero)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>PLAN AUTHORING</p>
					<h1 {...stylex.props(styles.title)}>Map Capture</h1>
				</div>
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
									<p {...stylex.props(styles.sectionLabel)}>CAPTURE AREA</p>
									<div {...stylex.props(styles.captureAreaGrid)}>
										<NumberField
											label="CENTER X"
											value={captureCenter()?.x ?? 0}
											onInput={(x) => updateCaptureCenter("x", x)}
										/>
										<NumberField
											label="CENTER Y"
											value={captureCenter()?.y ?? 0}
											onInput={(y) => updateCaptureCenter("y", y)}
										/>
										<NumberField
											commit
											label="SIZE · UU"
											min={1}
											step={100}
											title="Square capture width and height in Unreal units."
											value={captureSize() ?? 0}
											onInput={updateCaptureSize}
										/>
									</div>
									<div {...stylex.props(styles.requestedExtent)}>
										<small>REQUESTED EDGES</small>
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
												<div {...stylex.props(styles.outputExtent)}>
													<small>ACTUAL TILE OUTPUT</small>
													<code>
														CENTER{" "}
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
									<div {...stylex.props(styles.metrics)}>
										<Metric
											label="TOTAL TILES"
											value={grid()?.tileCount ?? "—"}
										/>
										<Metric
											label="LEVEL 0 IMAGE"
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
									<div {...stylex.props(styles.tileGeometryControl)}>
										<div {...stylex.props(styles.captureAreaGrid)}>
											<NumberField
												commit
												label="BASE GRID · N × N"
												min={1}
												step={1}
												title="Level 0 tile count on each axis; enter 1, 2, 4, or any positive whole number."
												value={coarsestLevel()?.rows ?? 1}
												onInput={(tilesPerAxis) =>
													updateDraft((value) =>
														setMapCaptureDraftGridSize(
															value,
															tilesPerAxis
														)
													)
												}
											/>
											<NumberField
												commit
												label="RESOLUTION · UU/PX"
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
												label="TILE SIZE · PX"
												min={64}
												max={4_096}
												step={64}
												title="Square PNG size. Changing it preserves tile world coverage by adjusting resolution."
												value={current().tilePixelSize}
												onInput={(tilePixelSize) =>
													updateDraft((value) =>
														setMapCaptureDraftTileSize(
															value,
															tilePixelSize
														)
													)
												}
											/>
										</div>
									</div>
									<div {...stylex.props(styles.resolutionReadout)}>
										<div>
											<small>EACH LEVEL 0 TILE COVERS</small>
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
											label="SEAM OVERDRAW · PX"
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
											label="ZOOM LEVELS"
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
															? "LEVEL 0 · WIDEST"
															: `DETAIL ${level.zoom} · Z${level.zoom}`}
													</small>
													<strong>
														{level.rows} × {level.columns} TILES
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
													profile: decodeRenderProfile(
														event.currentTarget.value
													)
												}))
											}
											{...stylex.props(styles.select)}
										>
											<option value="full_fidelity">FULL FIDELITY</option>
											<option value="seam_stable">SEAM STABLE</option>
											<option value="scene_capture_defaults">
												SCENE CAPTURE DEFAULTS
											</option>
											<option value="observation">OBSERVATION</option>
										</select>
									</div>
									<Show
										when={
											current().capture.render.profile ===
											"scene_capture_defaults"
										}
									>
										<p {...stylex.props(styles.backendNote)}>
											Comparison baseline using the previous tiled
											SceneCapture renderer defaults.
										</p>
									</Show>
									<Show when={current().capture.render.profile === "seam_stable"}>
										<p {...stylex.props(styles.backendNote)}>
											Project lighting with fixed exposure, spatial AA, and
											view-independent Lumen fallbacks. Renders 2× then
											downsamples.
										</p>
									</Show>
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
									<div {...stylex.props(styles.backendField)}>
										<label for="map-capture-backend">CAPTURE ENGINE</label>
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
												TILED SCENE CAPTURE
											</option>
											<option value="viewport_high_resolution">
												VIEWPORT HIGH RES · EXPERIMENTAL
											</option>
										</select>
										<Show
											when={captureBackend() === "viewport_high_resolution"}
										>
											<p {...stylex.props(styles.backendNote)}>
												Renders one complete zoom through Unreal&apos;s
												active Level Editor viewport, then cuts that image
												into tiles. Unreal forces LOD0. Test limit: 8 × 8
												tiles per zoom.
											</p>
										</Show>
									</div>
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
													decodeLodPolicy(event.currentTarget.value)
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
								>
									<div
										style={requestedPreviewBoundary()}
										{...stylex.props(styles.requestedBoundary)}
									>
										<span {...stylex.props(styles.requestedBoundaryLabel)}>
											REQUESTED AREA
										</span>
									</div>
								</div>
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
												<small>LIVE FRAMING · NOT CAPTURE OUTPUT</small>
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
	page: {
		minHeight: "calc(100vh - 52px)",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText
	},
	hero: {
		display: "grid",
		gridTemplateColumns: "minmax(420px, 1fr) auto",
		alignItems: "end",
		gap: 36,
		padding: "34px 42px 28px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundImage:
			"linear-gradient(110deg, rgba(255, 255, 255, 0.03) 0%, transparent 55%, rgba(255, 255, 255, 0.02) 100%)"
	},
	eyebrow: { margin: 0, color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: 0 },
	title: {
		margin: "8px 0 0",
		fontFamily: tokens.fontDisplay,
		fontSize: 24,
		fontWeight: 590
	},
	heroActions: { display: "flex", gap: 8 },
	layout: { display: "grid", gridTemplateColumns: "430px minmax(0, 1fr)", minHeight: 720 },
	controls: {
		maxHeight: "calc(100vh - 170px)",
		overflowY: "auto",
		borderRight: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		padding: 22
	},
	panel: {
		marginBottom: 14,
		padding: 18,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	emptyPanel: {
		padding: 28,
		border: `1px dashed ${tokens.colorBorderStrong}`,
		color: tokens.colorTextSubtle
	},
	sectionLabel: { margin: 0, color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: 0 },
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 12
	},
	dirtyFlag: { color: tokens.colorTextFaint, fontSize: 11, letterSpacing: 0 },
	dirty: { color: tokens.colorWarning },
	fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, margin: "14px 0" },
	captureAreaGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 10,
		marginTop: 14
	},
	requestedExtent: {
		display: "grid",
		gap: 6,
		marginTop: 12,
		padding: "9px 10px",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		lineHeight: 1.5
	},
	outputExtent: {
		display: "grid",
		gap: 6,
		marginTop: 12,
		padding: "9px 10px",
		borderLeft: `2px solid ${tokens.colorWarning}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		lineHeight: 1.5
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: 0
	},
	input: {
		width: "100%",
		boxSizing: "border-box",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "7px 8px",
		fontSize: 13
	},
	metrics: {
		display: "grid",
		gridTemplateColumns: "repeat(2, 1fr)",
		gap: 1,
		marginTop: 16,
		backgroundColor: tokens.colorBorder
	},
	tileGeometryControl: { marginTop: 2 },
	resolutionReadout: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 14,
		marginTop: 8,
		padding: "11px 12px",
		borderLeft: `2px solid ${tokens.colorAccent}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	levelLadder: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 1,
		marginTop: 4,
		backgroundColor: tokens.colorBorder
	},
	levelStep: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		minWidth: 0,
		padding: "9px 8px",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	moreLevels: {
		gridColumn: "1 / -1",
		padding: "7px 8px",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: 10,
		backgroundColor: tokens.colorSurfaceInset
	},
	select: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "6px 8px",
		fontSize: 12
	},
	backendField: {
		display: "grid",
		gap: 7,
		marginTop: 15,
		paddingTop: 13,
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	},
	backendNote: {
		margin: 0,
		padding: "9px 10px",
		borderLeft: `2px solid ${tokens.colorWarning}`,
		backgroundColor: "rgba(242, 153, 74, 0.08)",
		color: tokens.colorWarning,
		fontSize: 12,
		letterSpacing: 0,
		lineHeight: 1.5
	},
	toggle: {
		position: "relative",
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: 14,
		borderRadius: tokens.radiusBadge,
		fontSize: 11
	},
	checkbox: { position: "absolute", width: 1, height: 1, opacity: 0 },
	switchTrack: {
		width: 31,
		height: 16,
		borderRadius: 12,
		backgroundColor: tokens.colorBorderStrong,
		boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.08)"
	},
	switchOn: {
		backgroundColor: tokens.colorAccent,
		boxShadow: "inset 0 0 0 1px rgba(228, 242, 34, 0.35), 0 0 12px rgba(228, 242, 34, 0.27)"
	},
	levels: {
		display: "grid",
		gap: 8,
		marginTop: 12,
		paddingTop: 12,
		borderTop: `1px solid ${tokens.colorBorder}`
	},
	validationPanel: {
		marginBottom: 14,
		padding: 14,
		border: "1px solid rgba(235, 87, 87, 0.45)",
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 12,
		lineHeight: 1.5
	},
	saveActions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 },
	actions: { display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 8 },
	primaryButton: {
		border: 0,
		backgroundColor: tokens.colorAccent,
		color: tokens.colorAccentText,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: 0
	},
	headerButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: 0
	},
	secondaryButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 12px",
		fontSize: 12,
		letterSpacing: 0,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	captureButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "rgba(228, 242, 34, 0.08)",
			":hover": "rgba(228, 242, 34, 0.12)"
		},
		color: tokens.colorTextStrong,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: 0,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	stage: {
		position: "relative",
		minWidth: 0,
		padding: 24,
		backgroundImage:
			"radial-gradient(circle at 50% 45%, rgba(255, 255, 255, 0.03), transparent 42%)"
	},
	gridPreview: {
		position: "relative",
		minHeight: 360,
		aspectRatio: "16 / 9",
		overflow: "hidden",
		border: `1px solid ${tokens.colorBorder}`,
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
		padding: "3px 5px",
		backgroundColor: "rgba(8, 9, 10, 0.73)",
		color: tokens.colorWarning,
		fontSize: 11,
		letterSpacing: 0,
		whiteSpace: "nowrap"
	},
	north: {
		position: "absolute",
		zIndex: 2,
		top: 18,
		left: 18,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
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
		border: "1px solid rgba(56, 59, 63, 0.67)",
		backgroundColor: "rgba(12, 13, 14, 0.87)",
		color: tokens.colorText,
		fontSize: 11,
		letterSpacing: 0
	},
	previewPulse: {
		width: 6,
		height: 6,
		borderRadius: 99,
		backgroundColor: tokens.colorWarning,
		boxShadow: "0 0 10px rgba(242, 153, 74, 0.35)"
	},
	previewLive: {
		width: 6,
		height: 6,
		borderRadius: 99,
		backgroundColor: tokens.colorAccent,
		boxShadow: "0 0 11px rgba(228, 242, 34, 0.35)"
	},
	previewFailure: {
		position: "absolute",
		zIndex: 2,
		left: "50%",
		top: "50%",
		width: "min(340px, calc(100% - 64px))",
		transform: "translate(-50%, -50%)",
		padding: 18,
		border: "1px solid rgba(235, 87, 87, 0.45)",
		backgroundColor: "rgba(22, 23, 24, 0.9)",
		color: tokens.colorDanger,
		fontSize: 12,
		lineHeight: 1.5,
		textAlign: "center"
	},
	previewRetry: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 12px",
		fontSize: 11,
		letterSpacing: 0
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
		borderLeft: `2px solid ${tokens.colorAccent}`,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	captureProgress: {
		position: "absolute",
		zIndex: 2,
		left: 48,
		right: 48,
		bottom: 82,
		padding: "15px 17px 13px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: "rgba(15, 16, 17, 0.95)",
		boxShadow: "0 16px 48px rgba(8, 9, 10, 0.6), inset 0 0 28px rgba(228, 242, 34, 0.03)",
		backdropFilter: "blur(7px)"
	},
	progressHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 10,
		color: tokens.colorText,
		fontSize: 11,
		letterSpacing: 0
	},
	progressPhase: { display: "flex", alignItems: "center", gap: 9 },
	progressPulse: {
		width: 7,
		height: 7,
		borderRadius: 999,
		backgroundColor: tokens.colorAccent,
		boxShadow: "0 0 13px rgba(228, 242, 34, 0.35)"
	},
	progressTrack: {
		height: 8,
		overflow: "hidden",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	progressFill: {
		height: "100%",
		backgroundImage: `linear-gradient(90deg, rgba(228, 242, 34, 0.5), ${tokens.colorAccent})`,
		boxShadow: "0 0 16px rgba(228, 242, 34, 0.35)",
		transitionProperty: "width",
		transitionDuration: tokens.motionStandard,
		transitionTimingFunction: "ease-out"
	},
	progressMeta: {
		display: "flex",
		gap: 18,
		marginTop: 9,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	},
	progressFailures: { color: tokens.colorDanger },
	status: {
		display: "grid",
		gridTemplateColumns: "80px 1fr minmax(180px, auto)",
		alignItems: "center",
		gap: 18,
		marginTop: 12,
		padding: "11px 14px",
		border: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	info: { borderLeftColor: tokens.colorBorderStrong },
	success: { borderLeftColor: tokens.colorSuccess, color: tokens.colorSuccess },
	error: { borderLeftColor: tokens.colorDanger, color: tokens.colorDanger }
});
