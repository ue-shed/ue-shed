export interface MapWorldBounds {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

export interface MapTileKey {
	readonly zoom: number;
	readonly row: number;
	readonly column: number;
}

export interface MapTileLevel {
	readonly zoom: number;
	readonly unitsPerPixel: number;
	readonly tileWorldSize: number;
	readonly rows: number;
	readonly columns: number;
}

export interface MapTileGrid {
	readonly requestedBounds: MapWorldBounds;
	readonly snappedBounds: MapWorldBounds;
	readonly origin: { readonly x: number; readonly y: number };
	readonly orientation: "rows_max_x_to_min_x_columns_min_y_to_max_y";
	readonly tilePixelSize: number;
	readonly levels: ReadonlyArray<MapTileLevel>;
}

export interface CreateMapTileGridOptions {
	readonly requestedBounds: MapWorldBounds;
	readonly tilePixelSize: number;
	readonly coarsestUnitsPerPixel: number;
	readonly levelCount: number;
}

export interface MapTileSelectionOptions {
	readonly grid: MapTileGrid;
	readonly viewportBounds: MapWorldBounds;
	readonly screenPixelsPerWorldUnit: number;
	readonly currentLevel?: number;
	readonly hysteresisLevels?: number;
	readonly prefetchRing?: number;
	readonly maximumCacheEntries?: number;
}

export interface MapTileSelection {
	readonly level: number;
	readonly visible: ReadonlyArray<MapTileKey>;
	readonly ancestors: ReadonlyArray<MapTileKey>;
	readonly prefetch: ReadonlyArray<MapTileKey>;
	readonly recommendedCacheEntries: number;
}

function requireFinite(value: number, name: string): void {
	if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
}

function requireBounds(bounds: MapWorldBounds, name: string): void {
	requireFinite(bounds.minX, `${name}.minX`);
	requireFinite(bounds.minY, `${name}.minY`);
	requireFinite(bounds.maxX, `${name}.maxX`);
	requireFinite(bounds.maxY, `${name}.maxY`);
	if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
		throw new RangeError(`${name} must have positive X and Y extent.`);
	}
}

function requirePositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer.`);
	}
}

export function createMapTileGrid(options: CreateMapTileGridOptions): MapTileGrid {
	requireBounds(options.requestedBounds, "requestedBounds");
	requirePositiveInteger(options.tilePixelSize, "tilePixelSize");
	requirePositiveInteger(options.levelCount, "levelCount");
	requireFinite(options.coarsestUnitsPerPixel, "coarsestUnitsPerPixel");
	if (options.coarsestUnitsPerPixel <= 0) {
		throw new RangeError("coarsestUnitsPerPixel must be positive.");
	}

	const coarseTileWorldSize = options.tilePixelSize * options.coarsestUnitsPerPixel;
	const origin = {
		x: Math.ceil(options.requestedBounds.maxX / coarseTileWorldSize) * coarseTileWorldSize,
		y: Math.floor(options.requestedBounds.minY / coarseTileWorldSize) * coarseTileWorldSize
	};
	const coarseRows = Math.ceil((origin.x - options.requestedBounds.minX) / coarseTileWorldSize);
	const coarseColumns = Math.ceil(
		(options.requestedBounds.maxY - origin.y) / coarseTileWorldSize
	);
	const snappedBounds = {
		minX: origin.x - coarseRows * coarseTileWorldSize,
		minY: origin.y,
		maxX: origin.x,
		maxY: origin.y + coarseColumns * coarseTileWorldSize
	};
	const levels = Array.from({ length: options.levelCount }, (_, zoom) => {
		const scale = 2 ** zoom;
		const unitsPerPixel = options.coarsestUnitsPerPixel / scale;
		return {
			columns: coarseColumns * scale,
			rows: coarseRows * scale,
			tileWorldSize: options.tilePixelSize * unitsPerPixel,
			unitsPerPixel,
			zoom
		};
	});
	return {
		levels,
		orientation: "rows_max_x_to_min_x_columns_min_y_to_max_y",
		origin,
		requestedBounds: { ...options.requestedBounds },
		snappedBounds,
		tilePixelSize: options.tilePixelSize
	};
}

function levelAt(grid: MapTileGrid, zoom: number): MapTileLevel {
	const level = grid.levels[zoom];
	if (!level || !Number.isInteger(zoom)) throw new RangeError(`Unknown zoom level ${zoom}.`);
	return level;
}

export function mapTileKeyId(key: MapTileKey): string {
	return `${key.zoom}/${key.row}/${key.column}`;
}

export function mapTileRelativePath(key: MapTileKey): string {
	const zoom = String(key.zoom).padStart(2, "0");
	const row = String(key.row).padStart(3, "0");
	const column = String(key.column).padStart(3, "0");
	return `Z${zoom}/R${row}_C${column}.png`;
}

export function assertMapTileKey(grid: MapTileGrid, key: MapTileKey): void {
	const level = levelAt(grid, key.zoom);
	if (
		!Number.isInteger(key.row) ||
		key.row < 0 ||
		key.row >= level.rows ||
		!Number.isInteger(key.column) ||
		key.column < 0 ||
		key.column >= level.columns
	) {
		throw new RangeError(`Tile ${mapTileKeyId(key)} is outside the grid.`);
	}
}

export function mapTileWorldBounds(grid: MapTileGrid, key: MapTileKey): MapWorldBounds {
	assertMapTileKey(grid, key);
	const span = grid.levels[key.zoom]!.tileWorldSize;
	const maxX = grid.snappedBounds.maxX - key.row * span;
	const minY = grid.snappedBounds.minY + key.column * span;
	return { minX: maxX - span, minY, maxX, maxY: minY + span };
}

export function worldToMapTile(
	grid: MapTileGrid,
	zoom: number,
	world: { readonly x: number; readonly y: number }
): MapTileKey | undefined {
	requireFinite(world.x, "world.x");
	requireFinite(world.y, "world.y");
	const level = levelAt(grid, zoom);
	const bounds = grid.snappedBounds;
	if (
		world.x < bounds.minX ||
		world.x > bounds.maxX ||
		world.y < bounds.minY ||
		world.y > bounds.maxY
	) {
		return undefined;
	}
	return {
		column: Math.min(
			level.columns - 1,
			Math.floor((world.y - bounds.minY) / level.tileWorldSize)
		),
		row: Math.min(level.rows - 1, Math.floor((bounds.maxX - world.x) / level.tileWorldSize)),
		zoom
	};
}

export function mapTileParent(key: MapTileKey): MapTileKey | undefined {
	if (key.zoom === 0) return undefined;
	return {
		column: Math.floor(key.column / 2),
		row: Math.floor(key.row / 2),
		zoom: key.zoom - 1
	};
}

export function mapTileChildren(
	key: MapTileKey
): readonly [MapTileKey, MapTileKey, MapTileKey, MapTileKey] {
	const zoom = key.zoom + 1;
	const row = key.row * 2;
	const column = key.column * 2;
	return [
		{ zoom, row, column },
		{ zoom, row, column: column + 1 },
		{ zoom, row: row + 1, column },
		{ zoom, row: row + 1, column: column + 1 }
	];
}

export function chooseMapTileLevel(args: {
	readonly grid: MapTileGrid;
	readonly screenPixelsPerWorldUnit: number;
	readonly currentLevel?: number;
	readonly hysteresisLevels?: number;
}): number {
	requireFinite(args.screenPixelsPerWorldUnit, "screenPixelsPerWorldUnit");
	if (args.screenPixelsPerWorldUnit <= 0) {
		throw new RangeError("screenPixelsPerWorldUnit must be positive.");
	}
	const maximumLevel = args.grid.levels.length - 1;
	const continuousLevel = Math.log2(
		args.screenPixelsPerWorldUnit * args.grid.levels[0]!.unitsPerPixel
	);
	const desired = Math.max(0, Math.min(maximumLevel, Math.round(continuousLevel)));
	if (args.currentLevel === undefined) return desired;
	const current = Math.max(0, Math.min(maximumLevel, args.currentLevel));
	const hysteresis = args.hysteresisLevels ?? 0.15;
	if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= 0.5) {
		throw new RangeError("hysteresisLevels must be in [0, 0.5).");
	}
	if (
		continuousLevel > current + 0.5 + hysteresis ||
		continuousLevel < current - 0.5 - hysteresis
	) {
		return desired;
	}
	return current;
}

export function visibleMapTiles(
	grid: MapTileGrid,
	zoom: number,
	viewportBounds: MapWorldBounds
): ReadonlyArray<MapTileKey> {
	requireBounds(viewportBounds, "viewportBounds");
	const level = levelAt(grid, zoom);
	const bounds = grid.snappedBounds;
	const minX = Math.max(bounds.minX, viewportBounds.minX);
	const minY = Math.max(bounds.minY, viewportBounds.minY);
	const maxX = Math.min(bounds.maxX, viewportBounds.maxX);
	const maxY = Math.min(bounds.maxY, viewportBounds.maxY);
	if (maxX <= minX || maxY <= minY) return [];
	const rowStart = Math.max(0, Math.floor((bounds.maxX - maxX) / level.tileWorldSize));
	const rowEnd = Math.min(
		level.rows - 1,
		Math.ceil((bounds.maxX - minX) / level.tileWorldSize) - 1
	);
	const columnStart = Math.max(0, Math.floor((minY - bounds.minY) / level.tileWorldSize));
	const columnEnd = Math.min(
		level.columns - 1,
		Math.ceil((maxY - bounds.minY) / level.tileWorldSize) - 1
	);
	const result: MapTileKey[] = [];
	for (let row = rowStart; row <= rowEnd; row += 1) {
		for (let column = columnStart; column <= columnEnd; column += 1) {
			result.push({ zoom, row, column });
		}
	}
	return result;
}

function uniqueTiles(tiles: Iterable<MapTileKey>): ReadonlyArray<MapTileKey> {
	return [...new Map([...tiles].map((tile) => [mapTileKeyId(tile), tile])).values()];
}

export function mapTileAncestorChain(key: MapTileKey): ReadonlyArray<MapTileKey> {
	const ancestors: MapTileKey[] = [];
	let current = mapTileParent(key);
	while (current) {
		ancestors.push(current);
		current = mapTileParent(current);
	}
	return ancestors;
}

function prefetchMapTiles(args: {
	readonly grid: MapTileGrid;
	readonly visible: ReadonlyArray<MapTileKey>;
	readonly ring: number;
}): ReadonlyArray<MapTileKey> {
	if (args.visible.length === 0 || args.ring === 0) return [];
	const level = levelAt(args.grid, args.visible[0]!.zoom);
	const rows = args.visible.map((tile) => tile.row);
	const columns = args.visible.map((tile) => tile.column);
	const minRow = Math.max(0, Math.min(...rows) - args.ring);
	const maxRow = Math.min(level.rows - 1, Math.max(...rows) + args.ring);
	const minColumn = Math.max(0, Math.min(...columns) - args.ring);
	const maxColumn = Math.min(level.columns - 1, Math.max(...columns) + args.ring);
	const visibleIds = new Set(args.visible.map(mapTileKeyId));
	const result: MapTileKey[] = [];
	for (let row = minRow; row <= maxRow; row += 1) {
		for (let column = minColumn; column <= maxColumn; column += 1) {
			const tile = { zoom: level.zoom, row, column };
			if (!visibleIds.has(mapTileKeyId(tile))) result.push(tile);
		}
	}
	return result;
}

export function selectMapTiles(options: MapTileSelectionOptions): MapTileSelection {
	const level = chooseMapTileLevel(options);
	const visible = visibleMapTiles(options.grid, level, options.viewportBounds);
	const ancestors = uniqueTiles(visible.flatMap(mapTileAncestorChain));
	const ring = options.prefetchRing ?? 1;
	if (!Number.isInteger(ring) || ring < 0) {
		throw new RangeError("prefetchRing must be a non-negative integer.");
	}
	const prefetch = prefetchMapTiles({ grid: options.grid, ring, visible });
	const maximumCacheEntries = options.maximumCacheEntries ?? 256;
	requirePositiveInteger(maximumCacheEntries, "maximumCacheEntries");
	return {
		ancestors,
		level,
		prefetch,
		recommendedCacheEntries: Math.min(
			maximumCacheEntries,
			Math.max(visible.length + ancestors.length + prefetch.length, visible.length)
		),
		visible
	};
}

export function resolveAvailableMapTiles(args: {
	readonly desired: ReadonlyArray<MapTileKey>;
	readonly available: ReadonlySet<string>;
}): {
	readonly render: ReadonlyArray<MapTileKey>;
	readonly missing: ReadonlyArray<MapTileKey>;
} {
	const render: MapTileKey[] = [];
	const missing: MapTileKey[] = [];
	for (const desired of args.desired) {
		const candidates = [desired, ...mapTileAncestorChain(desired)];
		const selected = candidates.find((candidate) =>
			args.available.has(mapTileKeyId(candidate))
		);
		if (selected) render.push(selected);
		else missing.push(desired);
	}
	return { missing, render: uniqueTiles(render) };
}
