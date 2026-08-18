import {
	recordObservatoryPacket,
	recordObservatoryReceiverReplacements
} from "@ue-shed/observability";
import { RemoteControlClientError, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import {
	Context,
	Duration,
	Effect,
	Layer,
	PubSub,
	Result,
	Schedule,
	Schema,
	type Scope,
	Stream
} from "effect";
import { createServer, type Server, type Socket } from "node:net";
import { ActorId, WorldActorSnapshot, WorldVector } from "./actor-models.js";
import {
	ACTOR_STREAM_HEADER_BYTES,
	ACTOR_STREAM_RECORD_BYTES,
	ActorStreamDecoder,
	actorStreamPacketToTransformBatch,
	type ActorStreamPacket
} from "./actor-stream-protocol.js";
import {
	applyWorldObservationEvent,
	catalogFromWireEntries,
	CatalogRevision,
	connectingState,
	ObservationSessionId,
	StreamActorIndex,
	type WorldObservationEvent,
	type WorldObservationRejectReason,
	type WorldObservationState
} from "./world-observation.js";

const objectPath = "/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary";

// ---------------------------------------------------------------------------
// Transport-level feed: owns the named-pipe server and decodes USOT packets.
// A dedicated Unreal process names its pipe from its own PID (see
// `StartActorObservation`), so callers typically acquire this feed through
// `observeActorFeed` once the pipe name is known, rather than through the
// static `actorFeedLayer` below (kept for direct/standalone use and tests).
// ---------------------------------------------------------------------------

export interface ActorFeedMetrics {
	readonly bytesReceived: number;
	readonly decodeLimitDrops: number;
	readonly deliveryReplacements: number;
	readonly malformedPackets: number;
	readonly packetsReceived: number;
	readonly startedMonotonicMs: number;
	readonly transportErrors: number;
}

/** One accepted live packet as observed at the host boundary, for benchmarks and diagnostics. */
export interface ActorObservationDiagnostic {
	readonly actorsChanged: number;
	readonly actorsSampled: number;
	readonly decodeApplyMs: number;
	readonly missingSequences: number;
	readonly producerReplacements: number;
	readonly receiverReplacements: number;
	readonly samplingDurationMicros: number;
	readonly sequence: bigint;
}

export class ActorFeedError extends Schema.TaggedErrorClass<ActorFeedError>()("ActorFeedError", {
	message: Schema.String,
	operation: Schema.Literals(["listen", "decode_limit"]),
	pipeName: Schema.String,
	retrySafe: Schema.Boolean
}) {}

export interface ActorFeedApi {
	readonly latestPacket: Effect.Effect<ActorStreamPacket | undefined>;
	readonly metrics: Effect.Effect<ActorFeedMetrics>;
	readonly packets: Stream.Stream<ActorStreamPacket>;
}

export class ActorFeed extends Context.Service<ActorFeed, ActorFeedApi>()(
	"@ue-shed/observatory/ActorFeed"
) {}

export interface ActorFeedOptions {
	readonly capacity?: number;
	readonly maxMalformedPackets?: number;
	readonly pipeName: string;
}

interface AcquiredActorFeed {
	readonly feed: ActorFeedApi;
	readonly pubsub: PubSub.PubSub<ActorStreamPacket>;
	readonly server: Server;
	readonly sockets: Set<Socket>;
}

function listen(server: Server, pipeName: string): Effect.Effect<void, ActorFeedError> {
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					server.off("error", onError);
					server.off("listening", onListening);
					signal.removeEventListener("abort", onAbort);
				};
				const onAbort = () => {
					cleanup();
					try {
						server.close();
					} catch {
						// The server may not have started listening yet.
					}
					reject(signal.reason);
				};
				const onError = (cause: Error) => {
					cleanup();
					reject(cause);
				};
				const onListening = () => {
					cleanup();
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				signal.addEventListener("abort", onAbort, { once: true });
				server.listen(pipeName);
			}),
		catch: (cause) =>
			new ActorFeedError({
				message: String(cause),
				operation: "listen",
				pipeName,
				retrySafe: true
			})
	});
}

