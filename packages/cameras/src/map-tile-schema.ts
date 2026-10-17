import { contractParser } from "@ue-shed/protocol";
import { Schema } from "effect";
import { CameraVisibilityList } from "./camera-visibility.js";
import { CameraFrameEvidence } from "./camera-render-schema.js";
import {
	assertMapTileKey,
	createMapTileGrid,
	mapTileKeyId,
	mapTileRelativePath,
	mapTileWorldBounds
} from "./map-tile-pyramid.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const SafeIdentifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
const IsoTimestamp = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
);

/**
 * Branded safe identifier for a persisted map capture plan. Preserve it through related
 * requests/results; validation does not prove the resource exists or that a mutation
 * completed.
 */
export const MapCapturePlanId = SafeIdentifier.pipe(Schema.brand("MapCapturePlanId"));
export type MapCapturePlanId = typeof MapCapturePlanId.Type;

/**
 * Branded safe identifier for a immutable capture run. Preserve it through related
 * requests/results; validation does not prove the resource exists or that a mutation
 * completed.
 */
export const MapCaptureRunId = SafeIdentifier.pipe(Schema.brand("MapCaptureRunId"));
export type MapCaptureRunId = typeof MapCaptureRunId.Type;

/**
 * Branded safe identifier for a correlated editor tile operation. Preserve it through related
 * requests/results; validation does not prove the resource exists or that a mutation
 * completed.
 */
export const MapCaptureOperationId = SafeIdentifier.pipe(Schema.brand("MapCaptureOperationId"));
export type MapCaptureOperationId = typeof MapCaptureOperationId.Type;

/**
 * Supported map-capture contract major 1 and minor 0 through 2. Version-dependent rendering
 * evidence remains explicit when reading older plans/results.
 */
export const MapCaptureContractVersion = Schema.Struct({
	major: Schema.Literal(1),
	minor: Schema.Literals([0, 1, 2])
});

/**
 * Finite planar Unreal XY bounds with strictly positive spans. Capture height and downward
 * orientation are configured separately by the plan.
 */
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

/**
 * Explicit project identifier and Unreal map package path. This identifies capture inputs
 * rather than changing the host's selected project.
 */
export const MapCaptureProject = Schema.Struct({
	id: SafeIdentifier,
	mapPath: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/u))
});
export type MapCaptureProject = typeof MapCaptureProject.Type;

/**
 * Preserve current data-layer state or request at most 64 explicit unloaded/loaded/activated
 * states. Changes are scoped capture preparation rather than persistent project policy edits.
 */
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

/**
 * Scene-capture profile, effects, exposure and LOD policy. Per-level distance scaling
 * requires a bounded scale array; other LOD modes reject that extra policy.
 */
export const MapCaptureRenderPolicy = Schema.Struct({
	exposureEV100: Schema.optionalKey(
		Schema.Finite.check(Schema.isBetween({ minimum: -20, maximum: 30 }))
	),
	effects: Schema.Struct({
		fog: Schema.Boolean,
		volumetricFog: Schema.Boolean
	}),
	lodDistanceScaleByZoom: Schema.optionalKey(
		Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 100 }))).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(24)
		)
	),
	lodPolicy: Schema.Literals(["natural", "fixed_lod_zero", "per_level_distance_scale"]),
	profile: Schema.Literals([
		"full_fidelity",
		"seam_stable",
		"scene_capture_defaults",
		"observation"
	])
}).pipe(
	Schema.check(
		Schema.makeFilter((render) =>
			(render.lodPolicy === "per_level_distance_scale") ===
			(render.lodDistanceScaleByZoom !== undefined)
				? undefined
				: {
						issue: "Per-level LOD policy requires scales, and other policies must not carry them.",
						path: ["lodDistanceScaleByZoom"]
					}
		)
	)
);

/**
 * Versioned top-down map pyramid plan with bounds, tile/level dimensions, capture policy and
 * immutable local publication. Validation does not launch Unreal or reserve output storage.
 */
