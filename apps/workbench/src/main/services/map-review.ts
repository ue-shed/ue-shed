import {
	approveFramingCandidate,
	awaitReviewPreviewFrame,
	CameraFeed,
	clearReviewPreviewSources,
	configureCameras,
	ensureReviewPreviewSources,
	generateFramingCandidates,
	ReviewAuthoring,
	ReviewAuthoringSessions,
	ReviewCapture,
	ReviewRepository,
	ReviewViewId,
	evaluateReviewCapturePolicy,
	type ReviewAuthoringSession,
	type CaptureRunSummary,
	type ReviewSet
} from "@ue-shed/cameras";
import { EditorPlaySession } from "@ue-shed/engine-discovery";
import { recordObservatoryIpcReplacements } from "@ue-shed/observability";
import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCandidatePreviewResult,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewResult,
	MapReviewRunView
} from "@ue-shed/cameras/review-contracts";
import {
	Observatory,
	StreamActorIndex,
	type ActorId,
	type WorldObservationSample,
	type WorldObservationState,
	type WorldScoutFocusResult,
	type WorldScoutRefreshRate,
	type WorldScoutResult,
	type WorldTransform
} from "@ue-shed/observatory";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import {
	Context,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	Ref,
	Clock,
	Semaphore,
	Stream
} from "effect";
import { dirname } from "node:path";
import { LocalFiles } from "../adapters/local-files.js";
import { WorkbenchWindow } from "../adapters/electron-window.js";
import type { RendererWorldObservationEvent } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { makeUnrealOperationCoordinator } from "./unreal-operation-coordinator.js";

const artifactReadConcurrency = 4;
/** Presentation cadence cap independent of producer sample rate (plan 019 Step 5). */
const maxWorldObservationPresentationHz = 60;
const worldObservationEventChannel = "map-review:world-observation";

function catalogKey(sample: WorldObservationSample): string {
	return `${sample.catalog.sessionId}:${sample.catalog.revision.toString()}`;
}

function sampleToWire(sample: WorldObservationSample) {
	return {
		catalog: sample.catalog,
		health: sample.health,
		lastSequence: sample.lastSequence.toString(),
		sampleWorldSeconds: sample.sampleWorldSeconds,
		transforms: [...sample.transforms.entries()].map(([streamIndex, transform]) => ({
			streamIndex,
			transform
		}))
	};
}

function stateToStatusEvent(
	state: WorldObservationState
): RendererWorldObservationEvent | undefined {
	switch (state.status) {
		case "connecting":
			return { kind: "connecting" };
		case "live":
			return { kind: "catalog", sample: sampleToWire(state.sample), status: "live" };
		case "stale":
			return {
				kind: "catalog",
				message: state.message,
				recovery: state.recovery,
				sample: sampleToWire(state.sample),
				status: "stale"
			};
		case "polling_fallback":
			return {
				kind: "polling_fallback",
				cadenceHz: state.cadenceHz,
				message: state.message,
				snapshot: state.snapshot
			};
		case "unavailable":
			return {
				kind: "unavailable",
				message: state.message,
				recovery: state.recovery,
				...(state.sample === undefined ? {} : { sample: sampleToWire(state.sample) })
			};
	}
}

type PendingObservation =
	| { readonly tag: "status"; readonly event: RendererWorldObservationEvent }
	| {
			readonly tag: "transforms";
			readonly actorsChanged: number;
			readonly actorsSampled: number;
			readonly health: WorldObservationSample["health"];
			readonly message?: string;
			readonly producerMonotonicMs: number;
			readonly producerReplacements: number;
			readonly recovery?: string;
			readonly revision: string;
			readonly sequence: string;
			readonly sessionId: string;
			readonly status: "live" | "stale";
			readonly transforms: Map<number, WorldTransform>;
			readonly worldSeconds: number;
	  };

/**
 * Status/catalog events and transform deltas occupy independent presentation slots. A catalog
 * always includes a complete retained sample, so it invalidates obsolete deltas, but a pending
 * catalog must never be overwritten by the next sparse transform batch.
 */
interface PendingObservationSlots {
	readonly status: Option.Option<RendererWorldObservationEvent>;
	readonly transforms: Option.Option<Extract<PendingObservation, { readonly tag: "transforms" }>>;
}

const emptyPendingObservationSlots = (): PendingObservationSlots => ({
	status: Option.none(),
	transforms: Option.none()
});

function clampLivePreviewFps(fps: number): number {
	return Math.min(10, Math.max(1, Math.round(fps)));
}

function livePreviewPoseFingerprint(
	candidates: ReadonlyArray<{
		readonly approvedPose: {
			readonly fieldOfViewDegrees: number;
			readonly location: { readonly x: number; readonly y: number; readonly z: number };
			readonly rotation: { readonly pitch: number; readonly yaw: number };
		};
		readonly id: string;
	}>
): string {
	return candidates
		.map((candidate) =>
			[
				candidate.id,
				candidate.approvedPose.location.x.toFixed(2),
				candidate.approvedPose.location.y.toFixed(2),
				candidate.approvedPose.location.z.toFixed(2),
				candidate.approvedPose.rotation.pitch.toFixed(2),
				candidate.approvedPose.rotation.yaw.toFixed(2),
				candidate.approvedPose.fieldOfViewDegrees.toFixed(2)
			].join(":")
		)
		.join("|");
}

interface ReviewFailure {
	readonly error: { readonly message: string; readonly recovery: string };
	readonly status: "failed";
}

