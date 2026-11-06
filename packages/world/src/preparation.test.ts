import { it, expect } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { RemoteControlClientError, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import {
	makeWorldPreparation,
	WorldPreparation,
	WorldPreparationError,
	withPreparedWorld,
	worldPreparationGuidance
} from "./preparation.js";
import {
	WorldId,
	WorldLeaseId,
	WorldRequest,
	worldPreparationContract,
	type WorldRequirements,
	type WorldSnapshot
} from "./schema.js";

const decodeJsonEffect = Schema.decodeUnknownEffect(Schema.Json);
const WorldRequestJson = Schema.fromJsonString(WorldRequest);
const decodeWorldRequestJson = Schema.decodeUnknownEffect(WorldRequestJson);
const world = {
	worldId: WorldId.make("world"),
	mapPath: "/Game/Test",
	projectName: "Test",
	partitioned: true,
	streamingEnabled: true
};

it("decodes only known world preparation error codes", () => {
	const decodeCode = Schema.decodeUnknownSync(WorldPreparationError.fields.code);
	expect(decodeCode("actor_missing")).toBe("actor_missing");
	expect(() => decodeCode("unknown_failure")).toThrow();
	const recoveries = WorldPreparationError.fields.code.literals.map(
		(code) => worldPreparationGuidance(code).recovery
	);
	expect(new Set(recoveries).size).toBe(recoveries.length);
});

it.effect("reports an unknown producer failure as an invalid contract", () =>
	Effect.gen(function* () {
		const h = harness((request) =>
			request.action === "describe"
				? Effect.succeed({
						status: "failed",
						code: "unknown_failure",
						message: "Unknown",
						recovery: "Inspect"
					})
				: undefined
		);
		const error = yield* Effect.flip(h.api.describe);
		expect(error.code).toBe("invalid_contract");
		expect(error.nextStep).toBe("escalate");
	})
);
const requirements: WorldRequirements = {
	world,
	targets: [
		{
			kind: "region",
			region: { center: { x: 0, y: 0, z: 0 }, extent: { x: 100, y: 100, z: 100 } }
		}
	],
	dataLayers: [],
	maximumActors: 50
};
const id = WorldLeaseId.make("lease");
const evidence = (status: WorldSnapshot["status"], revision = 0): WorldSnapshot => ({
	status,
	revision,
	world,
	leaseId: id,
	actors: [],
	regions: [],
	issues: [],
	renderReadiness: "not_assessed"
});
function harness(
	override: (
		request: WorldRequest
	) => Effect.Effect<unknown, RemoteControlClientError> | undefined = () => undefined
) {
	const calls: WorldRequest[] = [];
	let revision = 0;
	const client: RemoteControlClientApi = {
		request: (call) =>
			Effect.gen(function* () {
				if (call.functionName === "GetCapabilityManifest")
					return {
						schemaVersion: 1,
						producerKind: "unreal_editor",
						capabilities: ["world.preparation.v1"],
						worldPreparationObjectPath: "/Script/Test"
					};
				const request = yield* decodeWorldRequestJson(call.parameters.RequestJson).pipe(
					Effect.orDie
				);
				calls.push(request);
				if (request.action === "replace") revision = request.revision;
				const custom = override(request);
				return yield* decodeJsonEffect(
					custom
						? yield* custom
						: request.action === "describe"
							? { status: "described", world }
							: {
									...evidence(
										request.action === "release"
											? "released"
											: request.action === "plan"
												? "planned"
												: "ready",
										revision
									),
									leaseId: request.action === "plan" ? "plan" : id
								}
				).pipe(Effect.orDie);
			})
	};
	return { api: makeWorldPreparation(client, "http://fixture"), calls };
}
const connectionLost = new RemoteControlClientError({
	code: "transport_failed",
	endpoint: "http://fixture",
	functionName: "ExecuteWorldPreparation",
	operation: "world",
	retrySafe: false,
	message: "Response lost after dispatch",
	recovery: "Test double: retry the Remote Control call.",
	nextStep: "escalate"
});

function restorationContext(error: WorldPreparationError) {
	if (!Cause.isCause(error.cause)) throw new Error("Expected structured restoration cause");
	const defect = error.cause.reasons.filter(Cause.isDieReason)[0]?.defect;
	if (!(defect instanceof Error)) throw new Error("Expected restoration context");
	return defect.cause;
}

it.effect("reports failed restoration even when the work succeeds", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "release" ? Effect.fail(connectionLost) : undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const result = yield* withPreparedWorld(requirements, () => Effect.succeed("done")).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected restoration failure");
		expect(result.failure.code).toBe("restoration_failed");
		expect(result.failure.message).toBe(
			"The owned world lease could not restore editor state."
		);
		expect(restorationContext(result.failure)).toMatchObject({
			error: { cause: connectionLost }
		});
	})
);

