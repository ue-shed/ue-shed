import { it } from "@effect/vitest";
import {
	makeEditorPlaySessionTestLayer,
	type EditorPlaySessionApi
} from "@ue-shed/engine-discovery";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { EditorPlaySessionId } from "@ue-shed/protocol";
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { movementGymRuns } from "./demo.js";
import { SCENARIO_EXECUTION_CAPABILITIES, scenarioWireContract } from "./live.js";
import { ScenarioRunner, ScenarioRunnerError, ScenarioRunnerLive } from "./scenario-runner.js";

const pieState = {
	contract: { name: "unreal-editor-play-session", version: { major: 1, minor: 0 } },
	state: { mode: "play", sessionId: EditorPlaySessionId.make("pie-session-1"), status: "running" }
} as const;

const editor: EditorPlaySessionApi = {
	execute: () => Effect.die("unexpected editor command"),
	pause: () => Effect.die("unexpected pause"),
	resume: () => Effect.die("unexpected resume"),
	start: () => Effect.die("unexpected start"),
	status: () => Effect.succeed(pieState),
	stop: () => Effect.die("unexpected stop")
};

const manifest = {
	capabilities: [...SCENARIO_EXECUTION_CAPABILITIES],
	producerKind: "unreal_editor",
	scenarioLimits: {
		maxActions: 8,
		maxDurationMs: 30_000,
		maxEvidence: 8,
		maxKeyframes: 32
	},
	scenariosObjectPath: "/Script/Fixture.Scenarios",
	schemaVersion: 1
} as const;

const prepared = {
	_tag: "Prepared",
	contract: scenarioWireContract,
	mapPath: "/Game/Fixture/Scenarios/L_MovementGym",
	scenarioId: "scenario_movement-gym_014"
} as const;

function runnerLayer(
	handle: Parameters<typeof makeRemoteControlClientTestLayer>[0],
	editorService: EditorPlaySessionApi = editor
) {
	return ScenarioRunnerLive.pipe(
		Layer.provide(
			Layer.merge(
				makeRemoteControlClientTestLayer(handle),
				makeEditorPlaySessionTestLayer(editorService)
			)
		)
	);
}

it.effect("returns a schema-validated terminal ScenarioRun through the public service", () =>
	Effect.gen(function* () {
		const statusReads = yield* Ref.make(0);
		const layer = runnerLayer((request) => {
			if (request.functionName === "GetCapabilityManifest") return Effect.succeed(manifest);
			if (request.functionName === "PrepareScenarioWorld") return Effect.succeed(prepared);
			if (request.functionName === "StartScenarioRun") {
				return Effect.succeed({
					_tag: "Accepted",
					contract: scenarioWireContract,
					pieSessionId: "pie-session-1",
					runId: "run-live-1",
					state: "accepted"
				});
			}
			if (request.functionName === "GetScenarioRunStatus") {
				return Ref.getAndUpdate(statusReads, (value) => value + 1).pipe(
					Effect.map((read) =>
						Schema.decodeUnknownSync(Schema.Json)(
							read === 0
								? {
										_tag: "Active",
										contract: scenarioWireContract,
										gameTimeMs: 20,
										pieSessionId: "pie-session-1",
										runId: "run-live-1",
										state: "running"
									}
								: {
										_tag: "Terminal",
										contract: scenarioWireContract,
										result: {
											...movementGymRuns[1]!,
											pieSessionId: "pie-session-1"
										}
									}
						)
					)
				);
			}
			return Effect.die(`unexpected call ${request.functionName}`);
		});
		return yield* Effect.gen(function* () {
			const runner = yield* ScenarioRunner;
			const fiber = yield* Effect.forkChild(
				runner.run({ endpoint: "http://editor/", evidenceLimit: 2 })
			);
			yield* TestClock.adjust("100 millis");
			const result = yield* Fiber.join(fiber);
			expect(result.status).toBe("completed");
			expect(yield* Ref.get(statusReads)).toBe(2);
		}).pipe(Effect.provide(layer));
	})
);

it.effect("exposes one-shot start and status operations for optional clients", () =>
	Effect.gen(function* () {
		const layer = runnerLayer((request) => {
			if (request.functionName === "GetCapabilityManifest") return Effect.succeed(manifest);
			if (request.functionName === "PrepareScenarioWorld") return Effect.succeed(prepared);
			if (request.functionName === "StartScenarioRun") {
				return Effect.succeed({
					_tag: "Accepted",
					contract: scenarioWireContract,
					pieSessionId: "pie-session-1",
					runId: "run-controlled-1",
					state: "accepted"
				});
			}
			if (request.functionName === "GetScenarioRunStatus") {
				return Effect.succeed({
					_tag: "Active",
					contract: scenarioWireContract,
					gameTimeMs: 4100,
					pieSessionId: "pie-session-1",
					runId: "run-controlled-1",
					state: "waiting"
				});
			}
			return Effect.die(`unexpected call ${request.functionName}`);
		});

		return yield* Effect.gen(function* () {
			const runner = yield* ScenarioRunner;
			const handle = yield* runner.start({ endpoint: "http://editor/" });
			expect(handle.endpoint).toBe("http://editor");
			expect(handle.runId).toBe("run-controlled-1");
			const status = yield* runner.status(handle);
			expect(status).toMatchObject({ _tag: "Active", gameTimeMs: 4100, state: "waiting" });
		}).pipe(Effect.provide(layer));
	})
);

