import {
	MapCaptureClientError,
	decodeMapCaptureActorCatalogResult,
	decodeMapCaptureExecuteResult,
	decodeMapCaptureLivePreviewResult,
	decodeMapCaptureOpenResult,
	decodeMapCaptureSaveResult,
	decodeMapCaptureSelectionResult,
	decodeMapCaptureTileResult,
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
				cause,
				operation: args.operation,
				recovery: "Restart Workbench and verify the selected project and package versions."
			})
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) =>
				new MapCaptureClientError({
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
			decode: decodeMapCaptureActorCatalogResult,
			invoke: () => window.ueShed.mapCapture.actors(mapPath),
			operation: "mapCapture.actors"
		}),
	capture: (intent: MapCaptureExecuteIntent) =>
		request({
			decode: decodeMapCaptureExecuteResult,
			invoke: () => window.ueShed.mapCapture.capture(intent),
			operation: "mapCapture.capture"
		}),
	choosePlan: () =>
		request({
			decode: decodeMapCaptureSelectionResult,
			invoke: () => window.ueShed.mapCapture.choosePlan(),
			operation: "mapCapture.choosePlan"
		}),
	newPlan: () =>
		request({
			decode: decodeMapCaptureSelectionResult,
			invoke: () => window.ueShed.mapCapture.newPlan(),
			operation: "mapCapture.newPlan"
		}),
	openMap: (plan) =>
		request({
			decode: decodeMapCaptureOpenResult,
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
			decode: decodeMapCaptureLivePreviewResult,
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
			decode: decodeMapCaptureSaveResult,
			invoke: () => window.ueShed.mapCapture.savePlan(intent),
			operation: "mapCapture.savePlan"
		}),
	tile: (intent: MapCaptureTileIntent) =>
		request({
			decode: decodeMapCaptureTileResult,
			invoke: () => window.ueShed.mapCapture.tile(intent),
			operation: "mapCapture.tile"
		})
};