it.effect("preserves defects raised by cleanup itself", () =>
	Effect.gen(function* () {
		const defect = new Error("Cleanup programming defect");
		const h = harness((r) => (r.action === "release" ? Effect.die(defect) : undefined));
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const result = yield* withPreparedWorld(requirements, () => Effect.void).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.exit
		);
		if (Exit.isSuccess(result)) throw new Error("Expected cleanup defect");
		expect(
			result.cause.reasons.some(
				(reason) => Cause.isDieReason(reason) && reason.defect === defect
			)
		).toBe(true);
	})
);

it.effect("preserves interruption and waits for release even when release fails", () =>
	Effect.gen(function* () {
		for (const cleanupFails of [false, true]) {
			const entered = yield* Deferred.make<void>();
			const h = harness((r) =>
				cleanupFails && r.action === "release" ? Effect.fail(connectionLost) : undefined
			);
			const service = WorldPreparation.of({
				...h.api,
				acquire: (input) => h.api.acquire(input, { leaseId: id })
			});
			const fiber = yield* withPreparedWorld(requirements, () =>
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
			).pipe(Effect.provideService(WorldPreparation, service), Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(fiber);
			const result = yield* Fiber.await(fiber);
			if (Exit.isSuccess(result)) throw new Error("Expected interruption");
			expect(Cause.hasInterrupts(result.cause)).toBe(true);
			if (cleanupFails)
				expect(Cause.pretty(result.cause)).toContain("Response lost after dispatch");
			expect(h.calls.at(-1)?.action).toBe("release");
		}
	})
);

it.effect("preserves caller defects when restoration succeeds or fails", () =>
	Effect.gen(function* () {
		for (const cleanupFails of [false, true]) {
			const defect = new Error("Caller programming defect");
			const h = harness((r) =>
				cleanupFails && r.action === "release"
					? Effect.succeed({
							status: "failed",
							code: "restoration_conflict",
							message: "External layer change",
							recovery: "Inspect preserved state"
						})
					: undefined
			);
			const service = WorldPreparation.of({
				...h.api,
				acquire: (input) => h.api.acquire(input, { leaseId: id })
			});
			const result = yield* withPreparedWorld(requirements, () => Effect.die(defect)).pipe(
				Effect.provideService(WorldPreparation, service),
				Effect.exit
			);
			if (Exit.isSuccess(result)) throw new Error("Expected the caller defect");
			expect(
				result.cause.reasons.some(
					(reason) => Cause.isDieReason(reason) && reason.defect === defect
				)
			).toBe(true);
			if (cleanupFails) expect(Cause.pretty(result.cause)).toContain("External layer change");
			expect(h.calls.at(-1)?.action).toBe("release");
		}
	})
);

it.effect("preserves typed work errors when restoration succeeds", () =>
	Effect.gen(function* () {
		const h = harness();
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const error = { code: "work_failed" };
		const result = yield* withPreparedWorld(requirements, () => Effect.fail(error)).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected the work error");
		expect(result.failure).toBe(error);
		expect(h.calls.at(-1)?.action).toBe("release");
	})
);

it.effect("retries a lost replacement response with exactly the same revision and targets", () =>
	Effect.gen(function* () {
		let replacements = 0;
		const h = harness((r) =>
			r.action === "replace" && ++replacements === 1 ? Effect.fail(connectionLost) : undefined
		);
		yield* Effect.scoped(
			Effect.gen(function* () {
				const lease = yield* h.api.acquire(requirements, { leaseId: id });
				expect((yield* lease.replace([])).revision).toBe(1);
				expect((yield* lease.inspect).revision).toBe(1);
				expect((yield* lease.replace(requirements.targets)).revision).toBe(2);
			})
		);
		const requests = h.calls.filter((r) => r.action === "replace");
		expect(requests).toHaveLength(3);
		expect(requests[0]).toEqual(requests[1]);
		expect(h.calls.at(-1)?.action).toBe("release");
	})
);

it.effect("reports work and restoration failures through the scoped public boundary", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "release"
				? Effect.succeed({
						status: "failed",
						code: "restoration_conflict",
						message: "External layer change",
						recovery: "Inspect preserved state"
					})
				: undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const workError = new WorldPreparationError({
			code: "invalid_request",
			operation: "test",
			message: "Work failed",
			recovery: "Inspect work",
			retrySafe: false,
			nextStep: "escalate"
		});
		const result = yield* withPreparedWorld(requirements, () => Effect.fail(workError)).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected a typed restoration failure");
		expect(result.failure.code).toBe("restoration_failed");
		if (!Cause.isCause(result.failure.cause)) throw new Error("Expected combined failures");
		expect(
			result.failure.cause.reasons.some(
				(reason) => Cause.isFailReason(reason) && reason.error === workError
			)
		).toBe(true);
		expect(restorationContext(result.failure)).toMatchObject({
			error: {
				code: "restoration_conflict",
				message: "External layer change"
			}
		});
	})
);