it.effect("fails before starting PIE when the scenario capability is absent", () =>
	Effect.gen(function* () {
		const runner = yield* ScenarioRunner;
		const error = yield* runner.run({ endpoint: "http://editor" }).pipe(Effect.flip);
		expect(error).toBeInstanceOf(ScenarioRunnerError);
		expect(error.code).toBe("capability_unavailable");
	}).pipe(
		Effect.provide(
			runnerLayer(() =>
				Effect.succeed({
					capabilities: [],
					producerKind: "unreal_editor",
					schemaVersion: 1
				})
			)
		)
	)
);

it.effect("maps an editor restart or forgotten run to stale_session", () =>
	Effect.gen(function* () {
		const layer = runnerLayer((request) => {
			if (request.functionName === "GetCapabilityManifest") return Effect.succeed(manifest);
			if (request.functionName === "PrepareScenarioWorld") return Effect.succeed(prepared);
			if (request.functionName === "StartScenarioRun") {
				return Effect.succeed({
					_tag: "Accepted",
					contract: scenarioWireContract,
					pieSessionId: "pie-session-1",
					runId: "forgotten-run",
					state: "accepted"
				});
			}
			return Effect.succeed({
				_tag: "Rejected",
				code: "run_not_found",
				contract: scenarioWireContract,
				message: "The editor restarted.",
				recovery: "Start a fresh run."
			});
		});
		return yield* Effect.gen(function* () {
			const runner = yield* ScenarioRunner;
			const error = yield* runner.run({ endpoint: "http://editor" }).pipe(Effect.flip);
			expect(error.code).toBe("stale_session");
		}).pipe(Effect.provide(layer));
	})
);

it.effect("rejects an active status bound to a replacement PIE session", () =>
	Effect.gen(function* () {
		const layer = runnerLayer((request) => {
			if (request.functionName === "GetCapabilityManifest") return Effect.succeed(manifest);
			if (request.functionName === "PrepareScenarioWorld") return Effect.succeed(prepared);
			if (request.functionName === "StartScenarioRun") {
				return Effect.succeed({
					_tag: "Accepted",
					contract: scenarioWireContract,
					pieSessionId: "pie-session-1",
					runId: "run-live-1",
					state: "accepted"
				});
			}
			return Effect.succeed({
				_tag: "Active",
				contract: scenarioWireContract,
				gameTimeMs: 20,
				pieSessionId: "pie-session-2",
				runId: "run-live-1",
				state: "running"
			});
		});

		return yield* Effect.gen(function* () {
			const runner = yield* ScenarioRunner;
			const error = yield* runner.run({ endpoint: "http://editor" }).pipe(Effect.flip);
			expect(error.code).toBe("stale_session");
		}).pipe(Effect.provide(layer));
	})
);

it.effect("exposes structured producer cancellation through the same contract", () =>
	Effect.gen(function* () {
		const layer = runnerLayer((request) =>
			Effect.succeed(
				request.functionName === "GetCapabilityManifest"
					? manifest
					: {
							_tag: "Accepted",
							contract: scenarioWireContract,
							runId: "run-live-1"
						}
			)
		);
		return yield* Effect.gen(function* () {
			const runner = yield* ScenarioRunner;
			const response = yield* runner.cancel("http://editor", "run-live-1");
			expect(response).toMatchObject({ _tag: "Accepted", runId: "run-live-1" });
		}).pipe(Effect.provide(layer));
	})
);

it.effect("cancels an accepted producer run when the owning effect is interrupted", () =>
	Effect.gen(function* () {
		const firstStatusRead = yield* Deferred.make<void>();
		const cancelCalls = yield* Ref.make(0);
		const layer = runnerLayer((request) => {
			if (request.functionName === "GetCapabilityManifest") return Effect.succeed(manifest);
			if (request.functionName === "PrepareScenarioWorld") return Effect.succeed(prepared);
			if (request.functionName === "StartScenarioRun") {
				return Effect.succeed({
					_tag: "Accepted",
					contract: scenarioWireContract,
					pieSessionId: "pie-session-1",
					runId: "run-interrupted",
					state: "accepted"
				});
			}
			if (request.functionName === "GetScenarioRunStatus") {
				return Deferred.succeed(firstStatusRead, undefined).pipe(
					Effect.as({
						_tag: "Active" as const,
						contract: scenarioWireContract,
						gameTimeMs: 20,
						pieSessionId: "pie-session-1",
						runId: "run-interrupted",
						state: "running" as const
					})
				);
			}
			if (request.functionName === "CancelScenarioRun") {
				return Ref.update(cancelCalls, (value) => value + 1).pipe(
					Effect.as({
						_tag: "Accepted" as const,
						contract: scenarioWireContract,
						runId: "run-interrupted"
					})
				);
			}
			return Effect.die(`unexpected call ${request.functionName}`);
		});

		return yield* Effect.gen(function* () {
			const runner = yield* ScenarioRunner;
			const fiber = yield* Effect.forkChild(runner.run({ endpoint: "http://editor" }));
			yield* Deferred.await(firstStatusRead);
			yield* Fiber.interrupt(fiber);
			expect(yield* Ref.get(cancelCalls)).toBe(1);
		}).pipe(Effect.provide(layer));
	})
);
