import { Effect, Schema } from "effect";
import {
	CameraBridgeSnapshot,
	arrangementBridgeCameras,
	readyCameraBridge,
	type CameraAuthoringBridge
} from "./camera-authoring-bridge.js";
import {
	CameraOperationId,
	ArrangementCameraId,
	CameraArrangementError,
	arrangementFailure,
	resolveArrangementCamera
} from "./camera-arrangement.js";
import { ApprovedPose } from "./review-schema.js";
import type { CameraAuthoringStore } from "./camera-authoring-store.js";

export const CameraRecoveryProposal = Schema.Struct({
	version: Schema.Literal(1),
	nativeCommitRevision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	native: CameraBridgeSnapshot,
	saved: Schema.Array(Schema.Struct({ id: ArrangementCameraId, pose: ApprovedPose })).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(256)
	)
});
export type CameraRecoveryProposal = typeof CameraRecoveryProposal.Type;
export const CameraRecoveryChoice = Schema.Literals(["saved", "native"]);
export type CameraRecoveryChoice = typeof CameraRecoveryChoice.Type;

/** Inspect a preserved recovery file without reconnecting or replaying it. */
export const prepareCameraRecovery = Effect.fn("CameraAuthoring.prepareRecovery")(function* (
	store: CameraAuthoringStore,
	input: CameraBridgeSnapshot
) {
	const native = yield* Schema.decodeUnknownEffect(CameraBridgeSnapshot)(input);
	const document = yield* store.load();
	if (document.arrangement.id !== native.sessionId)
		return yield* Effect.fail(
			arrangementFailure(
				"scope_mismatch",
				"The recovery session belongs to another arrangement."
			)
		);
	const committed = document.outcomes.find(
		(entry) => entry.operationId === `native-${native.producerId}-${native.sequence}`
	);
	return CameraRecoveryProposal.make({
		version: 1,
		...(committed ? { nativeCommitRevision: committed.revision } : undefined),
		expectedRevision: document.arrangement.revision,
		native,
		saved: arrangementBridgeCameras(document.arrangement).map(({ id, pose }) => ({ id, pose }))
	});
});

/** Read-only review of the durable draft and still-pending native edits. */
export const inspectCameraRecovery = Effect.fn("CameraAuthoring.inspectRecovery")(function* (
	store: CameraAuthoringStore,
	bridge: CameraAuthoringBridge,
	attachment: CameraBridgeSnapshot
) {
	const native = yield* bridge
		.call({
			version: 1,
			operation: "inspect",
			sessionId: attachment.sessionId,
			producerId: attachment.producerId
		})
		.pipe(Effect.flatMap(readyCameraBridge));
	return yield* prepareCameraRecovery(store, native);
});

/** Resolve only the inspected native gesture and host revision. Never approves saved Views. */
export const resolveCameraRecovery = Effect.fn("CameraAuthoring.resolveRecovery")(function* (
	store: CameraAuthoringStore,
	bridge: CameraAuthoringBridge,
	input: CameraRecoveryProposal,
	inputChoice: CameraRecoveryChoice
) {
	const proposal = yield* Schema.decodeUnknownEffect(CameraRecoveryProposal)(input);
	const choice = yield* Schema.decodeUnknownEffect(CameraRecoveryChoice)(inputChoice);
	const inspected = yield* inspectCameraRecovery(store, bridge, proposal.native);
	const native = inspected.native;
	if (
		inspected.expectedRevision !== proposal.expectedRevision ||
		native.producerId !== proposal.native.producerId ||
		native.sequence !== proposal.native.sequence ||
		native.revision !== proposal.native.revision ||
		native.pending !== proposal.native.pending
	)
		return yield* Effect.fail(
			arrangementFailure(
				"stale",
				"The saved draft or native camera changed. Inspect recovery again before choosing."
			)
		);
	const document = yield* restoreCameraRecovery(store, proposal, choice);
	const cameraId = document.arrangement.cameras.some((camera) => camera.id === native.cameraId)
		? native.cameraId
		: document.arrangement.cameras[0]!.id;
	return yield* bridge
		.call({
			version: 1,
			operation: "apply",
			sessionId: native.sessionId,
			producerId: native.producerId,
			expectedRevision: native.revision,
			revision: document.arrangement.revision,
			sequence: native.sequence,
			cameras: arrangementBridgeCameras(document.arrangement),
			cameraId,
			pose: resolveArrangementCamera(document.arrangement, cameraId)
		})
		.pipe(Effect.flatMap(readyCameraBridge));
});

