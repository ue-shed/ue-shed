import {
	decodeCompanionCapabilityManifest,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";

export class EditorConnectionError extends Schema.TaggedErrorClass<EditorConnectionError>()(
	"EditorConnectionError",
	{
		code: Schema.Literals([
			"transport_failure",
			"contract_failure",
			"project_mismatch",
			"readiness_timeout"
		]),
		endpoint: Schema.String,
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface EditorConnectionRequest {
	readonly endpoint: string;
	readonly expectedProjectName?: string;
}

export interface EditorReadinessRequest extends EditorConnectionRequest {
	readonly pollInterval?: Duration.Input;
	readonly timeout?: Duration.Input;
}

export interface EditorConnectionApi {
	readonly connect: (
		request: EditorConnectionRequest
	) => Effect.Effect<CompanionCapabilityManifest, EditorConnectionError>;
	readonly waitUntilReady: (
		request: EditorReadinessRequest
	) => Effect.Effect<CompanionCapabilityManifest, EditorConnectionError>;
}

export class EditorConnection extends Context.Service<EditorConnection, EditorConnectionApi>()(
	"@ue-shed/engine/EditorConnection"
) {}

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/u, "");
}

function transportError(endpoint: string, cause: RemoteControlClientError): EditorConnectionError {
	return new EditorConnectionError({
		code: "transport_failure",
		endpoint,
		message: cause.message,
		recovery: "Confirm that Unreal Editor and Remote Control are reachable, then retry.",
		retrySafe: cause.retrySafe
	});
}

export const EditorConnectionLive = Layer.effect(
	EditorConnection,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;
		const connect = Effect.fn("EditorConnection.connect")(function* (
			request: EditorConnectionRequest
		) {
			const endpoint = normalizedEndpoint(request.endpoint);
			const value = yield* remote
				.request({
					endpoint,
					functionName: "GetCapabilityManifest",
					objectPath: coreObjectPath,
					operation: "editor.connection.connect",
					parameters: {}
				})
				.pipe(Effect.mapError((cause) => transportError(endpoint, cause)));
			const manifest = yield* decodeCompanionCapabilityManifest(value).pipe(
				Effect.mapError(
					(cause) =>
						new EditorConnectionError({
							code: "contract_failure",
							endpoint,
							message: `The editor returned an invalid capability manifest: ${String(cause)}`,
							recovery:
								"Update UE Shed so the client and Unreal companion use compatible contracts.",
							retrySafe: false
						})
				)
			);
			if (
				request.expectedProjectName !== undefined &&
				manifest.projectName !== request.expectedProjectName
			) {
				return yield* new EditorConnectionError({
					code: "project_mismatch",
					endpoint,
					message: `The editor identifies project ${manifest.projectName ?? "unknown"}, not ${request.expectedProjectName}.`,
					recovery: "Connect to the selected project's Remote Control endpoint.",
					retrySafe: false
				});
			}
			return manifest;
		});

		const waitUntilReady = Effect.fn("EditorConnection.waitUntilReady")(function* (
			request: EditorReadinessRequest
		) {
			const endpoint = normalizedEndpoint(request.endpoint);
			return yield* connect(request).pipe(
				Effect.retry({
					schedule: Schedule.spaced(request.pollInterval ?? "500 millis"),
					while: (error) => error.code === "transport_failure" && error.retrySafe
				}),
				Effect.timeoutOrElse({
					duration: request.timeout ?? "3 minutes",
					orElse: () =>
						Effect.fail(
							new EditorConnectionError({
								code: "readiness_timeout",
								endpoint,
								message: "Unreal Editor did not become ready before the deadline.",
								recovery:
									"Inspect the editor log, Remote Control port, and enabled UEShedCore plugin.",
								retrySafe: true
							})
						)
				})
			);
		});

		return EditorConnection.of({ connect, waitUntilReady });
	})
);

export function makeEditorConnectionTestLayer(
	service: EditorConnectionApi
): Layer.Layer<EditorConnection> {
	return Layer.succeed(EditorConnection, EditorConnection.of(service));
}