export interface WorkbenchMapReviewShape {
	readonly worldSnapshot: () => Effect.Effect<WorldScoutResult>;
	readonly subscribeWorldObservations: (cadenceHz: WorldScoutRefreshRate) => Effect.Effect<void>;
	readonly setWorldObservationRate: (
		cadenceHz: WorldScoutRefreshRate
	) => Effect.Effect<WorldScoutRefreshRate>;
	readonly unsubscribeWorldObservations: () => Effect.Effect<void>;
	readonly worldObservationPresentationReplacements: () => Effect.Effect<number>;
	readonly focusActor: (
		actorId: ActorId,
		bringToFront: boolean
	) => Effect.Effect<WorldScoutFocusResult>;
	readonly approveCandidate: (
		intent: MapReviewApproveCandidateIntent
	) => Effect.Effect<MapReviewApprovalResult>;
	readonly authorFromSelection: () => Effect.Effect<MapReviewAuthoringResult>;
	readonly authoringPatch: (
		intent: MapReviewAuthoringPatchIntent
	) => Effect.Effect<MapReviewAuthoringResult>;
	readonly authoringReframe: (
		intent: MapReviewAuthoringSessionIntent
	) => Effect.Effect<MapReviewAuthoringResult>;
	readonly authoringResume: (
		intent: MapReviewAuthoringSessionIntent | undefined
	) => Effect.Effect<MapReviewAuthoringResult>;
	readonly discardAuthoring: (
		intent: MapReviewAuthoringSessionIntent
	) => Effect.Effect<MapReviewAuthoringResult>;
	readonly approveAuthoring: (
		intent: MapReviewAuthoringSessionIntent
	) => Effect.Effect<MapReviewApprovalResult>;
	readonly capture: (intent: MapReviewCaptureIntent) => Effect.Effect<MapReviewCaptureResult>;
	readonly load: () => Effect.Effect<MapReviewResult>;
	readonly previewCandidate: (
		candidateId: string
	) => Effect.Effect<MapReviewCandidatePreviewResult>;
	readonly previewAuthoringCandidate: (
		intent: MapReviewAuthoringPreviewIntent
	) => Effect.Effect<MapReviewCandidatePreviewResult>;
	readonly setLivePreviewFps: (fps: number) => Effect.Effect<number>;
}

export class WorkbenchMapReview extends Context.Service<
	WorkbenchMapReview,
	WorkbenchMapReviewShape
>()("@ue-shed/workbench/WorkbenchMapReview") {}

function mapReviewFailure(cause: {
	readonly message?: string;
	readonly recovery?: string;
}): ReviewFailure {
	return {
		error: {
			message: cause.message ?? String(cause),
			recovery:
				cause.recovery ??
				"Verify the Review Set, project directory, and local evidence store."
		},
		status: "failed"
	};
}

function mapReviewAuthoringFailure(cause: {
	readonly message?: string;
	readonly recovery?: string;
}): ReviewFailure {
	return {
		error: {
			message: cause.message ?? String(cause),
			recovery:
				cause.recovery ??
				"Verify the editor selection and Map Review authoring capability, then retry."
		},
		status: "failed"
	};
}

function authoringResult(
	session: ReviewAuthoringSession,
	recovery?: string
): MapReviewAuthoringResult {
	return {
		candidates: session.candidates.map((candidate) => {
			const realization = session.realizations.find(
				(item) => item.candidateId === candidate.id
			);
			return {
				diagnostics: [...candidate.diagnostics, ...(realization?.diagnostics ?? [])],
				displayName: candidate.displayName,
				id: candidate.id,
				pose: candidate.approvedPose,
				preset: candidate.recipe.preset,
				preview: { status: "pending" as const }
			};
		}),
		...(recovery === undefined ? {} : { recovery }),
		selection: {
			actorPath: session.subject.actorPath,
			displayName: session.subject.displayName,
			mapPath: session.subject.mapPath
		},
		session,
		sessionId: session.id,
		status: "ready",
		viewId: session.viewId
	};
}

