import * as stylex from "@stylexjs/stylex";
import { recordObservatoryPaintDuration } from "@ue-shed/observability";
import {
	type ObservedActor,
	WorldScoutRefreshRate,
	type WorldObservationState,
	type WorldScoutResult
} from "@ue-shed/observatory";
import {
	ActorExplorer,
	actorExplorerMatches,
	createEffectAction,
	createEffectSubscription,
	type ActorExplorerFilters
} from "@ue-shed/ui";
import { Effect } from "effect";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { MapReviewClientShape, MapReviewWorldObservation } from "./map-review-client.js";
import {
	contentBounds,
	clampViewportSize,
	createWorldScoutPaintGate,
	fitViewportSize,
	formatCoordinate,
	hitTestVisibleActors,
	nearestVisibleActor,
	paintWorldScout,
	panViewportBy,
	projectVisibleActors,
	resizeCanvasForDisplay,
	resizeViewportToSize,
	stabilizeViewport,
	viewportSizeLimits,
	WorldScoutRetainedStore,
	worldScoutMinViewportSize,
	zoomViewportAt,
	type WorldScoutPaintGate
} from "./world-scout-canvas.js";

const streamMaxHz = 60;
const pollingFallbackMaxHz = 10;
export const worldScoutFollowIntervalMs = 200;
export const worldScoutPaintedEvent = "ue-shed:world-scout-painted";

export interface WorldScoutPaintDetail {
	readonly actorsChanged: number;
	readonly actorsObserved: number;
	readonly durationMs: number;
	readonly sequence: string;
}

export function shouldRequestFollowUpdate(lastRequestMs: number, nowMs: number): boolean {
	return nowMs - lastRequestMs >= worldScoutFollowIntervalMs;
}

function observationConnectionLabel(state: WorldObservationState | undefined): string {
	if (state === undefined) return "OFFLINE";
	switch (state.status) {
		case "live":
			return state.sample.catalog.worldKind;
		case "stale":
			return "RECONNECTING";
		case "polling_fallback":
			return state.snapshot.worldKind;
		case "connecting":
			return "CONNECTING";
		case "unavailable":
			return state.sample === undefined ? "OFFLINE" : "RECONNECTING";
	}
}

function maxRefreshRateFor(state: WorldObservationState | undefined): number {
	return state?.status === "polling_fallback" ? pollingFallbackMaxHz : streamMaxHz;
}

function actorObjectName(actorPath: string): string {
	return actorPath.split(".").at(-1) ?? actorPath;
}

