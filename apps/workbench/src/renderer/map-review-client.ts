import {
	decodeMapReviewApprovalResult,
	decodeMapReviewAuthoringResult,
	decodeMapReviewCandidatePreviewResult,
	decodeMapReviewCaptureResult,
	decodeMapReviewResult,
	type MapReviewApprovalResult,
	type MapReviewAuthoringPatchIntent,
	type MapReviewAuthoringPreviewIntent,
	type MapReviewAuthoringSessionIntent,
	type MapReviewCandidatePreviewResult,
	type MapReviewCaptureIntent,
	type MapReviewCaptureResult,
	type MapReviewResult
} from "@ue-shed/cameras/review-contracts";
import {
	MapReviewClient,
	MapReviewClientError,
	type MapReviewWorldObservation,
	type MapReviewClientShape
} from "@ue-shed/extension-camera-review/client";
import {
	CatalogRevision,
	ObservationSessionId,
	PacketSequence,
	StreamActorIndex,
	WorldScoutRefreshRate,
	WorldActorCatalog,
	WorldIndexedTransform,
	WorldObservationHealth,
	WorldTransform,
	applyWorldObservationEvent,
	connectingState,
	decodeWorldScoutFocusResult,
	decodeWorldScoutResult,
	type ActorId,
	type WorldObservationSample,
	type WorldObservationState,
	type WorldScoutResult
} from "@ue-shed/observatory";
import { decodeSavedWorld, SavedWorldMap } from "@ue-shed/protocol";
import { Effect, Queue, Schema, Stream } from "effect";
import type { RendererWorldObservationEvent } from "../main/ipc-contracts.js";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

const loadWorldSnapshot = (): Effect.Effect<WorldScoutResult, MapReviewClientError> =>
	request({
		decode: decodeWorldScoutResult,
		invoke: () => window.ueShed.mapReview.worldSnapshot(),
		operation: "mapReview.worldSnapshot"
	});

const loadSavedWorld = (mapPath: string) =>
	request({
		decode: decodeSavedWorld,
		invoke: () => window.ueShed.mapReview.savedWorld(mapPath),
		operation: "mapReview.savedWorld"
	});

const loadSavedWorldMaps = () =>
	request({
		decode: Schema.decodeUnknownEffect(Schema.Array(SavedWorldMap)),
		invoke: () => window.ueShed.mapReview.savedWorldMaps(),
		operation: "mapReview.savedWorldMaps"
	});

function request<A>(args: {
	readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
	readonly invoke: () => Promise<unknown>;
	readonly operation: string;
}): Effect.Effect<A, MapReviewClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) => new MapReviewClientError({ cause, operation: args.operation, recovery })
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) => new MapReviewClientError({ cause, operation: args.operation, recovery })
		)
	);
}

function wireSampleToDomain(sample: {
	readonly catalog: unknown;
	readonly health: unknown;
	readonly lastSequence: string;
	readonly sampleWorldSeconds: number;
	readonly transforms: ReadonlyArray<{
		readonly streamIndex: number;
		readonly transform: {
			readonly location: { readonly x: number; readonly y: number; readonly z: number };
			readonly rotation: { readonly x: number; readonly y: number; readonly z: number };
		};
	}>;
}): WorldObservationSample {
	const catalog = WorldActorCatalog.make(sample.catalog as never);
	const health = WorldObservationHealth.make(sample.health as never);
	const transforms = new Map(
		sample.transforms.map(
			(entry) =>
				[
					StreamActorIndex.make(entry.streamIndex),
					WorldTransform.make(entry.transform)
				] as const
		)
	);
	return {
		catalog,
		health,
		lastSequence: PacketSequence.make(BigInt(sample.lastSequence)),
		sampleWorldSeconds: sample.sampleWorldSeconds,
		transforms
	};
}

function applyRendererObservationEvent(
	previous: WorldObservationState,
	event: RendererWorldObservationEvent
): MapReviewWorldObservation {
	switch (event.kind) {
		case "connecting":
			return connectingState();
		case "catalog": {
			const sample = wireSampleToDomain(event.sample);
			if (event.status === "stale") {
				return {
					status: "stale",
					message: event.message ?? "World observation is stale.",
					recovery: event.recovery ?? "Wait for the next catalog or reconnect.",
					sample
				};
			}
			return { status: "live", sample };
		}
		case "transforms": {
			const changedTransforms = event.transforms.map((entry) =>
				WorldIndexedTransform.make({
					streamIndex: StreamActorIndex.make(entry.streamIndex),
					transform: WorldTransform.make(entry.transform)
				})
			);
			const batch = {
				actorsChanged: event.actorsChanged,
				actorsSampled: event.actorsSampled,
				producerMonotonicMs: event.producerMonotonicMs,
				producerReplacements: event.producerReplacements,
				revision: CatalogRevision.make(BigInt(event.revision)),
				sequence: PacketSequence.make(BigInt(event.sequence)),
				sessionId: ObservationSessionId.make(event.sessionId),
				transforms: changedTransforms,
				worldSeconds: event.worldSeconds
			};
			const applied = applyWorldObservationEvent(previous, { _tag: "transforms", batch });
			if (!applied.accepted) return previous;
			if (event.status === "stale" && applied.state.status === "live") {
				return {
					status: "stale",
					message: event.message ?? "World observation is stale.",
					recovery: event.recovery ?? "Wait for the producer to resume.",
					sample: applied.state.sample,
					changedTransforms
				};
			}
			return { ...applied.state, changedTransforms };
		}
		case "polling_fallback":
			return {
				status: "polling_fallback",
				cadenceHz: event.cadenceHz,
				message: event.message,
				snapshot: event.snapshot
			};
		case "unavailable":
			return {
				status: "unavailable",
				message: event.message,
				recovery: event.recovery,
				...(event.sample === undefined ? {} : { sample: wireSampleToDomain(event.sample) })
			};
	}
}

