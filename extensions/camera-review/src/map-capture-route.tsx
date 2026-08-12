import * as stylex from "@stylexjs/stylex";
import {
	MapCapturePlan,
	type MapCapturePlan as MapCapturePlanValue
} from "@ue-shed/cameras/map-tiles";
import { SavedMapPicker, createEffectAction, type SavedMapPickerOption } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { For, Show, createMemo, createSignal } from "solid-js";
import type {
	MapCaptureClientShape,
	MapCaptureExecuteResult,
	MapCaptureSelectionResult
} from "./map-capture-client.js";
import { MapTilePyramidViewer } from "./map-tile-viewer.js";

type ReadySelection = Extract<MapCaptureSelectionResult, { readonly status: "ready" }>;
type CompletedCapture = Extract<MapCaptureExecuteResult, { readonly status: "completed" }>;

function causeMessage(cause: Cause.Cause<unknown>): string {
	return Cause.pretty(cause);
}

function editorMapPath(savedMapPath: string): string | undefined {
	const normalized = savedMapPath.replaceAll("\\", "/");
	const lower = normalized.toLocaleLowerCase();
	const contentMarker = lower.lastIndexOf("/content/");
	const contentStart = lower.startsWith("content/")
		? "content/".length
		: contentMarker < 0
			? undefined
			: contentMarker + "/content/".length;
	if (contentStart === undefined || !lower.endsWith(".umap")) return undefined;
	const relativePackage = normalized.slice(contentStart, -".umap".length);
	const packagePath = `/Game/${relativePackage}`;
	return /^\/Game\/[A-Za-z0-9_./-]+$/.test(packagePath) ? packagePath : undefined;
}

