import { Effect, Schema } from "effect";
import { decodeCompanionCapabilityManifest } from "@ue-shed/protocol";
import type { RemoteControlClientApi } from "@ue-shed/unreal-connection";
import { ApprovedPose } from "./review-schema.js";
import {
	ArrangementCameraId,
	CameraArrangementId,
	CameraOperationId,
	resolveArrangementCamera,
	arrangementFailure
} from "./camera-arrangement.js";
import type { CameraAuthoringStore } from "./camera-authoring-store.js";

const Version = Schema.Literal(1);
const Counter = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);
const Scope = {
	version: Version,
	sessionId: CameraArrangementId,
	producerId: Schema.NonEmptyString
};
export const CameraBridgeRequest = Schema.Union([
	Schema.Struct({ version: Version, operation: Schema.Literal("discover") }),
	Schema.Struct({
		version: Version,
		operation: Schema.Literal("attach"),
		sessionId: CameraArrangementId,
		cameraId: ArrangementCameraId,
		revision: Counter,
		projectName: Schema.NonEmptyString,
		mapPath: Schema.NonEmptyString,
		pose: ApprovedPose
	}),
	Schema.Struct({
		...Scope,
		operation: Schema.Literals(["inspect", "select", "pilot", "eject", "save", "detach"])
	}),
	Schema.Struct({
		...Scope,
		operation: Schema.Literal("edit"),
		expectedRevision: Counter,
		sequence: Counter,
		pose: ApprovedPose
	}),
	Schema.Struct({
		...Scope,
		operation: Schema.Literal("apply"),
		expectedRevision: Counter,
		revision: Counter,
		sequence: Counter,
		pose: ApprovedPose
	})
]);
export type CameraBridgeRequest = typeof CameraBridgeRequest.Type;
export const CameraBridgeSnapshot = Schema.Struct({
	version: Version,
	status: Schema.Literal("ready"),
	message: Schema.String,
	sessionId: CameraArrangementId,
	cameraId: ArrangementCameraId,
	producerId: Schema.NonEmptyString,
	revision: Counter,
	sequence: Counter,
	pending: Schema.Boolean,
	piloting: Schema.Boolean,
	saveRequested: Schema.Boolean,
	pose: ApprovedPose
});
export type CameraBridgeSnapshot = typeof CameraBridgeSnapshot.Type;
export const CameraBridgeResponse = Schema.Union([
	CameraBridgeSnapshot,
	Schema.Struct({
		version: Version,
		status: Schema.Literal("available"),
		message: Schema.String,
		leaseSeconds: Schema.Literal(30),
		viewportCulling: Schema.Literal(false)
	}),
	Schema.Struct({
		version: Version,
		status: Schema.Literals(["busy", "stale", "unavailable", "invalid", "detached"]),
		message: Schema.String
	})
]);
export type CameraBridgeResponse = typeof CameraBridgeResponse.Type;
export class CameraBridgeError extends Schema.TaggedErrorClass<CameraBridgeError>()(
	"CameraBridgeError",
	{
		code: Schema.Literals([
			"missing_plugin",
			"disconnected",
			"protocol",
			"busy",
			"stale",
			"unavailable",
			"invalid"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
export interface CameraAuthoringBridge {
	readonly call: (
		request: CameraBridgeRequest
	) => Effect.Effect<CameraBridgeResponse, CameraBridgeError>;
}
/** Replaceable transport adapter. Unreal RC remains the sole network transport. */
export function makeCameraAuthoringBridge(
	client: RemoteControlClientApi,
	endpoint: string
): CameraAuthoringBridge {
	return {
		call: Effect.fn("CameraAuthoringBridge.call")(function* (input) {
			const request = yield* Schema.decodeUnknownEffect(CameraBridgeRequest)(input, {
				onExcessProperty: "error"
			}).pipe(
				Effect.mapError(
					(cause) =>
						new CameraBridgeError({
							code: "protocol",
							message: String(cause),
							recovery: "Use the camera-authoring v1 request contract."
						})
				)
			);
			if (request.operation === "discover" || request.operation === "attach") {
				const manifest = yield* client
					.request({
						endpoint,
						objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
						functionName: "GetCapabilityManifest",
						operation: "camera.authoring.negotiate",
						parameters: {}
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new CameraBridgeError({
									code: cause.status === 404 ? "missing_plugin" : "disconnected",
									message: cause.message,
									recovery:
										"Reconnect to an editor with Core and the optional camera authoring bridge enabled."
								})
						),
						Effect.flatMap((value) =>
							decodeCompanionCapabilityManifest(value).pipe(
								Effect.mapError(
									(cause) =>
										new CameraBridgeError({
											code: "protocol",
											message: String(cause),
											recovery: "Update the companion capability contract."
										})
								)
							)
						)
					);
				if (!manifest.capabilities.includes("cameras.authoring.v1"))
					return yield* Effect.fail(
						new CameraBridgeError({
							code: "missing_plugin",
							message: "This editor does not advertise cameras.authoring.v1.",
							recovery:
								"Enable UEShedCameraAuthoringBridge. The reference menu is independently optional."
						})
					);
			}
			const response = yield* client
				.request({
					endpoint,
					objectPath:
						"/Script/UEShedCameraAuthoringBridge.Default__UEShedCameraAuthoringBridgeLibrary",
					functionName: "ExecuteCameraAuthoring",
					operation: `camera.authoring.${request.operation}`,
					parameters: { RequestJson: JSON.stringify(request) }
				})
				.pipe(
					Effect.mapError(
						(cause) =>
							new CameraBridgeError({
								code: cause.status === 404 ? "missing_plugin" : "disconnected",
								message: cause.message,
								recovery:
									"Enable UEShedCameraAuthoringBridge in this editor and reconnect to Unreal Remote Control. Pending draft changes remain on disk."
							})
					)
				);
			return yield* Schema.decodeUnknownEffect(CameraBridgeResponse)(response, {
				onExcessProperty: "error"
			}).pipe(
				Effect.mapError(
					(cause) =>
						new CameraBridgeError({
							code: "protocol",
							message: String(cause),
							recovery:
								"Use matching camera-authoring v1 bridge and package versions."
						})
				)
			);
		})
	};
}
export function readyCameraBridge(
	response: CameraBridgeResponse
): Effect.Effect<CameraBridgeSnapshot, CameraBridgeError> {
	if (response.status === "ready") return Effect.succeed(response);
	return Effect.fail(
		new CameraBridgeError({
			code:
				response.status === "available" || response.status === "detached"
					? "unavailable"
					: response.status,
			message: response.message,
			recovery:
				"Inspect the camera session. Resolve ownership or revision conflicts before retrying."
		})
	);
}
export const attachArrangementCamera = Effect.fn("CameraAuthoring.attach")(function* (
	store: CameraAuthoringStore,
	bridge: CameraAuthoringBridge,
	cameraId: ArrangementCameraId
) {
	const { arrangement } = yield* store.load();
	return yield* bridge
		.call({
			version: 1,
			operation: "attach",
			sessionId: arrangement.id,
			cameraId,
			revision: arrangement.revision,
			projectName: arrangement.projectName,
			mapPath: arrangement.mapPath,
			pose: resolveArrangementCamera(arrangement, cameraId)
		})
		.pipe(Effect.flatMap(readyCameraBridge));
});

/** One bounded reconciliation step. A caller owns scheduling, lifetime, and presentation. */
export const synchronizeArrangementCamera = Effect.fn("CameraAuthoring.synchronize")(
	function* (args: {
		readonly store: CameraAuthoringStore;
		readonly bridge: CameraAuthoringBridge;
		readonly attachment: CameraBridgeSnapshot;
		readonly approvalDestination: string;
	}) {
		const { store, bridge, attachment } = args;
		const native = yield* bridge
			.call({
				version: 1,
				operation: "inspect",
				sessionId: attachment.sessionId,
				producerId: attachment.producerId
			})
			.pipe(Effect.flatMap(readyCameraBridge));
		let document = yield* store.load();
		if (
			native.sessionId !== document.arrangement.id ||
			native.cameraId !== attachment.cameraId ||
			native.producerId !== attachment.producerId
		)
			return yield* Effect.fail(
				arrangementFailure("scope_mismatch", "The editor attachment changed scope.")
			);
		const operationId = CameraOperationId.make(
			`native-${native.producerId}-${native.sequence}`
		);
		const committed = document.outcomes.find((entry) => entry.operationId === operationId);
		if (native.pending && committed === undefined) {
			// A gesture can advance again before its previous acknowledgement reaches Unreal. Rebase only
			// through a complete, retained chain of this producer's earlier native edits; host edits conflict.
			const revisionGap = document.arrangement.revision - native.revision;
			const producerPrefix = `native-${native.producerId}-`;
			const ownPredecessors = document.outcomes.filter((entry) => {
				if (!entry.operationId.startsWith(producerPrefix)) return false;
				const sequence = Number(entry.operationId.slice(producerPrefix.length));
				return (
					Number.isSafeInteger(sequence) &&
					sequence < native.sequence &&
					entry.revision > native.revision &&
					entry.revision <= document.arrangement.revision
				);
			});
			const ownRevisionCount = new Set(ownPredecessors.map((entry) => entry.revision)).size;
			if (revisionGap < 0 || revisionGap > 256 || ownRevisionCount !== revisionGap)
				return yield* Effect.fail(
					arrangementFailure(
						"stale",
						"Native and host edits overlap. The native pose remains pending; explicitly resolve the conflict."
					)
				);
			const prior = resolveArrangementCamera(document.arrangement, native.cameraId);
			const poseChanged =
				JSON.stringify(prior.location) !== JSON.stringify(native.pose.location) ||
				JSON.stringify(prior.rotation) !== JSON.stringify(native.pose.rotation);
			document = yield* store.mutate({
				kind: "pose",
				arrangementId: native.sessionId,
				expectedRevision: document.arrangement.revision,
				operationId,
				cameraId: native.cameraId,
				pose: native.pose,
				poseChanged,
				lensChanged:
					Math.abs(prior.fieldOfViewDegrees - native.pose.fieldOfViewDegrees) > 0.0001
			});
		}
		if (native.saveRequested) {
			if (committed && committed.revision !== document.arrangement.revision)
				return yield* Effect.fail(
					arrangementFailure(
						"stale",
						"The host changed after this Save request. Review the latest camera before saving."
					)
				);
			document = yield* store.approve({
				cameraId: native.cameraId,
				expectedRevision: document.arrangement.revision,
				operationId: CameraOperationId.make(`save-${native.producerId}-${native.sequence}`),
				destination: args.approvalDestination
			});
		}
		return yield* bridge
			.call({
				version: 1,
				operation: "apply",
				sessionId: native.sessionId,
				producerId: native.producerId,
				expectedRevision: native.revision,
				revision: document.arrangement.revision,
				sequence: native.sequence,
				pose: resolveArrangementCamera(document.arrangement, native.cameraId)
			})
			.pipe(Effect.flatMap(readyCameraBridge));
	}
);