function sameTransform(left: WorldTransform, right: WorldTransform): boolean {
	return (
		left.location.x === right.location.x &&
		left.location.y === right.location.y &&
		left.location.z === right.location.z &&
		left.rotation.x === right.rotation.x &&
		left.rotation.y === right.rotation.y &&
		left.rotation.z === right.rotation.z
	);
}

/**
 * A sliding renderer queue may legitimately replace intermediate observation states. The retained
 * sample is cumulative, so reconstruct the sparse delta relative to the last state consumed by
 * World Scout; otherwise transforms in a replaced event would never reach the Canvas store.
 */
export function reconcileSparseTransformChanges(
	previous: MapReviewWorldObservation | undefined,
	current: MapReviewWorldObservation
): MapReviewWorldObservation {
	if (
		previous === undefined ||
		(previous.status !== "live" && previous.status !== "stale") ||
		(current.status !== "live" && current.status !== "stale") ||
		previous.sample.catalog.sessionId !== current.sample.catalog.sessionId ||
		previous.sample.catalog.revision !== current.sample.catalog.revision
	) {
		return current;
	}

	const changedTransforms = [];
	for (const [streamIndex, transform] of current.sample.transforms) {
		const prior = previous.sample.transforms.get(streamIndex);
		if (prior === undefined || !sameTransform(prior, transform)) {
			changedTransforms.push(WorldIndexedTransform.make({ streamIndex, transform }));
		}
	}
	return { ...current, changedTransforms };
}

