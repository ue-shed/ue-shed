import {
	MapCaptureBackend,
	MapCapturePlan,
	MapTileArtifact,
	MapTilePyramidManifest,
	type MapCapturePlan as MapCapturePlanValue
} from "@ue-shed/cameras/map-tiles";
import {
	ErrorNextStep,
	EditorWorldOpenResponse,
	SavedWorld,
	SavedWorldMap
} from "@ue-shed/protocol";
import { Effect, Schema, type Stream } from "effect";

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

export class MapCaptureClientError extends Schema.TaggedError<MapCaptureClientError>()(
	"MapCaptureClientError",
	{
		message: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: ErrorNextStep,
		code: Schema.Literal("map_capture_client_failed"),
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface MapCaptureClientApi {
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

/**
 * A value that does not match the Map Capture contract: the two sides disagree about the contract, so
 * repeating the same call returns the same mismatch.
 */
export class MapCaptureContractError extends Schema.TaggedError<MapCaptureContractError>()(
	"MapCaptureContractError",
	{
		nextStep: ErrorNextStep,
		code: Schema.Literal("invalid_contract"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/**
 * A unary parser for one Map Capture contract value: it decodes the encoded value and fails with
 * `MapCaptureContractError` naming `subject`, keeping the schema issue as its cause.
 */
function mapCaptureContractParser<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	subject: string
) {
	const decode = Schema.decodeUnknownEffect(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary: it decodes its input here.
		encoded: unknown
	): Effect.Effect<S["Type"], MapCaptureContractError> =>
		decode(encoded).pipe(
			Effect.mapError(
				(cause) =>
					new MapCaptureContractError({
						nextStep: "escalate",
						code: "invalid_contract",
						message: `The ${subject} does not match the Map Capture contract.`,
						recovery:
							"Run Workbench and its extensions from the same UE Shed version, then retry.",
						retrySafe: false,
						cause
					})
			)
		);
}

export const parseMapCaptureExecuteResult = mapCaptureContractParser(
	MapCaptureExecuteResult,
	"map capture execute result"
);
export const parseMapCaptureActorCatalogResult = mapCaptureContractParser(
	MapCaptureActorCatalogResult,
	"map capture actor catalog result"
);
export const parseMapCaptureOpenResult = mapCaptureContractParser(
	MapCaptureOpenResult,
	"map capture open result"
);
export const parseMapCaptureLivePreviewResult = mapCaptureContractParser(
	MapCaptureLivePreviewResult,
	"map capture live preview result"
);
export const parseMapCaptureSaveResult = mapCaptureContractParser(
	MapCaptureSaveResult,
	"map capture save result"
);
export const parseMapCaptureSelectionResult = mapCaptureContractParser(
	MapCaptureSelectionResult,
	"map capture selection result"
);
export const parseMapCaptureTileResult = mapCaptureContractParser(
	MapCaptureTileResult,
	"map capture tile result"
);