it.effect("preserves an independent cleanup defect that shares the work error value", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "release"
				? Effect.succeed({
						status: "failed",
						code: "restoration_conflict",
						message: "External layer change",
						recovery: "Inspect preserved state"
					})
				: undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const sharedError = new Error("shared work and finalizer error");
		const result = yield* withPreparedWorld(requirements, () =>
			Effect.gen(function* () {
				yield* Effect.addFinalizer(() => Effect.die(sharedError));
				return yield* Effect.fail(sharedError);
			})
		).pipe(Effect.provideService(WorldPreparation, service), Effect.exit);
		if (Exit.isSuccess(result)) throw new Error("Expected a defect");
		expect(Cause.hasFails(result.cause)).toBe(false);
		expect(
			result.cause.reasons.some(
				(reason) => Cause.isDieReason(reason) && reason.defect === sharedError
			)
		).toBe(true);
	})
);

it.effect("preserves an independent cleanup defect when the work repeats the same failure", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "release"
				? Effect.succeed({
						status: "failed",
						code: "restoration_conflict",
						message: "External layer change",
						recovery: "Inspect preserved state"
					})
				: undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const sharedError = new Error("shared work and finalizer error");
		const result = yield* withPreparedWorld(requirements, () =>
			Effect.gen(function* () {
				yield* Effect.addFinalizer(() => Effect.die(sharedError));
				return yield* Effect.failCause(
					Cause.fromReasons([
						...Cause.fail(sharedError).reasons,
						...Cause.fail(sharedError).reasons
					])
				);
			})
		).pipe(Effect.provideService(WorldPreparation, service), Effect.exit);
		if (Exit.isSuccess(result)) throw new Error("Expected a defect");
		expect(Cause.hasFails(result.cause)).toBe(false);
		expect(
			result.cause.reasons.some(
				(reason) => Cause.isDieReason(reason) && reason.defect === sharedError
			)
		).toBe(true);
	})
);

it.effect(
	"preserves an independent cleanup defect when restoration carriers share the work exit",
	() =>
		Effect.gen(function* () {
			const h = harness((r) =>
				r.action === "release"
					? Effect.succeed({
							status: "failed",
							code: "restoration_conflict",
							message: "External layer change",
							recovery: "Inspect preserved state"
						})
					: undefined
			);
			const service = WorldPreparation.of({
				...h.api,
				acquire: (input) => h.api.acquire(input, { leaseId: id })
			});
			const sharedError = new Error("shared work and finalizer error");
			const result = yield* withPreparedWorld(requirements, () =>
				Effect.gen(function* () {
					yield* h.api.acquire(requirements, { leaseId: id });
					yield* Effect.addFinalizer(() => Effect.die(sharedError));
					return yield* Effect.fail(sharedError);
				})
			).pipe(Effect.provideService(WorldPreparation, service), Effect.exit);
			if (Exit.isSuccess(result)) throw new Error("Expected a defect");
			expect(Cause.hasFails(result.cause)).toBe(false);
			expect(
				result.cause.reasons.some(
					(reason) => Cause.isDieReason(reason) && reason.defect === sharedError
				)
			).toBe(true);
			expect(h.calls.filter((call) => call.action === "release")).toHaveLength(2);
		})
);

