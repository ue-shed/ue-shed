import { Schema } from "effect";
import {
	ActorId,
	ObservedActor,
	WorldVector,
	type ObservedActor as ObservedActorType,
	type WorldActorSnapshot as WorldActorSnapshotType
} from "./actor-models.js";

/** Session-local alias into a catalog; never durable actor identity. */
export const StreamActorIndex = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
	Schema.isLessThanOrEqualTo(4095)
).pipe(Schema.brand("StreamActorIndex"));
export type StreamActorIndex = Schema.Schema.Type<typeof StreamActorIndex>;

export const ObservationSessionId = Schema.NonEmptyString.pipe(
	Schema.brand("ObservationSessionId")
);
export type ObservationSessionId = Schema.Schema.Type<typeof ObservationSessionId>;

export const CatalogRevision = Schema.BigInt.pipe(Schema.brand("CatalogRevision"));
export type CatalogRevision = Schema.Schema.Type<typeof CatalogRevision>;

export const PacketSequence = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)).pipe(
	Schema.brand("PacketSequence")
);
export type PacketSequence = Schema.Schema.Type<typeof PacketSequence>;

/** Static actor metadata retained from catalog discovery; transforms arrive separately. */
export const WorldActorCatalogEntry = Schema.Struct({
	bounds: Schema.Struct({
		center: WorldVector,
		extent: WorldVector
	}),
	className: Schema.NonEmptyString,
	displayName: Schema.NonEmptyString,
	id: ActorId,
	path: Schema.NonEmptyString,
	streamIndex: StreamActorIndex
});
export interface WorldActorCatalogEntry extends Schema.Schema.Type<typeof WorldActorCatalogEntry> {}

export const WorldActorCatalog = Schema.Struct({
	capturedAt: Schema.String,
	entries: Schema.Array(WorldActorCatalogEntry),
	mapPath: Schema.NonEmptyString,
	revision: CatalogRevision,
	sessionId: ObservationSessionId,
	worldKind: Schema.Literals(["editor", "pie"]),
	worldSeconds: Schema.Finite
});
export interface WorldActorCatalog extends Schema.Schema.Type<typeof WorldActorCatalog> {}

export const WorldTransform = Schema.Struct({
	location: WorldVector,
	rotation: WorldVector
});
export interface WorldTransform extends Schema.Schema.Type<typeof WorldTransform> {}

export const WorldIndexedTransform = Schema.Struct({
	streamIndex: StreamActorIndex,
	transform: WorldTransform
});
export interface WorldIndexedTransform extends Schema.Schema.Type<typeof WorldIndexedTransform> {}

export const WorldTransformBatch = Schema.Struct({
	actorsChanged: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	actorsSampled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	producerMonotonicMs: Schema.Finite,
	producerReplacements: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	revision: CatalogRevision,
	sequence: PacketSequence,
	sessionId: ObservationSessionId,
	transforms: Schema.Array(WorldIndexedTransform),
	worldSeconds: Schema.Finite
});
export interface WorldTransformBatch extends Schema.Schema.Type<typeof WorldTransformBatch> {}