export const WorkbenchMapReviewLive = Layer.effect(
	WorkbenchMapReview,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const localFiles = yield* LocalFiles;
		const repository = yield* ReviewRepository;
		const capture = yield* ReviewCapture;
		const authoring = yield* ReviewAuthoring;
		const authoringSessions = yield* ReviewAuthoringSessions;
		const observatory = yield* Observatory;
		const editorSession = yield* EditorPlaySession;
		const cameraFeed = yield* CameraFeed;
		const remoteControl = yield* RemoteControlClient;
		const window = yield* WorkbenchWindow;
		const layerScope = yield* Effect.scope;
		const coordinator = yield* makeUnrealOperationCoordinator;
		const lastWorldSnapshot = yield* Ref.make<Option.Option<WorldScoutResult>>(Option.none());
		const activeReviewSetPath = yield* Ref.make<Option.Option<string>>(Option.none());
		const livePreviewBindings = yield* Ref.make<
			Option.Option<{
				readonly bindings: ReadonlyArray<{
					readonly candidateId: string;
					readonly index: number;
				}>;
				readonly poseFingerprint: string;
				readonly sessionId: string;
			}>
		>(Option.none());
		const livePreviewFps = yield* Ref.make(5);
		const playActiveCache = yield* Ref.make<
			Option.Option<{ readonly active: boolean; readonly checkedAtMs: number }>
		>(Option.none());
		const liveEnsureGate = yield* Semaphore.make(1);

		const observationPresentationReplacements = yield* Ref.make(0);
		const lastObservationSample = yield* Ref.make<Option.Option<WorldObservationSample>>(
			Option.none()
		);
		const lastPresentedCatalogKey = yield* Ref.make<string | undefined>(undefined);
		const pendingObservation = yield* Ref.make<PendingObservationSlots>(
			emptyPendingObservationSlots()
		);
		const observationWake = yield* Queue.sliding<void>(1);
		const nextObservationPresentationAtMillis = yield* Ref.make(0);
		const observationSubscription = yield* Ref.make<{
			readonly cadenceHz: WorldScoutRefreshRate | undefined;
			readonly fiber: Fiber.Fiber<void, never> | undefined;
			readonly pausedForExclusive: boolean;
			readonly subscribers: number;
		}>({
			cadenceHz: undefined,
			fiber: undefined,
			pausedForExclusive: false,
			subscribers: 0
		});

		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const current = yield* Ref.get(observationSubscription);
				if (current.fiber !== undefined) yield* Fiber.interrupt(current.fiber);
				yield* Ref.set(observationSubscription, {
					cadenceHz: undefined,
					fiber: undefined,
					pausedForExclusive: false,
					subscribers: 0
				});
				yield* Ref.set(pendingObservation, emptyPendingObservationSlots());
				yield* Queue.shutdown(observationWake);
			})
		);

		const sendObservationEvent = Effect.fn("Workbench.WorkbenchMapReview.sendObservationEvent")(
			function* (event: RendererWorldObservationEvent) {
				yield* window.send(worldObservationEventChannel, event).pipe(
					Effect.matchEffect({
						onFailure: () => Effect.void,
						onSuccess: () => Effect.void
					})
				);
			}
		);

		const takePendingObservation = (): Effect.Effect<Option.Option<PendingObservation>> =>
			Ref.modify(pendingObservation, (current) => {
				if (Option.isSome(current.status)) {
					return [
						Option.some<PendingObservation>({
							tag: "status",
							event: current.status.value
						}),
						{ ...current, status: Option.none() }
					];
				}
				if (Option.isSome(current.transforms)) {
					return [
						Option.some<PendingObservation>(current.transforms.value),
						{ ...current, transforms: Option.none() }
					];
				}
				return [Option.none(), current];
			});

		const sendPendingObservation = Effect.fn(
			"Workbench.WorkbenchMapReview.sendPendingObservation"
		)(function* (pending: PendingObservation) {
			const now = yield* Clock.currentTimeMillis;
			const deadline = yield* Ref.get(nextObservationPresentationAtMillis);
			const scheduledAt = Math.max(now, deadline);
			const delayMs = scheduledAt - now;
			if (delayMs > 0) yield* Effect.sleep(delayMs);
			const event: RendererWorldObservationEvent =
				pending.tag === "status"
					? pending.event
					: {
							kind: "transforms",
							actorsChanged: pending.actorsChanged,
							actorsSampled: pending.actorsSampled,
							health: pending.health,
							producerMonotonicMs: pending.producerMonotonicMs,
							producerReplacements: pending.producerReplacements,
							revision: pending.revision,
							sequence: pending.sequence,
							sessionId: pending.sessionId,
							status: pending.status,
							transforms: [...pending.transforms.entries()].map(
								([streamIndex, transform]) => ({
									streamIndex: StreamActorIndex.make(streamIndex),
									transform
								})
							),
							worldSeconds: pending.worldSeconds,
							...(pending.message === undefined ? {} : { message: pending.message }),
							...(pending.recovery === undefined
								? {}
								: { recovery: pending.recovery })
						};
			yield* sendObservationEvent(event);
			yield* Ref.set(
				nextObservationPresentationAtMillis,
				scheduledAt + 1_000 / maxWorldObservationPresentationHz
			);
		});

		const drainPendingObservations: Effect.Effect<void> = Effect.gen(function* () {
			while (true) {
				const next = yield* takePendingObservation();
				if (Option.isNone(next)) return;
				yield* sendPendingObservation(next.value);
			}
		});

		const observationDrainWorker: Effect.Effect<void> = Effect.gen(function* () {
			while (true) {
				yield* Queue.take(observationWake);
				yield* drainPendingObservations;
			}
		});

		yield* observationDrainWorker.pipe(Effect.forkScoped);

		const queueStatusEvent = (event: RendererWorldObservationEvent) =>
			Ref.set(pendingObservation, {
				status: Option.some(event),
				transforms: Option.none()
			}).pipe(Effect.andThen(Queue.offer(observationWake, undefined)), Effect.asVoid);

		const ingestObservationState = Effect.fn(
			"Workbench.WorkbenchMapReview.ingestObservationState"
		)(function* (state: WorldObservationState) {
			if (state.status === "live" || state.status === "stale") {
				yield* Ref.set(lastObservationSample, Option.some(state.sample));
				yield* Ref.set(lastPresentedCatalogKey, catalogKey(state.sample));
			} else {
				yield* Ref.set(lastPresentedCatalogKey, undefined);
				if (state.status === "unavailable" && state.sample !== undefined) {
					yield* Ref.set(lastObservationSample, Option.some(state.sample));
				}
			}
			const event = stateToStatusEvent(state);
			if (event !== undefined) yield* queueStatusEvent(event);
		});

		/**
		 * Diff consecutive live samples so IPC carries only changed transforms. Catalog
		 * metadata is never resent on ordinary transform ticks.
		 */
		const ingestObservationStateWithDiff = Effect.fn(
			"Workbench.WorkbenchMapReview.ingestObservationStateWithDiff"
		)(function* (state: WorldObservationState, previous: WorldObservationState | undefined) {
			if (state.status !== "live" && state.status !== "stale") {
				yield* ingestObservationState(state);
				return;
			}
			const key = catalogKey(state.sample);
			const presentedKey = yield* Ref.get(lastPresentedCatalogKey);
			if (presentedKey !== key) {
				yield* ingestObservationState(state);
				return;
			}
			yield* Ref.set(lastObservationSample, Option.some(state.sample));
			const priorTransforms =
				previous !== undefined &&
				(previous.status === "live" || previous.status === "stale") &&
				catalogKey(previous.sample) === key
					? previous.sample.transforms
					: undefined;
			const changed = new Map<number, WorldTransform>();
			for (const [index, transform] of state.sample.transforms) {
				const prior = priorTransforms?.get(index);
				if (
					prior === undefined ||
					prior.location.x !== transform.location.x ||
					prior.location.y !== transform.location.y ||
					prior.location.z !== transform.location.z ||
					prior.rotation.x !== transform.rotation.x ||
					prior.rotation.y !== transform.rotation.y ||
					prior.rotation.z !== transform.rotation.z
				) {
					changed.set(index, transform);
				}
			}
			const hadPending = yield* Ref.modify(pendingObservation, (current) => {
				const transforms = new Map<number, WorldTransform>();
				if (Option.isSome(current.transforms)) {
					for (const [index, transform] of current.transforms.value.transforms) {
						transforms.set(index, transform);
					}
				}
				for (const [index, transform] of changed) transforms.set(index, transform);
				const next: PendingObservation = {
					tag: "transforms",
					actorsChanged: changed.size,
					actorsSampled: state.sample.catalog.entries.length,
					health: state.sample.health,
					producerMonotonicMs: state.sample.sampleWorldSeconds,
					producerReplacements: state.sample.health.producerReplacements,
					revision: state.sample.catalog.revision.toString(),
					sequence: state.sample.lastSequence.toString(),
					sessionId: state.sample.catalog.sessionId,
					status: state.status,
					transforms,
					worldSeconds: state.sample.sampleWorldSeconds,
					...(state.status === "stale"
						? { message: state.message, recovery: state.recovery }
						: {})
				};
				return [
					Option.isSome(current.transforms),
					{ ...current, transforms: Option.some(next) }
				];
			});
			if (hadPending) {
				yield* Ref.update(observationPresentationReplacements, (count) => count + 1);
				yield* recordObservatoryIpcReplacements(1);
			}
			yield* Queue.offer(observationWake, undefined);
		});

		const stopObservationFiber = Effect.fn("Workbench.WorkbenchMapReview.stopObservationFiber")(
			function* () {
				const current = yield* Ref.get(observationSubscription);
				if (current.fiber !== undefined) yield* Fiber.interrupt(current.fiber);
				yield* Ref.update(observationSubscription, (subscription) => ({
					...subscription,
					fiber: undefined
				}));
			}
		);

		const startObservationFiber = Effect.fn(
			"Workbench.WorkbenchMapReview.startObservationFiber"
		)(function* (cadenceHz: WorldScoutRefreshRate) {
			yield* stopObservationFiber();
			let previous: WorldObservationState | undefined;
			const fiber = yield* observatory
				.observe(configuration.remoteControlEndpoint, { cadenceHz })
				.pipe(
					Stream.runForEach((state) =>
						Effect.gen(function* () {
							yield* ingestObservationStateWithDiff(state, previous);
							previous = state;
						})
					),
					Effect.catch(() =>
						Effect.gen(function* () {
							const sample = yield* Ref.get(lastObservationSample);
							yield* queueStatusEvent({
								kind: "unavailable",
								message: "World observation stopped unexpectedly.",
								recovery:
									"Unsubscribe and subscribe again, or use Connect world for a snapshot.",
								...(Option.isSome(sample)
									? { sample: sampleToWire(sample.value) }
									: {})
							});
						})
					),
					Effect.forkIn(layerScope)
				);
			yield* Ref.update(observationSubscription, (subscription) => ({
				...subscription,
				cadenceHz,
				fiber
			}));
		});

		const pauseObservationForExclusive = Effect.fn(
			"Workbench.WorkbenchMapReview.pauseObservationForExclusive"
		)(function* () {
			const current = yield* Ref.get(observationSubscription);
			if (current.subscribers <= 0) return;
			yield* Ref.update(observationSubscription, (subscription) => ({
				...subscription,
				pausedForExclusive: true
			}));
			yield* stopObservationFiber();
			const sample = yield* Ref.get(lastObservationSample);
			if (Option.isSome(sample)) {
				yield* Ref.set(lastPresentedCatalogKey, undefined);
				yield* queueStatusEvent({
					kind: "catalog",
					message: "Unreal is busy with a selected preview or durable capture.",
					recovery: "Live world observation will resume automatically.",
					sample: sampleToWire(sample.value),
					status: "stale"
				});
			}
		});

		const resumeObservationAfterExclusive = Effect.fn(
			"Workbench.WorkbenchMapReview.resumeObservationAfterExclusive"
		)(function* () {
			const current = yield* Ref.get(observationSubscription);
			yield* Ref.update(observationSubscription, (subscription) => ({
				...subscription,
				pausedForExclusive: false
			}));
			if (current.subscribers <= 0 || current.cadenceHz === undefined) return;
			yield* Ref.set(lastPresentedCatalogKey, undefined);
			yield* startObservationFiber(current.cadenceHz);
		});

		const withObservationPause = <A, E, R>(
			effect: Effect.Effect<A, E, R>
		): Effect.Effect<A, E, R> =>
			pauseObservationForExclusive().pipe(
				Effect.andThen(effect),
				Effect.ensuring(resumeObservationAfterExclusive())
			) as Effect.Effect<A, E, R>;

		const runExclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			coordinator.exclusive(withObservationPause(effect));

		const subscribeWorldObservations = Effect.fn(
			"Workbench.WorkbenchMapReview.subscribeWorldObservations"
		)(function* (cadenceHz: WorldScoutRefreshRate) {
			const current = yield* Ref.get(observationSubscription);
			const subscribers = current.subscribers + 1;
			yield* Ref.set(observationSubscription, {
				...current,
				cadenceHz,
				subscribers
			});
			if (current.pausedForExclusive) return;
			if (
				subscribers === 1 ||
				current.cadenceHz !== cadenceHz ||
				current.fiber === undefined
			) {
				yield* startObservationFiber(cadenceHz);
			}
		});

		const unsubscribeWorldObservations = Effect.fn(
			"Workbench.WorkbenchMapReview.unsubscribeWorldObservations"
		)(function* () {
			const current = yield* Ref.get(observationSubscription);
			const subscribers = Math.max(0, current.subscribers - 1);
			yield* Ref.set(observationSubscription, {
				...current,
				subscribers
			});
			if (subscribers === 0) {
				yield* stopObservationFiber();
				yield* Ref.set(pendingObservation, emptyPendingObservationSlots());
				yield* Ref.set(lastPresentedCatalogKey, undefined);
			}
		});

		const setWorldObservationRate = Effect.fn(
			"Workbench.WorkbenchMapReview.setWorldObservationRate"
		)(function* (cadenceHz: WorldScoutRefreshRate) {
			const current = yield* Ref.get(observationSubscription);
			if (current.subscribers <= 0 || current.cadenceHz === undefined) return cadenceHz;
			const updated = yield* coordinator
				.poll(
					observatory.setObservationCadence(
						configuration.remoteControlEndpoint,
						cadenceHz
					)
				)
				.pipe(Effect.orElseSucceed(() => Option.none()));
			if (Option.isNone(updated)) return current.cadenceHz;
			yield* Ref.update(observationSubscription, (subscription) => ({
				...subscription,
				cadenceHz: updated.value
			}));
			return updated.value;
		});

		const worldObservationPresentationReplacements = Effect.fn(
			"Workbench.WorkbenchMapReview.worldObservationPresentationReplacements"
		)(() => Ref.get(observationPresentationReplacements));

		const invalidateLivePreviewBank = Effect.fn(
			"Workbench.WorkbenchMapReview.invalidateLivePreviewBank"
		)(function* () {
			yield* Ref.set(livePreviewBindings, Option.none());
			yield* clearReviewPreviewSources(configuration.remoteControlEndpoint).pipe(
				Effect.provideService(RemoteControlClient, remoteControl),
				Effect.ignore
			);
		});

		const applyLivePreviewSchedule = Effect.fn(
			"Workbench.WorkbenchMapReview.applyLivePreviewSchedule"
		)(function* (cameraCount: number, fps: number) {
			const clamped = clampLivePreviewFps(fps);
			yield* Ref.set(livePreviewFps, clamped);
			if (cameraCount <= 0) return clamped;
			yield* configureCameras(configuration.remoteControlEndpoint, {
				activeCameraCount: cameraCount,
				backgroundFps: clamped,
				captureBudgetPerTick: Math.min(8, cameraCount),
				focusedCameraIndex: 0,
				focusedFps: clamped,
				paused: false,
				pipelineMode: "full_pipeline",
				renderProfile: "observation",
				resolution: "320x180",
				viewMode: "posed"
			}).pipe(Effect.provideService(RemoteControlClient, remoteControl));
			return clamped;
		});

		const setLivePreviewFps = Effect.fn("Workbench.WorkbenchMapReview.setLivePreviewFps")(
			function* (fps: number) {
				const bindings = yield* Ref.get(livePreviewBindings);
				const cameraCount = Option.isSome(bindings) ? bindings.value.bindings.length : 0;
				return yield* applyLivePreviewSchedule(cameraCount, fps).pipe(
					Effect.catch((cause) =>
						Effect.gen(function* () {
							const clamped = clampLivePreviewFps(fps);
							yield* Ref.set(livePreviewFps, clamped);
							yield* Effect.logWarning(
								`Live preview FPS stored as ${clamped}; schedule update failed: ${String(cause)}`
							);
							return clamped;
						})
					)
				);
			}
		);

		const reviewProject =
			configuration.review.status === "not_configured"
				? undefined
				: { projectRoot: configuration.review.projectRoot };
		const selectedReviewSetPath = Effect.fn(
			"Workbench.WorkbenchMapReview.selectedReviewSetPath"
		)(function* () {
			if (configuration.review.status === "configured")
				return configuration.review.reviewSetPath;
			return yield* Ref.get(activeReviewSetPath).pipe(Effect.map(Option.getOrUndefined));
		});

		const worldSnapshot = Effect.fn("Workbench.WorkbenchMapReview.worldSnapshot")(function* () {
			const result = yield* coordinator.poll(
				observatory.snapshot(configuration.remoteControlEndpoint).pipe(
					Effect.map((snapshot) => ({ snapshot, status: "ready" as const })),
					Effect.catch((cause) =>
						Effect.succeed({
							message: cause.message,
							recovery: cause.recovery,
							status: "unavailable" as const
						})
					)
				)
			);
			if (Option.isSome(result)) {
				if (result.value.status === "ready") {
					yield* Ref.set(lastWorldSnapshot, Option.some(result.value));
				}
				return result.value;
			}
			return Option.getOrElse(yield* Ref.get(lastWorldSnapshot), () => ({
				message: "Unreal is busy with a selected preview or durable capture.",
				recovery: "Live world scouting will resume automatically.",
				status: "unavailable" as const
			}));
		});

		const focusActor = Effect.fn("Workbench.WorkbenchMapReview.focusActor")(function* (
			actorId: ActorId,
			bringToFront: boolean
		) {
			const focused = yield* coordinator.poll(
				observatory.focus(configuration.remoteControlEndpoint, actorId, bringToFront).pipe(
					Effect.catch((cause) =>
						Effect.succeed({
							actorId,
							message: cause.message,
							recovery: cause.recovery,
							status: "failed" as const
						})
					)
				)
			);
			return Option.getOrElse(focused, () => ({
				actorId,
				message: "Unreal is busy with an exclusive capture or authoring operation.",
				recovery: "Wait for that operation to finish, then focus the actor again.",
				status: "failed" as const
			}));
		});

		const buildRunView = Effect.fn("Workbench.WorkbenchMapReview.buildRunView")(function* (
			summary: CaptureRunSummary,
			reviewSet: ReviewSet
		) {
			const run = yield* repository.loadRun(summary.path);
			const captured = run.results.find((result) => result.status === "captured");
			if (!captured) return summary satisfies MapReviewRunView;
			const view = reviewSet.views.find((candidate) => candidate.id === captured.viewId);
			const bytes = yield* localFiles.readFileWithin(
				dirname(summary.path),
				captured.artifact.relativePath
			);
			return {
				...summary,
				preview: {
					bytes,
					height: captured.artifact.height,
					viewName: view?.displayName ?? captured.viewId,
					width: captured.artifact.width
				}
			} satisfies MapReviewRunView;
		});

		const load = Effect.fn("Workbench.WorkbenchMapReview.load")(function* () {
			if (reviewProject === undefined) return { status: "not_configured" as const };
			const { projectRoot } = reviewProject;
			const reviewSetPath = yield* selectedReviewSetPath();
			if (reviewSetPath === undefined) return { status: "setup_required" as const };
			return yield* Effect.gen(function* () {
				const reviewSet = yield* repository.loadSet(reviewSetPath);
				const views = yield* Effect.forEach(reviewSet.views, (view) => {
					const profile = reviewSet.captureProfiles.find(
						(candidate) => candidate.id === view.captureProfileId
					);
					return profile
						? Effect.succeed({
								displayName: view.displayName,
								id: view.id,
								resolution: profile.resolution
							})
						: Effect.fail(
								new Error(
									`Review View ${view.id} references missing profile ${view.captureProfileId}.`
								)
							);
				});
				const summaries = yield* repository.listRuns(projectRoot);
				const runs = yield* Effect.forEach(
					summaries,
					(summary) => buildRunView(summary, reviewSet),
					{ concurrency: artifactReadConcurrency }
				);
				return {
					reviewSet: {
						displayName: reviewSet.displayName,
						mapPath: reviewSet.project.mapPath,
						viewCount: reviewSet.views.length,
						views
					},
					runs,
					status: "ready" as const
				};
			}).pipe(Effect.catch((cause) => Effect.succeed(mapReviewFailure(cause))));
		});

		const captureAndReload = Effect.fn("Workbench.WorkbenchMapReview.capture")(function* (
			intent: MapReviewCaptureIntent
		) {
			if (reviewProject === undefined) return { status: "not_configured" as const };
			const reviewSetPath = yield* selectedReviewSetPath();
			if (reviewSetPath === undefined) return { status: "not_configured" as const };
			const session = yield* editorSession
				.status(configuration.remoteControlEndpoint)
				.pipe(Effect.option);
			if (Option.isNone(session)) {
				return {
					policy: {
						code: "play_session_unavailable" as const,
						message: "Workbench could not verify the Unreal Editor play-session state.",
						recovery:
							"Confirm UEShedCoreEditor and Remote Control are available, then retry."
					},
					status: "blocked" as const
				};
			}
			const policy = evaluateReviewCapturePolicy(session.value.state);
			if (policy.status === "blocked") {
				const { status: _status, ...block } = policy;
				return { policy: block, status: "blocked" as const };
			}
			const { projectRoot } = reviewProject;
			return yield* runExclusive(
				capture
					.captureSet({
						endpoint: configuration.remoteControlEndpoint,
						projectRoot,
						reviewSetPath,
						viewIds: intent.viewIds.map((viewId) => ReviewViewId.make(viewId))
					})
					.pipe(
						Effect.flatMap((run) =>
							load().pipe(
								Effect.map((review): MapReviewCaptureResult => {
									if (review.status === "setup_required") {
										return { status: "not_configured" as const };
									}
									if (review.status !== "ready") return review;
									const failedViews = run.results.filter(
										(result) => result.status === "failed"
									).length;
									return {
										job: {
											completedAt: run.completedAt,
											context: "editor",
											failedViews,
											jobId: run.id,
											progress: {
												completedViews: run.results.length,
												totalViews: intent.viewIds.length
											},
											runId: run.id,
											status: "completed",
											successfulViews: run.results.length - failedViews,
											viewIds: intent.viewIds
										},
										review,
										status: "completed"
									};
								})
							)
						),
						Effect.catch((cause) => Effect.succeed(mapReviewFailure(cause)))
					)
			);
		});

		const authorFromSelection = Effect.fn("Workbench.WorkbenchMapReview.authorFromSelection")(
			function* () {
				if (reviewProject === undefined) {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const { projectRoot } = reviewProject;
				return yield* runExclusive(
					Effect.gen(function* () {
						yield* invalidateLivePreviewBank();
						const selection = yield* authoring.inspectSelection(
							configuration.remoteControlEndpoint
						);
						if (selection.status === "failed") {
							return {
								error: { message: selection.message, recovery: selection.recovery },
								status: "failed" as const
							};
						}
						const candidates = generateFramingCandidates(selection);
						const session = yield* authoringSessions.start({
							candidates,
							projectRoot,
							...(configuration.review.status === "configured"
								? { reviewSetPath: configuration.review.reviewSetPath }
								: {}),
							selection
						});
						return authoringResult(session);
					}).pipe(
						Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause)))
					)
				);
			}
		);

		const authoringResume = Effect.fn("Workbench.WorkbenchMapReview.authoringResume")(
			function* (intent: MapReviewAuthoringSessionIntent | undefined) {
				if (reviewProject === undefined) {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const projectRoot = reviewProject.projectRoot;
				return yield* Effect.gen(function* () {
					const session = intent
						? yield* authoringSessions.load({
								projectRoot,
								sessionId: intent.sessionId
							})
						: yield* authoringSessions.latest({
								projectRoot
							});
					if (!session) {
						return mapReviewAuthoringFailure({
							message: "There is no active Map Review authoring session to resume.",
							recovery: "Select an actor and use Reframe selected actor to start one."
						});
					}
					return yield* runExclusive(
						authoringSessions
							.resume({
								endpoint: configuration.remoteControlEndpoint,
								projectRoot,
								sessionId: session.id
							})
							.pipe(
								Effect.map((recovered): MapReviewAuthoringResult => {
									if (recovered.status === "resumable")
										return authoringResult(recovered.session);
									if (recovered.status === "stale") {
										return authoringResult(
											recovered.session,
											recovered.recovery
										);
									}
									return mapReviewAuthoringFailure({
										message:
											recovered.status === "corrupt"
												? recovered.message
												: "The persisted Review Set is unavailable.",
										recovery: recovered.recovery
									});
								})
							)
					);
				}).pipe(Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause))));
			}
		);

		const authoringPatch = Effect.fn("Workbench.WorkbenchMapReview.authoringPatch")(function* (
			intent: MapReviewAuthoringPatchIntent
		) {
			if (reviewProject === undefined) {
				return mapReviewAuthoringFailure({ message: "No review project is configured." });
			}
			const projectRoot = reviewProject.projectRoot;
			return yield* authoringSessions
				.patch({
					patch: intent.patch,
					projectRoot,
					sessionId: intent.sessionId
				})
				.pipe(
					Effect.map(authoringResult),
					Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause)))
				);
		});

		const discardAuthoring = Effect.fn("Workbench.WorkbenchMapReview.discardAuthoring")(
			function* (intent: MapReviewAuthoringSessionIntent) {
				if (reviewProject === undefined) {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const projectRoot = reviewProject.projectRoot;
				return yield* Effect.gen(function* () {
					yield* invalidateLivePreviewBank();
					const session = yield* authoringSessions.discard({
						projectRoot,
						sessionId: intent.sessionId
					});
					return authoringResult(session);
				}).pipe(Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause))));
			}
		);

		const authoringReframe = Effect.fn("Workbench.WorkbenchMapReview.authoringReframe")(
			function* (intent: MapReviewAuthoringSessionIntent) {
				if (reviewProject === undefined) {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const { projectRoot } = reviewProject;
				return yield* runExclusive(
					Effect.gen(function* () {
						yield* invalidateLivePreviewBank();
						const selection = yield* authoring.inspectSelection(
							configuration.remoteControlEndpoint
						);
						if (selection.status === "failed") {
							return mapReviewAuthoringFailure({
								message: selection.message,
								recovery: selection.recovery
							});
						}
						const session = yield* authoringSessions.reframe({
							candidates: generateFramingCandidates(selection),
							projectRoot,
							selection,
							sessionId: intent.sessionId
						});
						return authoringResult(session);
					}).pipe(
						Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause)))
					)
				);
			}
		);

		const previewAuthoringCandidate = Effect.fn(
			"Workbench.WorkbenchMapReview.previewAuthoringCandidate"
		)(function* (intent: MapReviewAuthoringPreviewIntent) {
			return yield* Effect.gen(function* () {
				if (reviewProject === undefined) {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const projectRoot = reviewProject.projectRoot;

				const session = yield* authoringSessions.load({
					projectRoot,
					sessionId: intent.sessionId
				});
				if (session.lifecycle !== "active") {
					return mapReviewAuthoringFailure({
						message:
							"Reframe before requesting previews for a stale or completed session.",
						recovery: "Use Reframe selected actor to regenerate reviewable candidates."
					});
				}
				const candidate = session.candidates.find((item) => item.id === intent.candidateId);
				if (!candidate) {
					return mapReviewAuthoringFailure({
						message: `Candidate ${intent.candidateId} is no longer available.`
					});
				}
				const poseFingerprint = livePreviewPoseFingerprint(session.candidates);

				const nowMs = yield* Clock.currentTimeMillis;
				const cachedPlay = yield* Ref.get(playActiveCache);
				const playActive = yield* Option.match(cachedPlay, {
					onNone: () =>
						editorSession.status(configuration.remoteControlEndpoint).pipe(
							Effect.map(
								(playState) =>
									playState.state.status === "running" ||
									playState.state.status === "paused"
							),
							Effect.tap((active) =>
								Ref.set(
									playActiveCache,
									Option.some({ active, checkedAtMs: nowMs })
								)
							),
							Effect.orElseSucceed(() => false)
						),
					onSome: (cached) =>
						nowMs - cached.checkedAtMs < 2_000
							? Effect.succeed(cached.active)
							: editorSession.status(configuration.remoteControlEndpoint).pipe(
									Effect.map(
										(playState) =>
											playState.state.status === "running" ||
											playState.state.status === "paused"
									),
									Effect.tap((active) =>
										Ref.set(
											playActiveCache,
											Option.some({ active, checkedAtMs: nowMs })
										)
									),
									Effect.orElseSucceed(() => false)
								)
				});

				if (playActive) {
					const bindings = yield* liveEnsureGate.withPermits(1)(
						Effect.gen(function* () {
							const cached = yield* Ref.get(livePreviewBindings);
							if (
								Option.isSome(cached) &&
								cached.value.sessionId === intent.sessionId &&
								cached.value.poseFingerprint === poseFingerprint
							) {
								return cached.value.bindings;
							}
							return yield* runExclusive(
								Effect.gen(function* () {
									const fps = yield* Ref.get(livePreviewFps);
									const next = yield* ensureReviewPreviewSources(
										configuration.remoteControlEndpoint,
										session.candidates.map((item) => ({
											candidateId: item.id,
											fieldOfViewDegrees:
												item.approvedPose.fieldOfViewDegrees,
											height: 180,
											location: item.approvedPose.location,
											rotation: item.approvedPose.rotation,
											width: 320
										})),
										{ previewFps: fps }
									).pipe(
										Effect.provideService(RemoteControlClient, remoteControl)
									);
									yield* Ref.set(
										livePreviewBindings,
										Option.some({
											bindings: next.map((item) => ({
												candidateId: item.candidateId,
												index: item.index
											})),
											poseFingerprint,
											sessionId: intent.sessionId
										})
									);
									return next.map((item) => ({
										candidateId: item.candidateId,
										index: item.index
									}));
								})
							);
						})
					);
					const binding = bindings.find((item) => item.candidateId === candidate.id);
					if (!binding) {
						return mapReviewAuthoringFailure({
							message: `Live preview camera for ${candidate.id} was not registered.`,
							recovery: "Stop and restart PIE, then reframe the subject."
						});
					}
					const frame = yield* awaitReviewPreviewFrame({
						cameraIndex: binding.index,
						latestFrames: cameraFeed.latestFrames,
						timeout: "3 seconds"
					});
					return {
						bytes: frame.pixels,
						cameraIndex: binding.index,
						diagnostics: [],
						height: frame.height,
						pixelFormat: "bgra8" as const,
						status: "ready" as const,
						width: frame.width
					};
				}

				yield* invalidateLivePreviewBank();
				return yield* runExclusive(
					Effect.gen(function* () {
						const reviewSet =
							session.pendingReviewSet ??
							(yield* repository.loadSet(session.reviewSet.path));
						const view = reviewSet.views.find((item) => item.id === session.viewId);
						const profile =
							(view === undefined
								? undefined
								: reviewSet.captureProfiles.find(
										(item) => item.id === view.captureProfileId
									)) ?? reviewSet.captureProfiles[0];
						if (!profile) {
							return mapReviewAuthoringFailure({
								message: "The Review Set has no capture profile for previews.",
								recovery:
									"Add a capture profile to the Review Set, then reframe the subject."
							});
						}
						const subject = yield* authoring.inspectSubject({
							actorPath: session.subject.actorPath,
							endpoint: configuration.remoteControlEndpoint
						});
						if (subject.status === "failed") {
							return mapReviewAuthoringFailure({
								message: subject.message,
								recovery: subject.recovery
							});
						}
						const preview = yield* authoring.previewCandidate({
							candidate,
							endpoint: configuration.remoteControlEndpoint,
							mapPath: session.subject.mapPath,
							profile: { ...profile, resolution: { height: 180, width: 320 } },
							subject: {
								actorPath: subject.actorPath,
								displayName: subject.displayName
							}
						});
						const updated = yield* authoringSessions.recordProjection({
							candidateId: candidate.id,
							projectRoot,
							projection: preview.projection,
							sessionId: session.id
						});
						const realization = updated.realizations.find(
							(item) => item.candidateId === candidate.id
						);
						return {
							bytes: preview.bytes,
							diagnostics: realization?.diagnostics ?? [],
							height: preview.height,
							pixelFormat: "png" as const,
							projection: preview.projection,
							status: "ready" as const,
							width: preview.width
						};
					})
				);
			}).pipe(Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause))));
		});

		const approveAuthoring = Effect.fn("Workbench.WorkbenchMapReview.approveAuthoring")(
			function* (intent: MapReviewAuthoringSessionIntent) {
				if (reviewProject === undefined) {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const projectRoot = reviewProject.projectRoot;
				return yield* runExclusive(
					authoringSessions
						.approve({
							endpoint: configuration.remoteControlEndpoint,
							projectRoot,
							sessionId: intent.sessionId
						})
						.pipe(
							Effect.flatMap((result) =>
								Effect.gen(function* () {
									if (
										result.status === "resumable" &&
										result.session.lifecycle === "approved"
									) {
										yield* Ref.set(
											activeReviewSetPath,
											Option.some(result.session.reviewSet.path)
										);
										const candidateId =
											result.session.selectedCandidateId ??
											result.session.candidates[0]?.id;
										return candidateId === undefined
											? mapReviewAuthoringFailure({
													message: "No candidate was approved."
												})
											: { candidateId, status: "approved" as const };
									}
									const recovery =
										result.status === "resumable"
											? "The authoring session was not approved. Reframe before keeping a Review View."
											: result.recovery;
									return mapReviewAuthoringFailure({
										message:
											"The authoring session became stale before approval.",
										recovery
									});
								})
							),
							Effect.catch((cause) =>
								Effect.succeed(mapReviewAuthoringFailure(cause))
							)
						)
				);
			}
		);

		const previewCandidate = Effect.fn("Workbench.WorkbenchMapReview.previewCandidate")(
			function* (candidateId: string) {
				if (configuration.review.status !== "configured") {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const { reviewSetPath } = configuration.review;
				return yield* runExclusive(
					Effect.gen(function* () {
						const reviewSet = yield* repository.loadSet(reviewSetPath);
						const selection = yield* authoring.inspectSelection(
							configuration.remoteControlEndpoint
						);
						if (selection.status === "failed") {
							return {
								error: { message: selection.message, recovery: selection.recovery },
								status: "failed" as const
							};
						}
						const candidate = generateFramingCandidates(selection).find(
							(candidate) => candidate.id === candidateId
						);
						if (!candidate) {
							return mapReviewAuthoringFailure({
								message: `Candidate ${candidateId} is no longer available.`
							});
						}
						const view = reviewSet.views[0];
						const profile =
							(view === undefined
								? undefined
								: reviewSet.captureProfiles.find(
										(candidate) => candidate.id === view.captureProfileId
									)) ?? reviewSet.captureProfiles[0];
						if (!profile) {
							return mapReviewAuthoringFailure({
								message: "The Review Set has no capture profile for previews.",
								recovery:
									"Add a capture profile to the Review Set, then reframe the subject."
							});
						}
						const preview = yield* authoring.previewCandidate({
							candidate,
							endpoint: configuration.remoteControlEndpoint,
							mapPath: selection.mapPath,
							profile: { ...profile, resolution: { height: 180, width: 320 } },
							subject: {
								actorPath: selection.actorPath,
								displayName: selection.displayName
							}
						});
						return { ...preview, status: "ready" as const };
					}).pipe(
						Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause)))
					)
				);
			}
		);

		const approveCandidate = Effect.fn("Workbench.WorkbenchMapReview.approveCandidate")(
			function* (intent: MapReviewApproveCandidateIntent) {
				if (configuration.review.status !== "configured") {
					return mapReviewAuthoringFailure({
						message: "No review project is configured."
					});
				}
				const { reviewSetPath } = configuration.review;
				return yield* Effect.gen(function* () {
					const reviewSet = yield* repository.loadSet(reviewSetPath);
					const selection = yield* authoring.inspectSelection(
						configuration.remoteControlEndpoint
					);
					if (selection.status === "failed") {
						return {
							error: { message: selection.message, recovery: selection.recovery },
							status: "failed" as const
						};
					}
					if (selection.actorPath !== intent.sourceActorPath) {
						return mapReviewAuthoringFailure({
							message:
								"The selected actor changed after these framing candidates were generated. Reframe the selected actor before keeping a view."
						});
					}
					const candidate = generateFramingCandidates(selection).find(
						(candidate) => candidate.id === intent.candidateId
					);
					if (!candidate) {
						return mapReviewAuthoringFailure({
							message: `Candidate ${intent.candidateId} is no longer available.`
						});
					}
					if (
						JSON.stringify(candidate.approvedPose) !==
						JSON.stringify(intent.candidatePose)
					) {
						return mapReviewAuthoringFailure({
							message:
								"The selected actor bounds or framing inputs changed after this preview was generated. Reframe before keeping the view so the saved pose matches what you reviewed."
						});
					}
					const approved = approveFramingCandidate({
						candidate,
						...(intent.manualPose ? { manualPose: intent.manualPose } : {}),
						...(intent.manualReason ? { manualReason: intent.manualReason } : {}),
						reviewSet,
						subject: {
							actorPath: selection.actorPath,
							diagnosticLabel: selection.displayName,
							kind: "actor_path"
						},
						viewId: ReviewViewId.make(intent.viewId)
					});
					if (approved.status === "view_not_found") {
						return mapReviewAuthoringFailure({
							message: `Review View ${approved.viewId} was not found.`
						});
					}
					yield* repository.saveSet({
						path: reviewSetPath,
						reviewSet: approved.reviewSet
					});
					return { candidateId: candidate.id, status: "approved" as const };
				}).pipe(Effect.catch((cause) => Effect.succeed(mapReviewAuthoringFailure(cause))));
			}
		);

		return WorkbenchMapReview.of({
			approveAuthoring,
			approveCandidate,
			authoringPatch,
			authoringReframe,
			authoringResume,
			authorFromSelection,
			capture: captureAndReload,
			discardAuthoring,
			focusActor,
			load,
			previewAuthoringCandidate,
			previewCandidate,
			setLivePreviewFps,
			setWorldObservationRate,
			subscribeWorldObservations,
			unsubscribeWorldObservations,
			worldObservationPresentationReplacements,
			worldSnapshot
		});
	})
);

export function makeWorkbenchMapReviewTestLayer(
	service: WorkbenchMapReviewShape
): Layer.Layer<WorkbenchMapReview> {
	return Layer.succeed(WorkbenchMapReview, WorkbenchMapReview.of(service));
}