it.effect("reports a typed work failure with a restoration failure as typed", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "release"
				? Effect.succeed({
						status: "failed",
						code: "restoration_conflict",
						message: "External layer change",
						recovery: "Inspect preserved state"
					})
				: undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const workError = new WorldPreparationError({
			code: "invalid_request",
			operation: "test",
			message: "Work failed",
			recovery: "Inspect work",
			retrySafe: false,
			nextStep: "escalate"
		});
		const result = yield* withPreparedWorld(requirements, () => Effect.fail(workError)).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected a typed restoration failure");
		expect(result.failure.code).toBe("restoration_failed");
		if (!Cause.isCause(result.failure.cause)) throw new Error("Expected combined failures");
		expect(
			result.failure.cause.reasons.some(
				(reason) => Cause.isFailReason(reason) && reason.error === workError
			)
		).toBe(true);
		expect(
			result.failure.cause.reasons.some(
				(reason) => Cause.isDieReason(reason) && reason.defect === workError
			)
		).toBe(false);
	})
);

it.effect("gives callback finalizers the real work exit", () =>
	Effect.gen(function* () {
		for (const kind of ["typed", "defect"] as const) {
			let observed: Exit.Exit<unknown, unknown> | undefined;
			const h = harness();
			const service = WorldPreparation.of({
				...h.api,
				acquire: (input) => h.api.acquire(input, { leaseId: id })
			});
			const workError = new WorldPreparationError({
				code: "invalid_request",
				operation: "test",
				message: "Work failed",
				recovery: "Inspect work",
				retrySafe: false,
				nextStep: "escalate"
			});
			const defect = new Error("callback work defect");
			const result = yield* withPreparedWorld(requirements, () =>
				Effect.gen(function* () {
					yield* Effect.addFinalizer((exit) =>
						Effect.sync(() => {
							observed = exit;
						})
					);
					return kind === "typed" ? yield* workError : yield* Effect.die(defect);
				})
			).pipe(Effect.provideService(WorldPreparation, service), Effect.exit);
			if (Exit.isSuccess(result)) throw new Error("Expected work failure");
			if (observed === undefined) throw new Error("Expected a finalizer exit");
			if (Exit.isSuccess(observed)) throw new Error("Expected the real failed work exit");
			const expected = kind === "typed" ? workError : defect;
			expect(
				observed.cause.reasons.some((reason) =>
					Cause.isFailReason(reason)
						? reason.error === expected
						: Cause.isDieReason(reason) && reason.defect === expected
				)
			).toBe(true);
		}
	})
);

it.effect("translates acquisition and restoration failures through the typed boundary", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "acquire"
				? Effect.succeed({
						...evidence("blocked"),
						issues: [
							{
								code: "actor_unloaded",
								subject: "actor",
								message: "Actor is not loaded."
							}
						]
					})
				: r.action === "release"
					? Effect.succeed({
							status: "failed",
							code: "restoration_conflict",
							message: "External layer change",
							recovery: "Inspect preserved state"
						})
					: undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const result = yield* withPreparedWorld(requirements, () => Effect.void).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected restoration failure");
		expect(result.failure.code).toBe("restoration_failed");
		if (!Cause.isCause(result.failure.cause)) throw new Error("Expected combined failures");
		expect(
			result.failure.cause.reasons.some(
				(reason) =>
					Cause.isFailReason(reason) &&
					reason.error instanceof WorldPreparationError &&
					reason.error.code === "preparation_blocked"
			)
		).toBe(true);
		expect(h.calls.map((call) => call.action)).toEqual(["acquire", "release"]);
	})
);

it.effect("closes the lease scope when the work is interrupted", () =>
	Effect.gen(function* () {
		const entered = yield* Deferred.make<void>();
		const h = harness();
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const fiber = yield* withPreparedWorld(requirements, () =>
			Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
		).pipe(Effect.provideService(WorldPreparation, service), Effect.forkChild);
		yield* Deferred.await(entered);
		yield* Fiber.interrupt(fiber);
		const result = yield* Fiber.await(fiber);
		if (Exit.isSuccess(result)) throw new Error("Expected interruption");
		expect(Cause.hasInterrupts(result.cause)).toBe(true);
		expect(h.calls.at(-1)?.action).toBe("release");
	})
);

