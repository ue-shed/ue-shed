import { ErrorGuidanceFields } from "@ue-shed/protocol";
import { Result, Schema } from "effect";
import { AbsoluteCamera, CameraOutputSize } from "./camera-render-schema.js";
import {
	createMapTileGrid,
	mapTileWorldBounds,
	type MapTileGrid,
	type MapWorldBounds
} from "./map-tile-pyramid.js";
import { MapCapturePlan, MapTileKeySchema, MapTilePyramidLevel } from "./map-tile-schema.js";

const Count = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 }));
const Grid = Schema.Struct({
	requestedBounds: MapCapturePlan.fields.requestedBounds,
	snappedBounds: MapCapturePlan.fields.requestedBounds,
	origin: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
	orientation: Schema.Literal("rows_max_x_to_min_x_columns_min_y_to_max_y"),
	tilePixelSize: MapCapturePlan.fields.tilePixelSize,
	levels: Schema.Array(MapTilePyramidLevel).check(Schema.isMinLength(1), Schema.isMaxLength(24))
});

/**
 * Source-image policy capped at 16,384 pixels per dimension and one GiB decoded RGBA8 bytes.
 * The byte budget excludes GPU resources, codecs and cropped outputs.
 */
export const MapTileSourceLimits = Schema.Struct({
	maximumDimension: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 16384 })),
	/** One decoded RGBA8 source, excluding GPU resources, codecs and output crops. */
	maximumDecodedBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 30 }))
});
export type MapTileSourceLimits = typeof MapTileSourceLimits.Type;

/**
 * Rectangular row/column tile block starting at an explicit key. Source layout uses this
 * block to capture and crop multiple logical tiles together.
 */
export const MapTileSourceBlock = Schema.Struct({
	firstTile: MapTileKeySchema,
	rows: Count,
	columns: Count
});
export type MapTileSourceBlock = typeof MapTileSourceBlock.Type;

/**
 * Capture height, gutter pixels and source decode limits for batched map imagery. These are
 * host-configurable resource/render policies.
 */
export const MapTileSourceSettings = Schema.Struct({
	captureZ: MapCapturePlan.fields.capture.fields.z,
	gutterPixels: MapCapturePlan.fields.gutterPixels,
	limits: MapTileSourceLimits
});
export type MapTileSourceSettings = typeof MapTileSourceSettings.Type;

/**
 * Source settings with an explicit zoom and tiles-per-source-side. Layout covers only that
 * selected level rather than eagerly allocating the whole pyramid.
 */
export const MapTileSourceLayoutOptions = MapTileSourceSettings.mapFields((fields) => ({
	...fields,
	zoom: MapTileKeySchema.fields.zoom,
	tilesPerSourceSide: Count
}));
export type MapTileSourceLayoutOptions = typeof MapTileSourceLayoutOptions.Type;

/**
 * Non-negative pixel origin and positive bounded width/height for one crop. Coordinates
 * address the decoded source image, not world XY space.
 */
export const MapTilePixelRect = Schema.Struct({
	left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	top: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
	height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 }))
});
export type MapTilePixelRect = typeof MapTilePixelRect.Type;

/**
 * Logical tile key, source pixel crop and world footprint. Retains the mapping needed to
 * verify that one large capture produces the intended tiles.
 */
export const MapTileSourceCrop = Schema.Struct({
	key: MapTileKeySchema,
	rect: MapTilePixelRect,
	worldBounds: MapCapturePlan.fields.requestedBounds
});
export type MapTileSourceCrop = typeof MapTileSourceCrop.Type;

/**
 * One absolute-camera source image with pixel size, decoded-byte budget and logical tile
 * crops. Its camera footprint includes outer gutters beyond the logical worldBounds.
 */
export const MapTileSource = Schema.Struct({
	block: MapTileSourceBlock,
	camera: AbsoluteCamera,
	size: CameraOutputSize,
	decodedBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 30 })),
	/** Logical tile coverage. The camera footprint also includes the outer gutter. */
	worldBounds: MapCapturePlan.fields.requestedBounds,
	crops: Schema.Array(MapTileSourceCrop)
});
export type MapTileSource = typeof MapTileSource.Type;

/**
 * Lazy row-major sources for an explicitly selected zoom, with total source/tile counts.
 * Iterating the sources plans captures; it does not itself allocate decoded image buffers.
 */
export interface MapTileSourceLayout {
	readonly sourceCount: number;
	readonly tileCount: number;
	/** Lazy, row-major source descriptors for this explicitly selected zoom only. */
	readonly sources: Iterable<MapTileSource>;
}

/**
 * Invalid grid/source or exceeded source-image budget. Correct bounds, dimensions or resource
 * policy before attempting the capture again.
 */
