import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema, type Stream } from "effect";
import {
	ActorId,
	WorldActorSnapshot,
	type ActorId as ActorIdType,
	type ObservedActor as ObservedActorType
} from "./actor-models.js";
import {
	ActorObservationRecoveryExhaustedError,
	ActorObservationSessionError,
	observeActorFeed,
	type ObserveActorFeedOptions
} from "./actor-feed.js";
import type { WorldObservationState } from "./world-observation.js";

export * from "./actor-models.js";
export { actorInstanceKey, remapObservedActorId } from "./actor-identity.js";

export const WorldScoutRefreshRate = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(60)
).pipe(Schema.brand("WorldScoutRefreshRate"));
export type WorldScoutRefreshRate = Schema.Schema.Type<typeof WorldScoutRefreshRate>;

const SnapshotResponse = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		snapshot: WorldActorSnapshot
	}),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);

const FocusResponse = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("focused"),
		actorId: ActorId,
		authoringSubject: Schema.Literals(["selected", "runtime_only"])
	}),
	Schema.Struct({ status: Schema.Literal("not_found"), actorId: ActorId }),
	Schema.Struct({ status: Schema.Literal("not_supported"), actorId: ActorId }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		actorId: ActorId,
		message: Schema.String,
		recovery: Schema.String
	})
]);

export const WorldScoutResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), snapshot: WorldActorSnapshot }),
	Schema.Struct({
		status: Schema.Literal("unavailable"),
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type WorldScoutResult = Schema.Schema.Type<typeof WorldScoutResult>;

export const WorldScoutFocusResult = FocusResponse;
export type WorldScoutFocusResult = Schema.Schema.Type<typeof WorldScoutFocusResult>;

const ObservationCadenceResponse = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), cadenceHz: WorldScoutRefreshRate }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);

export class ObservatoryConnectionError extends Schema.TaggedErrorClass<ObservatoryConnectionError>()(
	"ObservatoryConnectionError",
	{
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ObservatoryApi {
	/** Retunes an active named-pipe producer without replacing its session or writer. */
	readonly setObservationCadence: (
		endpoint: string,
		cadenceHz: WorldScoutRefreshRate
	) => Effect.Effect<WorldScoutRefreshRate, ObservatoryConnectionError>;
	readonly focus: (
		endpoint: string,
		actorId: ActorIdType,
		bringToFront: boolean
	) => Effect.Effect<WorldScoutFocusResult, ObservatoryConnectionError>;
	/**
	 * Own the demand-driven actor observation lifecycle: negotiate a bounded transform stream,
	 * install/reacquire catalogs, apply packets into `WorldObservationState`, and fall back to
	 * bounded snapshot polling when the connected editor does not support streaming.
	 */
	readonly observe: (
		endpoint: string,
		options: ObserveActorFeedOptions
	) => Stream.Stream<
		WorldObservationState,
		ActorObservationSessionError | ActorObservationRecoveryExhaustedError
	>;
	readonly snapshot: (
		endpoint: string
	) => Effect.Effect<WorldActorSnapshot, ObservatoryConnectionError>;
}

export class Observatory extends Context.Service<Observatory, ObservatoryApi>()(
	"@ue-shed/observatory/Observatory"
) {}

const objectPath = "/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary";

function connectionError(
	operation: string,
	cause: RemoteControlClientError | unknown
): ObservatoryConnectionError {
	return new ObservatoryConnectionError({
		message: cause instanceof RemoteControlClientError ? cause.message : String(cause),
		operation,
		recovery:
			"Open an editor world with UEShedObservatory enabled, then retry the live world scan.",
		retrySafe: cause instanceof RemoteControlClientError ? cause.retrySafe : false
	});
}

export const ObservatoryLive = Layer.effect(
	Observatory,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;

		const snapshot = Effect.fn("Observatory.snapshot")(function* (endpoint: string) {
			const value = yield* remote
				.request({
					endpoint,
					functionName: "GetActorSnapshot",
					objectPath,
					operation: "observatory.actor_snapshot",
					parameters: {}
				})
				.pipe(Effect.mapError((cause) => connectionError("actor_snapshot", cause)));
			const response = yield* Schema.decodeUnknownEffect(SnapshotResponse)(value).pipe(
				Effect.mapError((cause) => connectionError("actor_snapshot.decode", cause))
			);
			if (response.status === "failed") {
				return yield* Effect.fail(
					new ObservatoryConnectionError({
						message: response.message,
						operation: "actor_snapshot",
						recovery: response.recovery,
						retrySafe: true
					})
				);
			}
			return response.snapshot;
		});

		const focus = Effect.fn("Observatory.focus")(function* (
			endpoint: string,
			actorId: ActorIdType,
			bringToFront: boolean
		) {
			const value = yield* remote
				.request({
					endpoint,
					functionName: "FocusActor",
					objectPath,
					operation: "observatory.focus_actor",
					parameters: { ActorId: actorId, BringToFront: bringToFront }
				})
				.pipe(Effect.mapError((cause) => connectionError("focus_actor", cause)));
			return yield* Schema.decodeUnknownEffect(FocusResponse)(value).pipe(
				Effect.mapError((cause) => connectionError("focus_actor.decode", cause))
			);
		});

		const setObservationCadence = Effect.fn("Observatory.setObservationCadence")(function* (
			endpoint: string,
			cadenceHz: WorldScoutRefreshRate
		) {
			const value = yield* remote
				.request({
					endpoint,
					functionName: "SetActorObservationCadence",
					objectPath,
					operation: "observatory.set_actor_observation_cadence",
					parameters: { RequestJson: JSON.stringify({ cadenceHz }) }
				})
				.pipe(
					Effect.mapError((cause) =>
						connectionError("set_actor_observation_cadence", cause)
					)
				);
			const response = yield* Schema.decodeUnknownEffect(ObservationCadenceResponse)(
				value
			).pipe(
				Effect.mapError((cause) =>
					connectionError("set_actor_observation_cadence.decode", cause)
				)
			);
			if (response.status === "ready") return response.cadenceHz;
			return yield* Effect.fail(
				new ObservatoryConnectionError({
					message: response.message,
					operation: "set_actor_observation_cadence",
					recovery: response.recovery,
					retrySafe: true
				})
			);
		});

		const observe = (endpoint: string, options: ObserveActorFeedOptions) =>
			observeActorFeed(remote, endpoint, options);

		return Observatory.of({ focus, observe, setObservationCadence, snapshot });
	})
);

