import {
	decodeCompanionCapabilityManifest,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { EditorPlaySession, type EditorPlaySessionError } from "@ue-shed/engine-discovery";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { movementGymScenario } from "./demo.js";
import {
	decodeScenarioCancelResponse,
	decodeScenarioPrepareResponse,
	decodeScenarioStartResponse,
	decodeScenarioStatusResponse,
	movementGymExecutionRequest,
	SCENARIO_EXECUTION_CAPABILITIES,
	type ScenarioCancelResponse,
	type ScenarioPrepareResponse,
	type ScenarioStartResponse,
	type ScenarioStatusResponse
} from "./live.js";
import type { ScenarioDocument, ScenarioRun } from "./schema.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";

export class ScenarioRunnerError extends Schema.TaggedErrorClass<ScenarioRunnerError>()(
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
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface RunScenarioOptions {
	readonly document?: ScenarioDocument;
	readonly endpoint: string;
	readonly evidenceLimit?: number;
}

export interface ScenarioRunnerShape {
	readonly cancel: (
		endpoint: string,
		runId: string
	) => Effect.Effect<ScenarioCancelResponse, ScenarioRunnerError>;
	readonly run: (options: RunScenarioOptions) => Effect.Effect<ScenarioRun, ScenarioRunnerError>;
}

export class ScenarioRunner extends Context.Service<ScenarioRunner, ScenarioRunnerShape>()(
	"@ue-shed/scenarios/ScenarioRunner"
) {}

class PollPending extends Schema.TaggedErrorClass<PollPending>()("ScenarioRunner.PollPending", {
	operation: Schema.String
}) {}

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
		retrySafe: "retrySafe" in cause ? cause.retrySafe : false
	});
}

