import {
	MapCaptureBackend,
	MapCapturePlan,
	MapTileArtifact,
	MapTilePyramidManifest,
	type MapCapturePlan as MapCapturePlanValue
} from "@ue-shed/cameras/map-tiles";
import { EditorWorldOpenResponse, SavedWorld, SavedWorldMap } from "@ue-shed/protocol";
import { type Effect, Schema, type Stream } from "effect";

const MapCaptureUiOperationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

const MapCaptureGridView = Schema.Struct({
	levels: Schema.Array(
		Schema.Struct({
			columns: Schema.Int.check(Schema.isGreaterThan(0)),
			rows: Schema.Int.check(Schema.isGreaterThan(0)),
			tileWorldSize: Schema.Finite.check(Schema.isGreaterThan(0)),
			unitsPerPixel: Schema.Finite.check(Schema.isGreaterThan(0)),
			zoom: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	snappedBounds: Schema.Struct({
		maxX: Schema.Finite,
		maxY: Schema.Finite,
		minX: Schema.Finite,
		minY: Schema.Finite
	})
});

const WorkbenchFailure = Schema.Struct({
	message: Schema.String,
	recovery: Schema.String,
	status: Schema.Literal("failed")
});

export const MapCaptureSelectionResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	WorkbenchFailure,
	Schema.Struct({
		grid: MapCaptureGridView,
		maps: Schema.Array(SavedWorldMap),
		plan: MapCapturePlan,
		planPath: Schema.optionalKey(Schema.String),
		projectRoot: Schema.String,
		source: Schema.Literals(["new", "opened"]),
		status: Schema.Literal("ready"),
		tileCount: Schema.Int.check(Schema.isGreaterThan(0))
	})
]);
export type MapCaptureSelectionResult = typeof MapCaptureSelectionResult.Type;

export const MapCaptureOpenResult = Schema.Union([
	WorkbenchFailure,
	Schema.Struct({ response: EditorWorldOpenResponse, status: Schema.Literal("completed") })
]);
export type MapCaptureOpenResult = typeof MapCaptureOpenResult.Type;

export const MapCaptureActorCatalogResult = Schema.Union([
	WorkbenchFailure,
	Schema.Struct({ status: Schema.Literal("ready"), world: SavedWorld })
]);
export type MapCaptureActorCatalogResult = typeof MapCaptureActorCatalogResult.Type;

export const MapCaptureLivePreviewResult = Schema.Union([
	WorkbenchFailure,
	Schema.Struct({
		bytes: Schema.Uint8Array,
		cameraId: Schema.String,
		cameraIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		height: Schema.Int.check(Schema.isGreaterThan(0)),
		previewContext: Schema.Literals(["editor_live", "play_live"]),
		status: Schema.Literal("ready"),
		width: Schema.Int.check(Schema.isGreaterThan(0))
	})
]);
export type MapCaptureLivePreviewResult = typeof MapCaptureLivePreviewResult.Type;

export interface MapCaptureLiveFrame {
	readonly cameraId: string;
	readonly cameraIndex: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly width: number;
}

export const MapCaptureSaveIntent = Schema.Struct({
	plan: MapCapturePlan,
	planPath: Schema.optionalKey(Schema.String),
	saveAs: Schema.Boolean
});
export interface MapCaptureSaveIntent extends Schema.Schema.Type<typeof MapCaptureSaveIntent> {}

export const MapCaptureSaveResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	WorkbenchFailure,
	Schema.Struct({
		plan: MapCapturePlan,
		planPath: Schema.String,
		status: Schema.Literal("saved")
	})
]);
export type MapCaptureSaveResult = typeof MapCaptureSaveResult.Type;

export const MapCaptureExecuteIntent = Schema.Struct({
	captureBackend: MapCaptureBackend,
	operationId: MapCaptureUiOperationId,
	openMap: Schema.Boolean,
	plan: MapCapturePlan
});
export interface MapCaptureExecuteIntent extends Schema.Schema.Type<
	typeof MapCaptureExecuteIntent
> {}

export const MapCaptureTileIntent = Schema.Struct({
	manifestPath: Schema.NonEmptyString,
	relativePath: MapTileArtifact.fields.relativePath
});
export interface MapCaptureTileIntent extends Schema.Schema.Type<typeof MapCaptureTileIntent> {}

export const MapCaptureTileResult = Schema.Union([
	WorkbenchFailure,
	Schema.Struct({ bytes: Schema.Uint8Array, status: Schema.Literal("ready") })
]);
export type MapCaptureTileResult = typeof MapCaptureTileResult.Type;

export const MapCaptureExecuteResult = Schema.Union([
	WorkbenchFailure,
	Schema.Struct({
		manifest: MapTilePyramidManifest,
		manifestPath: Schema.String,
		published: Schema.Boolean,
		status: Schema.Literal("completed")
	})
]);
export type MapCaptureExecuteResult = typeof MapCaptureExecuteResult.Type;

export const MapCaptureProgressEvent = Schema.Struct({
	failedTiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	operationId: MapCaptureUiOperationId,
	phase: Schema.Literals(["opening_map", "capturing", "publishing", "loading_preview"]),
	processedTiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	totalTiles: Schema.Int.check(Schema.isGreaterThan(0))
});
export interface MapCaptureProgressEvent extends Schema.Schema.Type<
	typeof MapCaptureProgressEvent
> {}

export class MapCaptureClientError extends Schema.TaggedErrorClass<MapCaptureClientError>()(
	"MapCaptureClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface MapCaptureClientShape {
	readonly actors: (
		mapPath: string
	) => Effect.Effect<MapCaptureActorCatalogResult, MapCaptureClientError>;
	readonly capture: (
		intent: MapCaptureExecuteIntent
	) => Effect.Effect<MapCaptureExecuteResult, MapCaptureClientError>;
	readonly choosePlan: () => Effect.Effect<MapCaptureSelectionResult, MapCaptureClientError>;
	readonly newPlan: () => Effect.Effect<MapCaptureSelectionResult, MapCaptureClientError>;
	readonly openMap: (
		plan: MapCapturePlanValue
	) => Effect.Effect<MapCaptureOpenResult, MapCaptureClientError>;
	readonly liveFrames: Stream.Stream<MapCaptureLiveFrame>;
	readonly preview: (
		plan: MapCapturePlanValue
	) => Effect.Effect<MapCaptureLivePreviewResult, MapCaptureClientError>;
	readonly progress: Stream.Stream<MapCaptureProgressEvent>;
	readonly savePlan: (
		intent: MapCaptureSaveIntent
	) => Effect.Effect<MapCaptureSaveResult, MapCaptureClientError>;
	readonly tile: (
		intent: MapCaptureTileIntent
	) => Effect.Effect<MapCaptureTileResult, MapCaptureClientError>;
}

export const decodeMapCaptureExecuteResult = Schema.decodeUnknownEffect(MapCaptureExecuteResult);
export const decodeMapCaptureActorCatalogResult = Schema.decodeUnknownEffect(
	MapCaptureActorCatalogResult
);
export const decodeMapCaptureOpenResult = Schema.decodeUnknownEffect(MapCaptureOpenResult);
export const decodeMapCaptureLivePreviewResult = Schema.decodeUnknownEffect(
	MapCaptureLivePreviewResult
);
export const decodeMapCaptureSaveResult = Schema.decodeUnknownEffect(MapCaptureSaveResult);
export const decodeMapCaptureSelectionResult =
	Schema.decodeUnknownEffect(MapCaptureSelectionResult);
export const decodeMapCaptureTileResult = Schema.decodeUnknownEffect(MapCaptureTileResult);