it.effect("keeps restoration evidence when cancellation arrives during release", () =>
	Effect.gen(function* () {
		const releaseStarted = yield* Deferred.make<void>();
		const releaseUnblock = yield* Deferred.make<void>();
		const h = harness((r) =>
			r.action === "release"
				? Effect.gen(function* () {
						yield* Deferred.succeed(releaseStarted, undefined);
						yield* Deferred.await(releaseUnblock);
						return {
							status: "failed",
							code: "restoration_conflict",
							message: "External layer change",
							recovery: "Inspect preserved state"
						};
					})
				: undefined
		);
		const service = WorldPreparation.of({
			...h.api,
			acquire: (input) => h.api.acquire(input, { leaseId: id })
		});
		const fiber = yield* withPreparedWorld(requirements, () => Effect.succeed("done")).pipe(
			Effect.provideService(WorldPreparation, service),
			Effect.forkChild
		);
		yield* Deferred.await(releaseStarted);
		yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
		yield* Effect.yieldNow;
		yield* Deferred.succeed(releaseUnblock, undefined);
		const result = yield* Fiber.await(fiber);
		if (Exit.isSuccess(result)) throw new Error("Expected interruption");
		expect(Cause.hasInterrupts(result.cause)).toBe(true);
		expect(
			result.cause.reasons.some(
				(reason) =>
					Cause.isDieReason(reason) &&
					reason.defect instanceof Error &&
					reason.defect.name === "WorldRestorationFailure"
			)
		).toBe(true);
		expect(Cause.pretty(result.cause)).toContain("External layer change");
	})
);

it.effect(
	"keeps restoration evidence when cancellation arrives during release after typed work",
	() =>
		Effect.gen(function* () {
			const releaseStarted = yield* Deferred.make<void>();
			const releaseUnblock = yield* Deferred.make<void>();
			const h = harness((r) =>
				r.action === "release"
					? Effect.gen(function* () {
							yield* Deferred.succeed(releaseStarted, undefined);
							yield* Deferred.await(releaseUnblock);
							return {
								status: "failed",
								code: "restoration_conflict",
								message: "External layer change",
								recovery: "Inspect preserved state"
							};
						})
					: undefined
			);
			const service = WorldPreparation.of({
				...h.api,
				acquire: (input) => h.api.acquire(input, { leaseId: id })
			});
			const workError = new WorldPreparationError({
				code: "invalid_request",
				operation: "test",
				message: "Work failed",
				recovery: "Inspect work",
				retrySafe: false,
				nextStep: "escalate"
			});
			const fiber = yield* withPreparedWorld(requirements, () => Effect.fail(workError)).pipe(
				Effect.provideService(WorldPreparation, service),
				Effect.forkChild
			);
			yield* Deferred.await(releaseStarted);
			yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			yield* Deferred.succeed(releaseUnblock, undefined);
			const result = yield* Fiber.await(fiber);
			if (Exit.isSuccess(result)) throw new Error("Expected interruption");
			expect(Cause.hasInterrupts(result.cause)).toBe(true);
			expect(
				result.cause.reasons.some(
					(reason) =>
						Cause.isDieReason(reason) &&
						reason.defect instanceof Error &&
						reason.defect.name === "WorldRestorationFailure"
				)
			).toBe(true);
			expect(Cause.pretty(result.cause)).toContain("External layer change");
		})
);

