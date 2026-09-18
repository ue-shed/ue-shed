import {
	EditorWorldOpenRequest,
	EditorWorldOperation,
	EditorWorldState,
	decodeCompanionCapabilityManifest,
	decodeEditorWorldOpenResponse,
	type EditorWorldOpenResponse
} from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Clock, Context, Duration, Effect, Layer, Schedule, Schema } from "effect";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const capability = "editor.world-control.v1";

export class EditorWorldControlError extends Schema.TaggedErrorClass<EditorWorldControlError>()(
	"EditorWorldControlError",
	{
		code: Schema.Literals([
			"capability_unavailable",
			"contract_failure",
			"request_invalid",
			"operation_indeterminate",
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
	/** Waiting can be interrupted without cancelling or replaying the editor mutation. */
	readonly waitTimeout?: Duration.Input;
	readonly pollInterval?: Duration.Input;
}

export interface EditorWorldControlApi {
	readonly snapshot: (
		endpoint: string
	) => Effect.Effect<EditorWorldState, EditorWorldControlError>;
	readonly open: (
		options: OpenEditorWorldOptions
	) => Effect.Effect<EditorWorldOpenResponse, EditorWorldControlError>;
}

export class EditorWorldControl extends Context.Service<
	EditorWorldControl,
	EditorWorldControlApi
>()("@ue-shed/engine/EditorWorldControl") {}

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
			return {
				endpoint,
				objectPath: manifest.worldControlObjectPath,
				capabilities: manifest.capabilities
			};
		});

		const snapshot = Effect.fn("EditorWorldControl.snapshot")(function* (endpoint: string) {
			const target = yield* objectPath(endpoint);
			const operation = "editor.world_control.snapshot";
			if (!target.capabilities.includes("editor.world-state.v1"))
				return yield* failure({
					code: "capability_unavailable",
					endpoint,
					operation,
					message: "This editor does not expose live map state.",
					recovery: "Update the UE Shed Core plugin and reconnect.",
					retrySafe: false
				});
			const value = yield* remote
				.request({ ...target, functionName: "GetWorldState", operation, parameters: {} })
				.pipe(
					Effect.mapError((cause) =>
						failure({
							code: "transport_failure",
							endpoint,
							operation,
							message: cause.message,
							recovery:
								"The editor may be loading. Waiting for its next state update.",
							retrySafe: true
						})
					)
				);
			return yield* Schema.decodeUnknownEffect(EditorWorldState)(value).pipe(
				Effect.mapError((cause) =>
					failure({
						code: "contract_failure",
						endpoint,
						operation,
						message: String(cause),
						recovery: "Update the UE Shed Core plugin and reconnect.",
						retrySafe: false
					})
				)
			);
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
			if (target.capabilities.includes("editor.world-control.async.v1")) {
				const indeterminate = (message: string, recovery: string) =>
					failure({
						code: "operation_indeterminate",
						endpoint,
						operation,
						message,
						recovery,
						retrySafe: false
					});
				const query = Effect.fn("EditorWorldControl.operationStatus")(function* (
					functionName: string
				) {
					const value = yield* remote
						.request({
							endpoint,
							objectPath: target.objectPath,
							functionName,
							operation,
							parameters: { RequestJson: JSON.stringify(request) }
						})
						.pipe(
							Effect.catchTag("RemoteControlClientError", (cause) =>
								cause.status === undefined || cause.status >= 500
									? Effect.logWarning(
											"Editor map-open acknowledgement unavailable; querying status",
											{
												operationId: request.operationId,
												functionName,
												message: cause.message
											}
										).pipe(Effect.as(undefined))
									: Effect.fail(
											indeterminate(
												cause.message,
												"Check the editor connection and permissions; the open command will not be replayed."
											)
										)
							)
						);
					if (value === undefined) return undefined;
					const status = yield* Schema.decodeUnknownEffect(EditorWorldOperation)(
						value
					).pipe(
						Effect.mapError((cause) =>
							indeterminate(
								String(cause),
								"Update UE Shed to matching client and plugin versions."
							)
						)
					);
					if (
						status.operationId !== request.operationId ||
						status.targetMapPath !== request.targetMapPath
					)
						return yield* indeterminate(
							"Editor returned another map-open operation.",
							"Check the editor's current map before trying again."
						);
					if (status.status === "unavailable")
						return yield* indeterminate(status.message, status.recovery);
					if (status.status !== "completed") return undefined;
					if (
						status.result.operationId !== request.operationId ||
						status.result.targetMapPath !== request.targetMapPath
					)
						return yield* indeterminate(
							"Editor returned another map-open result.",
							"Check the editor's current map before trying again."
						);
					return status.result;
				});
				const deadline =
					(yield* Clock.currentTimeMillis) +
					Duration.toMillis(options.waitTimeout ?? "30 minutes");
				return yield* Effect.gen(function* () {
					// Submit exactly once. A lost acknowledgement is recovered by identity, never replay.
					const started = yield* query("BeginOpenMap");
					if (started) return started;
					const completed = yield* Effect.gen(function* () {
						if ((yield* Clock.currentTimeMillis) >= deadline)
							return yield* indeterminate(
								"Stopped waiting for Unreal to finish loading; its map-open operation may still be running.",
								"Check Unreal and reconnect to its current map. Do not assume the load was cancelled or resend the command."
							);
						return yield* query("GetOpenMapStatus");
					}).pipe(
						Effect.repeat({
							schedule: Schedule.spaced(options.pollInterval ?? "2 seconds"),
							while: (result) => result === undefined
						})
					);
					if (!completed)
						return yield* Effect.die(
							"Map-open polling ended without a terminal result."
						);
					return completed;
				});
			}
			const value = yield* remote
				.request({
					endpoint: target.endpoint,
					functionName: "OpenMap",
					objectPath: target.objectPath,
					operation,
					timeout: options.waitTimeout ?? "30 minutes",
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
								"Check Unreal's current map before trying again. Losing the response does not cancel the load.",
							retrySafe: false
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

		return EditorWorldControl.of({ open, snapshot });
	})
);

export function makeEditorWorldControlTestLayer(
	service: EditorWorldControlApi
): Layer.Layer<EditorWorldControl> {
	return Layer.succeed(EditorWorldControl, EditorWorldControl.of(service));
}
