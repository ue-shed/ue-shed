import {
	MapCaptureClientError,
	decodeMapCaptureExecuteResult,
	decodeMapCaptureOpenResult,
	decodeMapCaptureSaveResult,
	decodeMapCaptureSelectionResult,
	type MapCaptureClientShape,
	type MapCaptureExecuteIntent,
	type MapCaptureSaveIntent
} from "@ue-shed/extension-camera-review/map-capture-client";
import { Effect } from "effect";

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
	savePlan: (intent: MapCaptureSaveIntent) =>
		request({
			decode: decodeMapCaptureSaveResult,
			invoke: () => window.ueShed.mapCapture.savePlan(intent),
			operation: "mapCapture.savePlan"
		})
};
