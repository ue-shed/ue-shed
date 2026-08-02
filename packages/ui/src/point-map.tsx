import { createEffect, onCleanup, onMount } from "solid-js";
import {
	pointMapBoundsOf,
	pointMapCanvasAspect,
	pointMapClampViewportSize,
	pointMapColorForClass,
	pointMapFitViewportSize,
	pointMapMinViewportSize,
	pointMapMarkerRadius,
	pointMapPanViewportBy,
	pointMapPickRadiusFraction,
	pointMapResizeCanvasForDisplay,
	pointMapResizeViewportToSize,
	pointMapStabilizeViewport,
	pointMapViewportSizeLimits,
	pointMapWorldWindowSize,
	pointMapZoomViewportAt,
	type PointMapConnection,
	type PointMapPoint,
	type PointMapViewport
} from "./point-map-core.js";

export * from "./point-map-core.js";

export interface PointMapViewState {
	readonly fitSize: number;
	readonly viewport: PointMapViewport;
	readonly worldHeight: number;
	readonly zoomFactor: number;
}

export interface PointMapController {
	readonly focusKey: (key: string) => void;
	readonly resetView: () => void;
	readonly setZoomFactor: (factor: number) => void;
}

function gridStep(size: number): number {
	const raw = Math.max(size, 1) / 8;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const normalized = raw / magnitude;
	const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	return factor * magnitude;
}

function paintGrid(
	context: CanvasRenderingContext2D,
	viewport: PointMapViewport,
	cssWidth: number,
	cssHeight: number
): void {
	const aspect = pointMapCanvasAspect(cssWidth, cssHeight);
	const { width, height } = pointMapWorldWindowSize(viewport, aspect);
	const left = viewport.centerX - width / 2;
	const right = viewport.centerX + width / 2;
	const bottom = viewport.centerY - height / 2;
	const top = viewport.centerY + height / 2;
	const step = gridStep(Math.max(width, height));
	context.beginPath();
	for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
		const cssX = ((x - left) / width) * cssWidth;
		context.moveTo(cssX, 0);
		context.lineTo(cssX, cssHeight);
	}
	for (let y = Math.ceil(bottom / step) * step; y <= top; y += step) {
		const cssY = ((top - y) / height) * cssHeight;
		context.moveTo(0, cssY);
		context.lineTo(cssWidth, cssY);
	}
	context.lineWidth = 1;
	context.strokeStyle = "rgba(151, 187, 186, 0.16)";
	context.stroke();
}

function growProjection(values: Float64Array<ArrayBufferLike>, length: number) {
	if (values.length >= length) return values;
	const next = new Float64Array(Math.max(length, values.length === 0 ? 32 : values.length * 2));
	next.set(values);
	return next as Float64Array<ArrayBufferLike>;
}

/** Reads a prop in a Solid effect solely to register it as a reactive dependency. */
function observePointMapInput(_value: unknown): void {}

function pointMapOpacity(value: number | undefined): number {
	return Math.min(1, Math.max(0, value ?? 1));
}

/**
 * Generic retained Canvas point map. Products adapt their own actor models into `PointMapPoint`;
 * this component owns draw, projection, pan, zoom, fit/reset, hit testing, and keyboard movement.
 */
