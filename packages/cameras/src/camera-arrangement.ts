import { Schema } from "effect";
import {
	ApprovedPose,
	SubjectBounds,
	SubjectLocator,
	ReviewSet,
	ReviewView,
	ReviewViewId,
	CaptureProfileId,
	VisibilityPolicyId,
	type ReviewAuthoringSession,
	initialReviewViewRevision,
	nextReviewViewRevision
} from "./review-schema.js";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u));
export const CameraArrangementId = Identifier.pipe(Schema.brand("CameraArrangementId"));
export const ArrangementCameraId = Identifier.pipe(Schema.brand("ArrangementCameraId"));
export type ArrangementCameraId = typeof ArrangementCameraId.Type;
export const CameraOperationId = Identifier.pipe(Schema.brand("CameraOperationId"));
const Revision = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);
const FOV = Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 }));
const Scale = Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 100 }));
const Margin = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 }));
export const CameraArrangementSettings = Schema.Struct({
	fieldOfViewDegrees: FOV,
	distanceScale: Scale,
	heightOffset: Schema.Finite,
	margin: Margin
});
export const CameraArrangementOverrides = CameraArrangementSettings.mapFields((fields) => ({
	fieldOfViewDegrees: Schema.optionalKey(fields.fieldOfViewDegrees),
	distanceScale: Schema.optionalKey(fields.distanceScale),
	heightOffset: Schema.optionalKey(fields.heightOffset),
	margin: Schema.optionalKey(fields.margin)
}));
export const ArrangementCamera = Schema.Struct({
	id: ArrangementCameraId,
	displayName: Schema.NonEmptyString,
	yawDegrees: Schema.Finite,
	overrides: CameraArrangementOverrides,
	manualPose: Schema.optionalKey(ApprovedPose),
	viewId: ReviewViewId
});
export type ArrangementCamera = typeof ArrangementCamera.Type;
export const CameraArrangement = Schema.Struct({
	version: Schema.Literal(1),
	id: CameraArrangementId,
	revision: Revision,
	projectName: Schema.NonEmptyString,
	mapPath: Schema.NonEmptyString,
	subject: SubjectLocator,
	bounds: SubjectBounds,
	settings: CameraArrangementSettings,
	cameras: Schema.Array(ArrangementCamera).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	retiredCameraIds: Schema.Array(ArrangementCameraId),
	captureProfileId: CaptureProfileId,
	visibilityPolicyId: VisibilityPolicyId
}).check(
	Schema.makeFilter((value) => {
		const ids = value.cameras.map((camera) => camera.id);
		if (new Set(ids).size !== ids.length) return "Camera identities must be unique.";
		if (new Set(value.cameras.map((camera) => camera.viewId)).size !== ids.length)
			return "View identities must be unique.";
		if (ids.some((id) => value.retiredCameraIds.includes(id)))
			return "Retired identities cannot be reused.";
		return undefined;
	})
);
export type CameraArrangement = typeof CameraArrangement.Type;

/** Explicit migration: keep every legacy candidate's exact pose rather than regenerate its identity. */
export function migrateLegacyCameraArrangement(args: {
	readonly session: ReviewAuthoringSession;
	readonly id: typeof CameraArrangementId.Type;
	readonly projectName: string;
	readonly captureProfileId: typeof CaptureProfileId.Type;
	readonly visibilityPolicyId: typeof VisibilityPolicyId.Type;
	readonly identities: readonly {
		readonly candidateId: string;
		readonly cameraId: ArrangementCameraId;
		readonly viewId: typeof ReviewViewId.Type;
	}[];
}): CameraArrangement {
	const { session } = args;
	const candidates = session.candidates.filter(
		(candidate) => !session.discardedCandidateIds.includes(candidate.id)
	);
	if (
		args.identities.length !== candidates.length ||
		new Set(args.identities.map((entry) => entry.candidateId)).size !== candidates.length
	)
		throw arrangementFailure(
			"invalid",
			"Provide one explicit stable camera/View identity for each retained legacy candidate."
		);
	const cameras = candidates.map((candidate) => {
		const identity = args.identities.find((entry) => entry.candidateId === candidate.id);
		if (!identity)
			throw arrangementFailure(
				"invalid",
				"A retained legacy candidate is missing its stable identity."
			);
		const pose =
			session.selectedCandidateId === candidate.id && session.draftPose
				? session.draftPose
				: candidate.approvedPose;
		return ArrangementCamera.make({
			id: identity.cameraId,
			viewId: identity.viewId,
			displayName: candidate.displayName,
			yawDegrees: pose.rotation.yaw - 180,
			overrides: { fieldOfViewDegrees: pose.fieldOfViewDegrees },
			manualPose: pose
		});
	});
	return CameraArrangement.make({
		version: 1,
		id: args.id,
		revision: 0,
		projectName: args.projectName,
		mapPath: session.subject.mapPath,
		subject: session.subject.actorGuid
			? {
					kind: "actor_guid",
					actorGuid: session.subject.actorGuid,
					lastKnownActorPath: session.subject.actorPath
				}
			: { kind: "actor_path", actorPath: session.subject.actorPath },
		bounds: session.subject.bounds,
		settings: { fieldOfViewDegrees: 60, distanceScale: 1, heightOffset: 0, margin: 0.12 },
		cameras,
		retiredCameraIds: [],
		captureProfileId: args.captureProfileId,
		visibilityPolicyId: args.visibilityPolicyId
	});
}

