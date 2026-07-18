import {
	decodeCompanionCapabilityManifest,
	decodeEditorPlaySessionCommandResponse,
	decodeEditorPlaySessionStateResponse,
	type EditorPlaySessionCommand,
	type EditorPlaySessionCommandResponse,
	type EditorPlaySessionMode,
	type EditorPlaySessionStateResponse
} from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const capability = "editor.play-session.v1";

export class EditorPlaySessionError extends Schema.TaggedErrorClass<EditorPlaySessionError>()(
	"EditorPlaySessionError",
	{
		code: Schema.Literals(["capability_unavailable", "contract_failure", "transport_failure"]),
		endpoint: Schema.String,
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface EditorPlaySessionShape {
	readonly status: (
		endpoint: string
	) => Effect.Effect<EditorPlaySessionStateResponse, EditorPlaySessionError>;
	readonly execute: (
		endpoint: string,
		command: EditorPlaySessionCommand
	) => Effect.Effect<EditorPlaySessionCommandResponse, EditorPlaySessionError>;
	readonly start: (
		endpoint: string,
		mode: EditorPlaySessionMode
	) => Effect.Effect<EditorPlaySessionCommandResponse, EditorPlaySessionError>;
	readonly stop: (
		endpoint: string
	) => Effect.Effect<EditorPlaySessionCommandResponse, EditorPlaySessionError>;
	readonly pause: (
		endpoint: string
	) => Effect.Effect<EditorPlaySessionCommandResponse, EditorPlaySessionError>;
	readonly resume: (
		endpoint: string
	) => Effect.Effect<EditorPlaySessionCommandResponse, EditorPlaySessionError>;
}

export class EditorPlaySession extends Context.Service<EditorPlaySession, EditorPlaySessionShape>()(
	"@ue-shed/engine-discovery/EditorPlaySession"
) {}

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

function transportError(
	endpoint: string,
	operation: string,
	cause: RemoteControlClientError
): EditorPlaySessionError {
	return new EditorPlaySessionError({
		code: "transport_failure",
		endpoint,
		message: cause.message,
		operation,
		recovery: "Confirm that Unreal Editor and Remote Control are reachable, then retry.",
		retrySafe: cause.retrySafe
	});
}

function contractError(
	endpoint: string,
	operation: string,
	cause: unknown
): EditorPlaySessionError {
	return new EditorPlaySessionError({
		code: "contract_failure",
		endpoint,
		message: `The editor returned an invalid play-session response: ${String(cause)}`,
		operation,
		recovery: "Update UE Shed so the client and Unreal companion use compatible contracts.",
		retrySafe: false
	});
}

const commandFunctions: Readonly<Record<EditorPlaySessionCommand, string>> = {
	pause: "PausePlaySession",
	resume: "ResumePlaySession",
	start_play: "StartPlaySession",
	start_simulate: "StartSimulateSession",
	stop: "StopPlaySession"
};

export const EditorPlaySessionLive = Layer.effect(
	EditorPlaySession,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;

		const objectPath = Effect.fn("EditorPlaySession.objectPath")(function* (
			configuredEndpoint: string
		) {
			const endpoint = normalizedEndpoint(configuredEndpoint);
			const operation = "editor.play_session.negotiate";
			const value = yield* remote
				.request({
					endpoint,
					functionName: "GetCapabilityManifest",
					objectPath: coreObjectPath,
					operation,
					parameters: {}
				})
				.pipe(Effect.mapError((cause) => transportError(endpoint, operation, cause)));
			const manifest = yield* decodeCompanionCapabilityManifest(value).pipe(
				Effect.mapError((cause) => contractError(endpoint, operation, cause))
			);
			if (!manifest.capabilities.includes(capability) || !manifest.playSessionObjectPath) {
				return yield* Effect.fail(
					new EditorPlaySessionError({
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
			return { endpoint, objectPath: manifest.playSessionObjectPath };
		});

		const status = Effect.fn("EditorPlaySession.status")(function* (
			configuredEndpoint: string
		) {
			const target = yield* objectPath(configuredEndpoint);
			const operation = "editor.play_session.status";
			const value = yield* remote
				.request({
					endpoint: target.endpoint,
					functionName: "GetPlaySessionState",
					objectPath: target.objectPath,
					operation,
					parameters: {}
				})
				.pipe(
					Effect.mapError((cause) => transportError(target.endpoint, operation, cause))
				);
			return yield* decodeEditorPlaySessionStateResponse(value).pipe(
				Effect.mapError((cause) => contractError(target.endpoint, operation, cause))
			);
		});

		const execute = Effect.fn("EditorPlaySession.execute")(function* (
			configuredEndpoint: string,
			command: EditorPlaySessionCommand
		) {
			const target = yield* objectPath(configuredEndpoint);
			const operation = `editor.play_session.${command}`;
			const value = yield* remote
				.request({
					endpoint: target.endpoint,
					functionName: commandFunctions[command],
					objectPath: target.objectPath,
					operation,
					parameters: {}
				})
				.pipe(
					Effect.mapError((cause) => transportError(target.endpoint, operation, cause))
				);
			return yield* decodeEditorPlaySessionCommandResponse(value).pipe(
				Effect.mapError((cause) => contractError(target.endpoint, operation, cause))
			);
		});

		return EditorPlaySession.of({
			execute,
			pause: (endpoint) => execute(endpoint, "pause"),
			resume: (endpoint) => execute(endpoint, "resume"),
			start: (endpoint, mode) =>
				execute(endpoint, mode === "play" ? "start_play" : "start_simulate"),
			status,
			stop: (endpoint) => execute(endpoint, "stop")
		});
	})
);
