/**
 * Planar Unreal world bounds with min/max X and Y. Grid construction requires finite positive
 * spans; Z/capture height is configured separately.
 */
export interface MapWorldBounds {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

/**
 * Zero-based zoom, row and column addressing a tile. Zoom zero is coarsest; rows run from
 * maximum X downward and columns from minimum Y upward.
 */
export interface MapTileKey {
	readonly zoom: number;
	readonly row: number;
	readonly column: number;
}

/**
 * One pyramid level's zoom, world-units-per-pixel, tile world size and grid dimensions. Each
 * finer level doubles rows/columns while halving world-units-per-pixel.
 */
export interface MapTileLevel {
	readonly zoom: number;
	readonly unitsPerPixel: number;
	readonly tileWorldSize: number;
	readonly rows: number;
	readonly columns: number;
}

/**
 * Requested/snapped planar bounds, fixed orientation, pixel tile size and pyramid levels.
 * Snapped bounds can exceed the requested area to maintain regular parent/child alignment.
 */
export interface MapTileGrid {
	readonly requestedBounds: MapWorldBounds;
	readonly snappedBounds: MapWorldBounds;
	readonly origin: { readonly x: number; readonly y: number };
	readonly orientation: "rows_max_x_to_min_x_columns_min_y_to_max_y";
	readonly tilePixelSize: number;
	readonly levels: ReadonlyArray<MapTileLevel>;
}

/**
 * Explicit planar bounds, positive pixel tile size, coarsest world-units-per-pixel and level
 * count. Grid construction validates numeric ranges before calculating coverage.
 */
export interface CreateMapTileGridOptions {
	readonly requestedBounds: MapWorldBounds;
	readonly tilePixelSize: number;
	readonly coarsestUnitsPerPixel: number;
	readonly levelCount: number;
}

/**
 * Viewport/world scale and optional hysteresis, prefetch and cache policy for one grid.
 * Screen scale is pixels per world unit, the inverse of a level's unitsPerPixel.
 */
export interface MapTileSelectionOptions {
	readonly grid: MapTileGrid;
	readonly viewportBounds: MapWorldBounds;
	readonly screenPixelsPerWorldUnit: number;
	readonly currentLevel?: number;
	readonly hysteresisLevels?: number;
	readonly prefetchRing?: number;
	readonly maximumCacheEntries?: number;
}

/**
 * Chosen level, visible tiles, fallback ancestors and prefetch candidates with a bounded
 * cache recommendation. This is a pure plan; it does not fetch images.
 */
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

function tileCountForSpan(span: number, tileWorldSize: number): number {
	const quotient = span / tileWorldSize;
	const nearestInteger = Math.round(quotient);
	const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8;
	return Math.abs(quotient - nearestInteger) <= tolerance ? nearestInteger : Math.ceil(quotient);
}

/**
 * Builds a centered snapped pyramid with a consistent Unreal XY orientation. Throws
 * RangeError for invalid bounds/dimensions/scale rather than producing an unusable grid.
 */
export function createMapTileGrid(options: CreateMapTileGridOptions): MapTileGrid {
	requireBounds(options.requestedBounds, "requestedBounds");
	requirePositiveInteger(options.tilePixelSize, "tilePixelSize");
	requirePositiveInteger(options.levelCount, "levelCount");
	requireFinite(options.coarsestUnitsPerPixel, "coarsestUnitsPerPixel");
	if (options.coarsestUnitsPerPixel <= 0) {
		throw new RangeError("coarsestUnitsPerPixel must be positive.");
	}

	const coarseTileWorldSize = options.tilePixelSize * options.coarsestUnitsPerPixel;
	const coarseRows = tileCountForSpan(
		options.requestedBounds.maxX - options.requestedBounds.minX,
		coarseTileWorldSize
	);
	const coarseColumns = tileCountForSpan(
		options.requestedBounds.maxY - options.requestedBounds.minY,
		coarseTileWorldSize
	);
	const center = {
		x: (options.requestedBounds.minX + options.requestedBounds.maxX) / 2,
		y: (options.requestedBounds.minY + options.requestedBounds.maxY) / 2
	};
	const snappedBounds = {
		minX: center.x - (coarseRows * coarseTileWorldSize) / 2,
		minY: center.y - (coarseColumns * coarseTileWorldSize) / 2,
		maxX: center.x + (coarseRows * coarseTileWorldSize) / 2,
		maxY: center.y + (coarseColumns * coarseTileWorldSize) / 2
	};
	const origin = {
		x: snappedBounds.maxX,
		y: snappedBounds.minY
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

/**
 * Formats a tile's stable zoom/row/column lookup key. This pure formatter assumes a valid
 * key; use assertMapTileKey when accepting untrusted coordinates.
 */
export function mapTileKeyId(key: MapTileKey): string {
	return `${key.zoom}/${key.row}/${key.column}`;
}

/**
 * Formats a tile PNG path as Z{zoom}/R{row}_C{column} with minimum numeric padding. Does not
 * access storage or validate that the key is inside a grid.
 */
export function mapTileRelativePath(key: MapTileKey): string {
	const zoom = String(key.zoom).padStart(2, "0");
	const row = String(key.row).padStart(3, "0");
	const column = String(key.column).padStart(3, "0");
	return `Z${zoom}/R${row}_C${column}.png`;
}

/**
 * Throws RangeError unless the zoom/row/column belongs to the supplied grid. Use before
 * accessing level-dependent tile bounds.
 */
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

/**
 * Returns a validated tile's planar world footprint using the grid's fixed row/column
 * orientation. Throws for an out-of-grid key; Z is not part of this footprint.
 */
export function mapTileWorldBounds(grid: MapTileGrid, key: MapTileKey): MapWorldBounds {
	assertMapTileKey(grid, key);
	const span = grid.levels[key.zoom]!.tileWorldSize;
	const maxX = grid.snappedBounds.maxX - key.row * span;
	const minY = grid.snappedBounds.minY + key.column * span;
	return { minX: maxX - span, minY, maxX, maxY: minY + span };
}

/**
 * Maps a finite world XY point to a tile at an existing level, or undefined outside snapped
 * bounds. Includes outer grid edges by clamping the final row/column index.
 */
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

/**
 * Returns the coarser parent by halving row/column, or undefined at zoom zero. This pure
 * addressing helper does not prove the input belongs to a particular grid.
 */
export function mapTileParent(key: MapTileKey): MapTileKey | undefined {
	if (key.zoom === 0) return undefined;
	return {
		column: Math.floor(key.column / 2),
		row: Math.floor(key.row / 2),
		zoom: key.zoom - 1
	};
}

/**
 * Returns four next-level children in row-major order. Callers must check the grid's finest
 * level before requesting children beyond its coverage.
 */
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

/**
 * Selects the nearest supported level for screen pixels per world unit, optionally retaining
 * the current level within a hysteresis band. Throws on non-positive scale or invalid
 * hysteresis.
 */
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

/**
 * Returns tiles intersecting the viewport at one grid level. Clips to snapped bounds, returns
 * empty for no overlap and validates the viewport before enumeration.
 */
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

/**
 * Returns successive parents from nearest to zoom zero. This is used for image fallback while
 * finer tiles load; it does not fetch or validate availability.
 */
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

/**
 * Computes visible, ancestor and bounded prefetch/cache recommendations from explicit
 * viewport policy. Throws for invalid scale/ring/cache inputs and performs no image IO.
 */
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

/**
 * Chooses each desired tile or its nearest available ancestor by lookup key. Returns missing
 * desired tiles explicitly and deduplicates fallback render tiles.
 */
export function resolveAvailableMapTiles(args: {
	readonly desired: ReadonlyArray<MapTileKey>;
	readonly available: ReadonlySet<string>;
}) {
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