export class MapTileSourceError extends Schema.TaggedError<MapTileSourceError>()(
	"MapTileSourceError",
	{
		code: Schema.Literals(["invalid_grid", "invalid_source", "source_limit_exceeded"]),
		cause: Schema.optionalKey(Schema.Defect()),
		...ErrorGuidanceFields
	}
) {}

const decodeGrid = Schema.decodeUnknownResult(Grid, { onExcessProperty: "error" });
const decodeSettings = Schema.decodeUnknownResult(MapTileSourceSettings, {
	onExcessProperty: "error"
});
const decodeLayout = Schema.decodeUnknownResult(MapTileSourceLayoutOptions, {
	onExcessProperty: "error"
});
const decodeBlock = Schema.decodeUnknownResult(MapTileSourceBlock, { onExcessProperty: "error" });

function failure(code: MapTileSourceError["code"], message: string, cause?: unknown) {
	return Result.fail(
		new MapTileSourceError({
			...(cause === undefined ? undefined : { cause }),
			code,
			message,
			nextStep: "fix_input",
			retrySafe: true,
			recovery:
				"Use a canonical map grid, an in-bounds source block and explicit dimension/memory limits; reduce the block size when necessary."
		})
	);
}

function sameBounds(first: MapWorldBounds, second: MapWorldBounds): boolean {
	return (
		first.minX === second.minX &&
		first.minY === second.minY &&
		first.maxX === second.maxX &&
		first.maxY === second.maxY
	);
}

function validateGrid(input: MapTileGrid): Result.Result<MapTileGrid, MapTileSourceError> {
	const decoded = decodeGrid(input);
	if (Result.isFailure(decoded))
		return failure("invalid_grid", "The map tile grid is invalid.", decoded.failure);
	const grid = decoded.success;
	const expected = createMapTileGrid({
		requestedBounds: grid.requestedBounds,
		tilePixelSize: grid.tilePixelSize,
		coarsestUnitsPerPixel: grid.levels[0]!.unitsPerPixel,
		levelCount: grid.levels.length
	});
	if (
		!sameBounds(grid.snappedBounds, expected.snappedBounds) ||
		grid.origin.x !== expected.origin.x ||
		grid.origin.y !== expected.origin.y ||
		grid.levels.some((level, index) => {
			const canonical = expected.levels[index]!;
			return (
				level.zoom !== canonical.zoom ||
				level.rows !== canonical.rows ||
				level.columns !== canonical.columns ||
				level.tileWorldSize !== canonical.tileWorldSize ||
				level.unitsPerPixel !== canonical.unitsPerPixel ||
				!Number.isSafeInteger(level.rows) ||
				!Number.isSafeInteger(level.columns)
			);
		})
	)
		return failure(
			"invalid_grid",
			"The grid must match createMapTileGrid's bounds, origin and levels."
		);
	return Result.succeed(expected);
}

function sourceSize(grid: MapTileGrid, block: MapTileSourceBlock, settings: MapTileSourceSettings) {
	const size = {
		width: block.columns * grid.tilePixelSize + 2 * settings.gutterPixels,
		height: block.rows * grid.tilePixelSize + 2 * settings.gutterPixels
	};
	return { ...size, decodedBytes: size.width * size.height * 4 };
}

function validateBlock(
	grid: MapTileGrid,
	block: MapTileSourceBlock,
	settings: MapTileSourceSettings
): Result.Result<void, MapTileSourceError> {
	const level = grid.levels[block.firstTile.zoom];
	if (
		!level ||
		block.firstTile.row + block.rows > level.rows ||
		block.firstTile.column + block.columns > level.columns
	) {
		return failure(
			"invalid_source",
			"The source block extends beyond its selected grid level."
		);
	}
	const size = sourceSize(grid, block, settings);
	if (
		size.width > settings.limits.maximumDimension ||
		size.height > settings.limits.maximumDimension ||
		size.decodedBytes > settings.limits.maximumDecodedBytes
	) {
		return failure(
			"source_limit_exceeded",
			`Source ${size.width}x${size.height} requires ${size.decodedBytes} decoded RGBA8 bytes and exceeds the declared limits.`
		);
	}
	if (
		!Number.isFinite(size.width * level.unitsPerPixel) ||
		size.width * level.unitsPerPixel > 1e9
	) {
		return failure(
			"invalid_source",
			"The source's orthographic width exceeds the camera-render contract."
		);
	}
	return Result.succeed(undefined);
}

