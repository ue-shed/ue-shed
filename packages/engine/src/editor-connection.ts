import {
	decodeCompanionCapabilityManifest,
	ErrorCauseFields,
	ErrorGuidanceFields,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";

/**
 * Connection transport, manifest-contract, project-identity or readiness-deadline failure.
 * Cause retains the underlying transport/parser error; retrySafe alone does not authorize a
 * readiness retry.
 */
export class EditorConnectionError extends Schema.TaggedError<EditorConnectionError>()(
	"EditorConnectionError",
	{
		code: Schema.Literals([
			"transport_failure",
			"contract_failure",
			"project_mismatch",
			"readiness_timeout"
		]),
		endpoint: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

/**
 * Remote Control endpoint to inspect, optionally bound to an expected project name. A name
 * mismatch fails before the manifest is accepted; this request never changes host selection.
 * `requestTimeout` bounds each manifest request; omitted, the Remote Control client's default
 * applies.
 */
export interface EditorConnectionRequest {
	readonly endpoint: string;
	readonly expectedProjectName?: string;
	readonly requestTimeout?: Duration.Input;
}

/**
 * Connection request with Effect duration overrides for polling and deadline. Defaults are
 * 500 milliseconds between attempts and a three-minute deadline; only transient transport
 * failures are retried.
 */
export interface EditorReadinessRequest extends EditorConnectionRequest {
	readonly pollInterval?: Duration.Input;
	readonly timeout?: Duration.Input;
}

/**
 * Reads the companion capability manifest once or waits for readiness. Permanent
 * contract/project failures return immediately rather than being hidden behind the polling
 * deadline.
 */
export interface EditorConnectionApi {
	readonly connect: (
		request: EditorConnectionRequest
	) => Effect.Effect<CompanionCapabilityManifest, EditorConnectionError>;
	readonly waitUntilReady: (
		request: EditorReadinessRequest
	) => Effect.Effect<CompanionCapabilityManifest, EditorConnectionError>;
}

/**
 * Capability-manifest connection port for an explicitly selected editor endpoint. Obtaining
 * the service does not start an editor.
 */
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
		recovery: cause.recovery,
		retrySafe: cause.retrySafe,
		nextStep: cause.nextStep,
		cause
	});
}

/**
 * RemoteControlClient-backed companion discovery and readiness polling. Retries require both
 * retrySafe and nextStep=retry; project mismatches and malformed replies fail immediately.
 */
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
					idempotent: true,
					objectPath: coreObjectPath,
					operation: "editor.connection.connect",
					parameters: {},
					...(request.requestTimeout === undefined
						? undefined
						: { timeout: request.requestTimeout })
				})
				.pipe(Effect.mapError((cause) => transportError(endpoint, cause)));
			const manifest = yield* decodeCompanionCapabilityManifest(value).pipe(
				Effect.mapError(
					(cause) =>
						new EditorConnectionError({
							code: "contract_failure",
							endpoint,
							message: `The editor at ${endpoint} returned a capability manifest that does not match the companion contract.`,
							recovery:
								"Update UE Shed so the client and Unreal companion use compatible contracts.",
							retrySafe: true,
							nextStep: "escalate",
							cause
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
					retrySafe: true,
					nextStep: "fix_input"
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
					while: (error) =>
						error.code === "transport_failure" &&
						error.retrySafe &&
						error.nextStep === "retry"
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
								retrySafe: true,
								nextStep: "retry"
							})
						)
				})
			);
		});

		return EditorConnection.of({ connect, waitUntilReady });
	})
);

/**
 * Provides a complete explicit EditorConnection test port. The supplied implementation owns
 * outcomes and synchronization; no missing operation falls back to the production service.
 */
export function makeEditorConnectionTestLayer(
	service: EditorConnectionApi
): Layer.Layer<EditorConnection> {
	return Layer.succeed(EditorConnection, EditorConnection.of(service));
}