export function WorldScout(props: {
	readonly client: Pick<
		MapReviewClientShape,
		"connectWorld" | "focusActor" | "setWorldObservationRate" | "worldObservations"
	>;
	readonly onActorFocused: (actor: ObservedActor) => void;
	/** Test seam: override paint scheduling to assert animation-frame coalescing. */
	readonly paintScheduler?: {
		readonly schedule: (callback: () => void) => number;
		readonly cancel: (handle: number) => void;
	};
	/** Test seam: reports the sparse transform count handed to the retained renderer. */
	readonly onTransformBatchApplied?: (count: number) => void;
}) {
	const subscription = createEffectSubscription();
	const connectAction = createEffectAction();
	const focusAction = createEffectAction();
	const followAction = createEffectAction();
	const rateAction = createEffectAction();
	const store = new WorldScoutRetainedStore();
	let canvasRef: HTMLCanvasElement | undefined;
	let paintGate: WorldScoutPaintGate | undefined;
	let cssWidth = 0;
	let cssHeight = 0;
	let viewLocked = false;
	let lastFollowRequestMs = Number.NEGATIVE_INFINITY;
	let resizeObserver: ResizeObserver | undefined;
	let pointerDrag:
		| {
				pointerId: number;
				startX: number;
				startY: number;
				moved: boolean;
		  }
		| undefined;

	const [latest, setLatest] = createSignal<WorldObservationState>();
	const [hasWorld, setHasWorld] = createSignal(false);
	const [refreshRate, setRefreshRate] = createSignal(WorldScoutRefreshRate.make(30));
	const [actorFilters, setActorFilters] = createSignal<ActorExplorerFilters>({
		classPaths: undefined,
		query: ""
	});
	const [selectedKey, setSelectedKey] = createSignal<string>();
	const [selectedStreamIndex, setSelectedStreamIndex] = createSignal<number>();
	const [following, setFollowing] = createSignal(false);
	const [navigationStatus, setNavigationStatus] = createSignal("SELECTED FOR REVIEW");
	const [catalogRevision, setCatalogRevision] = createSignal(0);
	const [presentationRevision, setPresentationRevision] = createSignal(0);
	const [selectionRevision, setSelectionRevision] = createSignal(0);
	const [liveRegion, setLiveRegion] = createSignal("");

	const connectionLabel = createMemo(() => {
		const label = observationConnectionLabel(latest());
		if (label === "OFFLINE" && hasWorld()) return "RECONNECTING";
		return label;
	});
	const sampleAge = createMemo(() => {
		presentationRevision();
		const capturedAt = store.capturedAt;
		if (capturedAt === undefined) return undefined;
		return Math.max(0, Date.now() - Date.parse(capturedAt));
	});
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
				classLabel: actor.className.replace(/^(BP_|A)/, ""),
				classPath: actor.className,
				key: actor.instanceKey,
				label: actor.displayName,
				packageName: actor.packageName,
				path: actor.path,
				searchFields: {
					class: actor.className,
					guid: actor.instanceKey,
					label: actor.displayName,
					package: actor.packageName,
					path: actor.path
				},
				...(actorObjectName(actor.path) === actor.displayName
					? {}
					: { secondary: actorObjectName(actor.path) }),
				...(actor.id === undefined ? { badges: ["CATALOG ONLY"] } : {})
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
	const visibleActorKeys = createMemo(() => {
		const filters = actorFilters();
		return new Set(
			actorItems()
				.filter((item) => actorExplorerMatches(item, filters))
				.map((item) => item.key)
		);
	});
	const visibleCount = createMemo(() => {
		return visibleActorKeys().size;
	});
	const observedCount = createMemo(() => {
		catalogRevision();
		return store.count;
	});
	const extentLabel = createMemo(() => {
		presentationRevision();
		const viewport = store.viewport;
		if (viewport === undefined) return "—";
		const aspect = cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : 2;
		const height = viewport.size / aspect;
		return `${Math.round(viewport.size).toLocaleString()} × ${Math.round(height).toLocaleString()} UU`;
	});
	const fitSize = createMemo(() => {
		presentationRevision();
		const aspect = cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : 2;
		return fitViewportSize(contentBounds(store, store.visibleIndices), aspect);
	});
	const zoomLimits = createMemo(() => viewportSizeLimits(fitSize()));
	const zoomFactor = createMemo(() => {
		presentationRevision();
		const viewport = store.viewport;
		const fit = fitSize();
		if (viewport === undefined || fit <= 0) return 1;
		return fit / Math.max(viewport.size, 1);
	});
	const maxZoomFactor = createMemo(() => {
		const { min, max } = zoomLimits();
		return max / Math.max(min, 1);
	});
	const selected = createMemo(() => {
		selectionRevision();
		const index = selectedStreamIndex();
		return index === undefined ? undefined : store.materialize(index);
	});
	const mapPathLabel = createMemo(() => {
		catalogRevision();
		return store.mapPath ?? "No observed world";
	});
	const rateMax = createMemo(() => maxRefreshRateFor(latest()));
	const fallbackCadence = createMemo(() => {
		const state = latest();
		return state?.status === "polling_fallback" ? state.cadenceHz : undefined;
	});

	const syncSelectionFromKey = () => {
		const key = selectedKey();
		if (key === undefined) {
			setSelectedStreamIndex(undefined);
			return;
		}
		const index = store.findByInstanceKey(key);
		setSelectedStreamIndex(index);
		if (index === undefined) {
			setFollowing(false);
			setNavigationStatus("ACTOR LEFT THE OBSERVED WORLD");
		}
	};

	const prepareVisibleProjection = () => {
		const visibleKeys = visibleActorKeys();
		store.visibleIndices.length = 0;
		for (let index = 0; index < store.count; index += 1) {
			const key = store.instanceKeys[index];
			if (key !== undefined && visibleKeys.has(key)) store.visibleIndices.push(index);
		}
		const bounds = contentBounds(store, store.visibleIndices);
		const aspect = cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : 2;
		const fit = fitViewportSize(bounds, aspect);
		if (!viewLocked) {
			store.viewport = stabilizeViewport(store.viewport, bounds, aspect);
		} else if (store.viewport === undefined) {
			store.viewport = stabilizeViewport(undefined, bounds, aspect);
		} else if (store.viewport.size > fit) {
			store.viewport = resizeViewportToSize(store.viewport, fit);
		}
		if (cssWidth > 0 && cssHeight > 0 && store.viewport !== undefined) {
			projectVisibleActors(store, store.viewport, cssWidth, cssHeight, store.visibleIndices);
		}
	};

	const paint = () => {
		const canvas = canvasRef;
		if (canvas === undefined || cssWidth <= 0 || cssHeight <= 0) return;
		const started = performance.now();
		const context = resizeCanvasForDisplay(
			canvas,
			cssWidth,
			cssHeight,
			typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
		);
		if (!context) return;
		prepareVisibleProjection();
		paintWorldScout(
			context,
			store,
			store.visibleIndices.length,
			selectedStreamIndex(),
			cssWidth,
			cssHeight
		);
		const durationMs = performance.now() - started;
		Effect.runSync(recordObservatoryPaintDuration(durationMs));
		setPresentationRevision((value) => value + 1);
		window.dispatchEvent(
			new CustomEvent<WorldScoutPaintDetail>(worldScoutPaintedEvent, {
				detail: {
					actorsChanged: lastPaintActorsChanged,
					actorsObserved: store.count,
					durationMs,
					sequence: lastPaintSequence
				}
			})
		);
	};

	const requestPaint = () => {
		paintGate?.markDirty();
	};

	let lastCatalogIdentity: string | undefined;
	let lastPaintActorsChanged = 0;
	let lastPaintSequence = "0";
	const acceptObservation = (current: MapReviewWorldObservation) => {
		setLatest(current);
		if (current.status === "live" || current.status === "stale") {
			const identity = `${current.sample.catalog.sessionId}:${current.sample.catalog.revision}`;
			lastPaintSequence = current.sample.lastSequence.toString();
			if (identity !== lastCatalogIdentity) {
				store.installCatalog(current.sample);
				lastCatalogIdentity = identity;
				viewLocked = false;
				lastPaintActorsChanged = store.count;
				setCatalogRevision((value) => value + 1);
			} else {
				const changed =
					current.changedTransforms ??
					[...current.sample.transforms].map(([streamIndex, transform]) => ({
						streamIndex,
						transform
					}));
				store.applyTransforms(changed, current.sample.sampleWorldSeconds);
				lastPaintActorsChanged = changed.length;
				props.onTransformBatchApplied?.(changed.length);
				store.capturedAt = current.sample.catalog.capturedAt;
			}
			setHasWorld(true);
		} else if (current.status === "polling_fallback") {
			lastCatalogIdentity = undefined;
			store.installSnapshot(current.snapshot);
			lastPaintActorsChanged = store.count;
			lastPaintSequence = String(current.snapshot.sequence);
			setCatalogRevision((value) => value + 1);
			setHasWorld(true);
		} else if (current.status === "unavailable" && current.sample !== undefined) {
			lastCatalogIdentity = `${current.sample.catalog.sessionId}:${current.sample.catalog.revision}`;
			store.installCatalog(current.sample);
			lastPaintActorsChanged = store.count;
			lastPaintSequence = current.sample.lastSequence.toString();
			setCatalogRevision((value) => value + 1);
			setHasWorld(true);
		}
		syncSelectionFromKey();
		setSelectionRevision((value) => value + 1);
		const selectedActor = selected();
		if (selectedActor !== undefined) {
			setLiveRegion(
				`${selectedActor.displayName}, ${selectedActor.className}, X ${formatCoordinate(selectedActor.location.x)}, Y ${formatCoordinate(selectedActor.location.y)}, Z ${formatCoordinate(selectedActor.location.z)}`
			);
		}
		requestPaint();
	};

	const acceptConnectResult = (current: WorldScoutResult) => {
		if (current.status === "ready") {
			acceptObservation({
				status: "polling_fallback",
				cadenceHz: Math.min(refreshRate(), pollingFallbackMaxHz),
				message: "Connected through a one-shot world snapshot.",
				snapshot: current.snapshot
			});
			return;
		}
		acceptObservation({
			status: "unavailable",
			message: current.message,
			recovery: current.recovery
		});
	};

	const subscribe = (rate: WorldScoutRefreshRate) => {
		subscription.subscribe(props.client.worldObservations(rate), {
			onValue: (current) => {
				acceptObservation(current);
				if (!following()) return;
				const actor = selected();
				if (actor === undefined) {
					setFollowing(false);
					setNavigationStatus("ACTOR LEFT THE OBSERVED WORLD");
					return;
				}
				if (current.status !== "live" && current.status !== "polling_fallback") return;
				const nowMs = performance.now();
				if (!shouldRequestFollowUpdate(lastFollowRequestMs, nowMs)) return;
				lastFollowRequestMs = nowMs;
				followAction.run(props.client.focusActor(actor.id, false), {
					onSuccess: (focus) => {
						if (focus.status !== "focused") {
							setFollowing(false);
							setNavigationStatus("FOLLOW UNAVAILABLE");
						}
					}
				});
			}
		});
	};

	onMount(() => {
		paintGate = createWorldScoutPaintGate(
			paint,
			props.paintScheduler?.schedule,
			props.paintScheduler?.cancel
		);
		subscribe(refreshRate());
	});
	onCleanup(() => {
		paintGate?.dispose();
		paintGate = undefined;
		resizeObserver?.disconnect();
		resizeObserver = undefined;
	});

	createEffect(() => {
		actorFilters();
		selectedStreamIndex();
		requestPaint();
	});

	const connect = () =>
		connectAction.run(props.client.connectWorld(), { onSuccess: acceptConnectResult });
	const updateRefreshRate = (value: string) => {
		const parsed = Number(value);
		const max = rateMax();
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return;
		const next = WorldScoutRefreshRate.make(parsed);
		if (props.client.setWorldObservationRate === undefined) {
			setRefreshRate(next);
			return;
		}
		rateAction.run(props.client.setWorldObservationRate(next), {
			onSuccess: (applied) => setRefreshRate(applied)
		});
	};
	const selectStreamIndex = (streamIndex: number) => {
		const meta = store.actorAt(streamIndex);
		if (meta === undefined) return;
		setSelectedKey(meta.instanceKey);
		setSelectedStreamIndex(streamIndex);
		setFollowing(false);
		setNavigationStatus("SELECTED FOR REVIEW");
		setLiveRegion(
			`${meta.displayName}, ${meta.className}, X ${formatCoordinate(store.locationX[streamIndex] ?? 0)}, Y ${formatCoordinate(store.locationY[streamIndex] ?? 0)}, Z ${formatCoordinate(store.locationZ[streamIndex] ?? 0)}`
		);
		requestPaint();
	};
	const focusActorOnMap = (key: string) => {
		const index = store.findByInstanceKey(key);
		if (index === undefined) return;
		prepareVisibleProjection();
		const aspect = cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : 2;
		const fit = fitViewportSize(contentBounds(store, store.visibleIndices), aspect);
		const actorExtent = Math.max(
			store.boundExtentX[index] ?? 0,
			store.boundExtentY[index] ?? 0,
			worldScoutMinViewportSize
		);
		store.viewport = {
			centerX: store.locationX[index] ?? 0,
			centerY: store.locationY[index] ?? 0,
			size: clampViewportSize(Math.max(fit / 6, actorExtent * 8), fit)
		};
		viewLocked = true;
		requestPaint();
	};
	const pickNearestActor = (cssX: number, cssY: number) => {
		prepareVisibleProjection();
		const hit = hitTestVisibleActors(
			store,
			store.visibleIndices.length,
			cssX,
			cssY,
			cssWidth,
			cssHeight
		);
		if (hit !== undefined) selectStreamIndex(hit);
	};
	const syncCanvasSize = (frame: Element) => {
		const rect = frame.getBoundingClientRect();
		const nextWidth = Math.max(1, rect.width - 56);
		const nextHeight = Math.max(1, rect.height - 56);
		if (nextWidth === cssWidth && nextHeight === cssHeight) return;
		cssWidth = nextWidth;
		cssHeight = nextHeight;
		requestPaint();
	};
	const onCanvasWheel = (event: WheelEvent & { currentTarget: HTMLCanvasElement }) => {
		event.preventDefault();
		const viewport = store.viewport;
		if (viewport === undefined) return;
		const rect = event.currentTarget.getBoundingClientRect();
		cssWidth = Math.max(1, rect.width);
		cssHeight = Math.max(1, rect.height);
		const aspect = cssWidth / cssHeight;
		const fit = fitViewportSize(contentBounds(store, store.visibleIndices), aspect);
		const { min, max } = viewportSizeLimits(fit);
		const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
		store.viewport = zoomViewportAt(
			viewport,
			cssWidth,
			cssHeight,
			event.clientX - rect.left,
			event.clientY - rect.top,
			factor,
			min,
			max
		);
		viewLocked = store.viewport.size < max - 1e-6;
		requestPaint();
	};
	const onCanvasPointerDown = (event: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
		if (event.button !== 0 && event.button !== 1) return;
		const rect = event.currentTarget.getBoundingClientRect();
		cssWidth = Math.max(1, rect.width);
		cssHeight = Math.max(1, rect.height);
		pointerDrag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			moved: false
		};
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onCanvasPointerMove = (event: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
		if (pointerDrag === undefined || pointerDrag.pointerId !== event.pointerId) return;
		const dx = event.clientX - pointerDrag.startX;
		const dy = event.clientY - pointerDrag.startY;
		if (!pointerDrag.moved && Math.hypot(dx, dy) < 4) return;
		const viewport = store.viewport;
		if (viewport === undefined) return;
		pointerDrag.moved = true;
		pointerDrag.startX = event.clientX;
		pointerDrag.startY = event.clientY;
		store.viewport = panViewportBy(viewport, cssWidth, cssHeight, dx, dy);
		viewLocked = true;
		requestPaint();
	};
	const onCanvasPointerUp = (event: PointerEvent & { currentTarget: HTMLCanvasElement }) => {
		if (pointerDrag === undefined || pointerDrag.pointerId !== event.pointerId) return;
		const drag = pointerDrag;
		pointerDrag = undefined;
		event.currentTarget.releasePointerCapture?.(event.pointerId);
		if (drag.moved || event.button === 1) return;
		const rect = event.currentTarget.getBoundingClientRect();
		pickNearestActor(event.clientX - rect.left, event.clientY - rect.top);
	};
	const resetView = () => {
		viewLocked = false;
		store.viewport = undefined;
		requestPaint();
	};
	const clearSelection = () => {
		setSelectedKey(undefined);
		setSelectedStreamIndex(undefined);
		setFollowing(false);
		setNavigationStatus("SELECTION CLEARED");
		setLiveRegion("Selection cleared");
		setSelectionRevision((value) => value + 1);
		requestPaint();
	};
	const setZoomFactor = (value: string) => {
		const viewport = store.viewport;
		if (viewport === undefined) return;
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || parsed <= 0) return;
		const fit = fitSize();
		const nextSize = clampViewportSize(fit / parsed, fit);
		store.viewport = resizeViewportToSize(viewport, nextSize);
		viewLocked = nextSize < fit - 1e-6;
		requestPaint();
	};
	const onCanvasKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			clearSelection();
			return;
		}
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			prepareVisibleProjection();
			const next = nearestVisibleActor(store, selectedStreamIndex(), "next");
			if (next !== undefined) selectStreamIndex(next);
			return;
		}
		if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			prepareVisibleProjection();
			const previous = nearestVisibleActor(store, selectedStreamIndex(), "previous");
			if (previous !== undefined) selectStreamIndex(previous);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const actor = selected();
			if (actor !== undefined) goToActor(actor, false);
		}
	};
	const goToActor = (actor: ObservedActor, follow: boolean) => {
		focusAction.run(props.client.focusActor(actor.id, true), {
			onSuccess: (focus) => {
				if (focus.status === "focused") {
					lastFollowRequestMs = performance.now();
					setFollowing(follow);
					setNavigationStatus(
						follow
							? "FOLLOWING IN UNREAL"
							: focus.authoringSubject === "selected"
								? "FOCUSED IN UNREAL"
								: "FOCUSED RUNTIME ACTOR"
					);
					if (focus.authoringSubject === "selected") props.onActorFocused(actor);
				} else {
					setFollowing(false);
					setNavigationStatus("FOCUS UNAVAILABLE");
				}
			}
		});
	};
	const setCanvasElement = (element: HTMLCanvasElement) => {
		canvasRef = element;
		const frame = element.parentElement;
		resizeObserver?.disconnect();
		resizeObserver = undefined;
		if (frame !== null) {
			syncCanvasSize(frame);
			if (typeof ResizeObserver !== "undefined") {
				resizeObserver = new ResizeObserver(() => syncCanvasSize(frame));
				resizeObserver.observe(frame);
			}
		}
		requestPaint();
	};

	return (
		<section aria-label="Live top-down actor map" {...stylex.props(styles.scout)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>WORLD SCOUT</p>
					<h2 {...stylex.props(styles.title)}>Actors in the open level</h2>
				</div>
				<div {...stylex.props(styles.worldStatus)}>
					<span {...stylex.props(styles.liveDot)} />
					<strong>{connectionLabel()}</strong>
					<code {...stylex.props(styles.worldStatusCode)}>{mapPathLabel()}</code>
					<Show when={sampleAge()}>
						{(age) => (
							<small {...stylex.props(styles.sampleAge)}>
								{age() < 1_000
									? "LIVE SAMPLE"
									: `${(age() / 1_000).toFixed(1)}s OLD`}
							</small>
						)}
					</Show>
				</div>
			</header>

			<Show
				when={hasWorld()}
				fallback={
					<div {...stylex.props(styles.offline)}>
						<div {...stylex.props(styles.offlineReticle)}>＋</div>
						<h3>No live world connected</h3>
						<p>
							Start the editor with Remote Control, open a map, then connect to list
							actors and jump the viewport to a selection.
						</p>
						<button
							type="button"
							onClick={connect}
							{...stylex.props(styles.connectButton)}
						>
							CONNECT LIVE WORLD
						</button>
						<Show when={latest()?.status === "unavailable"}>
							{(() => {
								const current = latest();
								return current?.status === "unavailable" ? (
									<small>{current.message}</small>
								) : null;
							})()}
						</Show>
					</div>
				}
			>
				<div {...stylex.props(styles.tools)}>
					<div
						aria-label={`${visibleCount()} visible of ${observedCount()} observed actors`}
						{...stylex.props(styles.sampleMeta)}
					>
						<strong>{visibleCount()}</strong>
						<span>VISIBLE / {observedCount()} OBSERVED</span>
					</div>
					<label {...stylex.props(styles.rateControl)}>
						<span>REFRESH RATE</span>
						<input
							type="range"
							aria-label="World refresh rate"
							min="1"
							max={rateMax()}
							step="1"
							value={Math.min(refreshRate(), rateMax())}
							onInput={(event) => updateRefreshRate(event.currentTarget.value)}
							{...stylex.props(styles.rateSlider)}
						/>
						<strong>
							{Math.min(refreshRate(), rateMax())} HZ
							{fallbackCadence() === undefined
								? ""
								: ` · FALLBACK ${fallbackCadence()} HZ`}
						</strong>
					</label>
				</div>

				<div {...stylex.props(styles.workspace)}>
					<ActorExplorer
						ariaLabel="Live actor outliner"
						classOptions={classOptions()}
						filters={actorFilters()}
						itemListLabel="Live actors"
						items={actorItems()}
						label="LIVE ACTORS"
						onClassPathsChange={(classPaths) =>
							setActorFilters((current) => ({ ...current, classPaths }))
						}
						onFiltersChange={setActorFilters}
						onFocus={focusActorOnMap}
						onSelect={(key) => {
							if (key === undefined) {
								clearSelection();
								return;
							}
							const index = store.findByInstanceKey(key);
							if (index !== undefined) selectStreamIndex(index);
						}}
						queryAriaLabel="Find live actor"
						selectedClassPath={undefined}
						selectedKey={selectedKey()}
						title="Select an actor to inspect it on the live map"
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
								onInput={(event) => setZoomFactor(event.currentTarget.value)}
								{...stylex.props(styles.zoomSlider)}
							/>
							<strong>{zoomFactor().toFixed(1)}×</strong>
						</label>
						<div {...stylex.props(styles.extentLabel)}>{extentLabel()}</div>
						<button
							type="button"
							onClick={resetView}
							{...stylex.props(styles.resetView)}
						>
							RESET VIEW
						</button>
						<canvas
							ref={setCanvasElement}
							role="application"
							tabIndex={0}
							aria-label="Top-down actor map"
							aria-describedby="world-scout-live"
							title="Scroll to zoom, drag to pan, click to select"
							onWheel={onCanvasWheel}
							onPointerDown={onCanvasPointerDown}
							onPointerMove={onCanvasPointerMove}
							onPointerUp={onCanvasPointerUp}
							onPointerCancel={onCanvasPointerUp}
							onKeyDown={onCanvasKeyDown}
							{...stylex.props(styles.map)}
						/>
						<div
							id="world-scout-live"
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
									<span>SELECT A POINT</span>
									<p>
										Focus an actor in Unreal and generate transient review
										framing.
									</p>
								</div>
							}
						>
							{(actor) => (
								<div {...stylex.props(styles.actorDetails)}>
									<p>OBSERVED ACTOR</p>
									<h3 {...stylex.props(styles.actorDetailsHeading)}>
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
									<div {...stylex.props(styles.actorActions)}>
										<button
											type="button"
											onClick={() => goToActor(actor(), false)}
											{...stylex.props(styles.goToButton)}
										>
											GO TO ACTOR ↗
										</button>
										<button
											type="button"
											aria-pressed={following()}
											onClick={() => {
												if (following()) {
													setFollowing(false);
													setNavigationStatus("FOLLOW STOPPED");
												} else goToActor(actor(), true);
											}}
											{...stylex.props(
												styles.followButton,
												following() && styles.followButtonActive
											)}
										>
											{following() ? "STOP FOLLOWING" : "FOLLOW ACTOR"}
										</button>
										<button
											type="button"
											onClick={clearSelection}
											{...stylex.props(styles.clearSelection)}
										>
											CLEAR SELECTION
										</button>
									</div>
									<span {...stylex.props(styles.focusedCopy)}>
										{navigationStatus()}
									</span>
								</div>
							)}
						</Show>
					</aside>
				</div>
			</Show>
		</section>
	);
}

