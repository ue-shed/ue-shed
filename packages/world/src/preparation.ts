import { randomUUID } from "node:crypto";
import {
	Cause,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Metric,
	PubSub,
	Schedule,
	Schema,
	Scope,
	Semaphore,
	Stream
} from "effect";
import {
	decodeCompanionCapabilityManifest,
	ErrorCauseFields,
	ErrorGuidanceFields
} from "@ue-shed/protocol";
import { RemoteControlClient, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import {
	WorldLeaseId,
	WorldRequest,
	WorldRequirements,
	WorldResponse,
	WorldSnapshot,
	worldPreparationContract,
	type WorldIdentity,
	type WorldTarget
} from "./schema.js";

const WorldPreparationErrorCode = Schema.Literals([
	"connection_failed",
	"active_lease_limit",
	"lease_conflict",
	"correlation_mismatch",
	"lease_released",
	"lease_unknown",
	"revision_conflict",
	"world_changed",
	"actor_missing",
	"bounds_unavailable",
	"budget_exceeded",
	"capability_unavailable",
	"container_unavailable",
	"dependency_budget_exceeded",
	"editor_required",
	"invalid_request",
	"layer_conflict",
	"layer_missing",
	"policy_mismatch",
	"preparation_blocked",
	"retention_budget_exceeded",
	"invalid_contract",
	"restoration_failed",
	"restoration_conflict"
]);

const worldPreparationRecovery = {
	connection_failed:
		"Check the editor connection and reconnect before repeating the world preparation request.",
	active_lease_limit: "Wait for an active world preparation lease to finish, then try again.",
	lease_conflict:
		"Inspect the retained lease in the editor and choose a new acquisition identity.",
	correlation_mismatch:
		"Read the current world and lease evidence, then prepare the intended world again.",
	lease_released:
		"Acquire a new world preparation lease before inspecting or replacing its targets.",
	lease_unknown:
		"Inspect the active editor leases and acquire a new lease for the intended world.",
	revision_conflict: "Read the current lease revision before replacing its targets.",
	world_changed:
		"Select the intended editor world and refresh its identity before preparing it again.",
	actor_missing:
		"Check that the requested actor exists in the selected map and update the target.",
	bounds_unavailable:
		"Give the requested actor valid bounds in the editor or choose an explicit region.",
	budget_exceeded:
		"Narrow the requested actors or region, or increase the explicit actor budget.",
	capability_unavailable:
		"Enable a matching UEShedWorld plugin in the project and restart the editor.",
	container_unavailable:
		"Load the requested actor container in the editor or choose an available container.",
	dependency_budget_exceeded:
		"Narrow the target dependencies or increase the explicit dependency budget.",
	editor_required: "Open the project in an editor world and end any active play session.",
	invalid_request:
		"Correct the world preparation request and use the supported contract version.",
	layer_conflict:
		"Remove duplicate Data Layer requests and resolve conflicting layer states in the editor.",
	layer_missing: "Check the Data Layer names in the selected map and choose an existing layer.",
	policy_mismatch:
		"Refresh the selected world streaming policy and update the preparation requirements.",
	preparation_blocked:
		"Inspect the blocked actors and Data Layers in the editor and make them available.",
	retention_budget_exceeded:
		"Wait for retained lease evidence to expire before acquiring another lease.",
	invalid_contract:
		"Update the host and UEShedWorld plugin to matching versions and report the retained contract failure.",
	restoration_failed:
		"Inspect the editor world and restore the owned actors and Data Layers manually, then report the restoration failure.",
	restoration_conflict:
		"Inspect the actors and Data Layers changed during the lease and report the restoration conflict before preparing again."
} satisfies Record<typeof WorldPreparationErrorCode.Type, string>;

export class WorldPreparationError extends Schema.TaggedError<WorldPreparationError>()(
	"WorldPreparationError",
	{
		code: WorldPreparationErrorCode,
		operation: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		snapshot: Schema.optionalKey(WorldSnapshot)
	}
) {}
// Effect finalizers cannot fail in the typed channel. Only this private carrier is
// translated by withPreparedWorld; unrelated defects must retain their original cause.
class WorldRestorationFailure extends Error {
	constructor(error: WorldPreparationError, original: Exit.Exit<unknown, unknown>) {
		super("The owned world lease could not restore editor state.", {
			cause: { error, original }
		});
		this.name = "WorldRestorationFailure";
	}
}
/**
 * Guidance for client and editor failure codes. Requests carry a lease id and revision, so a lost
 * response may be sent again; a held or full lease table may free up. Changed worlds, revisions
 * and leases need a fresh read; contract and restoration failures go to a person.
 */
export function worldPreparationGuidance(
	code: WorldPreparationError["code"]
): Pick<WorldPreparationError, "retrySafe" | "nextStep" | "recovery"> {
	switch (code) {
		case "connection_failed":
		case "active_lease_limit":
			return { recovery: worldPreparationRecovery[code], retrySafe: true, nextStep: "retry" };
		case "lease_conflict":
		case "correlation_mismatch":
		case "lease_released":
		case "lease_unknown":
		case "revision_conflict":
		case "world_changed":
			return {
				recovery: worldPreparationRecovery[code],
				retrySafe: false,
				nextStep: "reconcile"
			};
		case "actor_missing":
		case "bounds_unavailable":
		case "budget_exceeded":
		case "capability_unavailable":
		case "container_unavailable":
		case "dependency_budget_exceeded":
		case "editor_required":
		case "invalid_request":
		case "layer_conflict":
		case "layer_missing":
		case "policy_mismatch":
		case "preparation_blocked":
		case "retention_budget_exceeded":
			return {
				recovery: worldPreparationRecovery[code],
				retrySafe: false,
				nextStep: "fix_input"
			};
		case "invalid_contract":
		case "restoration_failed":
		case "restoration_conflict":
			return {
				recovery: worldPreparationRecovery[code],
				retrySafe: false,
				nextStep: "escalate"
			};
	}
}
const failure = (
	code: WorldPreparationError["code"],
	operation: string,
	message: string,
	snapshot?: WorldSnapshot,
	cause?: unknown
) =>
	new WorldPreparationError({
		code,
		operation,
		message,
		...(cause === undefined ? undefined : { cause }),
		...worldPreparationGuidance(code),
		...(snapshot === undefined ? undefined : { snapshot })
	});
const decode = <S extends Schema.Top, Input>(schema: S, value: Input, operation: string) =>
	Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
		Effect.mapError((cause) =>
			failure(
				"invalid_contract",
				operation,
				`The world preparation ${operation} value does not match its contract.`,
				undefined,
				cause
			)
		)
	);
