import {
	mapTileWorldBounds,
	type MapTileGrid,
	type MapTileKey,
	type MapWorldBounds
} from "@ue-shed/cameras/map-tiles";

export interface MapTileViewport {
	readonly centerX: number;
	readonly centerY: number;
	readonly height: number;
	readonly pixelsPerWorldUnit: number;
	readonly width: number;
}

export interface MapTileScreenRect {
	readonly height: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
}

export interface MapTileScreenPoint {
	readonly left: number;
	readonly top: number;
}

export function mapTileWorldPoint(args: {
	readonly viewport: MapTileViewport;
	readonly left: number;
	readonly top: number;
}) {
	return {
		worldX:
			args.viewport.centerX +
			(args.viewport.height / 2 - args.top) / args.viewport.pixelsPerWorldUnit,
		worldY:
			args.viewport.centerY +
			(args.left - args.viewport.width / 2) / args.viewport.pixelsPerWorldUnit
	};
}

export function fitMapTileActors(args: {
	readonly viewport: MapTileViewport;
	readonly points: readonly { readonly worldX: number; readonly worldY: number }[];
	readonly maximumScale: number;
}): MapTileViewport {
	const points = args.points.filter(
		(point) => Number.isFinite(point.worldX) && Number.isFinite(point.worldY)
	);
	if (points.length === 0) return args.viewport;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const point of points) {
		minX = Math.min(minX, point.worldX);
		maxX = Math.max(maxX, point.worldX);
		minY = Math.min(minY, point.worldY);
		maxY = Math.max(maxY, point.worldY);
	}
	const padding = 32 / args.maximumScale;
	const fitted = fitMapTileViewport({
		bounds: {
			minX: minX - padding,
			maxX: maxX + padding,
			minY: minY - padding,
			maxY: maxY + padding
		},
		height: args.viewport.height,
		width: args.viewport.width
	});
	return {
		...fitted,
		pixelsPerWorldUnit: Math.min(args.maximumScale, fitted.pixelsPerWorldUnit)
	};
}

export function mapTileViewportBounds(viewport: MapTileViewport): MapWorldBounds {
	const halfWorldWidth = viewport.width / viewport.pixelsPerWorldUnit / 2;
	const halfWorldHeight = viewport.height / viewport.pixelsPerWorldUnit / 2;
	return {
		maxX: viewport.centerX + halfWorldHeight,
		maxY: viewport.centerY + halfWorldWidth,
		minX: viewport.centerX - halfWorldHeight,
		minY: viewport.centerY - halfWorldWidth
	};
}

export function mapTileScreenRect(args: {
	readonly grid: MapTileGrid;
	readonly key: MapTileKey;
	readonly viewport: MapTileViewport;
}): MapTileScreenRect {
	const viewportBounds = mapTileViewportBounds(args.viewport);
	const bounds = mapTileWorldBounds(args.grid, args.key);
	return {
		height: (bounds.maxX - bounds.minX) * args.viewport.pixelsPerWorldUnit,
		left: (bounds.minY - viewportBounds.minY) * args.viewport.pixelsPerWorldUnit,
		top: (viewportBounds.maxX - bounds.maxX) * args.viewport.pixelsPerWorldUnit,
		width: (bounds.maxY - bounds.minY) * args.viewport.pixelsPerWorldUnit
	};
}

/** Projects Unreal world X north/up and world Y east/right onto the tile surface. */
export function mapTileScreenPoint(args: {
	readonly viewport: MapTileViewport;
	readonly worldX: number;
	readonly worldY: number;
}): MapTileScreenPoint {
	const viewportBounds = mapTileViewportBounds(args.viewport);
	return {
		left: (args.worldY - viewportBounds.minY) * args.viewport.pixelsPerWorldUnit,
		top: (viewportBounds.maxX - args.worldX) * args.viewport.pixelsPerWorldUnit
	};
}

export function fitMapTileViewport(args: {
	readonly bounds: MapWorldBounds;
	readonly height: number;
	readonly paddingPixels?: number;
	readonly width: number;
}): MapTileViewport {
	const padding = args.paddingPixels ?? 32;
	const usableWidth = Math.max(1, args.width - padding * 2);
	const usableHeight = Math.max(1, args.height - padding * 2);
	return {
		centerX: (args.bounds.minX + args.bounds.maxX) / 2,
		centerY: (args.bounds.minY + args.bounds.maxY) / 2,
		height: args.height,
		pixelsPerWorldUnit: Math.min(
			usableHeight / (args.bounds.maxX - args.bounds.minX),
			usableWidth / (args.bounds.maxY - args.bounds.minY)
		),
		width: args.width
	};
}
