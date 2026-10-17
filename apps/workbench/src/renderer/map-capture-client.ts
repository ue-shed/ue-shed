import {
	MapCaptureClientError,
	parseMapCaptureActorCatalogResult,
	parseMapCaptureExecuteResult,
	parseMapCaptureLivePreviewResult,
	parseMapCaptureOpenResult,
	parseMapCaptureSaveResult,
	parseMapCaptureSelectionResult,
	parseMapCaptureTileResult,
	type MapCaptureClientApi,
	type MapCaptureExecuteIntent,
	type MapCaptureProgressEvent,
	type MapCaptureSaveIntent,
	type MapCaptureTileIntent
} from "@ue-shed/extension-camera-review/map-capture-client";
import { Effect, Queue, Stream } from "effect";

function request<A, HostValue, DecodeError>(args: {
	readonly decode: (value: HostValue) => Effect.Effect<A, DecodeError>;
	readonly invoke: () => Promise<HostValue>;
	readonly operation: string;
}): Effect.Effect<A, MapCaptureClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) =>
			new MapCaptureClientError({
				message: "Map capture could not complete the host operation.",
				retrySafe: false,
				nextStep: "reconcile",
				code: "map_capture_client_failed",
				cause,
				operation: args.operation,
				recovery: "Restart Workbench and verify the selected project and package versions."
			})
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) =>
				new MapCaptureClientError({
					message: "Map capture could not complete the host operation.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "map_capture_client_failed",
					cause,
					operation: args.operation,
					recovery:
						"Restart Workbench and verify the selected project and package versions."
				})
		)
	);
}

export const mapCaptureClient: MapCaptureClientApi = {
	actors: (mapPath) =>
		request({
			decode: parseMapCaptureActorCatalogResult,
			invoke: () => window.ueShed.mapCapture.actors(mapPath),
			operation: "mapCapture.actors"
		}),
	capture: (intent: MapCaptureExecuteIntent) =>
		request({
			decode: parseMapCaptureExecuteResult,
			invoke: () => window.ueShed.mapCapture.capture(intent),
			operation: "mapCapture.capture"
		}),
	choosePlan: () =>
		request({
			decode: parseMapCaptureSelectionResult,
			invoke: () => window.ueShed.mapCapture.choosePlan(),
			operation: "mapCapture.choosePlan"
		}),
	newPlan: () =>
		request({
			decode: parseMapCaptureSelectionResult,
			invoke: () => window.ueShed.mapCapture.newPlan(),
			operation: "mapCapture.newPlan"
		}),
	openMap: (plan) =>
		request({
			decode: parseMapCaptureOpenResult,
			invoke: () => window.ueShed.mapCapture.openMap(plan),
			operation: "mapCapture.openMap"
		}),
	liveFrames: Stream.callback(
		(queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					window.ueShed.onFrame((frame) =>
						Queue.offerUnsafe(queue, {
							cameraId: frame.cameraId,
							cameraIndex: frame.cameraIndex,
							height: frame.height,
							pixels: frame.pixels,
							width: frame.width
						})
					)
				),
				(unsubscribe) => Effect.sync(unsubscribe)
			),
		{ bufferSize: 1, strategy: "sliding" }
	),
	preview: (plan) =>
		request({
			decode: parseMapCaptureLivePreviewResult,
			invoke: () => window.ueShed.mapCapture.preview(plan),
			operation: "mapCapture.preview"
		}),
	progress: Stream.callback<MapCaptureProgressEvent>(
		(queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					window.ueShed.mapCapture.onProgress((progress) =>
						Queue.offerUnsafe(queue, progress)
					)
				),
				(unsubscribe) => Effect.sync(unsubscribe)
			),
		{ bufferSize: 1, strategy: "sliding" }
	),
	savePlan: (intent: MapCaptureSaveIntent) =>
		request({
			decode: parseMapCaptureSaveResult,
			invoke: () => window.ueShed.mapCapture.savePlan(intent),
			operation: "mapCapture.savePlan"
		}),
	tile: (intent: MapCaptureTileIntent) =>
		request({
			decode: parseMapCaptureTileResult,
			invoke: () => window.ueShed.mapCapture.tile(intent),
			operation: "mapCapture.tile"
		})
};