function contractError(endpoint: string, operation: string, cause: unknown): ScenarioRunnerError {
	return new ScenarioRunnerError({
		code: "contract_failure",
		endpoint,
		message: `The scenario producer returned an invalid response: ${String(cause)}`,
		operation,
		recovery:
			"Update UE Shed so the client and Unreal scenario capability use compatible contracts.",
		retrySafe: false
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
		retrySafe: false
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
		retrySafe: false
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
				retrySafe: false
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
				retrySafe: false
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

		const call = Effect.fn("ScenarioRunner.call")(function* (options: {
			readonly endpoint: string;
			readonly functionName: string;
			readonly objectPath: string;
			readonly operation: string;
			readonly parameters: Readonly<Record<string, unknown>>;
		}) {
			return yield* remote
				.request(options)
				.pipe(
					Effect.mapError((cause) =>
						transportError(options.endpoint, options.operation, cause)
					)
				);
		});

		const negotiate = Effect.fn("ScenarioRunner.negotiate")(function* (endpoint: string) {
			const operation = "scenario.negotiate";
			const value = yield* call({
				endpoint,
				functionName: "GetCapabilityManifest",
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
			endpoint: string
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
							retrySafe: false
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
							retrySafe: false
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
									retrySafe: false
								})
							);
						}
						return Effect.fail(new PollPending({ operation: "scenario.pie.await" }));
					}
				)
			);
			return yield* readRunning.pipe(
				Effect.retry({
					schedule: Schedule.spaced("50 millis").pipe(
						Schedule.upTo({ duration: "15 seconds" })
					),
					while: (error) => error instanceof PollPending
				}),
				Effect.mapError((error) =>
					error instanceof PollPending
						? new ScenarioRunnerError({
								code: "pie_unavailable",
								endpoint,
								message:
									"Play In Editor did not reach running state before the deadline.",
								operation: error.operation,
								recovery: "Inspect Unreal PIE startup diagnostics, then retry.",
								retrySafe: true
							})
						: error
				)
			);
		});

		const cancel = Effect.fn("ScenarioRunner.cancel")(function* (
			configuredEndpoint: string,
			runId: string
		) {
			const endpoint = endpointOf(configuredEndpoint);
			const target = yield* negotiate(endpoint);
			const operation = "scenario.cancel";
			const value = yield* call({
				endpoint,
				functionName: "CancelScenarioRun",
				objectPath: target.objectPath,
				operation,
				parameters: { RunId: runId }
			});
			return yield* decodeScenarioCancelResponse(value).pipe(
				Effect.mapError((cause) => contractError(endpoint, operation, cause))
			);
		});

		const run = Effect.fn("ScenarioRunner.run")(function* (options: RunScenarioOptions) {
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
			const prepared = yield* decodeScenarioPrepareResponse(preparedValue).pipe(
				Effect.mapError((cause) => contractError(endpoint, prepareOperation, cause))
			);
			if (prepared._tag === "Rejected") {
				return yield* Effect.fail(rejectedError(endpoint, prepareOperation, prepared));
			}
			const pieSessionId = yield* runningPieSessionId(endpoint);
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
						message: String(cause),
						operation: "scenario.request",
						recovery:
							"Use the shipped pre-evaluation Movement Gym document without unsupported tracks.",
						retrySafe: false
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
			const started = yield* decodeScenarioStartResponse(startedValue).pipe(
				Effect.mapError((cause) => contractError(endpoint, startOperation, cause))
			);
			if (started._tag === "Rejected") {
				return yield* Effect.fail(rejectedError(endpoint, startOperation, started));
			}
			const runId = started.runId;
			if (started.pieSessionId !== pieSessionId) {
				yield* cancel(endpoint, runId).pipe(Effect.ignore);
				return yield* Effect.fail(staleBindingError(endpoint, startOperation));
			}
			const pollOperation = "scenario.status";
			const poll = call({
				endpoint,
				functionName: "GetScenarioRunStatus",
				objectPath: target.objectPath,
				operation: pollOperation,
				parameters: { RunId: runId }
			}).pipe(
				Effect.flatMap((value) =>
					decodeScenarioStatusResponse(value).pipe(
						Effect.mapError((cause) => contractError(endpoint, pollOperation, cause))
					)
				),
				Effect.flatMap(
					(response): Effect.Effect<ScenarioRun, ScenarioRunnerError | PollPending> => {
						if (response._tag === "Terminal") {
							if (
								response.result.pieSessionId !== pieSessionId ||
								response.result.scenarioId !== document.id
							) {
								return Effect.fail(staleBindingError(endpoint, pollOperation));
							}
							if (response.result.evidence.length > evidenceLimit) {
								return Effect.fail(
									contractError(
										endpoint,
										pollOperation,
										"producer exceeded the negotiated evidence limit"
									)
								);
							}
							return Effect.succeed(response.result);
						}
						if (response._tag === "Rejected") {
							return Effect.fail(rejectedError(endpoint, pollOperation, response));
						}
						if (response.runId !== runId || response.pieSessionId !== pieSessionId) {
							return Effect.fail(staleBindingError(endpoint, pollOperation));
						}
						return Effect.fail(new PollPending({ operation: pollOperation }));
					}
				)
			);

			return yield* poll.pipe(
				Effect.retry({
					schedule: Schedule.spaced("50 millis").pipe(
						Schedule.upTo({ duration: "45 seconds" })
					),
					while: (error) => error instanceof PollPending
				}),
				Effect.mapError((error) =>
					error instanceof PollPending
						? new ScenarioRunnerError({
								code: "poll_timeout",
								endpoint,
								message:
									"The scenario did not return a terminal result before the deadline.",
								operation: error.operation,
								recovery:
									"Inspect the live run status and cancel it before retrying.",
								retrySafe: false
							})
						: error
				),
				Effect.onInterrupt(() => cancel(endpoint, runId).pipe(Effect.ignore))
			);
		});

		return ScenarioRunner.of({ cancel, run });
	})
);

export function makeScenarioRunnerTestLayer(
	service: ScenarioRunnerShape
): Layer.Layer<ScenarioRunner> {
	return Layer.succeed(ScenarioRunner, ScenarioRunner.of(service));
}
