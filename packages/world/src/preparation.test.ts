import { it, expect } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { RemoteControlClientError, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import {
	makeWorldPreparation,
	WorldPreparation,
	WorldPreparationError,
	withPreparedWorld
} from "./preparation.js";
import {
	WorldId,
	WorldLeaseId,
	WorldRequest,
	type WorldRequirements,
	type WorldSnapshot
} from "./schema.js";

const world = {
	worldId: WorldId.make("world"),
	mapPath: "/Game/Test",
	projectName: "Test",
	partitioned: true,
	streamingEnabled: true
};
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
				const request = Schema.decodeUnknownSync(WorldRequest)(
					JSON.parse(String(call.parameters.RequestJson))
				);
				calls.push(request);
				if (request.action === "replace") revision = request.revision;
				const custom = override(request);
				return Schema.decodeUnknownSync(Schema.Json)(
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
				);
			})
	};
	return { api: makeWorldPreparation(client, "http://fixture"), calls };
}
const connectionLost = new RemoteControlClientError({
	endpoint: "http://fixture",
	functionName: "ExecuteWorldPreparation",
	operation: "world",
	retrySafe: false,
	message: "Response lost after dispatch"
});

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
		expect(result.failure.message).toContain("Response lost after dispatch");
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
				expect((yield* lease.inspect()).revision).toBe(1);
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
		const result = yield* withPreparedWorld(requirements, () =>
			Effect.fail(
				new WorldPreparationError({
					code: "work_failed",
					operation: "test",
					message: "Work failed",
					recovery: "Inspect work"
				})
			)
		).pipe(Effect.provideService(WorldPreparation, service), Effect.result);
		if (result._tag !== "Failure") throw new Error("Expected a typed restoration failure");
		expect(result.failure.code).toBe("restoration_failed");
		expect(result.failure.message).toContain("Work failed");
		expect(result.failure.message).toContain("External layer change");
	})
);

it.effect("describes and plans without acquiring ownership", () =>
	Effect.gen(function* () {
		const h = harness();
		expect(yield* h.api.describe()).toEqual(world);
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
				expect((yield* lease.inspect()).revision).toBe(1);
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
