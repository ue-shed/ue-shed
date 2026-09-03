import { COORDINATE_SYSTEM, Deck, OrthographicView, type Color } from "@deck.gl/core";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { PointMapCanvas } from "./point-map.js";
import {
	pointMapBoundsOf,
	pointMapCanvasAspect,
	pointMapClampViewportSize,
	pointMapColorForClass,
	pointMapFitViewportSize,
	pointMapMarkerRadius,
	pointMapViewportSizeLimits,
	pointMapZoomViewportAt,
	type PointMapConnection,
	type PointMapPoint,
	type PointMapViewport
} from "./point-map-core.js";

export type { PointMapConnection, PointMapPoint, PointMapViewport } from "./point-map-core.js";
export type { PointMapViewState } from "./point-map.js";
export interface PointMapDeckController {
	readonly focusKey: (key: string) => void;
	readonly resetView: () => void;
	readonly setZoomFactor: (factor: number) => void;
}

export interface PointMapDeckProps {
	readonly ariaDescribedBy?: string | undefined;
	readonly ariaLabel: string;
	readonly class?: string | undefined;
	readonly connections?: ReadonlyArray<PointMapConnection> | undefined;
	readonly onController?: ((controller: PointMapDeckController | undefined) => void) | undefined;
	readonly onSelect: (key: string | undefined) => void;
	readonly onViewChange?:
		| ((state: import("./point-map.js").PointMapViewState) => void)
		| undefined;
	readonly points: ReadonlyArray<PointMapPoint>;
	readonly renderMode?: "webgl" | "canvas";
	readonly resetKey?: unknown;
	readonly selectedKey: string | undefined;
	readonly title?: string | undefined;
}

function hexToRgb(hex: string): [number, number, number] {
	const cleaned = hex.replace("#", "").trim();
	if (cleaned.length === 3) {
		const first = cleaned[0] ?? "8";
		const second = cleaned[1] ?? "b";
		const third = cleaned[2] ?? "f";
		const r = Number.parseInt(first + first, 16);
		const g = Number.parseInt(second + second, 16);
		const b = Number.parseInt(third + third, 16);
		return [
			Number.isFinite(r) ? r : 139,
			Number.isFinite(g) ? g : 92,
			Number.isFinite(b) ? b : 246
		];
	}
	if (cleaned.length === 6) {
		const r = Number.parseInt(cleaned.slice(0, 2), 16);
		const g = Number.parseInt(cleaned.slice(2, 4), 16);
		const b = Number.parseInt(cleaned.slice(4, 6), 16);
		return [
			Number.isFinite(r) ? r : 139,
			Number.isFinite(g) ? g : 92,
			Number.isFinite(b) ? b : 246
		];
	}
	return [139, 92, 246];
}

function pointFillColor(point: PointMapPoint): Color {
	const rgb = point.color
		? hexToRgb(point.color)
		: hexToRgb(pointMapColorForClass(point.className));
	const opacity = Math.round(Math.min(1, Math.max(0, point.opacity ?? 1)) * 255);
	return [rgb[0], rgb[1], rgb[2], opacity];
}

function pointRadius(
	point: PointMapPoint,
	visibleCount: number,
	cssWidth: number,
	cssHeight: number,
	selected: boolean
): number {
	void point;
	return pointMapMarkerRadius(visibleCount, cssWidth, cssHeight, selected);
}

function toDeckColor(
	hex: string | undefined,
	fallback: string,
	opacity: number | undefined
): Color {
	const rgb = hexToRgb(hex ?? fallback);
	const a = Math.round(Math.min(1, Math.max(0, opacity ?? 1)) * 255);
	return [rgb[0], rgb[1], rgb[2], a];
}

function deckZoomForViewport(
	viewport: PointMapViewport,
	cssWidth: number,
	cssHeight: number
): number {
	const minSide = Math.max(1, Math.min(cssWidth, cssHeight));
	return Math.log2(minSide / Math.max(1, viewport.size));
}