function closeActorFeed(resource: AcquiredActorFeed): Effect.Effect<void> {
	return Effect.gen(function* () {
		for (const socket of resource.sockets) socket.destroy();
		yield* Effect.callback<void>((resume) => {
			if (!resource.server.listening) {
				resume(Effect.void);
				return;
			}
			resource.server.close(() => resume(Effect.void));
		});
		yield* PubSub.shutdown(resource.pubsub);
	});
}

function acquireActorFeedResource(
	options: ActorFeedOptions
): Effect.Effect<AcquiredActorFeed, ActorFeedError, Scope.Scope> {
	const pipeName = options.pipeName;
	const capacity = options.capacity ?? 8;
	const maxMalformedPackets = options.maxMalformedPackets ?? 128;
	if (!Number.isInteger(capacity) || capacity <= 0) {
		return Effect.fail(
			new ActorFeedError({
				message: `Actor feed capacity must be a positive integer, received ${capacity}.`,
				operation: "listen",
				pipeName,
				retrySafe: false
			})
		);
	}
	if (!Number.isInteger(maxMalformedPackets) || maxMalformedPackets <= 0) {
		return Effect.fail(
			new ActorFeedError({
				message: `Actor feed maxMalformedPackets must be a positive integer, received ${maxMalformedPackets}.`,
				operation: "decode_limit",
				pipeName,
				retrySafe: false
			})
		);
	}
	return Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const pubsub = yield* PubSub.sliding<ActorStreamPacket>(capacity);
		let latest: ActorStreamPacket | undefined;
		const sockets = new Set<Socket>();
		const startedMonotonicMs = performance.now();
		let bytesReceived = 0;
		let decodeLimitDrops = 0;
		let deliveryReplacements = 0;
		let malformedPackets = 0;
		let packetsReceived = 0;
		let transportErrors = 0;
		const server = createServer((socket) => {
			sockets.add(socket);
			const decoder = new ActorStreamDecoder();
			let consecutiveMalformed = 0;
			socket.on("error", () => {
				transportErrors += 1;
			});
			socket.on("data", (chunk) => {
				bytesReceived += chunk.byteLength;
				const decoded = decoder.push(chunk);
				malformedPackets += decoded.malformed;
				consecutiveMalformed =
					decoded.packets.length > 0
						? decoded.malformed
						: consecutiveMalformed + decoded.malformed;
				for (const packet of decoded.packets) {
					latest = packet;
					packetsReceived += 1;
					Effect.runFork(
						Effect.forkIn(
							Effect.gen(function* () {
								if ((yield* PubSub.size(pubsub)) >= capacity) {
									deliveryReplacements += 1;
									yield* recordObservatoryReceiverReplacements(1);
								}
								yield* PubSub.publish(pubsub, packet);
							}),
							scope
						)
					);
				}
				if (consecutiveMalformed >= maxMalformedPackets) {
					decodeLimitDrops += 1;
					socket.destroy();
				}
			});
			socket.once("close", () => sockets.delete(socket));
		});
		yield* listen(server, pipeName);
		server.on("error", () => {
			transportErrors += 1;
		});
		return {
			feed: {
				latestPacket: Effect.sync(() => latest),
				metrics: Effect.sync(() => ({
					bytesReceived,
					decodeLimitDrops,
					deliveryReplacements,
					malformedPackets,
					packetsReceived,
					startedMonotonicMs,
					transportErrors
				})),
				packets: Stream.fromPubSub(pubsub)
			},
			pubsub,
			server,
			sockets
		} satisfies AcquiredActorFeed;
	});
}

/** Scoped acquisition usable directly (bypassing `Context`) when the pipe name is dynamic. */
export function acquireActorFeedScoped(
	options: ActorFeedOptions
): Effect.Effect<ActorFeedApi, ActorFeedError, Scope.Scope> {
	return Effect.acquireRelease(acquireActorFeedResource(options), closeActorFeed).pipe(
		Effect.map((resource) => resource.feed)
	);
}

