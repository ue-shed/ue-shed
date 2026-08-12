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