const operations = Metric.frequency("ue_shed_world_preparation_operations", {
	description: "World preparation requests by action"
});
const outcomes = Metric.frequency("ue_shed_world_preparation_outcomes", {
	description: "Native world preparation response states"
});
export interface WorldLease {
	readonly id: WorldLeaseId;
	readonly progress: Stream.Stream<WorldSnapshot>;
	readonly inspect: () => Effect.Effect<WorldSnapshot, WorldPreparationError>;
	/** Poll once, renew ownership, and fail with evidence if preparation is blocked. */
	readonly checkReady: () => Effect.Effect<WorldSnapshot, WorldPreparationError>;
	readonly replace: (
		targets: ReadonlyArray<WorldTarget>
	) => Effect.Effect<WorldSnapshot, WorldPreparationError>;
	/** Interrupt work promptly if lease renewal fails. */
	readonly guard: <A, E, R>(
		work: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | WorldPreparationError, R>;
}
export interface WorldPreparationApi {
	readonly describe: () => Effect.Effect<WorldIdentity, WorldPreparationError>;
	readonly plan: (
		requirements: WorldRequirements
	) => Effect.Effect<WorldSnapshot, WorldPreparationError>;
	readonly acquire: (
		requirements: WorldRequirements,
		options?: {
			readonly leaseId?: WorldLeaseId;
			readonly leaseMs?: number;
		}
	) => Effect.Effect<WorldLease, WorldPreparationError, Scope.Scope>;
	/** Validated wire operations for non-scoped clients and recovery tools. Poll renews a lease. */
	readonly execute: (
		request: WorldRequest
	) => Effect.Effect<WorldResponse, WorldPreparationError>;
}
export class WorldPreparation extends Context.Service<WorldPreparation, WorldPreparationApi>()(
	"@ue-shed/world/WorldPreparation"
) {}
/**
 * Host options for world preparation. `requestTimeout` bounds each world preparation call to the
 * editor (default 30 seconds); raise it for large World Partition maps whose loads take longer.
 */
export interface WorldPreparationOptions {
	readonly requestTimeout?: Duration.Input;
}
export const worldPreparationLayer = (
	endpoint: string,
	options: WorldPreparationOptions = {}
): Layer.Layer<WorldPreparation, never, RemoteControlClient> =>
	Layer.effect(
		WorldPreparation,
		Effect.gen(function* () {
			return makeWorldPreparation(yield* RemoteControlClient, endpoint, options);
		})
	);
export const worldPreparationTestLayer = (
	api: WorldPreparationApi
): Layer.Layer<WorldPreparation> => Layer.succeed(WorldPreparation, WorldPreparation.of(api));

export function makeWorldPreparation(
	client: RemoteControlClientApi,
	endpoint: string,
	options: WorldPreparationOptions = {}
): WorldPreparationApi {
	const requestTimeout = options.requestTimeout ?? "30 seconds";
	const execute = Effect.fn("WorldPreparation.execute")(function* (input: WorldRequest) {
		const request = yield* decode(WorldRequest, input, input.action);
		yield* Metric.update(operations, request.action);
		yield* Effect.annotateCurrentSpan({
			"world.action": request.action,
			"unreal.endpoint": endpoint
		});
		const manifest = yield* client
			.request({
				endpoint,
				objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
				functionName: "GetCapabilityManifest",
				idempotent: true,
				parameters: {},
				operation: "world.negotiate"
			})
			.pipe(
				Effect.flatMap(decodeCompanionCapabilityManifest),
				Effect.mapError((cause) =>
					failure(
						"connection_failed",
						request.action,
						"The editor's world preparation capability could not be negotiated.",
						undefined,
						cause
					)
				)
			);
		if (
			!manifest.capabilities.includes("world.preparation.v1") ||
			!manifest.worldPreparationObjectPath
		)
			return yield* failure(
				"capability_unavailable",
				request.action,
				"Enable a matching UEShedWorld plugin in the connected editor."
			);
		const response = yield* client
			.request({
				endpoint,
				objectPath: manifest.worldPreparationObjectPath,
				functionName: "ExecuteWorldPreparation",
				parameters: { RequestJson: JSON.stringify(request) },
				operation: `world.${request.action}`,
				timeout: requestTimeout
			})
			.pipe(
				Effect.mapError((cause) =>
					failure(
						"connection_failed",
						request.action,
						`The editor's world preparation ${request.action} call failed.`,
						undefined,
						cause
					)
				),
				Effect.flatMap((value) => decode(WorldResponse, value, request.action))
			);
		yield* Metric.update(outcomes, response.status);
		if (response.status === "failed") {
			const code = yield* decode(WorldPreparationErrorCode, response.code, request.action);
			return yield* new WorldPreparationError({
				...response,
				operation: request.action,
				code,
				...worldPreparationGuidance(code)
			});
		}
		return response;
	});
	const snapshot = (request: WorldRequest) =>
		execute(request).pipe(
			Effect.flatMap((response) =>
				response.status === "described"
					? Effect.fail(
							failure(
								"invalid_contract",
								request.action,
								"Expected world preparation evidence."
							)
						)
					: Effect.succeed(response)
			)
		);
	const describe = Effect.fn("WorldPreparation.describe")(function* () {
		const result = yield* execute({ contract: worldPreparationContract, action: "describe" });
		if (result.status !== "described")
			return yield* failure(
				"invalid_contract",
				"describe",
				"Expected editor world identity."
			);
		return result.world;
	});
	const plan = Effect.fn("WorldPreparation.plan")(function* (requirements: WorldRequirements) {
		const result = yield* snapshot({
			contract: worldPreparationContract,
			action: "plan",
			requirements
		});
		if (
			result.status !== "planned" ||
			result.leaseId !== "plan" ||
			result.revision !== 0 ||
			result.world.worldId !== requirements.world.worldId ||
			result.world.mapPath !== requirements.world.mapPath
		)
			return yield* failure(
				"correlation_mismatch",
				"plan",
				"The plan does not describe the requested world."
			);
		return result;
	});
	const acquire = Effect.fn("WorldPreparation.acquire")(function* (
		input: WorldRequirements,
		options: { readonly leaseId?: WorldLeaseId; readonly leaseMs?: number } = {}
	) {
		const requirements = yield* decode(WorldRequirements, input, "acquire");
		const id = options.leaseId ?? WorldLeaseId.make(randomUUID());
		const leaseMs = options.leaseMs ?? 120000;
		const begin = yield* decode(
			WorldRequest,
			{
				contract: worldPreparationContract,
				action: "acquire",
				leaseId: id,
				leaseMs,
				requirements
			},
			"acquire"
		);
		const identity = {
			contract: worldPreparationContract,
			leaseId: id,
			worldId: requirements.world.worldId
		};
		const mutex = yield* Semaphore.make(1);
		const lost = yield* Deferred.make<never, WorldPreparationError>();
		const events = yield* PubSub.sliding<WorldSnapshot>(16);
		let revision = 0;
		let closed = false;
		let ownsOrUncertain = true;
		yield* Effect.addFinalizer(() => PubSub.shutdown(events));
		// Establish recovery before sending Begin: its response can be lost after native acquisition.
		yield* Effect.addFinalizer((exit) => {
			closed = true;
			if (!ownsOrUncertain) return Effect.void;
			return snapshot({ ...identity, action: "release" }).pipe(
				Effect.flatMap((result) =>
					result.status === "released" &&
					result.leaseId === id &&
					result.world.worldId === identity.worldId &&
					result.issues.length === 0
						? Effect.void
						: Effect.fail(
								failure(
									"restoration_failed",
									"release",
									"The editor did not release the lease.",
									result
								)
							)
				),
				Effect.catchCause((cleanup) => {
					// Scope finalizer failure replaces the work exit in Effect v4. Preserve
					// its defects/interruption explicitly and retain typed work errors in diagnostics.
					const original = Exit.isFailure(exit)
						? exit.cause.reasons.filter((reason) => !Cause.isFailReason(reason))
						: [];
					const restored = cleanup.reasons.flatMap((reason) =>
						Cause.isFailReason(reason)
							? Cause.die(new WorldRestorationFailure(reason.error, exit)).reasons
							: [reason]
					);
					return Effect.failCause(Cause.fromReasons([...original, ...restored]));
				}),
				mutex.withPermits(1)
			);
		});
		const check = (result: WorldSnapshot, expectedRevision: number) => {
			if (
				result.leaseId !== id ||
				result.world.worldId !== identity.worldId ||
				result.revision !== expectedRevision
			)
				return Effect.fail(
					failure(
						"correlation_mismatch",
						"inspect",
						"Preparation evidence belongs to another lease or revision."
					)
				);
			if (result.status === "released")
				return Effect.fail(
					failure(
						"lease_released",
						"inspect",
						"The native lease is no longer active.",
						result
					)
				);
			return PubSub.publish(events, result).pipe(Effect.as(result));
		};
		const opened = yield* snapshot(begin).pipe(
			Effect.catchIf(
				(error) => error.code === "connection_failed",
				() => snapshot(begin)
			),
			Effect.tapError((error) =>
				Effect.sync(() => {
					if (error.code !== "connection_failed" && error.code !== "invalid_contract")
						ownsOrUncertain = false;
				})
			),
			Effect.flatMap((result) => check(result, 0))
		);
		const ready = (result: WorldSnapshot) =>
			result.status === "ready"
				? Effect.succeed(result)
				: Effect.fail(
						failure(
							"preparation_blocked",
							"prepare",
							"Required actors or layers are unavailable.",
							result
						)
					);
		yield* ready(opened);
		const inspect = Effect.fn("WorldLease.inspect")(function* () {
			if (closed)
				return yield* failure("lease_released", "inspect", "The lease scope has ended.");
			return yield* snapshot({ ...identity, action: "poll" }).pipe(
				Effect.flatMap((value) => check(value, revision))
			);
		}, mutex.withPermits(1));
		const checkReady = Effect.fn("WorldLease.checkReady")(function* () {
			const value = yield* inspect();
			return yield* ready(value);
		});
		const replace = Effect.fn("WorldLease.replace")(function* (
			targets: ReadonlyArray<WorldTarget>
		) {
			if (closed)
				return yield* failure("lease_released", "replace", "The lease scope has ended.");
			const next = revision + 1;
			const request: WorldRequest = {
				...identity,
				action: "replace",
				revision: next,
				targets
			};
			const result = yield* snapshot(request).pipe(
				Effect.catchIf(
					(error) => error.code === "connection_failed",
					() => snapshot(request)
				),
				Effect.flatMap((value) => check(value, next))
			);
			revision = next;
			return yield* ready(result);
		}, mutex.withPermits(1));
		const guard = <A, E, R>(work: Effect.Effect<A, E, R>) =>
			Effect.raceFirst(work, Deferred.await(lost));
		yield* checkReady().pipe(
			Effect.repeat(Schedule.spaced(leaseMs / 3)),
			Effect.catch((error) => Deferred.fail(lost, error)),
			Effect.forkScoped
		);
		return {
			id,
			inspect,
			checkReady,
			replace,
			guard,
			progress: Stream.fromPubSub(events)
		} satisfies WorldLease;
	});
	return WorldPreparation.of({ execute, describe, plan, acquire });
}

/**
 * Run guarded work and report expected restoration failures without hiding defects or interruption.
 * `leaseOptions` passes a lease ID or duration to `acquire` (default 120 seconds).
 */
export const withPreparedWorld = Effect.fn("WorldPreparation.withPreparedWorld")(function* <
	A,
	E,
	R
>(
	requirements: WorldRequirements,
	use: (lease: WorldLease) => Effect.Effect<A, E, R>,
	leaseOptions: { readonly leaseId?: WorldLeaseId; readonly leaseMs?: number } = {}
) {
	const outcome = yield* Effect.exit(
		Effect.scoped(
			Effect.gen(function* () {
				const service = yield* WorldPreparation;
				const lease = yield* service.acquire(requirements, leaseOptions);
				return yield* lease.guard(use(lease));
			})
		)
	);
	if (Exit.isSuccess(outcome)) return outcome.value;
	const defects = outcome.cause.reasons.filter(Cause.isDieReason);
	if (
		!Cause.hasInterrupts(outcome.cause) &&
		defects.length > 0 &&
		defects.every((reason) => reason.defect instanceof WorldRestorationFailure)
	)
		return yield* failure(
			"restoration_failed",
			"scope",
			"The owned world lease could not restore editor state.",
			undefined,
			outcome.cause
		);
	return yield* Effect.failCause(outcome.cause);
});