export const WorldObservationHealth = Schema.Struct({
	producerReplacements: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	rejectedBatches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	sequenceGaps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export interface WorldObservationHealth extends Schema.Schema.Type<typeof WorldObservationHealth> {}

const emptyHealth = (): WorldObservationHealth =>
	WorldObservationHealth.make({
		producerReplacements: 0,
		rejectedBatches: 0,
		sequenceGaps: 0
	});

/** Dense latest transforms keyed by stream index; absent slots mean never received. */
export type WorldTransformStore = ReadonlyMap<StreamActorIndex, WorldTransform>;

export interface WorldObservationSample {
	readonly catalog: WorldActorCatalog;
	readonly health: WorldObservationHealth;
	readonly lastSequence: PacketSequence;
	readonly sampleWorldSeconds: number;
	readonly transforms: WorldTransformStore;
}

export type WorldObservationState =
	| { readonly status: "connecting" }
	| { readonly status: "live"; readonly sample: WorldObservationSample }
	| {
			readonly status: "stale";
			readonly message: string;
			readonly recovery: string;
			readonly sample: WorldObservationSample;
	  }
	| {
			readonly status: "polling_fallback";
			readonly cadenceHz: number;
			readonly message: string;
			readonly snapshot: WorldActorSnapshotType;
	  }
	| {
			readonly status: "unavailable";
			readonly message: string;
			readonly recovery: string;
			readonly sample?: WorldObservationSample;
	  };

export type WorldObservationEvent =
	| {
			readonly _tag: "catalog";
			readonly catalog: WorldActorCatalog;
			readonly initialTransforms: ReadonlyArray<WorldIndexedTransform>;
	  }
	| { readonly _tag: "transforms"; readonly batch: WorldTransformBatch }
	| {
			readonly _tag: "reset";
			readonly message: string;
			readonly recovery: string;
			readonly sessionId?: ObservationSessionId;
			readonly revision?: CatalogRevision;
	  }
	| { readonly _tag: "unavailable"; readonly message: string; readonly recovery: string }
	| {
			readonly _tag: "polling_fallback";
			readonly cadenceHz: number;
			readonly message: string;
			readonly snapshot: WorldActorSnapshotType;
	  };

export type WorldObservationRejectReason =
	| "wrong_session"
	| "wrong_revision"
	| "regressing_sequence"
	| "duplicate_sequence"
	| "out_of_range_index"
	| "duplicate_index"
	| "no_catalog";

export interface WorldObservationApplyResult {
	readonly accepted: boolean;
	readonly reason?: WorldObservationRejectReason;
	readonly sequenceGap: boolean;
	readonly state: WorldObservationState;
}

export const connectingState = (): WorldObservationState => ({ status: "connecting" });

function cloneTransforms(store: WorldTransformStore): Map<StreamActorIndex, WorldTransform> {
	return new Map(store);
}

function applyIndexedTransforms(
	catalog: WorldActorCatalog,
	base: WorldTransformStore,
	indexed: ReadonlyArray<WorldIndexedTransform>
):
	| { readonly ok: true; readonly transforms: Map<StreamActorIndex, WorldTransform> }
	| { readonly ok: false; readonly reason: "out_of_range_index" | "duplicate_index" } {
	const next = cloneTransforms(base);
	const seen = new Set<number>();
	for (const item of indexed) {
		const index = item.streamIndex;
		if (index >= catalog.entries.length) {
			return { ok: false, reason: "out_of_range_index" };
		}
		if (seen.has(index)) return { ok: false, reason: "duplicate_index" };
		seen.add(index);
		next.set(index, item.transform);
	}
	return { ok: true, transforms: next };
}

function retainedSample(state: WorldObservationState): WorldObservationSample | undefined {
	if (state.status === "live" || state.status === "stale") return state.sample;
	if (state.status === "unavailable") return state.sample;
	return undefined;
}

/**
 * Materialize one ObservedActor for selection/authoring from catalog metadata plus its latest
 * transform. Do not call this for every actor on every batch.
 */
export function materializeObservedActor(
	entry: WorldActorCatalogEntry,
	transform: WorldTransform
): ObservedActorType {
	return ObservedActor.make({
		bounds: entry.bounds,
		className: entry.className,
		displayName: entry.displayName,
		id: entry.id,
		location: transform.location,
		path: entry.path,
		rotation: transform.rotation
	});
}

/** Build a discovery catalog from a complete snapshot; stream indices are dense and session-local. */
export function catalogFromSnapshot(
	snapshot: WorldActorSnapshotType,
	sessionId: ObservationSessionId,
	revision: CatalogRevision
): {
	readonly catalog: WorldActorCatalog;
	readonly transforms: ReadonlyArray<WorldIndexedTransform>;
} {
	const entries: Array<WorldActorCatalogEntry> = [];
	const transforms: Array<WorldIndexedTransform> = [];
	for (let index = 0; index < snapshot.actors.length; index += 1) {
		const actor = snapshot.actors[index];
		if (actor === undefined) continue;
		const streamIndex = StreamActorIndex.make(index);
		entries.push(
			WorldActorCatalogEntry.make({
				bounds: actor.bounds,
				className: actor.className,
				displayName: actor.displayName,
				id: actor.id,
				path: actor.path,
				streamIndex
			})
		);
		transforms.push(
			WorldIndexedTransform.make({
				streamIndex,
				transform: WorldTransform.make({
					location: actor.location,
					rotation: actor.rotation
				})
			})
		);
	}
	return {
		catalog: WorldActorCatalog.make({
			capturedAt: snapshot.capturedAt,
			entries,
			mapPath: snapshot.mapPath,
			revision,
			sessionId,
			worldKind: snapshot.worldKind,
			worldSeconds: snapshot.worldSeconds
		}),
		transforms
	};
}

export function applyWorldObservationEvent(
	state: WorldObservationState,
	event: WorldObservationEvent
): WorldObservationApplyResult {
	switch (event._tag) {
		case "catalog": {
			const applied = applyIndexedTransforms(
				event.catalog,
				new Map(),
				event.initialTransforms
			);
			if (!applied.ok) {
				const prior = retainedSample(state);
				if (prior === undefined) {
					return {
						accepted: false,
						reason: applied.reason,
						sequenceGap: false,
						state
					};
				}
				return {
					accepted: false,
					reason: applied.reason,
					sequenceGap: false,
					state: {
						status: "stale",
						message: "Catalog install rejected a transform index.",
						recovery: "Request a fresh observation catalog.",
						sample: prior
					}
				};
			}
			const sample: WorldObservationSample = {
				catalog: event.catalog,
				health: emptyHealth(),
				lastSequence: PacketSequence.make(0n),
				sampleWorldSeconds: event.catalog.worldSeconds,
				transforms: applied.transforms
			};
			return {
				accepted: true,
				sequenceGap: false,
				state: { status: "live", sample }
			};
		}
		case "transforms":
			return applyTransformBatch(state, event.batch);
		case "reset": {
			const sample = retainedSample(state);
			if (sample === undefined) {
				return {
					accepted: true,
					sequenceGap: false,
					state: {
						status: "unavailable",
						message: event.message,
						recovery: event.recovery
					}
				};
			}
			return {
				accepted: true,
				sequenceGap: false,
				state: {
					status: "stale",
					message: event.message,
					recovery: event.recovery,
					sample
				}
			};
		}
		case "unavailable": {
			const sample = retainedSample(state);
			return {
				accepted: true,
				sequenceGap: false,
				state:
					sample === undefined
						? {
								status: "unavailable",
								message: event.message,
								recovery: event.recovery
							}
						: {
								status: "unavailable",
								message: event.message,
								recovery: event.recovery,
								sample
							}
			};
		}
		case "polling_fallback":
			return {
				accepted: true,
				sequenceGap: false,
				state: {
					status: "polling_fallback",
					cadenceHz: event.cadenceHz,
					message: event.message,
					snapshot: event.snapshot
				}
			};
	}
}

export function applyTransformBatch(
	state: WorldObservationState,
	batch: WorldTransformBatch
): WorldObservationApplyResult {
	if (state.status !== "live" && state.status !== "stale") {
		return {
			accepted: false,
			reason: "no_catalog",
			sequenceGap: false,
			state
		};
	}
	const sample = state.sample;
	if (batch.sessionId !== sample.catalog.sessionId) {
		return reject(state, "wrong_session");
	}
	if (batch.revision !== sample.catalog.revision) {
		return reject(state, "wrong_revision");
	}
	if (batch.sequence < sample.lastSequence) {
		return reject(state, "regressing_sequence");
	}
	if (batch.sequence === sample.lastSequence && state.status === "live") {
		return reject(state, "duplicate_sequence");
	}

	const applied = applyIndexedTransforms(sample.catalog, sample.transforms, batch.transforms);
	if (!applied.ok) return reject(state, applied.reason);

	const sequenceGap = state.status === "live" && batch.sequence > sample.lastSequence + 1n;
	const health = WorldObservationHealth.make({
		producerReplacements: Math.max(
			sample.health.producerReplacements,
			batch.producerReplacements
		),
		rejectedBatches: sample.health.rejectedBatches,
		sequenceGaps: sample.health.sequenceGaps + (sequenceGap ? 1 : 0)
	});
	const nextSample: WorldObservationSample = {
		catalog: sample.catalog,
		health,
		lastSequence: batch.sequence,
		sampleWorldSeconds: batch.worldSeconds,
		transforms: applied.transforms
	};
	return {
		accepted: true,
		sequenceGap,
		state: { status: "live", sample: nextSample }
	};
}

function reject(
	state: Extract<WorldObservationState, { status: "live" | "stale" }>,
	reason: WorldObservationRejectReason
): WorldObservationApplyResult {
	const health = WorldObservationHealth.make({
		...state.sample.health,
		rejectedBatches: state.sample.health.rejectedBatches + 1
	});
	return {
		accepted: false,
		reason,
		sequenceGap: false,
		state: {
			...state,
			sample: { ...state.sample, health }
		}
	};
}

/** Lookup a catalog entry by stream index without scanning by actor id. */
export function catalogEntryAt(
	catalog: WorldActorCatalog,
	streamIndex: StreamActorIndex
): WorldActorCatalogEntry | undefined {
	return catalog.entries[streamIndex];
}