export function actorFeedLayer(options: ActorFeedOptions): Layer.Layer<ActorFeed, ActorFeedError> {
	return Layer.effect(ActorFeed, acquireActorFeedScoped(options));
}

export function makeActorFeedTestLayer(feed: Partial<ActorFeedApi> = {}): Layer.Layer<ActorFeed> {
	return Layer.succeed(ActorFeed, {
		latestPacket: feed.latestPacket ?? Effect.succeed(undefined),
		metrics:
			feed.metrics ??
			Effect.succeed({
				bytesReceived: 0,
				decodeLimitDrops: 0,
				deliveryReplacements: 0,
				malformedPackets: 0,
				packetsReceived: 0,
				startedMonotonicMs: 0,
				transportErrors: 0
			}),
		packets: feed.packets ?? Stream.empty
	});
}

// ---------------------------------------------------------------------------
// Control-plane negotiation: StartActorObservation / StopActorObservation /
// GetActorSnapshot, plus the typed errors for control negotiation, session
// mismatch, and bounded recovery exhaustion.
// ---------------------------------------------------------------------------

export class ActorObservationControlError extends Schema.TaggedErrorClass<ActorObservationControlError>()(
	"ActorObservationControlError",
	{
		endpoint: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["start", "stop", "status"]),
		retrySafe: Schema.Boolean,
		status: Schema.optional(Schema.Number)
	}
) {}

export class ActorObservationSessionError extends Schema.TaggedErrorClass<ActorObservationSessionError>()(
	"ActorObservationSessionError",
	{
		endpoint: Schema.String,
		expectedSessionId: Schema.String,
		message: Schema.String,
		receivedSessionId: Schema.String
	}
) {}

export class ActorObservationRecoveryExhaustedError extends Schema.TaggedErrorClass<ActorObservationRecoveryExhaustedError>()(
	"ActorObservationRecoveryExhaustedError",
	{
		attempts: Schema.Int,
		endpoint: Schema.String,
		message: Schema.String
	}
) {}

const WireCatalogActor = Schema.Struct({
	bounds: Schema.Struct({ center: WorldVector, extent: WorldVector }),
	className: Schema.NonEmptyString,
	displayName: Schema.NonEmptyString,
	id: ActorId,
	location: WorldVector,
	path: Schema.NonEmptyString,
	rotation: WorldVector,
	streamIndex: StreamActorIndex
});

const WireCatalog = Schema.Struct({
	actors: Schema.Array(WireCatalogActor),
	capturedAt: Schema.String,
	mapPath: Schema.NonEmptyString,
	worldKind: Schema.Literals(["editor", "pie"]),
	worldSeconds: Schema.Finite
});

const StartActorObservationReady = Schema.Struct({
	status: Schema.Literal("ready"),
	capability: Schema.Literal("stream"),
	cadenceHz: Schema.Int,
	catalog: WireCatalog,
	catalogRevision: Schema.NonEmptyString,
	limits: Schema.Struct({ maxActors: Schema.Int, maxCadenceHz: Schema.Int }),
	pipeName: Schema.NonEmptyString,
	sessionId: Schema.NonEmptyString
});
type StartActorObservationReadyType = Schema.Schema.Type<typeof StartActorObservationReady>;

const StartActorObservationNotSupported = Schema.Struct({
	status: Schema.Literal("not_supported"),
	message: Schema.String,
	recovery: Schema.String
});

const StartActorObservationFailed = Schema.Struct({
	status: Schema.Literal("failed"),
	message: Schema.String,
	recovery: Schema.String
});

const StartActorObservationResponse = Schema.Union([
	StartActorObservationReady,
	StartActorObservationNotSupported,
	StartActorObservationFailed
]);

const SnapshotResponse = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), snapshot: WorldActorSnapshot }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);

