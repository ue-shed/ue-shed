const classColors = ["#8b5cf6", "#02b8cc", "#f2994a", "#4cb782", "#eb5757", "#6366f1"];
const defaultPaddingRatio = 0.08;
const viewportExpandSlack = 0.04;
const viewportShrinkFraction = 0.72;
const viewportCenterDriftFraction = 0.18;

/** Max pick distance as a fraction of the canvas CSS size (~6% of the map). */
export const pointMapPickRadiusFraction = 0.06;
/** Smallest allowed world-window width when zooming in on a large map. */
export const pointMapMinViewportSize = 50;

export interface PointMapBounds {
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
}

export interface PointMapViewport {
	readonly centerX: number;
	readonly centerY: number;
	/** World-space width of the visible window. Height is `size / canvasAspect`. */
	readonly size: number;
}

/** A resolved, top-down point owned by a product-specific adapter. */
export interface PointMapPoint {
	readonly className: string;
	/** Optional semantic override, such as a changelist addition or removal. */
	readonly color?: string;
	readonly key: string;
	/** Opacity from 0 to 1; useful for historical ghost markers. */
	readonly opacity?: number;
	/** Selection identity may group multiple rendered markers for one domain object. */
	readonly selectionKey?: string;
	readonly x: number;
	readonly y: number;
	readonly extentX?: number;
	readonly extentY?: number;
}

/** A product-neutral directed world-space relation, rendered beneath point markers. */
export interface PointMapConnection {
	readonly color?: string;
	readonly dashed?: boolean;
	readonly fromX: number;
	readonly fromY: number;
	readonly key: string;
	readonly opacity?: number;
	readonly toX: number;
	readonly toY: number;
}

/** World-window width that fits `bounds` at the given canvas aspect (width/height). */
export function pointMapFitViewportSize(
	bounds: PointMapBounds | undefined,
	aspect = 1,
	paddingRatio = defaultPaddingRatio
): number {
	if (bounds === undefined) return 1;
	const rawWidth = Math.max(1, bounds.maxX - bounds.minX);
	const rawHeight = Math.max(1, bounds.maxY - bounds.minY);
	const contentW = rawWidth * (1 + paddingRatio * 2);
	const contentH = rawHeight * (1 + paddingRatio * 2);
	return Math.max(1, Math.max(contentW, contentH * Math.max(aspect, 1e-9)));
}

/** Zoom-in floor and fit-all ceiling for the world-window width. */
export function pointMapViewportSizeLimits(fitSize: number, absoluteMin = pointMapMinViewportSize) {
	const max = Math.max(fitSize, 1);
	return { min: Math.min(absoluteMin, max), max };
}

export function pointMapClampViewportSize(
	size: number,
	fitSize: number,
	absoluteMin = pointMapMinViewportSize
): number {
	const { min, max } = pointMapViewportSizeLimits(fitSize, absoluteMin);
	return Math.min(max, Math.max(min, size));
}

export function pointMapColorForClass(className: string): string {
	let hash = 0;
	for (const character of className) hash = (hash * 31 + character.charCodeAt(0)) | 0;
	return classColors[Math.abs(hash) % classColors.length] ?? "#8b5cf6";
}

/**
 * Marker radius in CSS pixels so a dense full-world fit still reads as a lattice instead of noise.
 * Spacing is estimated from canvas size and visible count; radius tracks a fraction of that spacing.
 */
export function pointMapMarkerRadius(
	visibleCount: number,
	cssWidth: number,
	cssHeight: number,
	selected = false
): number {
	const count = Math.max(1, visibleCount);
	const span = Math.max(1, Math.min(cssWidth, cssHeight));
	const spacing = span / Math.sqrt(count);
	const base = Math.min(8, Math.max(3.5, spacing * 0.38));
	return selected ? Math.min(10, base + 2.25) : base;
}

/** Zoom a viewport around a CSS-pixel anchor. `factor` > 1 zooms in. */
export function pointMapZoomViewportAt(
	viewport: PointMapViewport,
	cssWidth: number,
	cssHeight: number,
	cssX: number,
	cssY: number,
	factor: number,
	minSize = pointMapMinViewportSize,
	maxSize = Number.POSITIVE_INFINITY
): PointMapViewport {
	const clamped = Math.min(8, Math.max(0.125, factor));
	const nextSize = Math.min(maxSize, Math.max(minSize, viewport.size / clamped));
	const aspect = pointMapCanvasAspect(cssWidth, cssHeight);
	const worldWidth = Math.max(viewport.size, 1);
	const worldHeight = worldWidth / aspect;
	const width = Math.max(cssWidth, 1);
	const height = Math.max(cssHeight, 1);
	const nx = cssX / width;
	const ny = cssY / height;
	const worldX = viewport.centerX - worldWidth / 2 + nx * worldWidth;
	const worldY = viewport.centerY + worldHeight / 2 - ny * worldHeight;
	return {
		centerX: worldX - (nx - 0.5) * nextSize,
		centerY: worldY + (ny - 0.5) * (nextSize / aspect),
		size: nextSize
	};
}

