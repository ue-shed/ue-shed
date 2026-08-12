import {
	EditorWorldOpenRequest,
	decodeCompanionCapabilityManifest,
	decodeEditorWorldOpenResponse,
	type EditorWorldOpenResponse
} from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const capability = "editor.world-control.v1";

export class EditorWorldControlError extends Schema.TaggedErrorClass<EditorWorldControlError>()(
	"EditorWorldControlError",
	{
		code: Schema.Literals([
			"capability_unavailable",
			"contract_failure",
			"request_invalid",
			"transport_failure"
		]),
		endpoint: Schema.String,
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface OpenEditorWorldOptions {
	readonly endpoint: string;
	readonly operationId: string;
	readonly targetMapPath: string;
}

export interface EditorWorldControlShape {
	readonly open: (
		options: OpenEditorWorldOptions
	) => Effect.Effect<EditorWorldOpenResponse, EditorWorldControlError>;
}

export class EditorWorldControl extends Context.Service<
	EditorWorldControl,
	EditorWorldControlShape
>()("@ue-shed/engine-discovery/EditorWorldControl") {}

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

function failure(args: {
	readonly code: EditorWorldControlError["code"];
	readonly endpoint: string;
	readonly message: string;
	readonly operation: string;
	readonly recovery: string;
	readonly retrySafe: boolean;
}): EditorWorldControlError {
	return new EditorWorldControlError(args);
}

export const EditorWorldControlLive = Layer.effect(
	EditorWorldControl,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;

		const objectPath = Effect.fn("EditorWorldControl.objectPath")(function* (
			configuredEndpoint: string
		) {
			const endpoint = normalizedEndpoint(configuredEndpoint);
			const operation = "editor.world_control.negotiate";
			const value = yield* remote
				.request({
					endpoint,
					functionName: "GetCapabilityManifest",
					objectPath: coreObjectPath,
					operation,
					parameters: {}
				})
				.pipe(
					Effect.mapError((cause: RemoteControlClientError) =>
						failure({
							code: "transport_failure",
							endpoint,
							message: cause.message,
							operation,
							recovery:
								"Confirm that Unreal Editor and Remote Control are reachable, then retry.",
							retrySafe: cause.retrySafe
						})
					)
				);
			const manifest = yield* decodeCompanionCapabilityManifest(value).pipe(
				Effect.mapError((cause) =>
					failure({
						code: "contract_failure",
						endpoint,
						message: `The editor returned an invalid capability manifest: ${String(cause)}`,
						operation,
						recovery:
							"Update UE Shed so the client and Unreal companion use compatible contracts.",
						retrySafe: false
					})
				)
			);
			if (!manifest.capabilities.includes(capability) || !manifest.worldControlObjectPath) {
				return yield* Effect.fail(
					failure({
						code: "capability_unavailable",
						endpoint,
						message: `Connected producer does not advertise ${capability}.`,
						operation,
						recovery:
							"Enable a compatible UEShedCoreEditor module in Unreal Editor, then reconnect.",
						retrySafe: false
					})
				);
			}
			return { endpoint, objectPath: manifest.worldControlObjectPath };
		});

		const open = Effect.fn("EditorWorldControl.open")(function* (
			options: OpenEditorWorldOptions
		) {
			const endpoint = normalizedEndpoint(options.endpoint);
			const operation = "editor.world_control.open";
			const request = yield* Schema.decodeUnknownEffect(EditorWorldOpenRequest)({
				contract: {
					name: "unreal-editor-world-control",
					version: { major: 1, minor: 0 }
				},
				operationId: options.operationId,
				targetMapPath: options.targetMapPath
			}).pipe(
				Effect.mapError((cause) =>
					failure({
						code: "request_invalid",
						endpoint,
						message: `Editor world-control request is invalid: ${String(cause)}`,
						operation,
						recovery: "Use a /Game/ map package path and a safe operation identity.",
						retrySafe: false
					})
				)
			);
			const target = yield* objectPath(endpoint);
			const value = yield* remote
				.request({
					endpoint: target.endpoint,
					functionName: "OpenMap",
					objectPath: target.objectPath,
					operation,
					parameters: { RequestJson: JSON.stringify(request) }
				})
				.pipe(
					Effect.mapError((cause: RemoteControlClientError) =>
						failure({
							code: "transport_failure",
							endpoint: target.endpoint,
							message: cause.message,
							operation,
							recovery:
								"Confirm that Unreal Editor and Remote Control are reachable, then retry.",
							retrySafe: cause.retrySafe
						})
					)
				);
			return yield* decodeEditorWorldOpenResponse(value).pipe(
				Effect.mapError((cause) =>
					failure({
						code: "contract_failure",
						endpoint: target.endpoint,
						message: `The editor returned an invalid world-control response: ${String(cause)}`,
						operation,
						recovery:
							"Update UE Shed so the client and Unreal companion use compatible contracts.",
						retrySafe: false
					})
				)
			);
		});

		return EditorWorldControl.of({ open });
	})
);

export function makeEditorWorldControlTestLayer(
	service: EditorWorldControlShape
): Layer.Layer<EditorWorldControl> {
	return Layer.succeed(EditorWorldControl, EditorWorldControl.of(service));
}