function controlError(
	endpoint: string,
	operation: "start" | "stop" | "status",
	cause: RemoteControlClientError | unknown
): ActorObservationControlError {
	if (cause instanceof RemoteControlClientError) {
		return new ActorObservationControlError({
			endpoint: cause.endpoint,
			message: cause.message,
			operation,
			retrySafe: cause.retrySafe,
			...(cause.status === undefined ? undefined : { status: cause.status })
		});
	}
	return new ActorObservationControlError({
		endpoint,
		message: `Invalid observatory ${operation} response: ${String(cause)}`,
		operation,
		retrySafe: false
	});
}

const callStartActorObservation = Effect.fn("ActorObservation.start")(function* (
	remote: RemoteControlClientApi,
	endpoint: string,
	cadenceHz: number
) {
	const value = yield* remote
		.request({
			endpoint,
			functionName: "StartActorObservation",
			objectPath,
			operation: "observatory.start_actor_observation",
			parameters: { RequestJson: JSON.stringify({ cadenceHz }) }
		})
		.pipe(Effect.mapError((cause) => controlError(endpoint, "start", cause)));
	return yield* Schema.decodeUnknownEffect(StartActorObservationResponse)(value).pipe(
		Effect.mapError((cause) => controlError(endpoint, "start", cause))
	);
});

const callStopActorObservation = Effect.fn("ActorObservation.stop")(function* (
	remote: RemoteControlClientApi,
	endpoint: string
) {
	yield* remote
		.request({
			endpoint,
			functionName: "StopActorObservation",
			objectPath,
			operation: "observatory.stop_actor_observation",
			parameters: {}
		})
		.pipe(Effect.mapError((cause) => controlError(endpoint, "stop", cause)));
});

const requestActorSnapshotForFallback = Effect.fn("ActorObservation.snapshotFallback")(function* (
	remote: RemoteControlClientApi,
	endpoint: string
) {
	const value = yield* remote
		.request({
			endpoint,
			functionName: "GetActorSnapshot",
			objectPath,
			operation: "observatory.actor_snapshot",
			parameters: {}
		})
		.pipe(Effect.mapError((cause) => controlError(endpoint, "status", cause)));
	const response = yield* Schema.decodeUnknownEffect(SnapshotResponse)(value).pipe(
		Effect.mapError((cause) => controlError(endpoint, "status", cause))
	);
	if (response.status === "ready") return response.snapshot;
	return yield* Effect.fail(
		new ActorObservationControlError({
			endpoint,
			message: response.message,
			operation: "status",
			retrySafe: true
		})
	);
});

function buildCatalogFromReady(
	response: StartActorObservationReadyType,
	endpoint: string
): Effect.Effect<
	{
		readonly catalog: ReturnType<typeof catalogFromWireEntries>["catalog"];
		readonly transforms: ReturnType<typeof catalogFromWireEntries>["transforms"];
	},
	ActorObservationControlError
> {
	return Effect.try({
		try: () => {
			const sessionId = ObservationSessionId.make(response.sessionId);
			const revision = CatalogRevision.make(BigInt(response.catalogRevision));
			return catalogFromWireEntries({
				actors: response.catalog.actors,
				capturedAt: response.catalog.capturedAt,
				mapPath: response.catalog.mapPath,
				revision,
				sessionId,
				worldKind: response.catalog.worldKind,
				worldSeconds: response.catalog.worldSeconds
			});
		},
		catch: (cause) =>
			new ActorObservationControlError({
				endpoint,
				message: `Invalid StartActorObservation catalog: ${String(cause)}`,
				operation: "start",
				retrySafe: false
			})
	});
}

// ---------------------------------------------------------------------------
// Observation driver: negotiates, installs catalogs, consumes packets, and
// recovers from reset/session/decode failures with a bounded attempt budget.
// ---------------------------------------------------------------------------

type AttemptOutcome =
	| { readonly _tag: "reset" }
	| {
			readonly _tag: "rejected_exhausted";
			readonly expectedSessionId: string | undefined;
			readonly reason: WorldObservationRejectReason;
			readonly receivedSessionId: string | undefined;
	  };

