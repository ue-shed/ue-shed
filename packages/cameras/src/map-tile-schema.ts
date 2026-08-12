import { Schema } from "effect";
import { createMapTileGrid, mapTileKeyId, mapTileRelativePath } from "./map-tile-pyramid.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const SafeIdentifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const IsoTimestamp = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
);

export const MapCapturePlanId = SafeIdentifier.pipe(Schema.brand("MapCapturePlanId"));
export type MapCapturePlanId = typeof MapCapturePlanId.Type;

export const MapCaptureRunId = SafeIdentifier.pipe(Schema.brand("MapCaptureRunId"));
export type MapCaptureRunId = typeof MapCaptureRunId.Type;

export const MapCaptureOperationId = SafeIdentifier.pipe(Schema.brand("MapCaptureOperationId"));
export type MapCaptureOperationId = typeof MapCaptureOperationId.Type;

export const MapCaptureContractVersion = Schema.Struct({
	major: Schema.Literal(1),
	minor: Schema.Literal(0)
});

export const MapCaptureWorldBounds = Schema.Struct({
	minX: Schema.Finite,
	minY: Schema.Finite,
	maxX: Schema.Finite,
	maxY: Schema.Finite
}).pipe(
	Schema.check(
		Schema.makeFilter((bounds) =>
			bounds.maxX > bounds.minX && bounds.maxY > bounds.minY
				? undefined
				: { issue: "World bounds must have positive X and Y extent.", path: [] }
		)
	)
);
export type MapCaptureWorldBounds = typeof MapCaptureWorldBounds.Type;

export const MapCaptureProject = Schema.Struct({
	id: SafeIdentifier,
	mapPath: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/))
});
export type MapCaptureProject = typeof MapCaptureProject.Type;

export const MapCaptureDataLayerPolicy = Schema.Union([
	Schema.Struct({ mode: Schema.Literal("unchanged") }),
	Schema.Struct({
		mode: Schema.Literal("explicit"),
		states: Schema.Array(
			Schema.Struct({
				name: NonEmptyString,
				state: Schema.Literals(["unloaded", "loaded", "activated"])
			})
		).check(Schema.isMaxLength(64))
	})
]);

export const MapCaptureRenderPolicy = Schema.Struct({
	lodPolicy: Schema.Literals(["natural", "fixed_lod_zero"]),
	profile: Schema.Literals(["full_fidelity", "observation"])
});

export const MapCapturePlan = Schema.Struct({
	capture: Schema.Struct({
		dataLayers: MapCaptureDataLayerPolicy,
		orientation: Schema.Struct({
			pitch: Schema.Literal(-90),
			roll: Schema.Literal(0),
			yaw: Schema.Finite
		}),
		render: MapCaptureRenderPolicy,
		z: Schema.Finite
	}),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-map-capture-plan"),
		version: MapCaptureContractVersion
	}),
	gutterPixels: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 })),
	id: MapCapturePlanId,
	levels: Schema.Struct({
		coarsestUnitsPerPixel: PositiveFinite,
		count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 }))
	}),
	output: Schema.Struct({
		imageFormat: Schema.Literal("png"),
		publication: Schema.Literal("local_immutable")
	}),
	project: MapCaptureProject,
	requestedBounds: MapCaptureWorldBounds,
	tilePixelSize: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4_096 }))
});
export type MapCapturePlan = typeof MapCapturePlan.Type;

export const MapTileKeySchema = Schema.Struct({
	zoom: NonNegativeInteger,
	row: NonNegativeInteger,
	column: NonNegativeInteger
});
export type MapTileKeyValue = typeof MapTileKeySchema.Type;

export const MapTileCaptureTileRequest = Schema.Struct({
	key: MapTileKeySchema,
	unitsPerPixel: PositiveFinite,
	worldBounds: MapCaptureWorldBounds
});