export function PointMapCanvas(props: {
	readonly ariaDescribedBy?: string | undefined;
	readonly ariaLabel: string;
	readonly class?: string | undefined;
	readonly connections?: ReadonlyArray<PointMapConnection> | undefined;
	readonly onController?: ((controller: PointMapController | undefined) => void) | undefined;
	readonly onSelect: (key: string | undefined) => void;
	readonly onViewChange?: ((state: PointMapViewState) => void) | undefined;
	readonly points: ReadonlyArray<PointMapPoint>;
	/** Changing this resets a user-locked view for a replaced dataset. */
	readonly resetKey?: unknown;
	readonly selectedKey: string | undefined;
	readonly title?: string | undefined;
}) {
	let canvas: HTMLCanvasElement | undefined;
	let cssWidth = 0;
	let cssHeight = 0;
	let viewport: PointMapViewport | undefined;
	let viewLocked = false;
	let projectionX: Float64Array<ArrayBufferLike> = new Float64Array(0);
	let projectionY: Float64Array<ArrayBufferLike> = new Float64Array(0);
	let paintHandle: number | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let pointerDrag:
		| { readonly pointerId: number; startX: number; startY: number; moved: boolean }
		| undefined;
	let lastViewState: PointMapViewState | undefined;

	const currentBounds = () => pointMapBoundsOf(props.points);
	const currentFitSize = () =>
		pointMapFitViewportSize(currentBounds(), pointMapCanvasAspect(cssWidth, cssHeight));
	const reportView = () => {
		if (viewport === undefined || cssWidth <= 0 || cssHeight <= 0) return;
		const fitSize = currentFitSize();
		const state: PointMapViewState = {
			fitSize,
			viewport,
			worldHeight: viewport.size / pointMapCanvasAspect(cssWidth, cssHeight),
			zoomFactor: fitSize / Math.max(viewport.size, 1)
		};
		if (
			lastViewState?.fitSize === state.fitSize &&
			lastViewState.viewport.centerX === state.viewport.centerX &&
			lastViewState.viewport.centerY === state.viewport.centerY &&
			lastViewState.viewport.size === state.viewport.size
		)
			return;
		lastViewState = state;
		props.onViewChange?.(state);
	};
	const prepareProjection = () => {
		const points = props.points;
		const bounds = currentBounds();
		const aspect = pointMapCanvasAspect(cssWidth, cssHeight);
		const fit = pointMapFitViewportSize(bounds, aspect);
		if (!viewLocked) viewport = pointMapStabilizeViewport(viewport, bounds, aspect);
		else if (viewport === undefined)
			viewport = pointMapStabilizeViewport(undefined, bounds, aspect);
		else if (viewport.size > fit) viewport = pointMapResizeViewportToSize(viewport, fit);
		if (viewport === undefined || cssWidth <= 0 || cssHeight <= 0) return;
		projectionX = growProjection(projectionX, points.length);
		projectionY = growProjection(projectionY, points.length);
		const { width, height } = pointMapWorldWindowSize(viewport, aspect);
		const left = viewport.centerX - width / 2;
		const top = viewport.centerY + height / 2;
		for (let index = 0; index < points.length; index += 1) {
			const point = points[index];
			if (point === undefined) continue;
			projectionX[index] = ((point.x - left) / width) * cssWidth;
			projectionY[index] = ((top - point.y) / height) * cssHeight;
		}
		reportView();
	};
	const projectWorldPoint = (x: number, y: number) => {
		if (viewport === undefined) return undefined;
		const { width, height } = pointMapWorldWindowSize(
			viewport,
			pointMapCanvasAspect(cssWidth, cssHeight)
		);
		const left = viewport.centerX - width / 2;
		const top = viewport.centerY + height / 2;
		return { x: ((x - left) / width) * cssWidth, y: ((top - y) / height) * cssHeight };
	};
	const paintConnections = (context: CanvasRenderingContext2D) => {
		for (const connection of props.connections ?? []) {
			const from = projectWorldPoint(connection.fromX, connection.fromY);
			const to = projectWorldPoint(connection.toX, connection.toY);
			if (from === undefined || to === undefined) continue;
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const length = Math.hypot(dx, dy);
			context.beginPath();
			context.setLineDash?.(connection.dashed ? [5, 4] : []);
			context.globalAlpha = pointMapOpacity(connection.opacity);
			context.strokeStyle = connection.color ?? "#73c7d0";
			context.lineWidth = 1.5;
			context.moveTo(from.x, from.y);
			context.lineTo(to.x, to.y);
			if (length >= 8) {
				const angle = Math.atan2(dy, dx);
				const arrowSize = 6;
				context.moveTo(to.x, to.y);
				context.lineTo(
					to.x - arrowSize * Math.cos(angle - Math.PI / 6),
					to.y - arrowSize * Math.sin(angle - Math.PI / 6)
				);
				context.moveTo(to.x, to.y);
				context.lineTo(
					to.x - arrowSize * Math.cos(angle + Math.PI / 6),
					to.y - arrowSize * Math.sin(angle + Math.PI / 6)
				);
			}
			context.stroke();
		}
		context.setLineDash?.([]);
		context.globalAlpha = 1;
	};
	const paint = () => {
		if (canvas === undefined || cssWidth <= 0 || cssHeight <= 0) return;
		const context = pointMapResizeCanvasForDisplay(
			canvas,
			cssWidth,
			cssHeight,
			typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
		);
		if (context === undefined) return;
		prepareProjection();
		context.clearRect(0, 0, cssWidth, cssHeight);
		if (viewport === undefined) return;
		paintGrid(context, viewport, cssWidth, cssHeight);
		paintConnections(context);
		const points = props.points;
		const normalRadius = pointMapMarkerRadius(points.length, cssWidth, cssHeight);
		const selectedRadius = pointMapMarkerRadius(points.length, cssWidth, cssHeight, true);
		const offsetsByStyle = new Map<string, number[]>();
		const selectedOffsets: number[] = [];
		for (let index = 0; index < points.length; index += 1) {
			const point = points[index];
			if (point === undefined) continue;
			if ((point.selectionKey ?? point.key) === props.selectedKey) {
				selectedOffsets.push(index);
				continue;
			}
			const style = `${point.color ?? pointMapColorForClass(point.className)}\u0000${pointMapOpacity(point.opacity)}`;
			const offsets = offsetsByStyle.get(style);
			if (offsets === undefined) offsetsByStyle.set(style, [index]);
			else offsets.push(index);
		}
		for (const [style, offsets] of offsetsByStyle) {
			const [color, opacity] = style.split("\u0000");
			context.beginPath();
			for (const offset of offsets) {
				const x = projectionX[offset] ?? 0;
				const y = projectionY[offset] ?? 0;
				context.moveTo(x + normalRadius, y);
				context.arc(x, y, normalRadius, 0, Math.PI * 2);
			}
			context.globalAlpha = Number(opacity);
			context.fillStyle = color ?? "#b9f227";
			context.fill();
			context.lineWidth = 1;
			context.strokeStyle = "rgba(255, 255, 255, 0.22)";
			context.stroke();
		}
		context.globalAlpha = 1;
		for (const selectedOffset of selectedOffsets) {
			const selected = points[selectedOffset];
			if (selected === undefined) continue;
			context.beginPath();
			context.arc(
				projectionX[selectedOffset] ?? 0,
				projectionY[selectedOffset] ?? 0,
				selectedRadius,
				0,
				Math.PI * 2
			);
			context.globalAlpha = pointMapOpacity(selected.opacity);
			context.fillStyle = selected.color ?? pointMapColorForClass(selected.className);
			context.fill();
			context.lineWidth = 2;
			context.strokeStyle = "#ffffff";
			context.stroke();
		}
		context.globalAlpha = 1;
	};
	const requestPaint = () => {
		if (paintHandle !== undefined) return;
		const schedule =
			typeof requestAnimationFrame === "undefined" ? setTimeout : requestAnimationFrame;
		paintHandle = schedule(() => {
			paintHandle = undefined;
			paint();
		}) as unknown as number;
	};
	const syncCanvasSize = () => {
		if (canvas === undefined) return;
		const rect = canvas.getBoundingClientRect();
		const width = Math.max(1, rect.width);
		const height = Math.max(1, rect.height);
		if (width === cssWidth && height === cssHeight) return;
		cssWidth = width;
		cssHeight = height;
		requestPaint();
	};
	const resetView = () => {
		viewLocked = false;
		viewport = undefined;
		requestPaint();
	};
	const setZoomFactor = (factor: number) => {
		if (viewport === undefined || !Number.isFinite(factor) || factor <= 0) return;
		const fit = currentFitSize();
		const size = pointMapClampViewportSize(fit / factor, fit);
		viewport = pointMapResizeViewportToSize(viewport, size);
		viewLocked = size < fit - 1e-6;
		requestPaint();
	};
	const focusKey = (key: string) => {
		syncCanvasSize();
		const point = props.points.find(
			(candidate) => (candidate.selectionKey ?? candidate.key) === key
		);
		if (point === undefined) return;
		const fit = currentFitSize();
		const actorExtent = Math.max(
			point.extentX ?? 0,
			point.extentY ?? 0,
			pointMapMinViewportSize
		);
		const focusSize = pointMapClampViewportSize(Math.max(fit / 6, actorExtent * 8), fit);
		viewport = { centerX: point.x, centerY: point.y, size: focusSize };
		viewLocked = true;
		reportView();
		requestPaint();
	};
	const selectNearestAt = (cssX: number, cssY: number) => {
		prepareProjection();
		const radius = Math.min(cssWidth, cssHeight) * pointMapPickRadiusFraction;
		let selected: PointMapPoint | undefined;
		let closest = Number.POSITIVE_INFINITY;
		for (let index = 0; index < props.points.length; index += 1) {
			const point = props.points[index];
			if (point === undefined) continue;
			const distance = Math.hypot(
				(projectionX[index] ?? 0) - cssX,
				(projectionY[index] ?? 0) - cssY
			);
			if (distance > radius || distance >= closest) continue;
			closest = distance;
			selected = point;
		}
		if (selected !== undefined) props.onSelect(selected.selectionKey ?? selected.key);
	};
	const selectRelative = (direction: "next" | "previous") => {
		if (props.points.length === 0) return;
		const keys = [...new Set(props.points.map((point) => point.selectionKey ?? point.key))];
		const selectedIndex = keys.findIndex((key) => key === props.selectedKey);
		const index =
			selectedIndex < 0
				? 0
				: direction === "next"
					? (selectedIndex + 1) % keys.length
					: (selectedIndex - 1 + keys.length) % keys.length;
		const key = keys[index];
		if (key !== undefined) props.onSelect(key);
	};
	const onWheel = (event: WheelEvent & { readonly currentTarget: HTMLCanvasElement }) => {
		event.preventDefault();
		syncCanvasSize();
		if (viewport === undefined) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const fit = currentFitSize();
		const { min, max } = pointMapViewportSizeLimits(fit);
		viewport = pointMapZoomViewportAt(
			viewport,
			cssWidth,
			cssHeight,
			event.clientX - rect.left,
			event.clientY - rect.top,
			event.deltaY < 0 ? 1.15 : 1 / 1.15,
			min,
			max
		);
		viewLocked = viewport.size < max - 1e-6;
		requestPaint();
	};
	const onPointerDown = (event: PointerEvent & { readonly currentTarget: HTMLCanvasElement }) => {
		if (event.button !== 0 && event.button !== 1) return;
		syncCanvasSize();
		pointerDrag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			moved: false
		};
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent & { readonly currentTarget: HTMLCanvasElement }) => {
		if (pointerDrag === undefined || pointerDrag.pointerId !== event.pointerId) return;
		const dx = event.clientX - pointerDrag.startX;
		const dy = event.clientY - pointerDrag.startY;
		if (!pointerDrag.moved && Math.hypot(dx, dy) < 4) return;
		if (viewport === undefined) return;
		pointerDrag.moved = true;
		pointerDrag.startX = event.clientX;
		pointerDrag.startY = event.clientY;
		viewport = pointMapPanViewportBy(viewport, cssWidth, cssHeight, dx, dy);
		viewLocked = true;
		requestPaint();
	};
	const onPointerUp = (event: PointerEvent & { readonly currentTarget: HTMLCanvasElement }) => {
		if (pointerDrag === undefined || pointerDrag.pointerId !== event.pointerId) return;
		const drag = pointerDrag;
		pointerDrag = undefined;
		event.currentTarget.releasePointerCapture?.(event.pointerId);
		if (drag.moved || event.button === 1) return;
		const rect = event.currentTarget.getBoundingClientRect();
		selectNearestAt(event.clientX - rect.left, event.clientY - rect.top);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			props.onSelect(undefined);
			return;
		}
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			selectRelative("next");
			return;
		}
		if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			selectRelative("previous");
		}
	};
	const setCanvas = (element: HTMLCanvasElement) => {
		canvas = element;
		syncCanvasSize();
		resizeObserver?.disconnect();
		if (typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(syncCanvasSize);
			resizeObserver.observe(element);
		}
		requestPaint();
	};

	createEffect(() => {
		observePointMapInput(props.resetKey);
		viewport = undefined;
		viewLocked = false;
		lastViewState = undefined;
		requestPaint();
	});
	createEffect(() => {
		observePointMapInput(props.points);
		observePointMapInput(props.connections);
		observePointMapInput(props.selectedKey);
		requestPaint();
	});
	onMount(() => props.onController?.({ focusKey, resetView, setZoomFactor }));
	onCleanup(() => {
		if (paintHandle !== undefined) {
			if (typeof cancelAnimationFrame === "undefined") clearTimeout(paintHandle);
			else cancelAnimationFrame(paintHandle);
		}
		resizeObserver?.disconnect();
		props.onController?.(undefined);
	});

	return (
		<canvas
			ref={setCanvas}
			role="application"
			tabIndex={0}
			aria-label={props.ariaLabel}
			aria-describedby={props.ariaDescribedBy}
			title={props.title ?? "Scroll to zoom, drag to pan, click a point to inspect it"}
			class={props.class}
			onWheel={onWheel}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onKeyDown={onKeyDown}
		/>
	);
}