export const decodeWorldScoutResult = Schema.decodeUnknownEffect(WorldScoutResult);
export const decodeWorldScoutFocusResult = Schema.decodeUnknownEffect(WorldScoutFocusResult);

export interface SpatialPoint {
	readonly actor: ObservedActorType;
	readonly xPercent: number;
	readonly yPercent: number;
}

export interface SpatialProjection {
	readonly center: { readonly x: number; readonly y: number };
	readonly height: number;
	readonly points: ReadonlyArray<SpatialPoint>;
	readonly width: number;
}

export function projectActors(
	actors: ReadonlyArray<ObservedActorType>,
	paddingRatio = 0.08
): SpatialProjection {
	if (actors.length === 0) {
		return { center: { x: 0, y: 0 }, height: 1, points: [], width: 1 };
	}
	const minX = Math.min(...actors.map((actor) => actor.location.x - actor.bounds.extent.x));
	const maxX = Math.max(...actors.map((actor) => actor.location.x + actor.bounds.extent.x));
	const minY = Math.min(...actors.map((actor) => actor.location.y - actor.bounds.extent.y));
	const maxY = Math.max(...actors.map((actor) => actor.location.y + actor.bounds.extent.y));
	const rawWidth = Math.max(1, maxX - minX);
	const rawHeight = Math.max(1, maxY - minY);
	const padX = rawWidth * paddingRatio;
	const padY = rawHeight * paddingRatio;
	const width = rawWidth + padX * 2;
	const height = rawHeight + padY * 2;
	const size = Math.max(width, height);
	const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
	const left = center.x - size / 2;
	const top = center.y + size / 2;
	return {
		center,
		height,
		points: actors.map((actor) => ({
			actor,
			xPercent: ((actor.location.x - left) / size) * 100,
			yPercent: ((top - actor.location.y) / size) * 100
		})),
		width
	};
}

export {
	ACTOR_STREAM_FLAG_RESET,
	ACTOR_STREAM_HEADER_BYTES,
	ACTOR_STREAM_MAGIC,
	ACTOR_STREAM_MAX_BUFFERED_BYTES,
	ACTOR_STREAM_MAX_PAYLOAD_BYTES,
	ACTOR_STREAM_MAX_RECORDS,
	ACTOR_STREAM_RECORD_BYTES,
	ACTOR_STREAM_VERSION,
	ActorStreamDecoder,
	actorStreamPacketToTransformBatch,
	encodeActorStreamPacket
} from "./actor-stream-protocol.js";
export type {
	ActorStreamPacket,
	ActorStreamRecord,
	EncodeActorStreamPacketInput
} from "./actor-stream-protocol.js";

export {
	applyTransformBatch,
	applyWorldObservationEvent,
	CatalogRevision,
	catalogEntryAt,
	catalogFromSnapshot,
	catalogFromWireEntries,
	connectingState,
	materializeObservedActor,
	ObservationSessionId,
	PacketSequence,
	StreamActorIndex,
	WorldActorCatalog,
	WorldActorCatalogEntry,
	WorldIndexedTransform,
	WorldObservationHealth,
	WorldTransform,
	WorldTransformBatch
} from "./world-observation.js";
export type {
	WorldObservationApplyResult,
	WorldObservationEvent,
	WorldObservationRejectReason,
	WorldObservationSample,
	WorldObservationState,
	WorldTransformStore
} from "./world-observation.js";

export {
	ActorFeed,
	ActorFeedError,
	ActorObservationControlError,
	ActorObservationRecoveryExhaustedError,
	ActorObservationSessionError,
	actorFeedLayer,
	acquireActorFeedScoped,
	makeActorFeedTestLayer,
	observeActorFeed
} from "./actor-feed.js";
export type {
	ActorFeedMetrics,
	ActorFeedOptions,
	ActorFeedApi,
	ActorObservationDiagnostic,
	ObserveActorFeedOptions
} from "./actor-feed.js";