export const MapTileCaptureRequest = Schema.Struct({
	capture: Schema.Struct({
		dataLayers: MapCaptureDataLayerPolicy,
		orientation: Schema.Struct({
			pitch: Schema.Literal(-90),
			roll: Schema.Literal(0),
			yaw: Schema.Finite
		}),
		render: MapCaptureRenderPolicy,
		z: Schema.Finite
	}),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-map-tile-capture"),
		version: MapCaptureContractVersion
	}),
	correlationId: SafeIdentifier,
	expectedMapPath: MapCaptureProject.fields.mapPath,
	gutterPixels: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 })),
	operationId: MapCaptureOperationId,
	planId: MapCapturePlanId,
	runId: MapCaptureRunId,
	tilePixelSize: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4_096 })),
	tiles: Schema.Array(MapTileCaptureTileRequest).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(64)
	)
}).pipe(
	Schema.check(
		Schema.makeFilter((request) => {
			const identities = request.tiles.map((tile) => mapTileKeyId(tile.key));
			return new Set(identities).size === identities.length
				? undefined
				: {
						issue: "A bounded tile batch cannot contain duplicate tile keys.",
						path: ["tiles"]
					};
		})
	)
);
export type MapTileCaptureRequest = typeof MapTileCaptureRequest.Type;

const MapTileCaptureFailure = Schema.Struct({
	code: Schema.Literals([
		"cancelled",
		"capture_failed",
		"data_layer_policy_unsupported",
		"dirty_state_changed",
		"encoding_failed",
		"invalid_request",
		"map_mismatch",
		"streaming_not_ready",
		"write_failed"
	]),
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean
});

const MapTileCaptureResult = Schema.Union([
	Schema.Struct({
		bytes: PositiveInteger,
		captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
		height: PositiveInteger,
		key: MapTileKeySchema,
		stagedPath: NonEmptyString,
		status: Schema.Literal("captured"),
		width: PositiveInteger
	}),
	Schema.Struct({
		failure: MapTileCaptureFailure,
		key: MapTileKeySchema,
		status: Schema.Literal("failed")
	})
]);

export const MapTileCaptureResponse = Schema.Struct({
	actualMapPath: Schema.optionalKey(MapCaptureProject.fields.mapPath),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-map-tile-capture"),
		version: MapCaptureContractVersion
	}),
	correlationId: SafeIdentifier,
	dirtyState: Schema.Struct({ before: Schema.Boolean, after: Schema.Boolean }),
	durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	failure: Schema.optionalKey(MapTileCaptureFailure),
	operationId: MapCaptureOperationId,
	results: Schema.Array(MapTileCaptureResult).check(Schema.isMaxLength(64)),
	status: Schema.Literals(["completed", "partial", "cancelled", "failed"]),
	tileCounts: Schema.Struct({
		failed: NonNegativeInteger,
		requested: NonNegativeInteger,
		succeeded: NonNegativeInteger
	})
}).pipe(
	Schema.check(
		Schema.makeFilter((response) => {
			if (
				response.tileCounts.requested !== response.results.length ||
				response.tileCounts.succeeded + response.tileCounts.failed !==
					response.tileCounts.requested
			) {
				return { issue: "Tile counts must exactly inventory the result array.", path: [] };
			}
			return undefined;
		})
	)
);
export type MapTileCaptureResponse = typeof MapTileCaptureResponse.Type;

export const MapTilePyramidLevel = Schema.Struct({
	columns: PositiveInteger,
	rows: PositiveInteger,
	tileWorldSize: PositiveFinite,
	unitsPerPixel: PositiveFinite,
	zoom: NonNegativeInteger
});

export const MapTileArtifact = Schema.Struct({
	bytes: PositiveInteger,
	hash: Sha256,
	height: PositiveInteger,
	key: MapTileKeySchema,
	relativePath: Schema.String.check(Schema.isPattern(/^Z\d{2,}\/R\d{3,}_C\d{3,}\.png$/)),
	width: PositiveInteger,
	worldBounds: MapCaptureWorldBounds
});

export const MapTilePyramidFailure = Schema.Struct({
	failure: MapTileCaptureFailure,
	key: MapTileKeySchema
});