export const MapCapturePlan = Schema.Struct({
	capture: Schema.Struct({
		visibility: Schema.optionalKey(CameraVisibilityList),
		dataLayers: MapCaptureDataLayerPolicy,
		orientation: Schema.Struct({
			pitch: Schema.Literal(-90),
			roll: Schema.Literal(0),
			yaw: Schema.Literal(0)
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
}).pipe(
	Schema.check(
		Schema.makeFilter((plan) =>
			plan.capture.visibility && plan.contract.version.minor < 2
				? "Authored visibility requires map capture 1.2."
				: undefined
		),
		Schema.makeFilter((plan) =>
			plan.capture.render.lodPolicy !== "per_level_distance_scale" ||
			plan.capture.render.lodDistanceScaleByZoom?.length === plan.levels.count
				? undefined
				: {
						issue: "LOD distance scales must contain exactly one value per pyramid level.",
						path: ["capture", "render", "lodDistanceScaleByZoom"]
					}
		)
	)
);
export type MapCapturePlan = typeof MapCapturePlan.Type;

/**
 * Runtime boundary for non-negative integer zoom/row/column coordinates. Membership in a
 * particular grid still requires assertMapTileKey.
 */
export const MapTileKeySchema = Schema.Struct({
	zoom: NonNegativeInteger,
	row: NonNegativeInteger,
	column: NonNegativeInteger
});
/**
 * Decoded tile-key value for map-capture wire/artifact contracts. Non-negative coordinates
 * still need a grid-membership check before indexing a pyramid.
 */
export type MapTileKeyValue = typeof MapTileKeySchema.Type;

/**
 * One tile's key, positive world-units-per-pixel and world footprint. The containing request
 * supplies the shared render policy and capture height.
 */
export const MapTileCaptureTileRequest = Schema.Struct({
	key: MapTileKeySchema,
	unitsPerPixel: PositiveFinite,
	worldBounds: MapCaptureWorldBounds
});

/**
 * Explicit lit-camera, scene-capture tile or high-resolution viewport backend. The connected
 * editor must advertise/support the requested strategy.
 */
export const MapCaptureBackend = Schema.Literals([
	"lit_camera_tiles",
	"scene_capture_tiles",
	"viewport_high_resolution"
]);
export type MapCaptureBackend = typeof MapCaptureBackend.Type;

/**
 * Correlated bounded tile batch bound to plan/run/operation identities and expected map.
 * Shared capture policy remains explicit; optional backend selection does not bypass
 * capability/readiness checks.
 */
export const MapTileCaptureRequest = Schema.Struct({
	capture: Schema.Struct({
		visibility: Schema.optionalKey(CameraVisibilityList),
		dataLayers: MapCaptureDataLayerPolicy,
		orientation: Schema.Struct({
			pitch: Schema.Literal(-90),
			roll: Schema.Literal(0),
			yaw: Schema.Literal(0)
		}),
		render: MapCaptureRenderPolicy,
		z: Schema.Finite
	}),
	captureBackend: Schema.optionalKey(MapCaptureBackend),
	overviewBounds: Schema.optionalKey(MapCaptureWorldBounds),
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
			if (request.capture.visibility && request.contract.version.minor < 2)
				return {
					issue: "Authored visibility requires map capture 1.2.",
					path: ["contract"]
				};
			const identities = request.tiles.map((tile) => mapTileKeyId(tile.key));
			if (new Set(identities).size !== identities.length) {
				return {
					issue: "A bounded tile batch cannot contain duplicate tile keys.",
					path: ["tiles"]
				};
			}
			if (
				request.capture.render.lodPolicy === "per_level_distance_scale" &&
				request.tiles.some(
					(tile) =>
						request.capture.render.lodDistanceScaleByZoom?.[tile.key.zoom] === undefined
				)
			) {
				return {
					issue: "Every requested tile zoom must have a configured LOD distance scale.",
					path: ["capture", "render", "lodDistanceScaleByZoom"]
				};
			}
			return undefined;
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
		renderEvidence: Schema.optionalKey(CameraFrameEvidence),
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

/**
 * Completed, partial, cancelled or failed tile batch with correlated operation, per-tile
 * outcomes and dirty-state evidence. Count validation prevents an apparently complete
 * response from hiding missing results.
 */
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

/**
 * Exposure warmup, tile warmup or capture progress with elapsed milliseconds and optional
 * current key. A progress event is not evidence that a tile artifact has been committed.
 */
export const MapTileCaptureProgress = Schema.Struct({
	phase: Schema.Literals(["exposure_warmup", "tile_warmup", "capturing"]),
	elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	totalTiles: NonNegativeInteger.check(Schema.isLessThanOrEqualTo(64)),
	currentTile: Schema.optionalKey(MapTileKeySchema)
});
export type MapTileCaptureProgress = typeof MapTileCaptureProgress.Type;
/**
 * Running correlated operation or finished tile response. Reconcile by the original operation
 * ID instead of replaying an uncertain capture request.
 */
export const MapTileCaptureOperation = Schema.Union([
	Schema.Struct({
		...Schema.Struct({
			phase: Schema.optionalKey(MapTileCaptureProgress.fields.phase),
			elapsedMs: Schema.optionalKey(MapTileCaptureProgress.fields.elapsedMs),
			totalTiles: Schema.optionalKey(MapTileCaptureProgress.fields.totalTiles),
			currentTile: MapTileCaptureProgress.fields.currentTile
		}).fields,
		state: Schema.Literal("running"),
		operationId: MapCaptureOperationId,
		completedTiles: NonNegativeInteger.check(Schema.isLessThanOrEqualTo(64))
	}),
	Schema.Struct({ state: Schema.Literal("finished"), response: MapTileCaptureResponse })
]);

/**
 * Persisted level geometry with positive row/column counts, tile world size and
 * world-units-per-pixel. Zoom is zero-based and coarsest first.
 */
export const MapTilePyramidLevel = Schema.Struct({
	columns: PositiveInteger,
	rows: PositiveInteger,
	tileWorldSize: PositiveFinite,
	unitsPerPixel: PositiveFinite,
	zoom: NonNegativeInteger
});

/**
 * Whether a run was released and whether temporary editor state was restored.
 * restoration=failed must not be treated as successful cleanup even if released is true.
 */
export const MapTileReleaseResult = Schema.Struct({
	released: Schema.Boolean,
	restoration: Schema.Literals(["restored", "failed"])
});

/**
 * PNG tile metadata with relative pyramid path, hash, byte size, pixel dimensions and world
 * footprint. Optional render evidence is retained for newer capture backends.
 */
export const MapTileArtifact = Schema.Struct({
	renderEvidence: Schema.optionalKey(CameraFrameEvidence),
	bytes: PositiveInteger,
	hash: Sha256,
	height: PositiveInteger,
	key: MapTileKeySchema,
	relativePath: Schema.String.check(Schema.isPattern(/^Z\d{2,}\/R\d{3,}_C\d{3,}\.png$/u)),
	width: PositiveInteger,
	worldBounds: MapCaptureWorldBounds
});

/**
 * Typed capture failure bound to a tile key. Failed tiles remain explicit in a
 * partial/retained run rather than being replaced by an empty successful image.
 */
export const MapTilePyramidFailure = Schema.Struct({
	failure: MapTileCaptureFailure,
	key: MapTileKeySchema
});

/**
 * Versioned immutable pyramid evidence: grid orientation/addressing, capture policy,
 * artifacts, failures and run provenance. Historical missing evidence must not be inferred
 * from current defaults.
 */
export const MapTilePyramidManifest = Schema.Struct({
	addressing: Schema.Struct({
		children: Schema.Literal("z+1: (2r,2c),(2r,2c+1),(2r+1,2c),(2r+1,2c+1)"),
		parent: Schema.Literal("z-1: (floor(r/2),floor(c/2))"),
		path: Schema.Literal("Z{zoom:02}/R{row:03}_C{column:03}.png")
	}),
	capturePolicy: Schema.Struct({
		visibility: Schema.optionalKey(CameraVisibilityList),
		dataLayers: MapCaptureDataLayerPolicy,
		orientation: Schema.Struct({
			pitch: Schema.Literal(-90),
			roll: Schema.Literal(0),
			yaw: Schema.Literal(0)
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
			if (manifest.capturePolicy.visibility && manifest.contract.version.minor < 2)
				return {
					issue: "Authored visibility requires map capture 1.2.",
					path: ["contract"]
				};
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
				try {
					assertMapTileKey(expectedGrid, tile.key);
				} catch {
					return { issue: "Manifest tile key is outside its declared level.", path: [] };
				}
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
				if (
					JSON.stringify(tile.worldBounds) !==
					JSON.stringify(mapTileWorldBounds(expectedGrid, tile.key))
				) {
					return {
						issue: "Manifest tile bounds must be derived exactly from the stable grid.",
						path: []
					};
				}
			}
			for (const failure of manifest.failures) {
				const identity = mapTileKeyId(failure.key);
				if (identities.has(identity)) {
					return { issue: "A tile key cannot be both captured and failed.", path: [] };
				}
				try {
					assertMapTileKey(expectedGrid, failure.key);
				} catch {
					return {
						issue: "Manifest failure key is outside its declared level.",
						path: []
					};
				}
				identities.add(identity);
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

/**
 * Validates an untrusted map capture plan, failing with ContractParseError and the original
 * schema cause. A parsed partial/failed outcome remains ordinary evidence for the caller to
 * inspect.
 */
export const decodeMapCapturePlan = contractParser(MapCapturePlan, "MapCapturePlan");
/**
 * Validates an untrusted tile batch request, failing with ContractParseError and the original
 * schema cause. A parsed partial/failed outcome remains ordinary evidence for the caller to
 * inspect.
 */
export const decodeMapTileCaptureRequest = contractParser(
	MapTileCaptureRequest,
	"MapTileCaptureRequest"
);
/**
 * Validates an untrusted tile batch response, failing with ContractParseError and the
 * original schema cause. A parsed partial/failed outcome remains ordinary evidence for the
 * caller to inspect.
 */
export const decodeMapTileCaptureResponse = contractParser(
	MapTileCaptureResponse,
	"MapTileCaptureResponse"
);
/**
 * Validates an untrusted persisted pyramid manifest, failing with ContractParseError and the
 * original schema cause. A parsed partial/failed outcome remains ordinary evidence for the
 * caller to inspect.
 */
export const decodeMapTilePyramidManifest = contractParser(
	MapTilePyramidManifest,
	"MapTilePyramidManifest"
);
