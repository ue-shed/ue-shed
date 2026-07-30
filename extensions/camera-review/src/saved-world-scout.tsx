import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import {
	PointMapCanvas,
	type PointMapController,
	type PointMapPoint,
	type PointMapViewState
} from "@ue-shed/ui/point-map";
import type { SavedWorld, SavedWorldMap } from "@ue-shed/protocol";
import { Cause } from "effect";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { MapReviewClientShape } from "./map-review-client.js";
import {
	colorForClass,
	formatCoordinate,
	actorMatchesFilter,
	WorldScoutRetainedStore
} from "./world-scout-canvas.js";

/**
 * Saved-package Map Review surface. It intentionally shares the retained rendering mechanics
 * with World Scout, but never materializes an actor as a live identity or offers editor actions.
 */
export function SavedWorldScout(props: {
	readonly client: Pick<
		MapReviewClientShape,
		"readSavedWorld" | "savedWorldMaps" | "chooseProjectAndMaps"
	>;
}) {
	const mapsAction = createEffectAction();
	const worldAction = createEffectAction();
	const chooseAction = createEffectAction();
	const store = new WorldScoutRetainedStore();
	let pointMap: PointMapController | undefined;

	const [world, setWorld] = createSignal<SavedWorld>();
	const [maps, setMaps] = createSignal<readonly SavedWorldMap[]>([]);
	const [projectLabel, setProjectLabel] = createSignal<string>();
	const [selectedMapPath, setSelectedMapPath] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [query, setQuery] = createSignal("");
	const [classQuery, setClassQuery] = createSignal("");
	const [hiddenClasses, setHiddenClasses] = createSignal<ReadonlySet<string>>(new Set());
	const [selectedStreamIndex, setSelectedStreamIndex] = createSignal<number>();
	const [catalogRevision, setCatalogRevision] = createSignal(0);
	const [selectionRevision, setSelectionRevision] = createSignal(0);
	const [liveRegion, setLiveRegion] = createSignal("");
	const [mapView, setMapView] = createSignal<PointMapViewState>();

	const classes = createMemo(() => {
		catalogRevision();
		return store.classCounts();
	});
	const filteredClasses = createMemo(() => {
		const needle = classQuery().trim().toLocaleLowerCase();
		return needle.length === 0
			? classes()
			: classes().filter(([className]) => className.toLocaleLowerCase().includes(needle));
	});
	const visiblePoints = createMemo<readonly PointMapPoint[]>(() => {
		catalogRevision();
		const points: PointMapPoint[] = [];
		for (let index = 0; index < store.count; index += 1) {
			if (!actorMatchesFilter(store, index, query(), hiddenClasses())) continue;
			const actor = store.actorAt(index);
			if (actor === undefined) continue;
			points.push({
				className: actor.className,
				key: actor.instanceKey,
				x: store.locationX[index] ?? 0,
				y: store.locationY[index] ?? 0,
				extentX: actor.bounds.extent.x,
				extentY: actor.bounds.extent.y
			});
		}
		return points;
	});
	const visibleCount = createMemo(() => visiblePoints().length);
	const extentLabel = createMemo(() => {
		const current = mapView();
		if (current === undefined) return "—";
		return `${Math.round(current.viewport.size).toLocaleString()} × ${Math.round(current.worldHeight).toLocaleString()} UU`;
	});
	const zoomFactor = createMemo(() => mapView()?.zoomFactor ?? 1);
	const maxZoomFactor = createMemo(() => {
		const fit = mapView()?.fitSize ?? 1;
		return fit / Math.min(50, fit);
	});
	const selected = createMemo(() => {
		selectionRevision();
		const streamIndex = selectedStreamIndex();
		const actor = streamIndex === undefined ? undefined : store.actorAt(streamIndex);
		if (actor === undefined || streamIndex === undefined) return undefined;
		return {
			...actor,
			location: {
				x: store.locationX[streamIndex] ?? 0,
				y: store.locationY[streamIndex] ?? 0,
				z: store.locationZ[streamIndex] ?? 0
			}
		};
	});

	const load = (mapPath: string) => {
		const readSavedWorld = props.client.readSavedWorld;
		if (readSavedWorld === undefined) {
			setError("This Workbench host does not expose saved-map review yet.");
			return;
		}
		setError(undefined);
		setWorld(undefined);
		worldAction.run(readSavedWorld(mapPath), {
			onFailure: (cause) => setError(Cause.pretty(cause)),
			onSuccess: (nextWorld) => {
				store.installSavedWorld(nextWorld);
				setWorld(nextWorld);
				setSelectedStreamIndex(undefined);
				setLiveRegion("");
				setCatalogRevision((value) => value + 1);
				setSelectionRevision((value) => value + 1);
			}
		});
	};
	const loadMaps = () => {
		const readSavedWorldMaps = props.client.savedWorldMaps;
		if (readSavedWorldMaps === undefined) {
			setError("This Workbench host does not expose saved-map choices yet.");
			return;
		}
		setError(undefined);
		mapsAction.run(readSavedWorldMaps(), {
			onFailure: (cause) => setError(Cause.pretty(cause)),
			onSuccess: (nextMaps) => {
				setMaps(nextMaps);
				const initialMap = nextMaps[0];
				if (initialMap === undefined) {
					setError("No saved maps are configured for offline review.");
					return;
				}
				setSelectedMapPath(initialMap.mapPath);
				load(initialMap.mapPath);
			}
		});
	};
	const selectMap = (mapPath: string) => {
		setSelectedMapPath(mapPath);
		load(mapPath);
	};
	const chooseProject = () => {
		const choose = props.client.chooseProjectAndMaps;
		if (choose === undefined) {
			setError("This Workbench host cannot choose a project from the UI yet.");
			return;
		}
		setError(undefined);
		chooseAction.run(choose(), {
			onFailure: (cause) => setError(Cause.pretty(cause)),
			onSuccess: (choice) => {
				if (choice.status === "cancelled") return;
				if (choice.status === "failed") {
					setError(`${choice.message} ${choice.recovery}`);
					return;
				}
				const initialMap = choice.maps[0];
				if (initialMap === undefined) {
					setError("No maps were chosen for offline review.");
					return;
				}
				setProjectLabel(choice.projectName);
				setMaps(choice.maps);
				setSelectedMapPath(initialMap.mapPath);
				load(initialMap.mapPath);
			}
		});
	};

	const toggleClass = (className: string) =>
		setHiddenClasses((current) => {
			const next = new Set(current);
			if (next.has(className)) next.delete(className);
			else next.add(className);
			return next;
		});
	const invertClasses = () => {
		setHiddenClasses((current) => {
			const next = new Set<string>();
			for (const [className] of classes()) {
				if (!current.has(className)) next.add(className);
			}
			return next;
		});
	};
	const selectStreamIndex = (streamIndex: number) => {
		const actor = store.actorAt(streamIndex);
		if (actor === undefined) return;
		setSelectedStreamIndex(streamIndex);
		setSelectionRevision((value) => value + 1);
		setLiveRegion(
			`${actor.displayName}, ${actor.className}, X ${formatCoordinate(store.locationX[streamIndex] ?? 0)}, Y ${formatCoordinate(store.locationY[streamIndex] ?? 0)}, Z ${formatCoordinate(store.locationZ[streamIndex] ?? 0)}`
		);
	};
	const clearSelection = () => {
		setSelectedStreamIndex(undefined);
		setSelectionRevision((value) => value + 1);
		setLiveRegion("Selection cleared");
	};
	const setZoomFactor = (value: string) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || parsed <= 0) return;
		pointMap?.setZoomFactor(parsed);
	};
	const selectPoint = (key: string | undefined) => {
		if (key === undefined) {
			clearSelection();
			return;
		}
		const index = store.findByInstanceKey(key);
		if (index !== undefined) selectStreamIndex(index);
	};

	onMount(() => {
		loadMaps();
	});

	return (
		<section aria-label="Saved top-down actor map" {...stylex.props(styles.scout)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>SAVED MAP</p>
					<h2 {...stylex.props(styles.title)}>Actors from project files</h2>
					<Show when={projectLabel()}>
						{(label) => (
							<p {...stylex.props(styles.projectLabel)}>PROJECT · {label()}</p>
						)}
					</Show>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<button
						type="button"
						onClick={chooseProject}
						disabled={props.client.chooseProjectAndMaps === undefined}
						{...stylex.props(styles.chooseButton)}
					>
						CHOOSE PROJECT…
					</button>
					<div {...stylex.props(styles.source)}>
						<span {...stylex.props(styles.sourceDot)} />
						<strong>PROJECT FILES</strong>
						<code>{world()?.authority.mapPackage ?? "NOT LOADED"}</code>
					</div>
				</div>
			</header>

			<Show
				when={world()}
				fallback={
					<div {...stylex.props(styles.message)}>
						<div {...stylex.props(styles.reticle)}>◇</div>
						<h3>
							{error() === undefined ? "Reading saved map…" : "Saved map unavailable"}
						</h3>
						<p>
							{error() ??
								"The selected level or its World Partition external-actor packages are being read from disk."}
						</p>
						<div {...stylex.props(styles.fallbackActions)}>
							<Show when={error()}>
								<button
									type="button"
									onClick={loadMaps}
									{...stylex.props(styles.retry)}
								>
									RETRY SAVED MAP
								</button>
							</Show>
							<Show when={props.client.chooseProjectAndMaps !== undefined}>
								<button
									type="button"
									onClick={chooseProject}
									{...stylex.props(styles.retry)}
								>
									CHOOSE PROJECT…
								</button>
							</Show>
						</div>
					</div>
				}
			>
				{(current) => (
					<>
						<div {...stylex.props(styles.tools)}>
							<Show when={maps().length > 1}>
								<label {...stylex.props(styles.mapPicker)}>
									<span>SAVED MAP</span>
									<select
										value={selectedMapPath()}
										onChange={(event) => selectMap(event.currentTarget.value)}
										aria-label="Saved map"
										{...stylex.props(styles.mapSelect)}
									>
										<For each={maps()}>
											{(map) => (
												<option
													value={map.mapPath}
													selected={map.mapPath === selectedMapPath()}
												>
													{map.label}
												</option>
											)}
										</For>
									</select>
								</label>
							</Show>
							<label {...stylex.props(styles.search)}>
								<span>FIND SAVED ACTOR</span>
								<input
									value={query()}
									onInput={(event) => setQuery(event.currentTarget.value)}
									aria-label="Find saved actor"
									placeholder="label or class"
									{...stylex.props(styles.searchInput)}
								/>
							</label>
							<div
								aria-label="Saved actor class filters"
								{...stylex.props(styles.classFilters)}
							>
								<div {...stylex.props(styles.classFilterSearch)}>
									<label {...stylex.props(styles.classFilterSearchLabel)}>
										<span>ACTOR CLASSES · {classes().length}</span>
										<input
											value={classQuery()}
											onInput={(event) =>
												setClassQuery(event.currentTarget.value)
											}
											aria-label="Filter saved actor classes"
											placeholder="filter class name"
											{...stylex.props(styles.classFilterInput)}
										/>
									</label>
									<button
										type="button"
										title="Invert which actor classes are selected"
										onClick={invertClasses}
										{...stylex.props(styles.classFilterAction)}
									>
										INVERT
									</button>
								</div>
								<div role="list" {...stylex.props(styles.classList)}>
									<For each={filteredClasses()}>
										{([className, count]) => (
											<button
												type="button"
												role="listitem"
												aria-pressed={!hiddenClasses().has(className)}
												onClick={() => toggleClass(className)}
												{...stylex.props(
													styles.classFilter,
													hiddenClasses().has(className) &&
														styles.classHidden
												)}
											>
												<i
													{...stylex.props(styles.classSwatch)}
													style={{
														"background-color": colorForClass(className)
													}}
												/>
												{className.replace(/^(BP_|A)/, "")} <b>{count}</b>
											</button>
										)}
									</For>
								</div>
							</div>
							<div {...stylex.props(styles.summary)}>
								<strong>{visibleCount()}</strong>
								<span>VISIBLE / {store.count} RESOLVED</span>
								<small>
									{current().summary.scannedPackages} PACKAGES ·{" "}
									{current().actors.length - store.count} UNRESOLVED
								</small>
							</div>
							<div
								{...stylex.props(
									styles.completeness,
									current().completeness === "partial" && styles.partial
								)}
							>
								{current().completeness === "complete" ? "COMPLETE" : "PARTIAL"}
							</div>
						</div>

						<div {...stylex.props(styles.workspace)}>
							<div {...stylex.props(styles.mapFrame)}>
								<div {...stylex.props(styles.north)}>N ↑</div>
								<label {...stylex.props(styles.zoomControl)}>
									<span>ZOOM</span>
									<input
										type="range"
										aria-label="Map zoom"
										min="1"
										max={maxZoomFactor()}
										step="0.01"
										value={Math.min(zoomFactor(), maxZoomFactor())}
										onInput={(event) =>
											setZoomFactor(event.currentTarget.value)
										}
										{...stylex.props(styles.zoomSlider)}
									/>
									<strong>{zoomFactor().toFixed(1)}×</strong>
								</label>
								<div {...stylex.props(styles.extentLabel)}>{extentLabel()}</div>
								<button
									type="button"
									onClick={() => pointMap?.resetView()}
									{...stylex.props(styles.reset)}
								>
									RESET VIEW
								</button>
								<PointMapCanvas
									ariaDescribedBy="saved-world-scout-live"
									ariaLabel="Top-down saved actor map"
									class={stylex.props(styles.map).className}
									onController={(controller) => {
										pointMap = controller;
									}}
									onSelect={selectPoint}
									onViewChange={setMapView}
									points={visiblePoints()}
									resetKey={current().mapPath}
									selectedKey={selected()?.instanceKey}
									title="Scroll to zoom, drag to pan, click to inspect a saved actor"
								/>
								<div
									id="saved-world-scout-live"
									aria-live="polite"
									{...stylex.props(styles.liveRegion)}
								>
									{liveRegion()}
								</div>
								<div {...stylex.props(styles.axisX)}>WORLD X →</div>
								<div {...stylex.props(styles.axisY)}>WORLD Y →</div>
							</div>

							<aside {...stylex.props(styles.inspector)}>
								<Show
									when={selected()}
									fallback={
										<div {...stylex.props(styles.noSelection)}>
											<span>SELECT A SAVED POINT</span>
											<p>
												Saved packages provide position and identity, not a
												live editor handle.
											</p>
										</div>
									}
								>
									{(actor) => (
										<div {...stylex.props(styles.actorDetails)}>
											<p>SAVED ACTOR</p>
											<h3 {...stylex.props(styles.actorName)}>
												{actor().displayName}
											</h3>
											<code>{actor().className}</code>
											<dl {...stylex.props(styles.coordinates)}>
												<div>
													<dt>X</dt>
													<dd>{formatCoordinate(actor().location.x)}</dd>
												</div>
												<div>
													<dt>Y</dt>
													<dd>{formatCoordinate(actor().location.y)}</dd>
												</div>
												<div>
													<dt>Z</dt>
													<dd>{formatCoordinate(actor().location.z)}</dd>
												</div>
											</dl>
											<dl {...stylex.props(styles.identity)}>
												<div>
													<dt>PACKAGE</dt>
													<dd>
														<code>{actor().packageName ?? "—"}</code>
													</dd>
												</div>
												<div>
													<dt>ACTOR PATH</dt>
													<dd>
														<code>{actor().path}</code>
													</dd>
												</div>
											</dl>
											<button
												type="button"
												onClick={clearSelection}
												{...stylex.props(styles.clearSelection)}
											>
												CLEAR SELECTION
											</button>
											<p {...stylex.props(styles.offlineCopy)}>
												Read from saved project files. Open Unreal and
												switch to Live World to focus or author review
												views.
											</p>
										</div>
									)}
								</Show>
							</aside>
						</div>
					</>
				)}
			</Show>
		</section>
	);
}

