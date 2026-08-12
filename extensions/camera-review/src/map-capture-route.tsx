import * as stylex from "@stylexjs/stylex";
import { savedMapPathToGameMapPath } from "@ue-shed/cameras/map-tiles";
import { SavedMapPicker, createEffectAction, type SavedMapPickerOption } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { For, Show, createMemo, createSignal } from "solid-js";
import type {
	MapCaptureClientShape,
	MapCaptureExecuteResult,
	MapCaptureSelectionResult
} from "./map-capture-client.js";
import {
	mapCaptureDraftGrid,
	mapCapturePlanDraft,
	validateMapCapturePlanDraft,
	type MapCapturePlanDraft
} from "./map-capture-plan-draft.js";
import { MapTilePyramidViewer } from "./map-tile-viewer.js";

type ReadySelection = Extract<MapCaptureSelectionResult, { readonly status: "ready" }>;
type CompletedCapture = Extract<MapCaptureExecuteResult, { readonly status: "completed" }>;

function causeMessage(cause: Cause.Cause<unknown>): string {
	return Cause.pretty(cause);
}

export function MapCaptureRoute(props: { readonly client: MapCaptureClientShape }) {
	const newAction = createEffectAction();
	const chooseAction = createEffectAction();
	const saveAction = createEffectAction();
	const openAction = createEffectAction();
	const captureAction = createEffectAction();
	const [selection, setSelection] = createSignal<ReadySelection>();
	const [draft, setDraft] = createSignal<MapCapturePlanDraft>();
	const [savedPlanJson, setSavedPlanJson] = createSignal<string>();
	const [capture, setCapture] = createSignal<CompletedCapture>();
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
	const isDirty = createMemo(() => {
		const current = draft();
		return current !== undefined && JSON.stringify(current) !== savedPlanJson();
	});
	const previewUrls = createMemo(
		() =>
			new Map(capture()?.previewTiles.map((tile) => [tile.relativePath, tile.dataUrl]) ?? [])
	);
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
			}
		});
	}

	function runCapture(openMapFirst: boolean) {
		const current = plan();
		if (current === undefined) return;
		setNotice({
			tone: "info",
			text: openMapFirst
				? "Safely opening the target map, then capturing bounded batches…"
				: "Capturing the currently open target map in bounded batches…"
		});
		captureAction.run(props.client.capture({ openMap: openMapFirst, plan: current }), {
			onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
			onSuccess: (result) => {
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
		});
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
										<Metric label="TILES" value={grid()?.tileCount ?? "—"} />
										<Metric label="LEVELS" value={current().levels.count} />
										<Metric label="PIXELS" value={current().tilePixelSize} />
									</div>
									<div {...stylex.props(styles.fieldGrid)}>
										<NumberField
											label="TILE PIXELS"
											min={64}
											max={4096}
											step={1}
											value={current().tilePixelSize}
											onInput={(tilePixelSize) =>
												updateDraft((value) => ({
													...value,
													tilePixelSize
												}))
											}
										/>
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
										<NumberField
											label="COARSEST UU/PX"
											min={0.01}
											step={0.1}
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
										disabled={plan() === undefined}
										{...stylex.props(styles.secondaryButton)}
									>
										OPEN TARGET MAP
									</button>
									<button
										type="button"
										onClick={() => runCapture(true)}
										disabled={plan() === undefined}
										{...stylex.props(styles.captureButton)}
									>
										OPEN + CAPTURE
									</button>
								</div>
							</>
						)}
					</Show>
				</aside>

				<section {...stylex.props(styles.stage)}>
					<Show
						when={capture()}
						fallback={
							<div {...stylex.props(styles.gridPreview)}>
								<div {...stylex.props(styles.north)}>+X / NORTH</div>
								<div {...stylex.props(styles.reticle)} />
								<div {...stylex.props(styles.gridReadout)}>
									<span>LIVE PLAN GEOMETRY</span>
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
							<MapTilePyramidViewer
								manifest={completed().manifest}
								tileUrl={(_key, relativePath) =>
									previewUrls().get(relativePath) ?? ""
								}
							/>
						)}
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
		minWidth: 0,
		padding: 24,
		backgroundImage: "radial-gradient(circle at 50% 45%, #26372755, transparent 42%)"
	},
	gridPreview: {
		position: "relative",
		minHeight: 610,
		overflow: "hidden",
		border: "1px solid #344037",
		backgroundColor: "#0e1510",
		backgroundImage:
			"linear-gradient(#6f89601b 1px, transparent 1px), linear-gradient(90deg, #6f89601b 1px, transparent 1px)",
		backgroundSize: "48px 48px"
	},
	reticle: {
		position: "absolute",
		left: "50%",
		top: "50%",
		width: 180,
		height: 180,
		transform: "translate(-50%, -50%) rotate(45deg)",
		border: "1px solid #b7e26d88",
		boxShadow: "0 0 80px #b7e26d1b"
	},
	north: {
		position: "absolute",
		top: 18,
		left: 18,
		color: "#708174",
		fontSize: 8,
		letterSpacing: ".14em"
	},
	gridReadout: {
		position: "absolute",
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