export function MapCaptureRoute(props: { readonly client: MapCaptureClientShape }) {
	const chooseAction = createEffectAction();
	const openAction = createEffectAction();
	const captureAction = createEffectAction();
	const [selection, setSelection] = createSignal<ReadySelection>();
	const [plan, setPlan] = createSignal<MapCapturePlanValue>();
	const [capture, setCapture] = createSignal<CompletedCapture>();
	const [notice, setNotice] = createSignal<{
		readonly tone: "error" | "info" | "success";
		readonly text: string;
	}>({ tone: "info", text: "Choose a versioned plan to begin." });
	const previewUrls = createMemo(
		() =>
			new Map(capture()?.previewTiles.map((tile) => [tile.relativePath, tile.dataUrl]) ?? [])
	);
	const mapOptions = createMemo<ReadonlyArray<SavedMapPickerOption>>(() =>
		(selection()?.maps ?? []).flatMap((map) => {
			const mapPath = editorMapPath(map.mapPath);
			return mapPath === undefined ? [] : [{ label: map.label, mapPath }];
		})
	);
	const validTargetMap = createMemo(() =>
		/^\/Game\/[A-Za-z0-9_./-]+$/.test(plan()?.project.mapPath ?? "")
	);

	function choosePlan() {
		setNotice({ tone: "info", text: "Reading plan and completed run evidence…" });
		chooseAction.run(props.client.choosePlan(), {
			onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
			onSuccess: (result) => {
				if (result.status === "ready") {
					setSelection(result);
					setPlan(result.plan);
					setCapture(undefined);
					setNotice({
						tone: "success",
						text: `${result.tileCount.toLocaleString()} deterministic tiles ready to capture.`
					});
				} else if (result.status === "failed") {
					setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
				}
			}
		});
	}

	function updateRender(
		change: (
			render: MapCapturePlanValue["capture"]["render"]
		) => MapCapturePlanValue["capture"]["render"]
	) {
		setPlan((current) =>
			current === undefined
				? current
				: MapCapturePlan.make({
						...current,
						capture: { ...current.capture, render: change(current.capture.render) }
					})
		);
	}

	function updateMapPath(mapPath: string) {
		setPlan((current) =>
			current === undefined
				? current
				: MapCapturePlan.make({
						...current,
						project: { ...current.project, mapPath }
					})
		);
		setCapture(undefined);
		setNotice(
			/^\/Game\/[A-Za-z0-9_./-]+$/.test(mapPath)
				? {
						tone: "info",
						text: "Target map changed for this capture. The source plan file remains unchanged."
					}
				: {
						tone: "error",
						text: "Enter an Unreal map package path beginning with /Game/."
					}
		);
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
					Array.from({ length: plan()?.levels.count ?? 1 }, () => 1),
				lodPolicy: "per_level_distance_scale"
			};
		});
	}

	function setLodScale(zoom: number, value: number) {
		if (!Number.isFinite(value) || value < 0.1 || value > 100) return;
		updateRender((render) => {
			const scales = [...(render.lodDistanceScaleByZoom ?? [])];
			scales[zoom] = value;
			return { ...render, lodDistanceScaleByZoom: scales };
		});
	}

	function openMap() {
		const current = plan();
		if (current === undefined || !validTargetMap()) return;
		setNotice({ tone: "info", text: `Asking Unreal to open ${current.project.mapPath}…` });
		openAction.run(props.client.openMap(current), {
			onFailure: (cause) => setNotice({ tone: "error", text: causeMessage(cause) }),
			onSuccess: (result) => {
				if (result.status === "failed") {
					setNotice({ tone: "error", text: `${result.message} ${result.recovery}` });
					return;
				}
				const response = result.response;
				setNotice(
					response.outcome === "rejected"
						? { tone: "error", text: `${response.message} ${response.recovery}` }
						: {
								tone: "success",
								text:
									response.outcome === "opened"
										? "Target map opened without player input."
										: "The target map was already open."
							}
				);
			}
		});
	}

	function runCapture(openMapFirst: boolean) {
		const current = plan();
		if (current === undefined || !validTargetMap()) return;
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
					<p {...stylex.props(styles.eyebrow)}>MAP CAPTURE / ORTHOGRAPHIC PYRAMID</p>
					<h1 {...stylex.props(styles.title)}>Build the world from above.</h1>
				</div>
				<p {...stylex.props(styles.intro)}>
					Transient editor capture. Stable tile geometry. No actors saved into the map.
				</p>
				<button type="button" onClick={choosePlan} {...stylex.props(styles.primaryButton)}>
					CHOOSE PLAN
				</button>
			</header>

			<div {...stylex.props(styles.layout)}>
				<aside {...stylex.props(styles.controls)}>
					<Show
						when={plan()}
						fallback={
							<div {...stylex.props(styles.emptyPanel)}>
								<span>01</span>
								<strong>SELECT A PLAN</strong>
								<p>The plan stays portable and remains the capture authority.</p>
							</div>
						}
					>
						{(current) => (
							<>
								<section {...stylex.props(styles.panel)}>
									<p {...stylex.props(styles.sectionLabel)}>TARGET</p>
									<h2 {...stylex.props(styles.planName)}>{current().id}</h2>
									<SavedMapPicker
										allowCustomPath
										ariaLabel="Map capture target map"
										customPathPlaceholder="/Game/Maps/L_MyMap"
										label="TARGET MAP"
										maps={mapOptions()}
										mapPath={current().project.mapPath}
										onMapPathChange={updateMapPath}
									/>
									<code {...stylex.props(styles.mapPath)}>
										{current().project.mapPath}
									</code>
									<div {...stylex.props(styles.metrics)}>
										<Metric
											label="TILES"
											value={selection()?.tileCount ?? "—"}
										/>
										<Metric label="LEVELS" value={current().levels.count} />
										<Metric label="PIXELS" value={current().tilePixelSize} />
									</div>
								</section>

								<section {...stylex.props(styles.panel)}>
									<p {...stylex.props(styles.sectionLabel)}>ATMOSPHERE</p>
									<Toggle
										checked={current().capture.render.effects.fog}
										label="Fog"
										onChange={(checked) =>
											updateRender((render) => ({
												...render,
												effects: { ...render.effects, fog: checked }
											}))
										}
									/>
									<Toggle
										checked={current().capture.render.effects.volumetricFog}
										label="Volumetric fog"
										onChange={(checked) =>
											updateRender((render) => ({
												...render,
												effects: {
													...render.effects,
													volumetricFog: checked
												}
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
											<For each={selection()?.grid.levels ?? []}>
												{(level) => (
													<label {...stylex.props(styles.levelRow)}>
														<span>Z{level.zoom}</span>
														<small>{level.unitsPerPixel} uu/px</small>
														<input
															type="number"
															min="0.1"
															max="100"
															step="0.1"
															value={
																current().capture.render
																	.lodDistanceScaleByZoom?.[
																	level.zoom
																] ?? 1
															}
															onInput={(event) =>
																setLodScale(
																	level.zoom,
																	event.currentTarget
																		.valueAsNumber
																)
															}
															{...stylex.props(styles.numberInput)}
														/>
													</label>
												)}
											</For>
										</div>
									</Show>
									<p {...stylex.props(styles.hint)}>
										1 = natural distance · larger values choose coarser LODs.
									</p>
								</section>

								<div {...stylex.props(styles.actions)}>
									<button
										type="button"
										onClick={openMap}
										disabled={!validTargetMap()}
										{...stylex.props(styles.secondaryButton)}
									>
										OPEN TARGET MAP
									</button>
									<button
										type="button"
										onClick={() => runCapture(true)}
										disabled={!validTargetMap()}
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
									<span>SNAPPED GRID</span>
									<strong>
										{selection()?.tileCount.toLocaleString() ?? "—"} TILES
									</strong>
									<small>
										Z0 → Z{Math.max(0, (plan()?.levels.count ?? 1) - 1)}
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
						<code>{selection()?.planPath ?? "ue-shed-map-capture-plan 1.0"}</code>
					</footer>
				</section>
			</div>
		</main>
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
	layout: {
		display: "grid",
		gridTemplateColumns: "390px minmax(0, 1fr)",
		minHeight: "calc(100vh - 183px)"
	},
	controls: { borderRight: "1px solid #303831", backgroundColor: "#111613", padding: 22 },
	panel: {
		marginBottom: 14,
		padding: 18,
		border: "1px solid #303831",
		backgroundColor: "#151b17"
	},
	emptyPanel: { padding: 28, border: "1px dashed #3d493f", color: "#7e897f" },
	sectionLabel: { margin: 0, color: "#79867a", fontSize: 8, letterSpacing: ".18em" },
	planName: { margin: "8px 0", fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 400 },
	mapPath: {
		display: "block",
		overflow: "hidden",
		marginTop: 8,
		color: "#9cb893",
		fontSize: 9,
		textOverflow: "ellipsis"
	},
	metrics: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		gap: 1,
		marginTop: 18,
		backgroundColor: "#303831"
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: 10,
		backgroundColor: "#101512"
	},
	sectionHeading: { display: "flex", justifyContent: "space-between", alignItems: "center" },
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
		display: "flex",
		flexDirection: "column",
		marginTop: 12,
		borderTop: "1px solid #303831"
	},
	levelRow: {
		display: "grid",
		gridTemplateColumns: "38px 1fr 72px",
		alignItems: "center",
		gap: 8,
		padding: "8px 0",
		borderBottom: "1px solid #252d27",
		fontSize: 10
	},
	numberInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #3b473d",
		backgroundColor: "#0c100e",
		color: "#c7d0c8",
		padding: "5px 7px"
	},
	hint: { margin: "12px 0 0", color: "#68726a", fontSize: 9, lineHeight: 1.5 },
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