const styles = stylex.create({
	scout: { minWidth: 0, border: "1px solid #303a3b", backgroundColor: "#101516", marginTop: 14 },
	header: {
		display: "flex",
		justifyContent: "space-between",
		gap: 18,
		alignItems: "flex-start",
		padding: "18px 20px",
		borderBottom: "1px solid #2c3637"
	},
	eyebrow: { margin: 0, color: "#61d5df", fontSize: 8, fontWeight: 800, letterSpacing: ".16em" },
	projectLabel: {
		margin: "6px 0 0",
		color: "#75e0e8",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".12em"
	},
	headerActions: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-end",
		gap: 8
	},
	chooseButton: {
		border: "1px solid #61d5df",
		backgroundColor: { default: "transparent", ":hover": "#1b3032" },
		color: { default: "#b9eef2", ":disabled": "#4a5658" },
		borderColor: { default: "#61d5df", ":disabled": "#33403f" },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		padding: "7px 10px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	fallbackActions: { display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" },
	title: {
		margin: "5px 0 0",
		color: "#eef7f8",
		fontFamily: "Georgia, serif",
		fontSize: 23,
		fontWeight: 400
	},
	source: {
		display: "grid",
		gridTemplateColumns: "auto auto",
		alignItems: "center",
		columnGap: 7,
		color: "#8d9a9c",
		fontSize: 8,
		letterSpacing: ".11em",
		textAlign: "right"
	},
	sourceDot: {
		width: 7,
		height: 7,
		borderRadius: "50%",
		backgroundColor: "#61d5df",
		boxShadow: "0 0 12px #61d5df"
	},
	message: {
		minHeight: 300,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		padding: 24,
		color: "#91a0a2",
		textAlign: "center"
	},
	reticle: { color: "#61d5df", fontSize: 36 },
	retry: {
		border: "1px solid #61d5df",
		backgroundColor: { default: "transparent", ":hover": "#1b3032" },
		color: "#b9eef2",
		padding: "10px 12px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	tools: {
		display: "flex",
		flexWrap: "wrap",
		gap: 10,
		alignItems: "center",
		padding: "12px 14px",
		borderBottom: "1px solid #293233"
	},
	mapPicker: { display: "grid", gap: 4, color: "#879294", fontSize: 7, letterSpacing: ".12em" },
	mapSelect: {
		minWidth: 160,
		border: "1px solid #3b484a",
		backgroundColor: "#0c1011",
		color: "#e7eeee",
		padding: "7px 8px",
		fontSize: 11,
		outline: { ":focus": "1px solid #61d5df" }
	},
	search: { display: "grid", gap: 4, color: "#879294", fontSize: 7, letterSpacing: ".12em" },
	searchInput: {
		width: 190,
		border: "1px solid #3b484a",
		backgroundColor: "#0c1011",
		color: "#e7eeee",
		padding: "8px 9px",
		fontSize: 12,
		outline: { ":focus": "1px solid #61d5df" }
	},
	classFilters: {
		display: "grid",
		gap: 7,
		flexBasis: "100%",
		minWidth: 0,
		paddingTop: 2
	},
	classFilterSearch: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		color: "#879294",
		fontSize: 7,
		letterSpacing: ".12em"
	},
	classFilterSearchLabel: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		minWidth: 0
	},
	classFilterInput: {
		minWidth: 220,
		border: "1px solid #3b484a",
		backgroundColor: "#0c1011",
		color: "#e7eeee",
		padding: "6px 8px",
		fontSize: 11,
		outline: { ":focus": "1px solid #61d5df" }
	},
	classFilterAction: {
		border: "1px solid #344042",
		backgroundColor: { default: "#151b1c", ":hover": "#20292a" },
		color: "#879294",
		padding: "6px 8px",
		fontSize: 8,
		letterSpacing: ".08em",
		cursor: "pointer",
		flexShrink: 0
	},
	classList: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(176px, 1fr))",
		gap: 4,
		maxHeight: 132,
		overflowY: "auto",
		paddingRight: 4
	},
	classFilter: {
		border: "1px solid #344042",
		backgroundColor: { default: "#151b1c", ":hover": "#20292a" },
		color: "#aab5b6",
		padding: "6px 7px",
		fontSize: 8,
		cursor: "pointer",
		minWidth: 0,
		overflow: "hidden",
		textAlign: "left",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	classHidden: { opacity: 0.42 },
	classSwatch: {
		display: "inline-block",
		width: 6,
		height: 6,
		marginRight: 5,
		borderRadius: "50%"
	},
	summary: {
		display: "grid",
		gap: 1,
		minWidth: 145,
		color: "#b8c5c6",
		fontSize: 7,
		letterSpacing: ".09em",
		textAlign: "right"
	},
	completeness: {
		border: "1px solid #3f6b70",
		color: "#75e0e8",
		padding: "6px 7px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	partial: { borderColor: "#e6a36e", color: "#f2bc8e" },
	workspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 270px",
			"@media (max-width: 900px)": "1fr"
		},
		alignItems: "start"
	},
	mapFrame: {
		position: "relative",
		aspectRatio: "2 / 1",
		width: "100%",
		overflow: "hidden",
		backgroundColor: "#0c1011",
		backgroundImage:
			"linear-gradient(#93a9aa10 1px,transparent 1px),linear-gradient(90deg,#93a9aa10 1px,transparent 1px),linear-gradient(#93a9aa07 1px,transparent 1px),linear-gradient(90deg,#93a9aa07 1px,transparent 1px)",
		backgroundSize: "80px 80px,80px 80px,16px 16px,16px 16px"
	},
	map: {
		position: "absolute",
		inset: 28,
		width: "calc(100% - 56px)",
		height: "calc(100% - 56px)",
		cursor: "crosshair",
		touchAction: "none",
		outline: { ":focus": "1px solid #61d5df" }
	},
	reset: {
		position: "absolute",
		top: 10,
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 2,
		border: "1px solid #3b494a",
		backgroundColor: { default: "#101617d9", ":hover": "#1d2829" },
		color: "#a7b5b6",
		padding: "4px 8px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	liveRegion: {
		position: "absolute",
		width: 1,
		height: 1,
		overflow: "hidden",
		clip: "rect(0 0 0 0)",
		whiteSpace: "nowrap"
	},
	north: {
		position: "absolute",
		top: 12,
		left: 14,
		color: "#61d5df",
		fontSize: 9,
		letterSpacing: ".12em"
	},
	extentLabel: {
		position: "absolute",
		top: 34,
		right: 14,
		color: "#667476",
		fontSize: 8,
		zIndex: 2
	},
	zoomControl: {
		position: "absolute",
		top: 8,
		right: 14,
		zIndex: 2,
		display: "grid",
		gridTemplateColumns: "auto minmax(88px, 120px) auto",
		gap: "4px 8px",
		alignItems: "center",
		color: "#879294",
		fontSize: 7,
		letterSpacing: ".1em",
		backgroundColor: "#101617d9",
		border: "1px solid #3b494a",
		padding: "4px 8px"
	},
	zoomSlider: {
		width: "100%",
		accentColor: "#61d5df",
		cursor: "ew-resize"
	},
	clearSelection: {
		marginTop: 8,
		border: "1px solid #3b494a",
		backgroundColor: { default: "transparent", ":hover": "#1d2829" },
		color: "#a7b5b6",
		padding: "10px 12px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	axisX: { position: "absolute", right: 12, bottom: 10, color: "#59686a", fontSize: 7 },
	axisY: {
		position: "absolute",
		left: 8,
		bottom: 46,
		color: "#59686a",
		fontSize: 7,
		transform: "rotate(-90deg)",
		transformOrigin: "left bottom"
	},
	inspector: {
		borderLeft: { default: "1px solid #2d3738", "@media (max-width: 900px)": 0 },
		borderTop: { default: 0, "@media (max-width: 900px)": "1px solid #2d3738" },
		backgroundColor: "#111718",
		padding: 18,
		minWidth: 0
	},
	noSelection: { marginTop: 80, color: "#7f8c8d", textAlign: "center", fontSize: 9 },
	actorDetails: { display: "flex", flexDirection: "column", gap: 8 },
	actorName: {
		margin: 0,
		color: "#edf6f7",
		fontFamily: "Georgia, serif",
		fontSize: 24,
		fontWeight: 400
	},
	coordinates: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", marginTop: 10 },
	identity: {
		display: "grid",
		gap: 8,
		marginTop: 10,
		color: "#a2b0b1",
		fontSize: 8,
		overflowWrap: "anywhere"
	},
	offlineCopy: {
		marginTop: 12,
		borderTop: "1px solid #354143",
		paddingTop: 12,
		color: "#75e0e8",
		fontSize: 8,
		letterSpacing: ".05em",
		lineHeight: 1.5
	}
});