const styles = stylex.create({
	scout: {
		minWidth: 0,
		maxWidth: "100%",
		border: "1px solid #384039",
		backgroundColor: "#0a0d0b",
		boxShadow: "inset 4px 0 #b9f227"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "end",
		padding: "20px 22px",
		borderBottom: "1px solid #303632",
		minWidth: 0
	},
	eyebrow: { margin: "0 0 8px", color: "#89938c", fontSize: 9, letterSpacing: ".16em" },
	title: { margin: 0, fontFamily: "Georgia, serif", fontWeight: 400, fontSize: 28 },
	worldStatus: {
		display: "grid",
		gridTemplateColumns: "8px auto",
		gap: "3px 8px",
		alignItems: "center",
		textAlign: "right",
		fontSize: 8,
		minWidth: 0,
		maxWidth: "42vw"
	},
	liveDot: {
		width: 6,
		height: 6,
		borderRadius: "50%",
		backgroundColor: "#b9f227",
		boxShadow: "0 0 10px #b9f277"
	},
	worldStatusCode: {
		color: "#7d8780",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	sampleAge: { gridColumn: "2", color: "#657068", fontSize: 7, letterSpacing: ".1em" },
	offline: {
		minHeight: 410,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		backgroundImage:
			"linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px)",
		backgroundSize: "32px 32px"
	},
	offlineReticle: { color: "#b9f227", fontSize: 40 },
	connectButton: {
		marginTop: 14,
		border: "1px solid #b9f227",
		backgroundColor: { default: "#b9f227", ":hover": "#d4ff62" },
		color: "#11150d",
		padding: "11px 16px",
		fontWeight: 900,
		fontSize: 9,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	tools: {
		display: "grid",
		gap: 12,
		alignItems: "end",
		padding: "12px 14px",
		borderBottom: "1px solid #303632",
		backgroundColor: "#111512",
		minWidth: 0,
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 180px",
			"@media (max-width: 600px)": "1fr"
		}
	},
	sampleMeta: { display: "grid", textAlign: "right", color: "#7f8882", fontSize: 8 },
	rateControl: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: "5px 10px",
		alignItems: "center",
		color: "#879188",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	rateSlider: {
		gridColumn: "1 / -1",
		width: "100%",
		accentColor: "#b9f227",
		cursor: "ew-resize"
	},
	workspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(240px, 280px) minmax(0, 1fr) minmax(240px, 280px)",
			"@media (max-width: 1150px)": "240px minmax(0, 1fr) 220px",
			"@media (max-width: 900px)": "minmax(0, 1fr)"
		},
		alignItems: "stretch",
		minWidth: 0
	},
	mapFrame: {
		position: "relative",
		aspectRatio: "2 / 1",
		width: "100%",
		overflow: "hidden",
		backgroundColor: "#0c100d",
		backgroundImage:
			"linear-gradient(#a7b2aa12 1px,transparent 1px),linear-gradient(90deg,#a7b2aa12 1px,transparent 1px),linear-gradient(#a7b2aa08 1px,transparent 1px),linear-gradient(90deg,#a7b2aa08 1px,transparent 1px)",
		backgroundSize: "80px 80px,80px 80px,16px 16px,16px 16px",
		minWidth: 0
	},
	map: {
		position: "absolute",
		inset: 28,
		width: "calc(100% - 56px)",
		height: "calc(100% - 56px)",
		cursor: "crosshair",
		touchAction: "none",
		outline: { ":focus": "1px solid #ffffff" }
	},
	resetView: {
		position: "absolute",
		top: 10,
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 2,
		border: "1px solid #3a433c",
		backgroundColor: { default: "#111512cc", ":hover": "#1a211c" },
		color: "#9aa49c",
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
		color: "#b9f227",
		fontSize: 9,
		letterSpacing: ".12em"
	},
	extentLabel: {
		position: "absolute",
		top: 34,
		right: 14,
		color: "#667069",
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
		color: "#879188",
		fontSize: 7,
		letterSpacing: ".1em",
		backgroundColor: "#111512cc",
		border: "1px solid #3a433c",
		padding: "4px 8px"
	},
	zoomSlider: {
		width: "100%",
		accentColor: "#b9f227",
		cursor: "ew-resize"
	},
	clearSelection: {
		border: "1px solid #3a433c",
		backgroundColor: { default: "transparent", ":hover": "#1a211c" },
		color: "#9aa49c",
		padding: "10px 12px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	axisX: { position: "absolute", right: 12, bottom: 10, color: "#59625c", fontSize: 7 },
	axisY: {
		position: "absolute",
		left: 8,
		bottom: 46,
		color: "#59625c",
		fontSize: 7,
		transform: "rotate(-90deg)",
		transformOrigin: "left bottom"
	},
	inspector: {
		borderLeft: {
			default: "1px solid #303632",
			"@media (max-width: 900px)": 0
		},
		borderTop: {
			default: 0,
			"@media (max-width: 900px)": "1px solid #303632"
		},
		backgroundColor: "#111512",
		padding: 18,
		minWidth: 0
	},
	noSelection: { marginTop: 80, color: "#778078", textAlign: "center", fontSize: 9 },
	actorDetails: { display: "flex", flexDirection: "column", gap: 8 },
	actorDetailsHeading: { margin: 0, fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 400 },
	coordinates: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", marginTop: 18 },
	actorActions: { display: "grid", gap: 7, marginTop: 16 },
	goToButton: {
		border: "1px solid #b9f227",
		backgroundColor: { default: "#b9f227", ":hover": "#d4ff62" },
		color: "#10130c",
		padding: "11px 12px",
		fontSize: 9,
		fontWeight: 900,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	followButton: {
		border: "1px solid #566058",
		backgroundColor: { default: "transparent", ":hover": "#202721" },
		color: "#aeb7b0",
		padding: "10px 12px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".09em",
		cursor: "pointer"
	},
	followButtonActive: {
		borderColor: "#b9f227",
		backgroundColor: "#1c2612",
		color: "#b9f227"
	},
	focusedCopy: {
		marginTop: 16,
		borderTop: "1px solid #3c443e",
		paddingTop: 12,
		color: "#b9f227",
		fontSize: 8,
		letterSpacing: ".09em"
	}
});
