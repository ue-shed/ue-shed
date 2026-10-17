import {
	decodeCompanionCapabilityManifest,
	decodeEditorPlaySessionCommandResponse,
	decodeEditorPlaySessionStateResponse,
	ErrorCauseFields,
	ErrorGuidanceFields,
	type EditorPlaySessionCommand,
	type EditorPlaySessionCommandResponse,
	type EditorPlaySessionMode,
	type EditorPlaySessionStateResponse
} from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const capability = "editor.play-session.v1";

/**
 * PIE capability, response-contract or transport failure. Guidance distinguishes repeatable
 * reads from commands that may already have changed the editor; the underlying cause is
 * retained.
 */
export class EditorPlaySessionError extends Schema.TaggedError<EditorPlaySessionError>()(
	"EditorPlaySessionError",
	{
		code: Schema.Literals(["capability_unavailable", "contract_failure", "transport_failure"]),
		endpoint: Schema.String,
		operation: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

/**
 * Reads PIE state and sends explicit start, stop, pause or resume commands. After an
 * uncertain command reply, read status before issuing another mutation.
 */
export interface EditorPlaySessionApi {
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

/**
 * Capability-negotiated PIE lifecycle port. It controls the connected editor's play session
 * without launching an editor or selecting a project.
 */
export class EditorPlaySession extends Context.Service<EditorPlaySession, EditorPlaySessionApi>()(
	"@ue-shed/engine/EditorPlaySession"
) {}

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

/**
 * Reads may be repeated as the transport allows. A play-session command whose response was lost
 * may already have applied, so the caller reads the session state before sending it again.
 */
function transportError(
	endpoint: string,
	operation: string,
	cause: RemoteControlClientError,
	mutation: boolean
): EditorPlaySessionError {
	if (mutation && cause.retrySafe)
		return new EditorPlaySessionError({
			code: "transport_failure",
			endpoint,
			message: cause.message,
			operation,
			recovery:
				"The command may have reached the editor. Read the play-session status before sending it again.",
			retrySafe: false,
			nextStep: "reconcile",
			cause
		});
	return new EditorPlaySessionError({
		code: "transport_failure",
		endpoint,
		message: cause.message,
		operation,
		recovery: "Confirm that Unreal Editor and Remote Control are reachable, then retry.",
		retrySafe: mutation ? false : cause.retrySafe,
		nextStep: cause.nextStep,
		cause
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
		message: `The editor at ${endpoint} returned a ${operation} response that does not match the play-session contract.`,
		operation,
		recovery: "Update UE Shed so the client and Unreal companion use compatible contracts.",
		retrySafe: false,
		nextStep: "escalate",
		cause
	});
}

const commandFunctions = {
	pause: "PausePlaySession",
	resume: "ResumePlaySession",
	start_play: "StartPlaySession",
	start_simulate: "StartSimulateSession",
	stop: "StopPlaySession"
} satisfies Readonly<Record<EditorPlaySessionCommand, string>>;

/**
 * RemoteControlClient-backed PIE control with capability and response validation. Mutations
 * are not automatically replayed when a reply is lost or malformed.
 */
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
					idempotent: true,
					objectPath: coreObjectPath,
					operation,
					parameters: {}
				})
				.pipe(
					Effect.mapError((cause) => transportError(endpoint, operation, cause, false))
				);
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
						retrySafe: false,
						nextStep: "fix_input"
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
					idempotent: true,
					objectPath: target.objectPath,
					operation,
					parameters: {}
				})
				.pipe(
					Effect.mapError((cause) =>
						transportError(target.endpoint, operation, cause, false)
					)
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
					Effect.mapError((cause) =>
						transportError(target.endpoint, operation, cause, true)
					)
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

/**
 * Provides a complete explicit EditorPlaySession test port. The supplied implementation owns
 * outcomes and synchronization; no missing operation falls back to the production service.
 */
export function makeEditorPlaySessionTestLayer(
	service: EditorPlaySessionApi
): Layer.Layer<EditorPlaySession> {
	return Layer.succeed(EditorPlaySession, EditorPlaySession.of(service));
}