function viewportForDeckZoom(
	centerX: number,
	centerY: number,
	deckZoom: number,
	cssWidth: number,
	cssHeight: number
): PointMapViewport {
	const minSide = Math.max(1, Math.min(cssWidth, cssHeight));
	return {
		centerX,
		centerY,
		size: minSide / 2 ** deckZoom
	};
}

const fallbackStyles = stylex.create({
	fallbackCanvas: {
		display: "block",
		height: "100%",
		width: "100%"
	},
	fallbackFill: {
		height: "100%",
		width: "100%"
	}
});

/**
 * WebGL-backed point map via deck.gl. Mirrors the `PointMapCanvas` API but batches points
 * on the GPU (ScatterplotLayer) for tens-of-thousands of actors. Falls back to a degraded
 * state if WebGL is unavailable.
 */
export function PointMapDeckCanvas(props: PointMapDeckProps) {
	let canvasElement: HTMLCanvasElement | undefined;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for container ref
	let rootElement: HTMLDivElement | undefined;
	const [deck, setDeck] = createSignal<Deck<OrthographicView>>();
	const [dimensions, setDimensions] = createSignal({ height: 1, width: 1 });
	const [rendererError, setRendererError] = createSignal<string>();
	let viewport: PointMapViewport | undefined;
	let viewLocked = false;
	let lastPointsRef: ReadonlyArray<PointMapPoint> | undefined;

	const currentBounds = () => pointMapBoundsOf(props.points);
	const currentFitSize = () =>
		pointMapFitViewportSize(
			currentBounds(),
			pointMapCanvasAspect(dimensions().width, dimensions().height)
		);

	const stabilize = (
		next: PointMapViewport | undefined,
		bounds = currentBounds()
	): PointMapViewport => {
		const aspect = pointMapCanvasAspect(dimensions().width, dimensions().height);
		const proposedSize = pointMapFitViewportSize(bounds, aspect);
		const proposedCenterX = bounds ? (bounds.minX + bounds.maxX) / 2 : (next?.centerX ?? 0);
		const proposedCenterY = bounds ? (bounds.minY + bounds.maxY) / 2 : (next?.centerY ?? 0);
		if (next === undefined)
			return { centerX: proposedCenterX, centerY: proposedCenterY, size: proposedSize };
		// Hysteresis: reuse same thresholds as point-map-core stabilize (expand 4%, shrink 28%)
		let size = next.size;
		if (proposedSize > next.size * 1.04) size = proposedSize;
		else if (proposedSize < next.size * 0.72) size = proposedSize;
		return { centerX: next.centerX, centerY: next.centerY, size };
	};

	const syncDeckView = () => {
		const d = deck();
		if (d === undefined || viewport === undefined) return;
		const { width, height } = dimensions();
		// SAFETY: OrthographicViewState is broad; our narrow PointMapViewport target/zoom matches deck's expected shape.
		d.setProps({
			viewState: {
				target: [viewport.centerX, viewport.centerY, 0],
				zoom: deckZoomForViewport(viewport, width, height)
			} as never
		});
	};

	const layers = createMemo(() => {
		const pts = props.points;
		const conns = props.connections ?? [];
		const selectedKey = props.selectedKey;
		const { width, height } = dimensions();
		const normalCount = pts.length;

		// Connections first (beneath points)
		const connectionLayer =
			conns.length === 0
				? undefined
				: new LineLayer<PointMapConnection>({
						coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
						data: [...conns],
						getColor: (c) => toDeckColor(c.color, "#02b8cc", c.opacity),
						getSourcePosition: (c) => [c.fromX, c.fromY],
						getTargetPosition: (c) => [c.toX, c.toY],
						getWidth: 1.5,
						id: "point-map-connections",
						pickable: false,
						widthUnits: "pixels"
					});

		const pointLayer = new ScatterplotLayer<PointMapPoint>({
			antialiasing: true,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			data: [...pts],
			getFillColor: (p) => pointFillColor(p),
			getLineColor: [255, 255, 255, 56],
			getLineWidth: 1,
			getPosition: (p) => [p.x, p.y],
			getRadius: (p) =>
				pointRadius(
					p,
					normalCount,
					width,
					height,
					(p.selectionKey ?? p.key) === selectedKey
				),
			id: "point-map-points",
			lineWidthUnits: "pixels",
			onClick: ({ object }) => {
				if (object !== undefined && object !== null) {
					// SAFETY: ScatterplotLayer<PointMapPoint> guarantees object is PointMapPoint when pickable.
					const pt = object as PointMapPoint;
					props.onSelect(pt.selectionKey ?? pt.key);
				}
			},
			pickable: true,
			radiusUnits: "pixels",
			stroked: true
		});

		const selectedPoint = selectedKey
			? pts.find((p) => (p.selectionKey ?? p.key) === selectedKey)
			: undefined;
		const selectionLayer =
			selectedPoint === undefined
				? undefined
				: new ScatterplotLayer<PointMapPoint>({
						coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
						data: [selectedPoint],
						getFillColor: pointFillColor(selectedPoint),
						getLineColor: [255, 255, 255, 255],
						getLineWidth: 2,
						getPosition: (p) => [p.x, p.y],
						getRadius: pointRadius(selectedPoint, normalCount, width, height, true),
						id: "point-map-selection",
						lineWidthUnits: "pixels",
						pickable: true,
						radiusUnits: "pixels",
						stroked: true
					});

		return [connectionLayer, pointLayer, selectionLayer].filter((l) => l !== undefined);
	});

	// Keep viewport stable across data changes; reset when resetKey changes
	createEffect(() => {
		void props.resetKey;
		viewport = undefined;
		viewLocked = false;
	});

	createEffect(() => {
		// react to points change
		void props.points;
		const bounds = currentBounds();
		if (lastPointsRef !== props.points) {
			lastPointsRef = props.points;
			if (!viewLocked) viewport = stabilize(viewport, bounds);
			else if (viewport !== undefined) {
				const fit = currentFitSize();
				if (viewport.size > fit) viewport = { ...viewport, size: fit };
			} else viewport = stabilize(undefined, bounds);
			syncDeckView();
			if (viewport) {
				const fitSizeState = currentFitSize();
				const { width, height } = dimensions();
				props.onViewChange?.({
					fitSize: fitSizeState,
					viewport,
					worldHeight: viewport.size / pointMapCanvasAspect(width, height),
					zoomFactor: fitSizeState / Math.max(viewport.size, 1)
				});
			}
		}
	});

	createEffect(() => {
		const d = deck();
		if (d === undefined) return;
		// SAFETY: deck.gl layers are invariant; our Scatterplot/LineLayer array is the expected layer union.
		d.setProps({ layers: layers() as never[] });
	});

	createEffect(() => {
		const dims = dimensions();
		void dims.width;
		void dims.height;
		if (viewport === undefined) return;
		if (!viewLocked) {
			const next = stabilize(viewport, currentBounds());
			if (
				next.centerX !== viewport.centerX ||
				next.centerY !== viewport.centerY ||
				next.size !== viewport.size
			) {
				viewport = next;
				const fitSizeState = currentFitSize();
				props.onViewChange?.({
					fitSize: fitSizeState,
					viewport: next,
					worldHeight: next.size / pointMapCanvasAspect(dims.width, dims.height),
					zoomFactor: fitSizeState / Math.max(next.size, 1)
				});
			}
		}
		syncDeckView();
	});

	onMount(() => {
		if (canvasElement === undefined) return;
		const rect = canvasElement.getBoundingClientRect();
		const dims = { height: Math.max(1, rect.height), width: Math.max(1, rect.width) };
		setDimensions(dims);
		const bounds = currentBounds();
		viewport = stabilize(undefined, bounds);
		try {
			const deckInstance = new Deck<OrthographicView>({
				canvas: canvasElement,
				getCursor: ({ isDragging, isHovering }) =>
					isDragging ? "grabbing" : isHovering ? "pointer" : "grab",
				height: "100%",
				layers: [],
				onError: (error) => setRendererError(error.message),
				onHover: ({ picked }) => {
					if (!picked) {
						// Deck handles picking; no-op parity with Canvas onHover
					}
				},
				onResize: ({ height, width }) => {
					setDimensions({ height: Math.max(1, height), width: Math.max(1, width) });
				},
				onViewStateChange: ({ viewState }) => {
					// SAFETY: Deck OrthographicViewState always provides target/zoom as numbers or arrays for orthographic.
					const target = viewState.target as readonly number[] | undefined;
					// SAFETY: zoom may be number or [number] for multi-view; normalize to first element.
					const zoom = viewState.zoom as number | number[] | undefined;
					const deckZoom = Array.isArray(zoom) ? (zoom[0] ?? 0) : (zoom ?? 0);
					const cx = target?.[0] ?? viewport?.centerX ?? 0;
					const cy = target?.[1] ?? viewport?.centerY ?? 0;
					const { width, height } = dimensions();
					const base = viewportForDeckZoom(cx, cy, deckZoom, width, height);
					// clamp to fit ceiling
					const fit = currentFitSize();
					const { min, max } = pointMapViewportSizeLimits(fit);
					const clampedSize = Math.min(max, Math.max(min, base.size));
					const next: PointMapViewport = {
						centerX: base.centerX,
						centerY: base.centerY,
						size: clampedSize
					};
					viewport = next;
					viewLocked = true;
					const fitSizeState = currentFitSize();
					props.onViewChange?.({
						fitSize: fitSizeState,
						viewport: next,
						worldHeight: next.size / pointMapCanvasAspect(width, height),
						zoomFactor: fitSizeState / Math.max(next.size, 1)
					});
					// Deck is controlled (props.viewState is set), so it ignores the return
					// value unless we push via setProps. Push the clamped view explicitly
					// so drag-pan actually moves the map instead of snapping back.
					syncDeckView();
					return {
						...viewState,
						target: [next.centerX, next.centerY, 0],
						zoom: deckZoomForViewport(next, width, height)
					};
				},
				pickingRadius: 4,
				useDevicePixels: true,
				viewState: viewport
					? {
							target: [viewport.centerX, viewport.centerY, 0],
							zoom: deckZoomForViewport(viewport, dims.width, dims.height)
						}
					: { target: [0, 0, 0], zoom: 0 },
				views: new OrthographicView({
					controller: {
						doubleClickZoom: false,
						dragPan: true,
						dragRotate: false,
						keyboard: true,
						scrollZoom: false,
						touchRotate: false
					},
					flipY: true,
					id: "point-map-deck"
				}),
				width: "100%"
			});
			setDeck(deckInstance);
		} catch (error) {
			setRendererError(error instanceof Error ? error.message : "Could not start WebGL map");
		}
	});

	onCleanup(() => {
		deck()?.finalize();
	});

	const controller: PointMapDeckController = {
		focusKey: (key: string) => {
			const point = props.points.find((p) => (p.selectionKey ?? p.key) === key);
			if (point === undefined || viewport === undefined) return;
			const fit = currentFitSize();
			const actorExtent = Math.max(point.extentX ?? 0, point.extentY ?? 0, 50);
			const focusSize = pointMapClampViewportSize(Math.max(fit / 6, actorExtent * 8), fit);
			viewport = { centerX: point.x, centerY: point.y, size: focusSize };
			viewLocked = true;
			syncDeckView();
			const { width, height } = dimensions();
			props.onViewChange?.({
				fitSize: fit,
				viewport,
				worldHeight: viewport.size / pointMapCanvasAspect(width, height),
				zoomFactor: fit / Math.max(viewport.size, 1)
			});
		},
		resetView: () => {
			viewLocked = false;
			viewport = stabilize(undefined, currentBounds());
			syncDeckView();
			if (viewport) {
				const fitSizeState = currentFitSize();
				const { width, height } = dimensions();
				props.onViewChange?.({
					fitSize: fitSizeState,
					viewport,
					worldHeight: viewport.size / pointMapCanvasAspect(width, height),
					zoomFactor: fitSizeState / Math.max(viewport.size, 1)
				});
			}
		},
		setZoomFactor: (factor: number) => {
			if (viewport === undefined || !Number.isFinite(factor) || factor <= 0) return;
			const fit = currentFitSize();
			const size = pointMapClampViewportSize(fit / factor, fit);
			viewport = { ...viewport, size };
			viewLocked = size < fit - 1e-6;
			syncDeckView();
			const { width, height } = dimensions();
			props.onViewChange?.({
				fitSize: fit,
				viewport,
				worldHeight: viewport.size / pointMapCanvasAspect(width, height),
				zoomFactor: fit / Math.max(viewport.size, 1)
			});
		}
	};

	createEffect(() => {
		props.onController?.(controller);
		onCleanup(() => props.onController?.(undefined));
	});

	const handleWheel = (event: WheelEvent & { readonly currentTarget: HTMLCanvasElement }) => {
		// Manual wheel zoom ensures scroll works even if Deck controller is misconfigured; mirrors PointMapCanvas.
		event.preventDefault();
		if (viewport === undefined) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const { width, height } = dimensions();
		const fit = currentFitSize();
		const { min, max } = pointMapViewportSizeLimits(fit);
		const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
		viewport = pointMapZoomViewportAt(
			viewport,
			width,
			height,
			event.clientX - rect.left,
			event.clientY - rect.top,
			factor,
			min,
			max
		);
		viewLocked = viewport.size < max - 1e-6;
		syncDeckView();
		const fitSizeState = currentFitSize();
		props.onViewChange?.({
			fitSize: fitSizeState,
			viewport,
			worldHeight: viewport.size / pointMapCanvasAspect(width, height),
			zoomFactor: fitSizeState / Math.max(viewport.size, 1)
		});
	};

	return (
		<div
			ref={(el) => {
				rootElement = el;
			}}
			class={props.class}
			data-renderer={rendererError() ? "canvas-fallback" : "deck.gl"}
			data-testid="point-map-deck-root"
		>
			<Show
				when={rendererError() === undefined}
				fallback={
					<div {...stylex.props(fallbackStyles.fallbackFill)}>
						<PointMapCanvas
							ariaDescribedBy={props.ariaDescribedBy}
							ariaLabel={props.ariaLabel}
							class={stylex.props(fallbackStyles.fallbackCanvas).className}
							connections={props.connections}
							// SAFETY: Deck and Canvas controllers are structurally compatible (focusKey/resetView/setZoomFactor).
							onController={props.onController as never}
							onSelect={props.onSelect}
							onViewChange={props.onViewChange}
							points={props.points}
							resetKey={props.resetKey}
							selectedKey={props.selectedKey}
							title={props.title}
						/>
					</div>
				}
			>
				<canvas
					ref={(el) => {
						canvasElement = el;
					}}
					aria-describedby={props.ariaDescribedBy}
					aria-label={props.ariaLabel}
					role="application"
					style={{ display: "block", height: "100%", width: "100%" }}
					tabIndex={0}
					title={
						props.title ?? "Scroll to zoom, drag to pan, click a point to inspect it"
					}
					onWheel={handleWheel}
				/>
			</Show>
			<Show when={rendererError()}>
				{(message) => (
					<div
						role="alert"
						style={{
							"background-color": "rgba(15,16,17,0.85)",
							bottom: "4px",
							color: "#f87171",
							"font-size": "10px",
							left: "4px",
							padding: "3px 6px",
							position: "absolute"
						}}
					>
						GPU map unavailable: {message()} — using Canvas fallback.
					</div>
				)}
			</Show>
		</div>
	);
}
