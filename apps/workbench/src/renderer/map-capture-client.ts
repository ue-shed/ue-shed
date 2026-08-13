import {
	MapCaptureClientError,
	decodeMapCaptureActorCatalogResult,
	decodeMapCaptureExecuteResult,
	decodeMapCaptureLivePreviewResult,
	decodeMapCaptureOpenResult,
	decodeMapCaptureSaveResult,
	decodeMapCaptureSelectionResult,
	type MapCaptureClientShape,
	type MapCaptureExecuteIntent,
	type MapCaptureProgressEvent,
	type MapCaptureSaveIntent
} from "@ue-shed/extension-camera-review/map-capture-client";
import { Effect, Queue, Stream } from "effect";

function request<A>(args: {
	readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
	readonly invoke: () => Promise<unknown>;
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

export const mapCaptureClient: MapCaptureClientShape = {
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
		})
};