/** Restore an explicitly reviewed file to the draft; the caller must reattach to resume editing. */
export const restoreCameraRecovery = Effect.fn("CameraAuthoring.restoreRecovery")(function* (
	store: CameraAuthoringStore,
	input: CameraRecoveryProposal,
	inputChoice: CameraRecoveryChoice
) {
	const proposal = yield* Schema.decodeUnknownEffect(CameraRecoveryProposal)(input);
	const choice = yield* Schema.decodeUnknownEffect(CameraRecoveryChoice)(inputChoice);
	const native = proposal.native;
	if (!native.pending || native.panelEvent)
		return yield* Effect.fail(
			arrangementFailure(
				"invalid",
				"Recovery requires pending native camera edits without a queued panel action."
			)
		);
	let document = yield* store.load();
	if (document.arrangement.id !== native.sessionId)
		return yield* Effect.fail(
			arrangementFailure(
				"scope_mismatch",
				"The recovery session belongs to another arrangement."
			)
		);
	const edits = native.edits ?? [{ cameraId: native.cameraId, pose: native.pose }];
	const operationId = CameraOperationId.make(`native-${native.producerId}-${native.sequence}`);
	if (choice === "native" && proposal.nativeCommitRevision !== undefined) {
		if (
			!document.outcomes.some(
				(entry) =>
					entry.operationId === operationId &&
					entry.revision === proposal.nativeCommitRevision
			)
		)
			return yield* Effect.fail(
				arrangementFailure(
					"stale",
					"The retained native commit changed. Inspect recovery again."
				)
			);
		return document;
	}
	if (choice === "native") {
		const added = native.added ?? [],
			addedIds = new Set(added.map((camera) => camera.id));
		const cameras = yield* Effect.try({
			try: () =>
				edits
					.filter((edit) => !addedIds.has(edit.cameraId))
					.map((edit) => {
						const saved = proposal.saved.find(
							(camera) => camera.id === edit.cameraId
						)?.pose;
						if (!saved)
							throw arrangementFailure(
								"scope_mismatch",
								"The recovery edit has no reviewed saved camera."
							);
						return {
							...edit,
							poseChanged:
								JSON.stringify(saved.location) !==
									JSON.stringify(edit.pose.location) ||
								JSON.stringify(saved.rotation) !==
									JSON.stringify(edit.pose.rotation),
							lensChanged:
								Math.abs(saved.fieldOfViewDegrees - edit.pose.fieldOfViewDegrees) >
								0.0001
						};
					}),
			catch: (cause) =>
				cause instanceof CameraArrangementError
					? cause
					: arrangementFailure("invalid", String(cause))
		});
		document = yield* store.mutate({
			kind: "poses",
			arrangementId: native.sessionId,
			expectedRevision: proposal.expectedRevision,
			operationId,
			cameras,
			added,
			removed: native.removed ?? []
		});
	} else {
		// Commit a revision even for "keep saved", fencing concurrent writers and recording the decision.
		document = yield* store.mutate({
			kind: "tune",
			arrangementId: native.sessionId,
			expectedRevision: proposal.expectedRevision,
			operationId: CameraOperationId.make(
				`recover-saved-${native.producerId}-${native.sequence}`
			),
			settings: {}
		});
	}
	return document;
});