function runLiveAttempt(args: {
	readonly feed: ActorFeedApi;
	readonly getState: () => WorldObservationState;
	readonly maxConsecutiveRejectedBatches: number;
	readonly onDiagnostic?: (diagnostic: ActorObservationDiagnostic) => Effect.Effect<void>;
	readonly publish: (state: WorldObservationState) => Effect.Effect<void>;
}): Effect.Effect<AttemptOutcome> {
	return Effect.gen(function* () {
		let outcome: AttemptOutcome = {
			_tag: "rejected_exhausted",
			expectedSessionId: undefined,
			reason: "no_catalog",
			receivedSessionId: undefined
		};
		let consecutiveRejected = 0;
		let previousProducerReplacements = 0;
		yield* Stream.runForEachWhile(args.feed.packets, (packet) =>
			Effect.gen(function* () {
				const applyStarted = performance.now();
				const stateBefore = args.getState();
				const event: WorldObservationEvent = packet.reset
					? {
							_tag: "reset",
							message: "The Unreal actor catalog was invalidated.",
							recovery: "Reacquiring a fresh catalog over Remote Control."
						}
					: { _tag: "transforms", batch: actorStreamPacketToTransformBatch(packet) };
				const result = applyWorldObservationEvent(stateBefore, event);
				const decodeApplyMs = packet.decodeDurationMs + performance.now() - applyStarted;
				const priorSequence =
					stateBefore.status === "live" || stateBefore.status === "stale"
						? stateBefore.sample.lastSequence
						: undefined;
				const missingSequences =
					priorSequence === undefined || packet.sequence <= priorSequence + 1n
						? 0
						: Number(packet.sequence - priorSequence - 1n);
				const feedMetrics = yield* args.feed.metrics;
				yield* args.publish(result.state);
				yield* recordObservatoryPacket({
					actorsChanged: packet.actorsChanged,
					actorsSampled: packet.actorsSampled,
					bytes:
						ACTOR_STREAM_HEADER_BYTES +
						packet.records.length * ACTOR_STREAM_RECORD_BYTES,
					decodeApplyMs,
					producerReplacements: Math.max(
						0,
						packet.producerReplacements - previousProducerReplacements
					),
					sequenceGap: result.sequenceGap
				});
				previousProducerReplacements = Math.max(
					previousProducerReplacements,
					packet.producerReplacements
				);
				if (args.onDiagnostic !== undefined && result.accepted && !packet.reset) {
					yield* args.onDiagnostic({
						actorsChanged: packet.actorsChanged,
						actorsSampled: packet.actorsSampled,
						decodeApplyMs,
						missingSequences,
						producerReplacements: packet.producerReplacements,
						receiverReplacements: feedMetrics.deliveryReplacements,
						samplingDurationMicros: packet.samplingDurationMicros,
						sequence: packet.sequence
					});
				}
				if (packet.reset) {
					outcome = { _tag: "reset" };
					return false;
				}
				if (result.accepted) {
					consecutiveRejected = 0;
					return true;
				}
				consecutiveRejected += 1;
				if (consecutiveRejected >= args.maxConsecutiveRejectedBatches) {
					const reason = result.reason ?? "no_catalog";
					const expectedSessionId =
						stateBefore.status === "live" || stateBefore.status === "stale"
							? stateBefore.sample.catalog.sessionId
							: undefined;
					const receivedSessionId =
						event._tag === "transforms" ? event.batch.sessionId : undefined;
					outcome = {
						_tag: "rejected_exhausted",
						expectedSessionId,
						receivedSessionId,
						reason
					};
					return false;
				}
				return true;
			})
		);
		return outcome;
	});
}