function buildSource(
	grid: MapTileGrid,
	block: MapTileSourceBlock,
	settings: MapTileSourceSettings
): MapTileSource {
	const first = mapTileWorldBounds(grid, block.firstTile);
	const last = mapTileWorldBounds(grid, {
		zoom: block.firstTile.zoom,
		row: block.firstTile.row + block.rows - 1,
		column: block.firstTile.column + block.columns - 1
	});
	const worldBounds = { minX: last.minX, minY: first.minY, maxX: first.maxX, maxY: last.maxY };
	const { decodedBytes, ...size } = sourceSize(grid, block, settings);
	const crops: MapTileSourceCrop[] = [];
	for (let row = 0; row < block.rows; row++)
		for (let column = 0; column < block.columns; column++) {
			const key = {
				zoom: block.firstTile.zoom,
				row: block.firstTile.row + row,
				column: block.firstTile.column + column
			};
			crops.push({
				key,
				rect: {
					left: settings.gutterPixels + column * grid.tilePixelSize,
					top: settings.gutterPixels + row * grid.tilePixelSize,
					width: grid.tilePixelSize,
					height: grid.tilePixelSize
				},
				worldBounds: mapTileWorldBounds(grid, key)
			});
		}
	return {
		block,
		size,
		decodedBytes,
		worldBounds,
		crops,
		camera: {
			location: {
				x: (worldBounds.minX + worldBounds.maxX) / 2,
				y: (worldBounds.minY + worldBounds.maxY) / 2,
				z: settings.captureZ
			},
			rotation: { pitch: -90, yaw: 0, roll: 0 },
			projection: {
				kind: "orthographic",
				width: size.width * grid.levels[block.firstTile.zoom]!.unitsPerPixel
			}
		}
	};
}

/** Plan one explicit rectangular block, including ragged grid edges and only an outer gutter. */
export function createMapTileSource(args: {
	readonly grid: MapTileGrid;
	readonly block: MapTileSourceBlock;
	readonly settings: MapTileSourceSettings;
}): Result.Result<MapTileSource, MapTileSourceError> {
	const grid = validateGrid(args.grid);
	if (Result.isFailure(grid)) return Result.fail(grid.failure);
	const block = decodeBlock(args.block),
		settings = decodeSettings(args.settings);
	if (Result.isFailure(block))
		return failure(
			"invalid_source",
			"The map tile source definition is invalid.",
			block.failure
		);
	if (Result.isFailure(settings))
		return failure(
			"invalid_source",
			"The map tile source definition is invalid.",
			settings.failure
		);
	const ready = validateBlock(grid.success, block.success, settings.success);
	if (Result.isFailure(ready)) return Result.fail(ready.failure);
	return Result.succeed(buildSource(grid.success, block.success, settings.success));
}

/** Plan one caller-selected zoom. A side of one preserves individually rendered tiles. */
export function planMapTileSources(args: {
	readonly grid: MapTileGrid;
	readonly options: MapTileSourceLayoutOptions;
}): Result.Result<MapTileSourceLayout, MapTileSourceError> {
	const grid = validateGrid(args.grid);
	if (Result.isFailure(grid)) return Result.fail(grid.failure);
	const decoded = decodeLayout(args.options);
	if (Result.isFailure(decoded))
		return failure(
			"invalid_source",
			"The map tile source definition is invalid.",
			decoded.failure
		);
	const options = { ...decoded.success, limits: { ...decoded.success.limits } };
	const level = grid.success.levels[options.zoom];
	if (!level) return failure("invalid_source", "The selected zoom does not exist in this grid.");
	const tileCount = level.rows * level.columns;
	const sourceCount =
		Math.ceil(level.rows / options.tilesPerSourceSide) *
		Math.ceil(level.columns / options.tilesPerSourceSide);
	if (!Number.isSafeInteger(tileCount) || !Number.isSafeInteger(sourceCount)) {
		return failure(
			"invalid_grid",
			"The selected level's source/tile count exceeds safe integer arithmetic."
		);
	}
	const maximum = {
		firstTile: { zoom: options.zoom, row: 0, column: 0 },
		rows: Math.min(level.rows, options.tilesPerSourceSide),
		columns: Math.min(level.columns, options.tilesPerSourceSide)
	};
	const ready = validateBlock(grid.success, maximum, options);
	if (Result.isFailure(ready)) return Result.fail(ready.failure);
	const canonical = grid.success;
	return Result.succeed({
		sourceCount,
		tileCount,
		sources: {
			*[Symbol.iterator]() {
				for (let row = 0; row < level.rows; row += options.tilesPerSourceSide) {
					for (
						let column = 0;
						column < level.columns;
						column += options.tilesPerSourceSide
					) {
						yield buildSource(
							canonical,
							{
								firstTile: { zoom: options.zoom, row, column },
								rows: Math.min(options.tilesPerSourceSide, level.rows - row),
								columns: Math.min(
									options.tilesPerSourceSide,
									level.columns - column
								)
							},
							options
						);
					}
				}
			}
		}
	});
}
