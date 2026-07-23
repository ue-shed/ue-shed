import {
	type RemoteControlClientShape,
	type RemoteControlRequest,
	RemoteControlClient,
	RemoteControlClientLive
} from "@ue-shed/unreal-connection";
import { Deferred, Duration, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	Observatory,
	ObservatoryLive,
	WorldScoutRefreshRate,
	type WorldObservationState
} from "./index.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const observatoryObjectPath = "/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary";
const playSessionObjectPath = "/Script/UEShedCoreEditor.Default__UEShedEditorPlaySessionLibrary";

const ObservationStatus = Schema.Struct({
	status: Schema.Literals(["live", "stopped"]),
	capability: Schema.String,
	cadenceHz: Schema.Number,
	effectiveCadenceHz: Schema.Number,
	sessionId: Schema.String,
	catalogRevision: Schema.String,
	pipeName: Schema.String,
	counters: Schema.Struct({
		samplesAttempted: Schema.Number,
		samplesDelivered: Schema.Number,
		actorsSampled: Schema.Number,
		actorsChanged: Schema.Number,
		catalogRebuilds: Schema.Number,
		boundsCalculations: Schema.Number,
		samplingAvgMicros: Schema.Number,
		samplingMaxMicros: Schema.Number,
		bytesSent: Schema.Number,
		producerReplacements: Schema.Number,
		pipeConnected: Schema.Boolean,
		resetCount: Schema.Number
	})
});

const PlaySessionState = Schema.Struct({
	state: Schema.Struct({
		mode: Schema.optional(Schema.String),
		status: Schema.Literals(["stopped", "running", "paused"])
	})
});

const live = Layer.mergeAll(
	ObservatoryLive.pipe(Layer.provide(RemoteControlClientLive)),
	RemoteControlClientLive
);

const getObservationStatus = Effect.fn("Observatory.real.getStatus")(function* () {
	const remote = yield* RemoteControlClient;
	const value = yield* remote.request({
		endpoint: endpoint!,
		functionName: "GetActorObservationStatus",
		objectPath: observatoryObjectPath,
		operation: "observatory.status",
		parameters: {}
	});
	return yield* Schema.decodeUnknownEffect(ObservationStatus)(value);
});

const getPlaySessionState = Effect.fn("Observatory.real.getPlaySession")(function* () {
	const remote = yield* RemoteControlClient;
	const value = yield* remote.request({
		endpoint: endpoint!,
		functionName: "GetPlaySessionState",
		objectPath: playSessionObjectPath,
		operation: "editor.play_session.status",
		parameters: {}
	});
	return yield* Schema.decodeUnknownEffect(PlaySessionState)(value);
});

const executePlaySession = Effect.fn("Observatory.real.executePlaySession")(function* (
	functionName: "StartPlaySession" | "StopPlaySession"
) {
	const remote = yield* RemoteControlClient;
	yield* remote.request({
		endpoint: endpoint!,
		functionName,
		objectPath: playSessionObjectPath,
		operation: `editor.play_session.${functionName}`,
		parameters: {}
	});
});

const waitForPlayStatus = (status: "stopped" | "running") =>
	getPlaySessionState().pipe(
		Effect.filterOrFail(
			(response) => response.state.status === status,
			() => new Error(`Play session did not reach ${status}`)
		),
		Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "15 seconds" })))
	);

const ensureStopped = Effect.gen(function* () {
	const current = yield* getPlaySessionState();
	if (current.state.status !== "stopped") {
		yield* executePlaySession("StopPlaySession");
		yield* waitForPlayStatus("stopped");
	}
});

function interceptStartNotSupported(inner: RemoteControlClientShape): RemoteControlClientShape {
	return {
		request: (request: RemoteControlRequest) => {
			if (request.functionName === "StartActorObservation") {
				return Effect.succeed({
					status: "not_supported",
					message: "Synthetic unsupported Observatory stream for fallback proof.",
					recovery: "Use bounded GetActorSnapshot polling at no more than 10 Hz."
				});
			}
			return inner.request(request);
		}
	};
}

