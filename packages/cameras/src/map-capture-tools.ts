import { Effect, Schema } from "effect";
import { decodeCompanionCapabilityManifest } from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { MapCaptureSelection, MapCaptureReadiness } from "./map-capture-tools-schema.js";
export * from "./map-capture-tools-schema.js";
export class MapCaptureInspectionError extends Schema.TaggedErrorClass<MapCaptureInspectionError>()(
	"MapCaptureInspectionError",
	{ message: Schema.String, recovery: Schema.String }
) {}
const failure = (cause: unknown) =>
	cause instanceof MapCaptureInspectionError
		? cause
		: new MapCaptureInspectionError({
				message: String(cause),
				recovery: "Check the editor endpoint and update Core and Cameras plugins together."
			});
const negotiate = Effect.fn("MapCapture.inspect.negotiate")(function* (
	endpoint: string,
	capability: string
) {
	const client = yield* RemoteControlClient;
	const manifest = yield* client
		.request({
			endpoint,
			functionName: "GetCapabilityManifest",
			objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
			operation: "map_capture.inspect.negotiate",
			parameters: {}
		})
		.pipe(Effect.flatMap(decodeCompanionCapabilityManifest));
	if (!manifest.capabilities.includes(capability))
		return yield* Effect.fail(
			new MapCaptureInspectionError({
				message: `Editor does not advertise ${capability}.`,
				recovery: "Update Core and Cameras plugins and restart the editor."
			})
		);
	return client;
});
export const inspectMapCaptureSelection = Effect.fn("MapCapture.inspect.selection")(function* (
	endpoint: string
) {
	const client = yield* negotiate(endpoint, "cameras.capture-selection.v1");
	return yield* client
		.request({
			endpoint,
			functionName: "InspectMapCaptureSelection",
			objectPath: "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
			operation: "map_capture.inspect.selection",
			parameters: {}
		})
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(MapCaptureSelection)));
}, Effect.mapError(failure));
export const inspectMapCaptureReadiness = Effect.fn("MapCapture.inspect.readiness")(function* (
	endpoint: string,
	expectedMapPath: string
) {
	const client = yield* negotiate(endpoint, "cameras.capture-readiness.v1");
	if (!/^\/Game\/[A-Za-z0-9_/]+$/.test(expectedMapPath))
		return yield* Effect.fail(
			new MapCaptureInspectionError({
				message: "Expected a /Game/ map package path.",
				recovery: "Use the map package path from the capture plan."
			})
		);
	return yield* client
		.request({
			endpoint,
			functionName: "InspectMapCaptureReadiness",
			objectPath: "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
			operation: "map_capture.inspect.readiness",
			parameters: { ExpectedMapPath: expectedMapPath }
		})
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(MapCaptureReadiness)));
}, Effect.mapError(failure));
