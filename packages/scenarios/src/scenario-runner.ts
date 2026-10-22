import {
	decodeCompanionCapabilityManifest,
	ErrorCauseFields,
	ErrorGuidanceFields,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { EditorPlaySession, type EditorPlaySessionError } from "@ue-shed/engine";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { movementGymScenario } from "./demo.js";
import {
	parseScenarioCancelResponse,
	parseScenarioPrepareResponse,
	parseScenarioStartResponse,
	parseScenarioStatusResponse,
	movementGymExecutionRequest,
	SCENARIO_EXECUTION_CAPABILITIES,
	type ScenarioCancelResponse,
	type ScenarioPrepareResponse,
	type ScenarioStartResponse,
	type ScenarioStatusResponse
} from "./live.js";
import type { ScenarioDocument, ScenarioRun } from "./schema.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";

export class ScenarioRunnerError extends Schema.TaggedError<ScenarioRunnerError>()(
	"ScenarioRunnerError",
	{
		code: Schema.Literals([
			"capability_unavailable",
			"contract_failure",
			"invalid_document",
			"pie_unavailable",
			"poll_timeout",
			"producer_rejected",
			"stale_session",
			"transport_failure"
		]),
		endpoint: Schema.String,
		operation: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

/**
 * One scenario run. `pieStartTimeout` bounds the wait for Play In Editor to reach running state
 * (default 15 seconds); `resultTimeout` bounds how long `run` waits for a terminal result (default
 * 45 seconds), so raise it for scenarios that last longer.
 */
export interface RunScenarioOptions {
	readonly document?: ScenarioDocument;
	readonly endpoint: string;
	readonly evidenceLimit?: number;
	readonly pieStartTimeout?: Duration.Input;
	readonly resultTimeout?: Duration.Input;
}

import { ScenarioRunHandle, type ScenarioRunnerStatus } from "./runner-contracts.js";
export { ScenarioRunHandle, type ScenarioRunnerStatus } from "./runner-contracts.js";
export interface ScenarioRunnerApi {
	readonly cancel: (
		endpoint: string,
		runId: string
	) => Effect.Effect<ScenarioCancelResponse, ScenarioRunnerError>;
	readonly cancelHandle: (
		handle: ScenarioRunHandle
	) => Effect.Effect<ScenarioCancelResponse, ScenarioRunnerError>;
	readonly run: (options: RunScenarioOptions) => Effect.Effect<ScenarioRun, ScenarioRunnerError>;
	readonly start: (
		options: RunScenarioOptions
	) => Effect.Effect<ScenarioRunHandle, ScenarioRunnerError>;
	readonly status: (
		handle: ScenarioRunHandle
	) => Effect.Effect<ScenarioRunnerStatus, ScenarioRunnerError>;
}

export class ScenarioRunner extends Context.Service<ScenarioRunner, ScenarioRunnerApi>()(
	"@ue-shed/scenarios/ScenarioRunner"
) {}

/** Internal poll marker; it never leaves the runner, but carries the shared guidance shape. */
class PollPending extends Schema.TaggedError<PollPending>()("ScenarioRunner.PollPending", {
	operation: Schema.String,
	...ErrorGuidanceFields
}) {}
const pollPending = (operation: string) =>
	new PollPending({
		operation,
		message: `The ${operation} poll has not reached its awaited state yet.`,
		recovery: "Poll again until the deadline.",
		retrySafe: true,
		nextStep: "retry"
	});
const isPollPending = Schema.is(PollPending);

function endpointOf(configured: string): string {
	return configured.replace(/\/+$/, "");
}

function transportError(
	endpoint: string,
	operation: string,
	cause: RemoteControlClientError | EditorPlaySessionError
): ScenarioRunnerError {
	return new ScenarioRunnerError({
		code: "transport_failure",
		endpoint,
		message: cause.message,
		operation,
		recovery:
			"Confirm that the selected Unreal Editor and Remote Control endpoint are reachable.",
		retrySafe: "retrySafe" in cause ? cause.retrySafe : false,
		nextStep: "retrySafe" in cause && cause.retrySafe ? "retry" : "reconcile",
		cause
	});
}

function contractError(endpoint: string, operation: string, cause: unknown): ScenarioRunnerError {
	return new ScenarioRunnerError({
		code: "contract_failure",
		endpoint,
		message: `The scenario producer at ${endpoint} returned a ${operation} response that does not match the scenario contract.`,
		operation,
		recovery:
			"Update UE Shed so the client and Unreal scenario capability use compatible contracts.",
		retrySafe: false,
		nextStep: "escalate",
		cause
	});
}

function staleBindingError(endpoint: string, operation: string): ScenarioRunnerError {
	return new ScenarioRunnerError({
		code: "stale_session",
		endpoint,
		message: "The producer response no longer matches the accepted run and PIE session.",
		operation,
		recovery:
			"Cancel any remaining producer run and start again against the current PIE session.",
		retrySafe: false,
		nextStep: "reconcile"
	});
}

function rejectedError(
	endpoint: string,
	operation: string,
	response: Extract<
		ScenarioPrepareResponse | ScenarioStartResponse | ScenarioStatusResponse,
		{ readonly _tag: "Rejected" }
	>
): ScenarioRunnerError {
	return new ScenarioRunnerError({
		code:
			response.code === "stale_session" || response.code === "run_not_found"
				? "stale_session"
				: "producer_rejected",
		endpoint,
		message: response.message,
		operation,
		recovery: response.recovery,
		retrySafe: false,
		nextStep:
			response.code === "stale_session" || response.code === "run_not_found"
				? "reconcile"
				: "fix_input"
	});
}

function validateManifest(
	endpoint: string,
	manifest: CompanionCapabilityManifest
): Effect.Effect<
	{ readonly evidenceLimit: number; readonly objectPath: string },
	ScenarioRunnerError
> {
	const missing = SCENARIO_EXECUTION_CAPABILITIES.find(
		(capability) => !manifest.capabilities.includes(capability)
	);
	if (missing !== undefined || manifest.scenariosObjectPath === undefined) {
		return Effect.fail(
			new ScenarioRunnerError({
				code: "capability_unavailable",
				endpoint,
				message: `Connected producer does not advertise ${missing ?? "a scenario object path"}.`,
				operation: "scenario.negotiate",
				recovery:
					"Enable compatible UEShedCore and UEShedScenarios plugins, then reconnect.",
				retrySafe: false,
				nextStep: "fix_input"
			})
		);
	}
	const limits = manifest.scenarioLimits;
	if (
		limits === undefined ||
		limits.maxActions < 4 ||
		limits.maxDurationMs < movementGymScenario.durationMs ||
		limits.maxEvidence < 1 ||
		limits.maxKeyframes < 11
	) {
		return Effect.fail(
			new ScenarioRunnerError({
				code: "capability_unavailable",
				endpoint,
				message:
					"Connected producer does not advertise sufficient bounded scenario limits.",
				operation: "scenario.negotiate",
				recovery: "Use a producer that supports the Movement Gym v1 execution limits.",
				retrySafe: false,
				nextStep: "fix_input"
			})
		);
	}
	return Effect.succeed({
		evidenceLimit: limits.maxEvidence,
		objectPath: manifest.scenariosObjectPath
	});
}

export const ScenarioRunnerLive = Layer.effect(
	ScenarioRunner,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;
		const playSession = yield* EditorPlaySession;

		const call = Effect.fn("ScenarioRunner.call")(
			function* (options: {
				readonly endpoint: string;
				readonly functionName: string;
				readonly idempotent?: boolean;
				readonly objectPath: string;
				readonly operation: string;
				readonly parameters: Schema.JsonObject;
			}) {
				return yield* remote.request(options);
			},
			(effect, options) =>
				effect.pipe(
					Effect.mapError((cause) =>
						transportError(options.endpoint, options.operation, cause)
					)
				)
		);

		const negotiate = Effect.fn("ScenarioRunner.negotiate")(function* (endpoint: string) {
			const operation = "scenario.negotiate";
			const value = yield* call({
				endpoint,
				functionName: "GetCapabilityManifest",
				idempotent: true,
				objectPath: coreObjectPath,
				operation,
				parameters: {}
			});
			const manifest = yield* decodeCompanionCapabilityManifest(value).pipe(
				Effect.mapError((cause) => contractError(endpoint, operation, cause))
			);
			return yield* validateManifest(endpoint, manifest);
		});

		const runningPieSessionId = Effect.fn("ScenarioRunner.runningPieSessionId")(function* (
			endpoint: string,
			timeout: Duration.Input
		) {
			const status = yield* playSession
				.status(endpoint)
				.pipe(
					Effect.mapError((cause) =>
						transportError(endpoint, "scenario.pie.status", cause)
					)
				);
			if (status.state.status === "stopped") {
				const started = yield* playSession
					.start(endpoint, "play")
					.pipe(
						Effect.mapError((cause) =>
							transportError(endpoint, "scenario.pie.start", cause)
						)
					);
				if (started.outcome === "rejected") {
					return yield* Effect.fail(
						new ScenarioRunnerError({
							code: "pie_unavailable",
							endpoint,
							message: started.message,
							operation: "scenario.pie.start",
							recovery: started.recovery,
							retrySafe: false,
							nextStep: "reconcile"
						})
					);
				}
			}
			if (status.state.status === "paused") {
				const resumed = yield* playSession
					.resume(endpoint)
					.pipe(
						Effect.mapError((cause) =>
							transportError(endpoint, "scenario.pie.resume", cause)
						)
					);
				if (resumed.outcome === "rejected") {
					return yield* Effect.fail(
						new ScenarioRunnerError({
							code: "pie_unavailable",
							endpoint,
							message: resumed.message,
							operation: "scenario.pie.resume",
							recovery: resumed.recovery,
							retrySafe: false,
							nextStep: "reconcile"
						})
					);
				}
			}

			const readRunning = playSession.status(endpoint).pipe(
				Effect.mapError((cause) => transportError(endpoint, "scenario.pie.await", cause)),
				Effect.flatMap(
					(response): Effect.Effect<string, ScenarioRunnerError | PollPending> => {
						if (response.state.status === "running" && response.state.mode === "play") {
							return Effect.succeed(response.state.sessionId);
						}
						if (
							response.state.status !== "stopped" &&
							"mode" in response.state &&
							response.state.mode === "simulate"
						) {
							return Effect.fail(
								new ScenarioRunnerError({
									code: "pie_unavailable",
									endpoint,
									message:
										"Scenario execution requires PIE play mode, not simulation.",
									operation: "scenario.pie.await",
									recovery:
										"Stop simulation and start Play In Editor, then retry.",
									retrySafe: false,
									nextStep: "fix_input"
								})
							);
						}
						return Effect.fail(pollPending("scenario.pie.await"));
					}
				)
			);
			return yield* readRunning.pipe(
				Effect.retry({
					schedule: Schedule.spaced("50 millis").pipe(
						Schedule.upTo({ duration: timeout })
					),
					while: isPollPending
				}),
				Effect.mapError((error) =>
					isPollPending(error)
						? new ScenarioRunnerError({
								cause: error,
								code: "pie_unavailable",
								endpoint,
								message:
									"Play In Editor did not reach running state before the deadline.",
								operation: error.operation,
								recovery: "Inspect Unreal PIE startup diagnostics, then retry.",
								retrySafe: true,
								nextStep: "retry"
							})
						: error
				)
			);
		});

		const cancelTarget = Effect.fn("ScenarioRunner.cancelTarget")(function* (
			endpoint: string,
			objectPath: string,
			runId: string
		) {
			const operation = "scenario.cancel";
			const value = yield* call({
				endpoint,
				functionName: "CancelScenarioRun",
				objectPath,
				operation,
				parameters: { RunId: runId }
			});
			return yield* parseScenarioCancelResponse(value).pipe(
				Effect.mapError((cause) => contractError(endpoint, operation, cause))
			);
		});

		const cancel = Effect.fn("ScenarioRunner.cancel")(function* (
			configuredEndpoint: string,
			runId: string
		) {
			const endpoint = endpointOf(configuredEndpoint);
			const target = yield* negotiate(endpoint);
			return yield* cancelTarget(endpoint, target.objectPath, runId);
		});

		const cancelHandle = Effect.fn("ScenarioRunner.cancelHandle")(function* (
			handle: ScenarioRunHandle
		) {
			return yield* cancelTarget(handle.endpoint, handle.objectPath, handle.runId);
		});

		const start = Effect.fn("ScenarioRunner.start")(function* (options: RunScenarioOptions) {
			const endpoint = endpointOf(options.endpoint);
			const document = options.document ?? movementGymScenario;
			const target = yield* negotiate(endpoint);
			const prepareOperation = "scenario.prepare";
			const preparedValue = yield* call({
				endpoint,
				functionName: "PrepareScenarioWorld",
				objectPath: target.objectPath,
				operation: prepareOperation,
				parameters: { MapPath: document.mapPath, ScenarioId: document.id }
			});
			const prepared = yield* parseScenarioPrepareResponse(preparedValue).pipe(
				Effect.mapError((cause) => contractError(endpoint, prepareOperation, cause))
			);
			if (prepared._tag === "Rejected") {
				return yield* Effect.fail(rejectedError(endpoint, prepareOperation, prepared));
			}
			const pieSessionId = yield* runningPieSessionId(
				endpoint,
				options.pieStartTimeout ?? "15 seconds"
			);
			const evidenceLimit = Math.min(
				options.evidenceLimit ?? target.evidenceLimit,
				target.evidenceLimit
			);
			const request = yield* Effect.try({
				try: () => movementGymExecutionRequest({ document, evidenceLimit, pieSessionId }),
				catch: (cause) =>
					new ScenarioRunnerError({
						code: "invalid_document",
						endpoint,
						message:
							"The scenario document cannot be turned into a live Movement Gym execution request.",
						operation: "scenario.request",
						recovery:
							"Use the shipped pre-evaluation Movement Gym document without unsupported tracks.",
						retrySafe: false,
						nextStep: "fix_input",
						cause
					})
			});
			const startOperation = "scenario.start";
			const startedValue = yield* call({
				endpoint,
				functionName: "StartScenarioRun",
				objectPath: target.objectPath,
				operation: startOperation,
				parameters: { RequestJson: JSON.stringify(request) }
			});
			const started = yield* parseScenarioStartResponse(startedValue).pipe(
				Effect.mapError((cause) => contractError(endpoint, startOperation, cause))
			);
			if (started._tag === "Rejected") {
				return yield* Effect.fail(rejectedError(endpoint, startOperation, started));
			}
			const runId = started.runId;
			if (started.pieSessionId !== pieSessionId) {
				yield* cancelTarget(endpoint, target.objectPath, runId).pipe(Effect.ignore);
				return yield* Effect.fail(staleBindingError(endpoint, startOperation));
			}
			return ScenarioRunHandle.make({
				endpoint,
				evidenceLimit,
				objectPath: target.objectPath,
				pieSessionId,
				runId,
				scenarioId: document.id
			});
		});

		const status = Effect.fn("ScenarioRunner.status")(function* (handle: ScenarioRunHandle) {
			const pollOperation = "scenario.status";
			const value = yield* call({
				endpoint: handle.endpoint,
				functionName: "GetScenarioRunStatus",
				objectPath: handle.objectPath,
				operation: pollOperation,
				parameters: { RunId: handle.runId }
			});
			const response = yield* parseScenarioStatusResponse(value).pipe(
				Effect.mapError((cause) => contractError(handle.endpoint, pollOperation, cause))
			);
			if (response._tag === "Rejected") {
				return yield* Effect.fail(rejectedError(handle.endpoint, pollOperation, response));
			}
			if (response._tag === "Terminal") {
				if (
					response.result.pieSessionId !== handle.pieSessionId ||
					response.result.scenarioId !== handle.scenarioId
				) {
					return yield* Effect.fail(staleBindingError(handle.endpoint, pollOperation));
				}
				if (response.result.evidence.length > handle.evidenceLimit) {
					return yield* Effect.fail(
						contractError(
							handle.endpoint,
							pollOperation,
							"producer exceeded the negotiated evidence limit"
						)
					);
				}
				return response;
			}
			if (response.runId !== handle.runId || response.pieSessionId !== handle.pieSessionId) {
				return yield* Effect.fail(staleBindingError(handle.endpoint, pollOperation));
			}
			return response;
		});

		const run = Effect.fn("ScenarioRunner.run")(function* (options: RunScenarioOptions) {
			const handle = yield* start(options);
			const poll = status(handle).pipe(
				Effect.flatMap((response) =>
					response._tag === "Terminal"
						? Effect.succeed(response.result)
						: Effect.fail(pollPending("scenario.status"))
				)
			);

			return yield* poll.pipe(
				Effect.retry({
					schedule: Schedule.spaced("50 millis").pipe(
						Schedule.upTo({ duration: options.resultTimeout ?? "45 seconds" })
					),
					while: isPollPending
				}),
				Effect.mapError((error) =>
					isPollPending(error)
						? new ScenarioRunnerError({
								cause: error,
								code: "poll_timeout",
								endpoint: handle.endpoint,
								message:
									"The scenario did not return a terminal result before the deadline.",
								operation: error.operation,
								recovery:
									"Inspect the live run status and cancel it before retrying.",
								retrySafe: false,
								nextStep: "reconcile"
							})
						: error
				),
				Effect.onInterrupt(() => cancelHandle(handle).pipe(Effect.ignore))
			);
		});

		return ScenarioRunner.of({ cancel, cancelHandle, run, start, status });
	})
);

export function makeScenarioRunnerTestLayer(
	service: ScenarioRunnerApi
): Layer.Layer<ScenarioRunner> {
	return Layer.succeed(ScenarioRunner, ScenarioRunner.of(service));
}