describe.skipIf(!endpoint)("real Unreal Observatory actor observation", () => {
	it("negotiates a stream, receives transform packets, and keeps bounds stable", async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				yield* ensureStopped;
				yield* executePlaySession("StartPlaySession");
				yield* waitForPlayStatus("running");

				const observatory = yield* Observatory;
				const liveStates: WorldObservationState[] = [];
				const diagnostics: Array<{
					readonly actorsChanged: number;
					readonly sequence: bigint;
				}> = [];
				const ready = yield* Deferred.make<void>();
				const twoPackets = yield* Deferred.make<void>();

				const fiber = yield* observatory
					.observe(endpoint!, {
						cadenceHz: WorldScoutRefreshRate.make(30),
						onDiagnostic: (diagnostic) =>
							Effect.gen(function* () {
								diagnostics.push({
									actorsChanged: diagnostic.actorsChanged,
									sequence: diagnostic.sequence
								});
								if (diagnostics.length >= 2) {
									yield* Deferred.succeed(twoPackets, undefined);
								}
							})
					})
					.pipe(
						Stream.runForEach((state) =>
							Effect.gen(function* () {
								if (state.status === "live") {
									liveStates.push(state);
									yield* Deferred.succeed(ready, undefined);
								}
							})
						),
						Effect.forkScoped
					);

				yield* Deferred.await(ready).pipe(Effect.timeout(Duration.seconds(20)));
				yield* Deferred.await(twoPackets).pipe(Effect.timeout(Duration.seconds(15)));
				expect(diagnostics.length).toBeGreaterThanOrEqual(2);
				expect(diagnostics[1]!.sequence).toBeGreaterThan(diagnostics[0]!.sequence);
				expect(diagnostics.some((row) => row.actorsChanged > 0)).toBe(true);

				const firstLive = liveStates.at(-1);
				expect(firstLive?.status).toBe("live");
				if (firstLive?.status !== "live") {
					return yield* Fiber.interrupt(fiber);
				}
				expect(firstLive.sample.catalog.entries.length).toBeGreaterThan(0);
				expect(firstLive.sample.catalog.worldKind).toBe("pie");
				expect(firstLive.sample.catalog.mapPath).toMatch(/L_CameraLoad/);

				let stable = false;
				for (let attempt = 0; attempt < 3 && !stable; attempt += 1) {
					const statusBefore = yield* getObservationStatus();
					expect(statusBefore.status).toBe("live");
					const boundsBefore = statusBefore.counters.boundsCalculations;
					const samplesBefore = statusBefore.counters.samplesAttempted;
					const actorsSampledBefore = statusBefore.counters.actorsSampled;
					yield* Effect.sleep("1200 millis");
					const statusAfter = yield* getObservationStatus();
					expect(statusAfter.status).toBe("live");
					if (
						statusAfter.sessionId !== statusBefore.sessionId ||
						statusAfter.catalogRevision !== statusBefore.catalogRevision
					) {
						continue;
					}
					expect(statusAfter.counters.boundsCalculations).toBe(boundsBefore);
					expect(statusAfter.counters.samplesAttempted).toBeGreaterThan(samplesBefore);
					expect(statusAfter.counters.actorsSampled).toBeGreaterThan(actorsSampledBefore);
					stable = true;
				}
				expect(stable).toBe(true);

				const focusTarget = firstLive.sample.catalog.entries.find((entry) =>
					entry.className.includes("Flying")
				);
				expect(focusTarget).toBeDefined();
				const focus = yield* observatory.focus(endpoint!, focusTarget!.id, false);
				expect(focus.status).toBe("focused");

				yield* Fiber.interrupt(fiber);
				yield* Effect.sleep("250 millis");
				const statusStopped = yield* getObservationStatus();
				expect(statusStopped.status).toBe("stopped");
			}).pipe(
				Effect.ensuring(
					executePlaySession("StopPlaySession").pipe(
						Effect.andThen(waitForPlayStatus("stopped")),
						Effect.ignore
					)
				)
			)
		);

		await Effect.runPromise(program.pipe(Effect.provide(live)));
	}, 90_000);

	it("emits reset across PIE transition and retains the last sample when PIE stops", async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				yield* ensureStopped;
				yield* Effect.sleep("500 millis");

				const observatory = yield* Observatory;
				const states: WorldObservationState[] = [];
				const sawEditorLive = yield* Deferred.make<void>();
				const sawPieLive = yield* Deferred.make<{
					readonly sessionId: string;
					readonly revision: bigint;
				}>();
				const sawStaleOrUnavailable = yield* Deferred.make<WorldObservationState>();

				const fiber = yield* observatory
					.observe(endpoint!, { cadenceHz: WorldScoutRefreshRate.make(20) })
					.pipe(
						Stream.runForEach((state) =>
							Effect.gen(function* () {
								states.push(state);
								if (
									state.status === "live" &&
									state.sample.catalog.worldKind === "editor"
								) {
									yield* Deferred.succeed(sawEditorLive, undefined);
								}
								if (
									state.status === "live" &&
									state.sample.catalog.worldKind === "pie"
								) {
									yield* Deferred.succeed(sawPieLive, {
										sessionId: state.sample.catalog.sessionId,
										revision: state.sample.catalog.revision
									});
								}
								if (
									(state.status === "stale" || state.status === "unavailable") &&
									state.sample !== undefined
								) {
									yield* Deferred.succeed(sawStaleOrUnavailable, state);
								}
							})
						),
						Effect.forkScoped
					);

				yield* Deferred.await(sawEditorLive).pipe(Effect.timeout(Duration.seconds(30)));

				yield* executePlaySession("StartPlaySession");
				yield* waitForPlayStatus("running");
				const pieIdentity = yield* Deferred.await(sawPieLive).pipe(
					Effect.timeout(Duration.seconds(30))
				);

				const mixedPieSessions = states.filter(
					(state) =>
						state.status === "live" &&
						state.sample.catalog.worldKind === "pie" &&
						state.sample.catalog.sessionId !== pieIdentity.sessionId
				);
				expect(mixedPieSessions).toHaveLength(0);

				yield* executePlaySession("StopPlaySession");
				yield* waitForPlayStatus("stopped");
				const retained = yield* Deferred.await(sawStaleOrUnavailable).pipe(
					Effect.timeout(Duration.seconds(30))
				);
				expect(retained.status === "stale" || retained.status === "unavailable").toBe(true);
				if (retained.status !== "stale" && retained.status !== "unavailable") {
					return yield* Fiber.interrupt(fiber);
				}
				expect(retained.sample).toBeDefined();
				expect(retained.sample!.catalog.entries.length).toBeGreaterThan(0);

				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.ensuring(ensureStopped.pipe(Effect.ignore)))
		);

		await Effect.runPromise(program.pipe(Effect.provide(live)));
	}, 120_000);

	it("uses explicit polling_fallback when StartActorObservation is unsupported", async () => {
		const program = Effect.gen(function* () {
			yield* ensureStopped;
			const realRemote = yield* RemoteControlClient;
			const fallbackLayer = ObservatoryLive.pipe(
				Layer.provide(
					Layer.succeed(RemoteControlClient, interceptStartNotSupported(realRemote))
				)
			);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const observatory = yield* Observatory;
					const fallback = yield* Deferred.make<WorldObservationState>();
					const fiber = yield* observatory
						.observe(endpoint!, { cadenceHz: WorldScoutRefreshRate.make(30) })
						.pipe(
							Stream.runForEach((state) =>
								state.status === "polling_fallback"
									? Deferred.succeed(fallback, state).pipe(Effect.asVoid)
									: Effect.void
							),
							Effect.forkScoped
						);
					const state = yield* Deferred.await(fallback).pipe(
						Effect.timeout(Duration.seconds(20))
					);
					expect(state.status).toBe("polling_fallback");
					if (state.status !== "polling_fallback") {
						return yield* Fiber.interrupt(fiber);
					}
					expect(state.cadenceHz).toBeLessThanOrEqual(10);
					expect(state.snapshot.actors.length).toBeGreaterThan(0);

					const focusTarget = state.snapshot.actors[0]!;
					const focus = yield* observatory.focus(endpoint!, focusTarget.id, false);
					expect(["focused", "not_found", "not_supported"]).toContain(focus.status);
					yield* Fiber.interrupt(fiber);
				})
			).pipe(Effect.provide(fallbackLayer));
		});

		await Effect.runPromise(program.pipe(Effect.provide(RemoteControlClientLive)));
	}, 60_000);
});