const Scope = {
	arrangementId: CameraArrangementId,
	expectedRevision: Revision,
	operationId: CameraOperationId
};
export const CameraArrangementCommand = Schema.Union([
	Schema.Struct({ ...Scope, kind: Schema.Literal("tune"), settings: CameraArrangementOverrides }),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("override"),
		cameraId: ArrangementCameraId,
		overrides: CameraArrangementOverrides
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("pose"),
		cameraId: ArrangementCameraId,
		pose: ApprovedPose,
		lensChanged: Schema.Boolean,
		poseChanged: Schema.Boolean
	}),
	Schema.Struct({ ...Scope, kind: Schema.Literal("unpin"), cameraId: ArrangementCameraId }),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("regenerate"),
		cameras: Schema.Array(ArrangementCamera).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		),
		discardCustomizedIds: Schema.Array(ArrangementCameraId)
	})
]);
export type CameraArrangementCommand = typeof CameraArrangementCommand.Type;
export class CameraArrangementError extends Schema.TaggedErrorClass<CameraArrangementError>()(
	"CameraArrangementError",
	{
		code: Schema.Literals([
			"stale",
			"scope_mismatch",
			"camera_missing",
			"customization_at_risk",
			"invalid",
			"busy",
			"storage",
			"operation_reused"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
export function arrangementFailure(
	code: (typeof CameraArrangementError.Type)["code"],
	message: string
) {
	return new CameraArrangementError({
		code,
		message,
		recovery:
			"Inspect the latest arrangement and retry with its revision and an explicit camera scope."
	});
}

/** Aspect-aware sphere fit uses the smaller horizontal/vertical FOV; values are Unreal centimetres. */
export function arrangementFitDistance(
	bounds: typeof SubjectBounds.Type,
	fieldOfViewDegrees: number,
	aspect: number,
	margin: number
) {
	if (!Number.isFinite(aspect) || aspect <= 0)
		throw arrangementFailure("invalid", "Aspect must be positive and finite.");
	const horizontal = (fieldOfViewDegrees * Math.PI) / 360;
	const vertical = Math.atan(Math.tan(horizontal) / aspect);
	return (
		Math.max(1, Math.hypot(bounds.extent.x, bounds.extent.y, bounds.extent.z)) /
		(Math.sin(Math.min(horizontal, vertical)) * (1 - margin * 2))
	);
}
export function resolveArrangementCamera(
	arrangement: CameraArrangement,
	cameraId: string
): typeof ApprovedPose.Type {
	const camera = arrangement.cameras.find((entry) => entry.id === cameraId);
	if (camera === undefined)
		throw arrangementFailure(
			"camera_missing",
			`Camera ${cameraId} does not belong to ${arrangement.id}.`
		);
	const settings = { ...arrangement.settings, ...camera.overrides };
	if (camera.manualPose !== undefined)
		return ApprovedPose.make({
			...camera.manualPose,
			fieldOfViewDegrees: settings.fieldOfViewDegrees
		});
	const distance =
		arrangementFitDistance(
			arrangement.bounds,
			settings.fieldOfViewDegrees,
			16 / 9,
			settings.margin
		) * settings.distanceScale;
	const yaw = (camera.yawDegrees * Math.PI) / 180;
	const location = {
		x: arrangement.bounds.center.x + Math.cos(yaw) * distance,
		y: arrangement.bounds.center.y + Math.sin(yaw) * distance,
		z: arrangement.bounds.center.z + settings.heightOffset
	};
	return ApprovedPose.make({
		aspectRatio: "16:9",
		projection: "perspective",
		fieldOfViewDegrees: settings.fieldOfViewDegrees,
		location,
		rotation: {
			pitch: (-Math.atan2(settings.heightOffset, distance) * 180) / Math.PI || 0,
			yaw: camera.yawDegrees + 180,
			roll: 0
		}
	});
}
export function previewArrangementRegeneration(
	arrangement: CameraArrangement,
	cameras: readonly ArrangementCamera[]
) {
	const retained = new Set(cameras.map((camera) => camera.id));
	return {
		removed: arrangement.cameras
			.filter((camera) => !retained.has(camera.id))
			.map((camera) => camera.id),
		customized: arrangement.cameras
			.filter(
				(camera) =>
					!retained.has(camera.id) &&
					(camera.manualPose !== undefined || Object.keys(camera.overrides).length > 0)
			)
			.map((camera) => camera.id),
		added: cameras
			.filter((camera) => !arrangement.cameras.some((existing) => existing.id === camera.id))
			.map((camera) => camera.id)
	};
}
/** No selection/global state: every mutation is bound to one actor's explicit arrangement revision. */
export function applyCameraArrangementCommand(
	current: CameraArrangement,
	command: CameraArrangementCommand
): CameraArrangement {
	if (command.arrangementId !== current.id)
		throw arrangementFailure("scope_mismatch", "The command targets another arrangement.");
	if (command.expectedRevision !== current.revision)
		throw arrangementFailure(
			"stale",
			"The arrangement changed after this command was authored."
		);
	if ("cameraId" in command && !current.cameras.some((camera) => camera.id === command.cameraId))
		throw arrangementFailure("camera_missing", "The camera is outside this arrangement.");
	let cameras = current.cameras;
	let retiredCameraIds = current.retiredCameraIds;
	if (command.kind === "regenerate") {
		const proposal = previewArrangementRegeneration(current, command.cameras);
		if (proposal.customized.some((id) => !command.discardCustomizedIds.includes(id)))
			throw arrangementFailure(
				"customization_at_risk",
				"Explicitly acknowledge removal of customized cameras."
			);
		// A retained identity keeps its exceptions and pinned pose, even if its generated direction changes.
		cameras = command.cameras.map((camera) => {
			const existing = current.cameras.find((entry) => entry.id === camera.id);
			return existing === undefined ? camera : { ...existing, yawDegrees: camera.yawDegrees };
		});
		retiredCameraIds = [...retiredCameraIds, ...proposal.removed];
	} else if (command.kind !== "tune") {
		cameras = current.cameras.map((camera) => {
			if (camera.id !== command.cameraId) return camera;
			if (command.kind === "override") return { ...camera, overrides: command.overrides };
			if (command.kind === "pose")
				return {
					...camera,
					...(command.poseChanged ? { manualPose: command.pose } : undefined),
					overrides: command.lensChanged
						? {
								...camera.overrides,
								fieldOfViewDegrees: command.pose.fieldOfViewDegrees
							}
						: camera.overrides
				};
			const { manualPose: _removed, ...unpinned } = camera;
			return unpinned;
		});
	}
	return CameraArrangement.make({
		...current,
		revision: current.revision + 1,
		settings:
			command.kind === "tune"
				? { ...current.settings, ...command.settings }
				: current.settings,
		cameras,
		retiredCameraIds
	});
}

/** Materialize exact approved poses into the existing capture-only Review Set contract. */
export function approveArrangementCamera(
	arrangement: CameraArrangement,
	cameraId: string,
	set: ReviewSet
): ReviewSet {
	if (set.project.mapPath !== arrangement.mapPath)
		throw arrangementFailure("scope_mismatch", "The Review Set belongs to another map.");
	const camera = arrangement.cameras.find((entry) => entry.id === cameraId);
	if (camera === undefined)
		throw arrangementFailure(
			"camera_missing",
			"The camera does not belong to this arrangement."
		);
	const existing = set.views.find((view) => view.id === camera.viewId);
	if (
		existing?.authoring &&
		(existing.authoring.arrangementId !== arrangement.id ||
			existing.authoring.cameraId !== camera.id)
	)
		throw arrangementFailure(
			"scope_mismatch",
			"The destination View belongs to another camera arrangement."
		);
	if (
		existing &&
		JSON.stringify(existing.target) !==
			JSON.stringify({ kind: "actor", subject: arrangement.subject })
	)
		throw arrangementFailure(
			"scope_mismatch",
			"The destination View belongs to another subject."
		);
	const view = ReviewView.make({
		...existing,
		authoring: { arrangementId: arrangement.id, cameraId: camera.id },
		id: camera.viewId,
		displayName: camera.displayName,
		purpose: existing?.purpose ?? "Authored camera",
		tags: existing?.tags ?? [],
		captureProfileId: arrangement.captureProfileId,
		visibilityPolicyId: arrangement.visibilityPolicyId,
		target: { kind: "actor", subject: arrangement.subject },
		viewpoint: {
			kind: "world_fixed",
			approvedPose: resolveArrangementCamera(arrangement, camera.id)
		},
		framingRecipe: { kind: "manual", version: 1 },
		revision: existing
			? nextReviewViewRevision(camera.viewId, existing.revision)
			: initialReviewViewRevision(camera.viewId)
	});
	return ReviewSet.make({
		...set,
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 4 } },
		views: existing
			? set.views.map((entry) => (entry.id === view.id ? view : entry))
			: [...set.views, view]
	});
}