function runPollingFallback(args: {
	readonly cadenceHz: number;
	readonly endpoint: string;
	readonly publish: (state: WorldObservationState) => Effect.Effect<void>;
	readonly remote: RemoteControlClientApi;
}): Effect.Effect<never> {
	const effectiveHz = Math.min(Math.max(1, Math.round(args.cadenceHz)), 10);
	const tick = requestActorSnapshotForFallback(args.remote, args.endpoint).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				args.publish(
					applyWorldObservationEvent(connectingState(), {
						_tag: "unavailable",
						message: error.message,
						recovery:
							"Reacquire named-pipe observation once the editor is reachable again."
					}).state
				),
			onSuccess: (snapshot) =>
				args.publish({
					status: "polling_fallback",
					cadenceHz: effectiveHz,
					message: "Named-pipe observation is unavailable on this host.",
					snapshot
				})
		})
	);
	return Effect.repeat(tick, Schedule.spaced(Duration.millis(1_000 / effectiveHz))).pipe(
		Effect.andThen(Effect.never)
	);
}

interface DriveObservationArgs {
	readonly cadenceHz: number;
	readonly capacity: number;
	readonly endpoint: string;
	readonly getState: () => WorldObservationState;
	readonly maxConsecutiveRejectedBatches: number;
	readonly maxMalformedPackets: number;
	readonly maxRecoveryAttempts: number;
	readonly overridePipeName: string | undefined;
	readonly onDiagnostic:
		| ((diagnostic: ActorObservationDiagnostic) => Effect.Effect<void>)
		| undefined;
	readonly publish: (state: WorldObservationState) => Effect.Effect<void>;
	readonly remote: RemoteControlClientApi;
}

function driveObservation(
	args: DriveObservationArgs
): Effect.Effect<
	never,
	ActorObservationSessionError | ActorObservationRecoveryExhaustedError,
	Scope.Scope
> {
	const {
		cadenceHz,
		capacity,
		endpoint,
		getState,
		maxConsecutiveRejectedBatches,
		maxMalformedPackets,
		maxRecoveryAttempts,
		overridePipeName,
		onDiagnostic,
		publish,
		remote
	} = args;
	return Effect.gen(function* () {
		let feed: ActorFeedApi | undefined;
		let boundPipeName: string | undefined;
		let attempts = 0;

		const backoff = (attempt: number) =>
			Effect.sleep(Duration.millis(Math.min(200 * 2 ** Math.max(0, attempt - 1), 5_000)));

		const publishUnavailable = (message: string, recovery: string) =>
			publish(
				applyWorldObservationEvent(getState(), { _tag: "unavailable", message, recovery })
					.state
			);

		const attemptFailed = (message: string) =>
			Effect.gen(function* () {
				attempts += 1;
				if (attempts > maxRecoveryAttempts) {
					return yield* Effect.fail(
						new ActorObservationRecoveryExhaustedError({
							attempts: attempts - 1,
							endpoint,
							message
						})
					);
				}
				yield* publishUnavailable(message, "Retrying actor observation negotiation.");
				yield* backoff(attempts);
			});

		while (true) {
			const startOutcome = yield* Effect.result(
				callStartActorObservation(remote, endpoint, cadenceHz)
			);
			if (Result.isFailure(startOutcome)) {
				yield* attemptFailed(startOutcome.failure.message);
				continue;
			}
			const startResponse = startOutcome.success;

			if (startResponse.status === "not_supported") {
				yield* publishUnavailable(startResponse.message, startResponse.recovery);
				return yield* runPollingFallback({ cadenceHz, endpoint, publish, remote });
			}
			if (startResponse.status === "failed") {
				yield* attemptFailed(startResponse.message);
				continue;
			}

			const catalogOutcome = yield* Effect.result(
				buildCatalogFromReady(startResponse, endpoint)
			);
			if (Result.isFailure(catalogOutcome)) {
				yield* attemptFailed(catalogOutcome.failure.message);
				continue;
			}
			const built = catalogOutcome.success;

			const pipeName = overridePipeName ?? startResponse.pipeName;
			if (feed === undefined) {
				const feedOutcome = yield* Effect.result(
					acquireActorFeedScoped({ capacity, maxMalformedPackets, pipeName })
				);
				if (Result.isFailure(feedOutcome)) {
					yield* attemptFailed(feedOutcome.failure.message);
					continue;
				}
				feed = feedOutcome.success;
				boundPipeName = pipeName;
			} else if (boundPipeName !== pipeName) {
				yield* attemptFailed(
					`Actor observation pipe name changed from ${boundPipeName} to ${pipeName}; a single feed cannot rebind mid-session.`
				);
				continue;
			}

			const installed = applyWorldObservationEvent(getState(), {
				_tag: "catalog",
				catalog: built.catalog,
				initialTransforms: built.transforms
			});
			yield* publish(installed.state);

			const liveOutcome = yield* runLiveAttempt({
				feed,
				getState,
				maxConsecutiveRejectedBatches,
				publish,
				...(onDiagnostic === undefined ? undefined : { onDiagnostic })
			});
			if (liveOutcome._tag === "reset") {
				// Unreal-initiated catalog invalidation (map change, actor add/delete) is expected
				// during ordinary editor use; it does not consume the bounded recovery budget.
				attempts = 0;
				continue;
			}

			if (liveOutcome.reason === "wrong_session") {
				attempts += 1;
				if (attempts > maxRecoveryAttempts) {
					return yield* Effect.fail(
						new ActorObservationSessionError({
							endpoint,
							expectedSessionId: liveOutcome.expectedSessionId ?? "",
							message: `Actor observation kept receiving packets for the wrong session after ${
								attempts - 1
							} recovery attempts.`,
							receivedSessionId: liveOutcome.receivedSessionId ?? ""
						})
					);
				}
				yield* publishUnavailable(
					"Actor observation packets did not match the negotiated session.",
					"Retrying actor observation negotiation."
				);
				yield* backoff(attempts);
				continue;
			}

			yield* attemptFailed(
				`Actor observation packets were rejected (${liveOutcome.reason}).`
			);
		}
	});
}