/** Resize the world window around the current center. */
export function pointMapResizeViewportToSize(
	viewport: PointMapViewport,
	nextSize: number
): PointMapViewport {
	return { centerX: viewport.centerX, centerY: viewport.centerY, size: Math.max(nextSize, 1) };
}

/** Pan a viewport by a CSS-pixel drag delta (positive dx moves content right). */
export function pointMapPanViewportBy(
	viewport: PointMapViewport,
	cssWidth: number,
	cssHeight: number,
	cssDeltaX: number,
	cssDeltaY: number
): PointMapViewport {
	const worldPerPixel = Math.max(viewport.size, 1) / Math.max(cssWidth, 1);
	return {
		centerX: viewport.centerX - cssDeltaX * worldPerPixel,
		centerY: viewport.centerY + cssDeltaY * worldPerPixel,
		size: viewport.size
	};
}

/** Canvas width / height. Used so the world window matches the map frame without squashing. */
export function pointMapCanvasAspect(cssWidth: number, cssHeight: number): number {
	return Math.max(cssWidth, 1) / Math.max(cssHeight, 1);
}

/** World-space width/height of the viewport window for a canvas aspect ratio. */
export function pointMapWorldWindowSize(viewport: PointMapViewport, aspect: number) {
	const width = Math.max(viewport.size, 1);
	return { width, height: width / Math.max(aspect, 1e-9) };
}

export function pointMapBoundsOf(points: ReadonlyArray<PointMapPoint>): PointMapBounds | undefined {
	if (points.length === 0) return undefined;
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
		const extentX = Math.max(0, point.extentX ?? 0);
		const extentY = Math.max(0, point.extentY ?? 0);
		minX = Math.min(minX, point.x - extentX);
		maxX = Math.max(maxX, point.x + extentX);
		minY = Math.min(minY, point.y - extentY);
		maxY = Math.max(maxY, point.y + extentY);
	}
	if (!Number.isFinite(minX)) return undefined;
	return { maxX, maxY, minX, minY };
}

/**
 * Stable top-down viewport with hysteresis so ordinary updates do not make markers pulse.
 * It expands promptly, only shrinks when content is well inside, and recenters after real drift.
 */
export function pointMapStabilizeViewport(
	previous: PointMapViewport | undefined,
	bounds: PointMapBounds | undefined,
	aspect = 1,
	paddingRatio = defaultPaddingRatio
): PointMapViewport {
	if (bounds === undefined) return previous ?? { centerX: 0, centerY: 0, size: 1 };
	const proposedSize = pointMapFitViewportSize(bounds, aspect, paddingRatio);
	const proposedCenterX = (bounds.minX + bounds.maxX) / 2;
	const proposedCenterY = (bounds.minY + bounds.maxY) / 2;
	if (previous === undefined) {
		return { centerX: proposedCenterX, centerY: proposedCenterY, size: proposedSize };
	}
	let size = previous.size;
	if (proposedSize > previous.size * (1 + viewportExpandSlack)) size = proposedSize;
	else if (proposedSize < previous.size * viewportShrinkFraction) size = proposedSize;
	let centerX = previous.centerX;
	let centerY = previous.centerY;
	const driftLimit = size * viewportCenterDriftFraction;
	if (Math.abs(proposedCenterX - previous.centerX) > driftLimit) centerX = proposedCenterX;
	if (Math.abs(proposedCenterY - previous.centerY) > driftLimit) centerY = proposedCenterY;
	return { centerX, centerY, size };
}

export function pointMapResizeCanvasForDisplay(
	canvas: HTMLCanvasElement,
	cssWidth: number,
	cssHeight: number,
	devicePixelRatio: number
): CanvasRenderingContext2D | undefined {
	const dpr = Math.max(1, devicePixelRatio);
	const width = Math.max(1, Math.round(cssWidth * dpr));
	const height = Math.max(1, Math.round(cssHeight * dpr));
	if (canvas.width !== width) canvas.width = width;
	if (canvas.height !== height) canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) return undefined;
	context.setTransform(dpr, 0, 0, dpr, 0, 0);
	return context;
}