it.effect("describes and plans without acquiring ownership", () =>
	Effect.gen(function* () {
		const h = harness();
		expect(yield* h.api.describe).toEqual(world);
		expect((yield* h.api.plan(requirements)).status).toBe("planned");
		expect(h.calls.map((r) => r.action)).toEqual(["describe", "plan"]);
	})
);
it.effect("replaces with the next revision and releases after scoped work", () =>
	Effect.gen(function* () {
		const h = harness();
		yield* Effect.scoped(
			Effect.gen(function* () {
				const lease = yield* h.api.acquire(requirements, { leaseId: id });
				expect((yield* lease.replace([])).revision).toBe(1);
				expect((yield* lease.inspect).revision).toBe(1);
			})
		);
		expect(h.calls.at(-1)?.action).toBe("release");
		expect(h.calls.filter((r) => r.action === "release")).toHaveLength(1);
	})
);
it.effect("releases uncertain acquisition after two lost responses", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "acquire" ? Effect.fail(connectionLost) : undefined
		);
		const result = yield* Effect.scoped(h.api.acquire(requirements, { leaseId: id })).pipe(
			Effect.result
		);
		expect(result._tag).toBe("Failure");
		expect(h.calls.map((r) => r.action)).toEqual(["acquire", "acquire", "release"]);
		expect(h.calls[0]).toEqual(h.calls[1]);
	})
);
it.effect("does not release another owner's rejected lease", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "acquire"
				? Effect.succeed({
						status: "failed",
						code: "lease_conflict",
						message: "Owned",
						recovery: "Choose a new identity"
					})
				: undefined
		);
		yield* Effect.scoped(h.api.acquire(requirements, { leaseId: id })).pipe(Effect.result);
		expect(h.calls.map((r) => r.action)).toEqual(["acquire"]);
	})
);
it.effect("blocked evidence fails acquisition and releases its references", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "acquire"
				? Effect.succeed({
						...evidence("blocked"),
						issues: [
							{ code: "actor_unloaded", subject: "actor", message: "Layer filter" }
						]
					})
				: undefined
		);
		const result = yield* Effect.scoped(h.api.acquire(requirements, { leaseId: id })).pipe(
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected failure");
		expect(result.failure.code).toBe("preparation_blocked");
		expect(result.failure.snapshot?.issues[0]?.code).toBe("actor_unloaded");
		expect(h.calls.at(-1)?.action).toBe("release");
	})
);
it.effect("guards work when renewal reports lost ownership", () =>
	Effect.gen(function* () {
		const renewed = yield* Deferred.make<void>();
		const h = harness((r) =>
			r.action === "poll"
				? Deferred.succeed(renewed, undefined).pipe(Effect.as(evidence("released")))
				: undefined
		);
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				const lease = yield* h.api.acquire(requirements, { leaseId: id });
				const work = yield* lease.guard(Effect.never).pipe(Effect.forkScoped);
				yield* Deferred.await(renewed);
				return yield* Fiber.join(work);
			})
		).pipe(Effect.result);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("lease_released");
		expect(h.calls.at(-1)?.action).toBe("release");
	})
);
it.effect("rejects unrelated response evidence and cleans up uncertain ownership", () =>
	Effect.gen(function* () {
		const h = harness((r) =>
			r.action === "acquire"
				? Effect.succeed({ ...evidence("ready"), leaseId: "other" })
				: undefined
		);
		const result = yield* Effect.scoped(h.api.acquire(requirements, { leaseId: id })).pipe(
			Effect.result
		);
		if (result._tag !== "Failure") throw new Error("Expected failure");
		expect(result.failure.code).toBe("correlation_mismatch");
		expect(h.calls.at(-1)?.action).toBe("release");
	})
);

it("guides each world failure to its next step", () => {
	expect(worldPreparationGuidance("connection_failed")).toMatchObject({
		retrySafe: true,
		nextStep: "retry"
	});
	expect(worldPreparationGuidance("revision_conflict")).toMatchObject({
		retrySafe: false,
		nextStep: "reconcile"
	});
	expect(worldPreparationGuidance("layer_missing")).toMatchObject({
		retrySafe: false,
		nextStep: "fix_input"
	});
	expect(worldPreparationGuidance("restoration_failed")).toMatchObject({
		retrySafe: false,
		nextStep: "escalate"
	});
});

it.effect("reconciles a retained lease identity acquired with different requirements", () =>
	Effect.gen(function* () {
		const h = harness((request) =>
			request.action === "acquire"
				? Effect.succeed({
						status: "failed",
						code: "lease_conflict",
						message: "This identity retains another acquisition request.",
						recovery:
							"Inspect the retained lease and choose a new acquisition identity."
					})
				: undefined
		);
		const request = {
			contract: worldPreparationContract,
			action: "acquire" as const,
			leaseId: id,
			leaseMs: 1000,
			requirements
		};
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const error = yield* Effect.flip(h.api.execute(request));
			expect(error.code).toBe("lease_conflict");
			expect(error.nextStep).toBe("reconcile");
			expect(error.retrySafe).toBe(false);
			expect(error.recovery).toContain("new acquisition identity");
		}
		expect(worldPreparationGuidance("active_lease_limit")).toMatchObject({
			retrySafe: true,
			nextStep: "retry"
		});
	})
);