export interface ObserveActorFeedOptions {
	readonly cadenceHz: number;
	readonly capacity?: number;
	readonly maxConsecutiveRejectedBatches?: number;
	readonly maxMalformedPackets?: number;
	readonly maxRecoveryAttempts?: number;
	readonly onDiagnostic?: (diagnostic: ActorObservationDiagnostic) => Effect.Effect<void>;
	readonly pipeName?: string;
}

/**
 * Own the full observation lifecycle: negotiate `StartActorObservation`, install/reacquire
 * catalogs, decode and apply transform packets, recover from reset/session faults with a bounded
 * attempt budget, and always call `StopActorObservation` when the returned stream's scope closes.
 */
export function observeActorFeed(
	remote: RemoteControlClientApi,
	endpoint: string,
	options: ObserveActorFeedOptions
): Stream.Stream<
	WorldObservationState,
	ActorObservationSessionError | ActorObservationRecoveryExhaustedError
> {
	return Stream.scoped(
		Stream.unwrap(
			Effect.gen(function* () {
				const capacity = options.capacity ?? 16;
				let currentState: WorldObservationState = connectingState();
				const statePubSub = yield* PubSub.sliding<WorldObservationState>({
					capacity,
					replay: 1
				});
				const publish = (next: WorldObservationState): Effect.Effect<void> =>
					Effect.sync(() => {
						currentState = next;
					}).pipe(Effect.andThen(PubSub.publish(statePubSub, next)), Effect.asVoid);
				yield* publish(currentState);

				yield* Effect.addFinalizer(() =>
					callStopActorObservation(remote, endpoint).pipe(
						Effect.ignore,
						Effect.andThen(PubSub.shutdown(statePubSub))
					)
				);

				const driver = Effect.scoped(
					driveObservation({
						cadenceHz: options.cadenceHz,
						capacity,
						endpoint,
						getState: () => currentState,
						maxConsecutiveRejectedBatches: options.maxConsecutiveRejectedBatches ?? 64,
						maxMalformedPackets: options.maxMalformedPackets ?? 128,
						maxRecoveryAttempts: options.maxRecoveryAttempts ?? 5,
						onDiagnostic: options.onDiagnostic,
						overridePipeName: options.pipeName,
						publish,
						remote
					})
				);

				return Stream.fromPubSub(statePubSub).pipe(Stream.mergeEffect(driver));
			})
		)
	);
}