export const MapTilePyramidManifest = Schema.Struct({
	addressing: Schema.Struct({
		children: Schema.Literal("z+1: (2r,2c),(2r,2c+1),(2r+1,2c),(2r+1,2c+1)"),
		parent: Schema.Literal("z-1: (floor(r/2),floor(c/2))"),
		path: Schema.Literal("Z{zoom:02}/R{row:03}_C{column:03}.png")
	}),
	capturePolicy: Schema.Struct({
		dataLayers: MapCaptureDataLayerPolicy,
		orientation: Schema.Struct({
			pitch: Schema.Literal(-90),
			roll: Schema.Literal(0),
			yaw: Schema.Finite
		}),
		render: MapCaptureRenderPolicy,
		z: Schema.Finite
	}),
	completedAt: IsoTimestamp,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-map-tile-pyramid"),
		version: MapCaptureContractVersion
	}),
	failures: Schema.Array(MapTilePyramidFailure),
	grid: Schema.Struct({
		orientation: Schema.Struct({
			name: Schema.Literal("rows_max_x_to_min_x_columns_min_y_to_max_y"),
			version: Schema.Literal(1)
		}),
		origin: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
		requestedBounds: MapCaptureWorldBounds,
		snappedBounds: MapCaptureWorldBounds
	}),
	gutter: Schema.Struct({
		pixels: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 })),
		rule: Schema.Literal("render_overdraw_then_crop"),
		textureAddress: Schema.Literal("clamp_to_edge")
	}),
	levels: Schema.Array(MapTilePyramidLevel).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
	planId: MapCapturePlanId,
	project: MapCaptureProject,
	provenance: Schema.Struct({
		producer: NonEmptyString,
		tool: Schema.Literal("ue-shed"),
		toolVersion: NonEmptyString
	}),
	runId: MapCaptureRunId,
	startedAt: IsoTimestamp,
	state: Schema.Literals(["complete", "partial", "cancelled"]),
	tilePixelSize: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4_096 })),
	tiles: Schema.Array(MapTileArtifact)
}).pipe(
	Schema.check(
		Schema.makeFilter((manifest) => {
			const expectedGrid = createMapTileGrid({
				coarsestUnitsPerPixel: manifest.levels[0]!.unitsPerPixel,
				levelCount: manifest.levels.length,
				requestedBounds: manifest.grid.requestedBounds,
				tilePixelSize: manifest.tilePixelSize
			});
			if (
				JSON.stringify(expectedGrid.snappedBounds) !==
				JSON.stringify(manifest.grid.snappedBounds)
			) {
				return {
					issue: "Manifest snapped bounds do not match the deterministic coarsest grid.",
					path: []
				};
			}
			if (JSON.stringify(expectedGrid.origin) !== JSON.stringify(manifest.grid.origin)) {
				return {
					issue: "Manifest grid origin does not match the deterministic coarsest grid.",
					path: []
				};
			}
			for (let index = 0; index < expectedGrid.levels.length; index += 1) {
				const expected = expectedGrid.levels[index]!;
				const actual = manifest.levels[index]!;
				if (
					expected.zoom !== actual.zoom ||
					expected.rows !== actual.rows ||
					expected.columns !== actual.columns ||
					expected.unitsPerPixel !== actual.unitsPerPixel ||
					expected.tileWorldSize !== actual.tileWorldSize
				) {
					return {
						issue: "Manifest levels must exactly follow the 2x tile-pyramid rule.",
						path: []
					};
				}
			}
			const identities = new Set<string>();
			for (const tile of manifest.tiles) {
				const identity = mapTileKeyId(tile.key);
				if (identities.has(identity))
					return { issue: "Manifest tile keys must be unique.", path: [] };
				identities.add(identity);
				if (tile.relativePath !== mapTileRelativePath(tile.key)) {
					return {
						issue: "Manifest tile paths must be derived from their tile key.",
						path: []
					};
				}
				if (
					tile.width !== manifest.tilePixelSize ||
					tile.height !== manifest.tilePixelSize
				) {
					return {
						issue: "Published tile dimensions must equal the fixed tile pixel size.",
						path: []
					};
				}
			}
			const expectedTileCount = manifest.levels.reduce(
				(count, level) => count + level.rows * level.columns,
				0
			);
			if (
				manifest.state === "complete" &&
				(manifest.failures.length > 0 || manifest.tiles.length !== expectedTileCount)
			) {
				return {
					issue: "A complete manifest must inventory every tile and have no failures.",
					path: []
				};
			}
			return undefined;
		})
	)
);
export type MapTilePyramidManifest = typeof MapTilePyramidManifest.Type;

export const decodeMapCapturePlan = Schema.decodeUnknownEffect(MapCapturePlan);
export const decodeMapTileCaptureRequest = Schema.decodeUnknownEffect(MapTileCaptureRequest);
export const decodeMapTileCaptureResponse = Schema.decodeUnknownEffect(MapTileCaptureResponse);
export const decodeMapTilePyramidManifest = Schema.decodeUnknownEffect(MapTilePyramidManifest);
