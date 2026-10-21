import {
	EditorWindowActivation,
	EditorWindowActivationLive,
	EditorForegroundPermissionLive
} from "@ue-shed/engine";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema, type Stream } from "effect";
import { WorldActorSnapshot, type ActorId as ActorIdType } from "./actor-models.js";
import {
	ActorObservationRecoveryExhaustedError,
	ActorObservationSessionError,
	observeActorFeed,
	type ObserveActorFeedOptions
} from "./actor-feed.js";
import type { WorldObservationState } from "./world-observation.js";

export * from "./actor-models.js";
export { actorInstanceKey, remapObservedActorId } from "./actor-identity.js";

import {
	SnapshotResponse,
	FocusResponse,
	WorldScoutRefreshRate,
	WorldScoutFocusResult
} from "./scout-contracts.js";
export {
	WorldScoutRefreshRate,
	WorldScoutResult,
	WorldScoutFocusResult
} from "./scout-contracts.js";
const ObservationCadenceResponse = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), cadenceHz: WorldScoutRefreshRate }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		/** Plugins from 0.17 name the cause (`stream_inactive`, `invalid_cadence`, ...). */
		code: Schema.optionalKey(Schema.String),
		message: Schema.String,
		recovery: Schema.String,
		/** Plugins from 0.17 say whether the same request can succeed later. */
		retrySafe: Schema.optionalKey(Schema.Boolean)
	})
]);

export class ObservatoryConnectionError extends Schema.TaggedError<ObservatoryConnectionError>()(
	"ObservatoryConnectionError",
	{
		operation: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		/** Stable native category, when the Observatory plugin supplies one. */
		code: Schema.optionalKey(Schema.String)
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

/** @deprecated Use `ObservatoryApi`. */
export type ObservatoryShape = ObservatoryApi;

export class Observatory extends Context.Service<Observatory, ObservatoryApi>()(
	"@ue-shed/observatory/Observatory"
) {}

const objectPath = "/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary";
const isRemoteControlClientError = Schema.is(RemoteControlClientError);

function connectionError(
	operation: string,
	cause: RemoteControlClientError | unknown
): ObservatoryConnectionError {
	return new ObservatoryConnectionError({
		message: isRemoteControlClientError(cause)
			? cause.message
			: `The observatory ${operation} response does not match the observatory contract.`,
		operation,
		recovery:
			"Open an editor world with UEShedObservatory enabled, then retry the live world scan.",
		retrySafe: isRemoteControlClientError(cause) ? cause.retrySafe : false,
		nextStep: isRemoteControlClientError(cause) ? cause.nextStep : "fix_input",
		cause
	});
}

/**
 * Observatory over the host's Remote Control client and editor window activation. Hosts that own
 * focus (an Electron shell, a headless run that must never raise a window, or a test) provide
 * their own `EditorWindowActivation`; `ObservatoryLive` supplies the engine's.
 */
export const observatoryLayer = Layer.effect(
	Observatory,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;
		const windowActivation = yield* EditorWindowActivation;

		const snapshot = Effect.fn("Observatory.snapshot")(function* (endpoint: string) {
			const value = yield* remote
				.request({
					endpoint,
					functionName: "GetActorSnapshot",
					idempotent: true,
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
						retrySafe: true,
						nextStep: "retry"
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
					parameters: { ActorId: actorId, BringToFront: false }
				})
				.pipe(Effect.mapError((cause) => connectionError("focus_actor", cause)));
			const focused = yield* Schema.decodeUnknownEffect(FocusResponse)(value).pipe(
				Effect.mapError((cause) => connectionError("focus_actor.decode", cause))
			);
			if (focused.status !== "focused" || !bringToFront) return focused;
			const activation = yield* windowActivation.activate(endpoint).pipe(
				Effect.catch((cause) =>
					Effect.succeed({
						status: "unavailable" as const,
						message: cause.message,
						recovery: cause.recovery
					})
				)
			);
			return { ...focused, windowActivation: activation };
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
			const retrySafe = response.retrySafe ?? true;
			return yield* Effect.fail(
				new ObservatoryConnectionError({
					message: response.message,
					operation: "set_actor_observation_cadence",
					recovery: response.recovery,
					retrySafe,
					nextStep: retrySafe ? "retry" : "fix_input",
					...(response.code === undefined ? undefined : { code: response.code })
				})
			);
		});

		const observe = (endpoint: string, options: ObserveActorFeedOptions) =>
			observeActorFeed(remote, endpoint, options);

		return Observatory.of({ focus, observe, setObservationCadence, snapshot });
	})
);

/** `observatoryLayer` with the engine's editor window activation and foreground permission. */
export const ObservatoryLive: Layer.Layer<Observatory, never, RemoteControlClient> =
	observatoryLayer.pipe(
		Layer.provide(
			EditorWindowActivationLive.pipe(Layer.provide(EditorForegroundPermissionLive))
		)
	);

/**
 * Complete test implementation of the Observatory. The supplied service owns snapshots, focus,
 * cadence and the observation stream; no editor is contacted.
 */
export function makeObservatoryTestLayer(service: ObservatoryApi): Layer.Layer<Observatory> {
	return Layer.succeed(Observatory, Observatory.of(service));
}

export * from "./spatial.js";
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

/** @deprecated Use `ActorFeedApi`. */
export type ActorFeedShape = import("./actor-feed.js").ActorFeedApi;
