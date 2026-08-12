import {
	MapCapturePlan,
	MapTilePyramidManifest,
	type MapCapturePlan as MapCapturePlanValue
} from "@ue-shed/cameras/map-tiles";
import { EditorWorldOpenResponse } from "@ue-shed/protocol";
import { type Effect, Schema } from "effect";

const MapCaptureRunSummary = Schema.Struct({
	completedAt: Schema.String,
	manifestPath: Schema.String,
	planId: Schema.String,
	runId: Schema.String,
	tileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});

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
		plan: MapCapturePlan,
		planPath: Schema.String,
		projectRoot: Schema.String,
		runs: Schema.Array(MapCaptureRunSummary),
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

export const MapCaptureExecuteIntent = Schema.Struct({
	openMap: Schema.Boolean,
	plan: MapCapturePlan
});
export interface MapCaptureExecuteIntent extends Schema.Schema.Type<
	typeof MapCaptureExecuteIntent
> {}

const MapCapturePreviewTile = Schema.Struct({
	dataUrl: Schema.String.check(Schema.isStartsWith("data:image/png;base64,")),
	relativePath: Schema.String
});

export const MapCaptureExecuteResult = Schema.Union([
	WorkbenchFailure,
	Schema.Struct({
		manifest: MapTilePyramidManifest,
		manifestPath: Schema.String,
		previewTiles: Schema.Array(MapCapturePreviewTile),
		previewTruncated: Schema.Boolean,
		published: Schema.Boolean,
		status: Schema.Literal("completed")
	})
]);
export type MapCaptureExecuteResult = typeof MapCaptureExecuteResult.Type;

export class MapCaptureClientError extends Schema.TaggedErrorClass<MapCaptureClientError>()(
	"MapCaptureClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface MapCaptureClientShape {
	readonly capture: (
		intent: MapCaptureExecuteIntent
	) => Effect.Effect<MapCaptureExecuteResult, MapCaptureClientError>;
	readonly choosePlan: () => Effect.Effect<MapCaptureSelectionResult, MapCaptureClientError>;
	readonly openMap: (
		plan: MapCapturePlanValue
	) => Effect.Effect<MapCaptureOpenResult, MapCaptureClientError>;
}

export const decodeMapCaptureExecuteResult = Schema.decodeUnknownEffect(MapCaptureExecuteResult);
export const decodeMapCaptureOpenResult = Schema.decodeUnknownEffect(MapCaptureOpenResult);
export const decodeMapCaptureSelectionResult =
	Schema.decodeUnknownEffect(MapCaptureSelectionResult);
