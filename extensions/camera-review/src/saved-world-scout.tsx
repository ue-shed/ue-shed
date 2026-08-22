import * as stylex from "@stylexjs/stylex";
import {
	ActorExplorer,
	actorExplorerMatches,
	createEffectAction,
	SavedMapPicker,
	type ActorExplorerFilters
} from "@ue-shed/ui";
import {
	PointMapCanvas,
	type PointMapController,
	type PointMapPoint,
	type PointMapViewState
} from "@ue-shed/ui/point-map";
import type { SavedWorld, SavedWorldMap } from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { MapReviewClientApi } from "./map-review-client.js";
import { formatCoordinate, WorldScoutRetainedStore } from "./world-scout-canvas.js";

/**
 * Saved-package Map Review surface. It intentionally shares the retained rendering mechanics
 * with World Scout, but never materializes an actor as a live identity or offers editor actions.
 */
export function SavedWorldScout(props: {
	readonly client: Pick<
		MapReviewClientApi,
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
	const [actorFilters, setActorFilters] = createSignal<ActorExplorerFilters>({
		classPaths: undefined,
		query: ""
	});
	const [selectedStreamIndex, setSelectedStreamIndex] = createSignal<number>();
	const [catalogRevision, setCatalogRevision] = createSignal(0);
	const [selectionRevision, setSelectionRevision] = createSignal(0);
	const [liveRegion, setLiveRegion] = createSignal("");
	const [mapView, setMapView] = createSignal<PointMapViewState>();

	const classes = createMemo(() => {
		catalogRevision();
		return store.classCounts();
	});
	const actorItems = createMemo(() => {
		catalogRevision();
		const items = [];
		for (let index = 0; index < store.count; index += 1) {
			const actor = store.actorAt(index);
			if (actor === undefined) continue;
			items.push({
				classPath: actor.className,
				key: actor.instanceKey,
				label: actor.displayName,
				packageName: actor.packageName,
				path: actor.path,
				searchFields: {
					class: actor.className,
					label: actor.displayName,
					package: actor.packageName,
					path: actor.path
				}
			});
		}
		return items;
	});
	const classOptions = createMemo(() =>
		classes().map(([classPath, count]) => ({
			classPath,
			count,
			label: classPath.replace(/^(BP_|A)/, "")
		}))
	);
	const visiblePoints = createMemo<readonly PointMapPoint[]>(() => {
		catalogRevision();
		const visibleKeys = new Set(
			actorItems()
				.filter((item) => actorExplorerMatches(item, actorFilters()))
				.map((item) => item.key)
		);
		const points: PointMapPoint[] = [];
		for (let index = 0; index < store.count; index += 1) {
			const actor = store.actorAt(index);
			if (actor === undefined) continue;
			if (!visibleKeys.has(actor.instanceKey)) continue;
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
		setActorFilters({ classPaths: undefined, query: "" });
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
	const focusActor = (key: string) => pointMap?.focusKey(key);

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
							<SavedMapPicker
								maps={maps()}
								mapPath={selectedMapPath() ?? ""}
								onMapPathChange={selectMap}
							/>
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
							<ActorExplorer
								ariaLabel="Saved actor outliner"
								classOptions={classOptions()}
								filters={actorFilters()}
								itemListLabel="Saved actors"
								items={actorItems()}
								label="SAVED ACTORS"
								onClassPathsChange={(classPaths) =>
									setActorFilters((current) => ({ ...current, classPaths }))
								}
								onFiltersChange={setActorFilters}
								onFocus={focusActor}
								onSelect={(key) => {
									if (key === undefined) {
										clearSelection();
										return;
									}
									const index = store.findByInstanceKey(key);
									if (index !== undefined) selectStreamIndex(index);
								}}
								queryAriaLabel="Find saved actor"
								selectedClassPath={undefined}
								selectedKey={selected()?.instanceKey}
								title="Select an actor to inspect it on the map"
							/>
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
	scout: {
		minWidth: 0,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		marginTop: 14
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		gap: 18,
		alignItems: "flex-start",
		padding: "18px 20px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	eyebrow: { margin: 0, color: "#02b8cc", fontSize: 11, fontWeight: 500, letterSpacing: ".04em" },
	projectLabel: {
		margin: "6px 0 0",
		color: "#02b8cc",
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: ".04em"
	},
	headerActions: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-end",
		gap: 8
	},
	chooseButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: { default: tokens.colorText, ":disabled": tokens.colorTextFaint },
		borderColor: { default: tokens.colorBorderStrong, ":disabled": tokens.colorBorder },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: ".04em"
	},
	fallbackActions: { display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" },
	title: {
		margin: "5px 0 0",
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 23,
		fontWeight: 590
	},
	source: {
		display: "grid",
		gridTemplateColumns: "auto auto",
		alignItems: "center",
		columnGap: 7,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: ".04em",
		textAlign: "right"
	},
	sourceDot: {
		width: 7,
		height: 7,
		borderRadius: "50%",
		backgroundColor: "#02b8cc",
		boxShadow: "0 0 8px rgba(2, 184, 204, 0.35)"
	},
	message: {
		minHeight: 300,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		padding: 24,
		color: tokens.colorTextMuted,
		textAlign: "center"
	},
	reticle: { color: "#02b8cc", fontSize: 36 },
	retry: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: ".04em",
		cursor: "pointer"
	},
	tools: {
		display: "flex",
		flexWrap: "wrap",
		gap: 10,
		alignItems: "center",
		padding: "12px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	summary: {
		display: "grid",
		gap: 1,
		minWidth: 145,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: ".04em",
		textAlign: "right"
	},
	completeness: {
		border: `1px solid #02b8cc`,
		color: "#02b8cc",
		padding: "6px 7px",
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: ".04em"
	},
	partial: { borderColor: tokens.colorWarning, color: tokens.colorWarning },
	workspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "280px minmax(0, 1fr) 270px",
			"@media (max-width: 900px)": "1fr"
		},
		alignItems: "stretch"
	},
	mapFrame: {
		position: "relative",
		aspectRatio: "2 / 1",
		width: "100%",
		overflow: "hidden",
		backgroundColor: tokens.colorSurfaceInset,
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
		outline: { ":focus": "1px solid #02b8cc" }
	},
	reset: {
		position: "absolute",
		top: 10,
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 2,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: {
			default: "rgba(15, 16, 17, 0.85)",
			":hover": "rgba(255, 255, 255, 0.06)"
		},
		color: tokens.colorTextMuted,
		padding: "4px 8px",
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: ".04em",
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
		color: "#02b8cc",
		fontSize: 11,
		letterSpacing: ".04em"
	},
	extentLabel: {
		position: "absolute",
		top: 34,
		right: 14,
		color: tokens.colorTextSubtle,
		fontSize: 11,
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
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: ".04em",
		backgroundColor: "rgba(15, 16, 17, 0.85)",
		border: `1px solid ${tokens.colorBorderStrong}`,
		padding: "4px 8px"
	},
	zoomSlider: {
		width: "100%",
		accentColor: "#02b8cc",
		cursor: "ew-resize"
	},
	clearSelection: {
		marginTop: 8,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: ".04em",
		cursor: "pointer"
	},
	axisX: {
		position: "absolute",
		right: 12,
		bottom: 10,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	axisY: {
		position: "absolute",
		left: 8,
		bottom: 46,
		color: tokens.colorTextFaint,
		fontSize: 11,
		transform: "rotate(-90deg)",
		transformOrigin: "left bottom"
	},
	inspector: {
		borderLeft: { default: `1px solid ${tokens.colorBorder}`, "@media (max-width: 900px)": 0 },
		borderTop: { default: 0, "@media (max-width: 900px)": `1px solid ${tokens.colorBorder}` },
		backgroundColor: tokens.colorSurface,
		padding: 18,
		minWidth: 0
	},
	noSelection: {
		marginTop: 80,
		color: tokens.colorTextSubtle,
		textAlign: "center",
		fontSize: 11
	},
	actorDetails: { display: "flex", flexDirection: "column", gap: 8 },
	actorName: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 24,
		fontWeight: 590
	},
	coordinates: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", marginTop: 10 },
	identity: {
		display: "grid",
		gap: 8,
		marginTop: 10,
		color: tokens.colorTextMuted,
		fontSize: 11,
		overflowWrap: "anywhere"
	},
	offlineCopy: {
		marginTop: 12,
		borderTop: `1px solid ${tokens.colorBorder}`,
		paddingTop: 12,
		color: "#02b8cc",
		fontSize: 11,
		letterSpacing: ".05em",
		lineHeight: 1.5
	}
});