export const mapReviewClient: MapReviewClientShape = MapReviewClient.of({
	readSavedWorld: Effect.fn("MapReviewClient.readSavedWorld")((mapPath) =>
		loadSavedWorld(mapPath)
	),
	savedWorldMaps: Effect.fn("MapReviewClient.savedWorldMaps")(() => loadSavedWorldMaps()),
	connectWorld: Effect.fn("MapReviewClient.connectWorld")(() => loadWorldSnapshot()),
	focusActor: Effect.fn("MapReviewClient.focusActor")((actorId: ActorId, bringToFront: boolean) =>
		request({
			decode: decodeWorldScoutFocusResult,
			invoke: () => window.ueShed.mapReview.focusActor(actorId, bringToFront),
			operation: "mapReview.focusActor"
		})
	),
	worldObservations: (refreshRate: WorldScoutRefreshRate) =>
		Stream.callback<MapReviewWorldObservation>(
			(queue) =>
				Effect.acquireRelease(
					Effect.gen(function* () {
						let state = connectingState();
						const unsubscribe = window.ueShed.onWorldObservation((event) => {
							state = applyRendererObservationEvent(state, event);
							Queue.offerUnsafe(queue, state);
						});
						yield* Effect.tryPromise({
							try: () =>
								window.ueShed.mapReview.subscribeWorldObservations(refreshRate),
							catch: (cause) =>
								new MapReviewClientError({
									cause,
									operation: "mapReview.subscribeWorldObservations",
									recovery
								})
						}).pipe(
							Effect.onError(() => Effect.sync(unsubscribe)),
							Effect.orDie
						);
						return unsubscribe;
					}),
					(unsubscribe) =>
						Effect.gen(function* () {
							yield* Effect.sync(unsubscribe);
							yield* Effect.tryPromise({
								try: () => window.ueShed.mapReview.unsubscribeWorldObservations(),
								catch: (cause) =>
									new MapReviewClientError({
										cause,
										operation: "mapReview.unsubscribeWorldObservations",
										recovery
									})
							}).pipe(Effect.ignore);
						})
				),
			{ bufferSize: 1, strategy: "sliding" }
		).pipe(
			Stream.mapAccum(
				() => undefined as MapReviewWorldObservation | undefined,
				(
					previous: MapReviewWorldObservation | undefined,
					current: MapReviewWorldObservation
				): readonly [
					MapReviewWorldObservation,
					ReadonlyArray<MapReviewWorldObservation>
				] => [current, [reconcileSparseTransformChanges(previous, current)]]
			)
		),
	setWorldObservationRate: Effect.fn("MapReviewClient.setWorldObservationRate")(
		(refreshRate: WorldScoutRefreshRate) =>
			request({
				decode: (value) =>
					typeof value === "number"
						? Effect.succeed(WorldScoutRefreshRate.make(value))
						: Effect.fail(
								new Error("Expected a numeric world observation refresh rate.")
							),
				invoke: () => window.ueShed.mapReview.setWorldObservationRate(refreshRate),
				operation: "mapReview.setWorldObservationRate"
			})
	),
	liveFrames: Stream.callback(
		(queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					window.ueShed.onFrame((frame) =>
						Queue.offerUnsafe(queue, {
							cameraIndex: frame.cameraIndex,
							height: frame.height,
							pixels: frame.pixels,
							width: frame.width
						})
					)
				),
				(unsubscribe) => Effect.sync(unsubscribe)
			),
		{ bufferSize: 32, strategy: "sliding" }
	),
	setLivePreviewFps: Effect.fn("MapReviewClient.setLivePreviewFps")((fps) =>
		request({
			decode: (value) =>
				typeof value === "number"
					? Effect.succeed(value)
					: Effect.fail(new Error("Expected a numeric live preview FPS.")),
			invoke: () => window.ueShed.mapReview.setLivePreviewFps(fps),
			operation: "mapReview.setLivePreviewFps"
		})
	),
	approveCandidate: Effect.fn("MapReviewClient.approveCandidate")(
		(intent): Effect.Effect<MapReviewApprovalResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewApprovalResult,
				invoke: () => window.ueShed.mapReview.approveCandidate(intent),
				operation: "mapReview.approveCandidate"
			})
	),
	authorFromSelection: Effect.fn("MapReviewClient.authorFromSelection")(() =>
		request({
			decode: decodeMapReviewAuthoringResult,
			invoke: () => window.ueShed.mapReview.authorFromSelection(),
			operation: "mapReview.authorFromSelection"
		})
	),
	authoringResume: Effect.fn("MapReviewClient.authoringResume")(() =>
		request({
			decode: decodeMapReviewAuthoringResult,
			invoke: () => window.ueShed.mapReview.authoringResume(),
			operation: "mapReview.authoringResume"
		})
	),
	authoringPatch: Effect.fn("MapReviewClient.authoringPatch")(
		(intent: MapReviewAuthoringPatchIntent) =>
			request({
				decode: decodeMapReviewAuthoringResult,
				invoke: () => window.ueShed.mapReview.authoringPatch(intent),
				operation: "mapReview.authoringPatch"
			})
	),
	authoringReframe: Effect.fn("MapReviewClient.authoringReframe")(
		(intent: MapReviewAuthoringSessionIntent) =>
			request({
				decode: decodeMapReviewAuthoringResult,
				invoke: () => window.ueShed.mapReview.authoringReframe(intent),
				operation: "mapReview.authoringReframe"
			})
	),
	discardAuthoring: Effect.fn("MapReviewClient.discardAuthoring")(
		(intent: MapReviewAuthoringSessionIntent) =>
			request({
				decode: decodeMapReviewAuthoringResult,
				invoke: () => window.ueShed.mapReview.discardAuthoring(intent),
				operation: "mapReview.discardAuthoring"
			})
	),
	previewAuthoringCandidate: Effect.fn("MapReviewClient.previewAuthoringCandidate")(
		(intent: MapReviewAuthoringPreviewIntent) =>
			request({
				decode: decodeMapReviewCandidatePreviewResult,
				invoke: () => window.ueShed.mapReview.previewAuthoringCandidate(intent),
				operation: "mapReview.previewAuthoringCandidate"
			})
	),
	approveAuthoring: Effect.fn("MapReviewClient.approveAuthoring")(
		(intent: MapReviewAuthoringSessionIntent) =>
			request({
				decode: decodeMapReviewApprovalResult,
				invoke: () => window.ueShed.mapReview.approveAuthoring(intent),
				operation: "mapReview.approveAuthoring"
			})
	),
	capture: Effect.fn("MapReviewClient.capture")(
		(
			intent: MapReviewCaptureIntent
		): Effect.Effect<MapReviewCaptureResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewCaptureResult,
				invoke: () => window.ueShed.mapReview.capture(intent),
				operation: "mapReview.capture"
			})
	),
	load: Effect.fn("MapReviewClient.load")(
		(): Effect.Effect<MapReviewResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewResult,
				invoke: () => window.ueShed.mapReview.load(),
				operation: "mapReview.load"
			})
	),
	previewCandidate: Effect.fn("MapReviewClient.previewCandidate")(
		(candidateId): Effect.Effect<MapReviewCandidatePreviewResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewCandidatePreviewResult,
				invoke: () => window.ueShed.mapReview.previewCandidate(candidateId),
				operation: "mapReview.previewCandidate"
			})
	)
});
