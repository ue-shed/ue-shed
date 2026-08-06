import {
	ApprovedPose,
	nextReviewViewRevision,
	FramingCandidate,
	FramingCandidateId,
	FramingGroup,
	FramingGroupId,
	FramingParameters,
	ReviewSet,
	ReviewView,
	initialReviewViewRevision,
	reviewViewActorSubject,
	type FramingDiagnostic,
	type FramingCandidateOverrides,
	type FramingParameters as FramingParametersDocument,
	type ActorTransformSnapshot,
	type NumberedReviewViewRevision,
	type ReviewViewDefinition,
	type ReviewSubjectProjection,
	type CaptureProfileId,
	type ReviewViewId,
	type SubjectBounds,
	type SubjectLocator,
	type VisibilityPolicyId
} from "./review-schema.js";

const degrees = 180 / Math.PI;
const radians = Math.PI / 180;
const defaultFieldOfViewDegrees = 60;
const defaultMargin = 0.12;

type ReviewQuaternion = {
	readonly w: number;
	readonly x: number;
	readonly y: number;
	readonly z: number;
};

function quaternionFromRotation(
	rotation: (typeof ApprovedPose.Type)["rotation"]
): ReviewQuaternion {
	const pitch = rotation.pitch * radians * 0.5;
	const yaw = rotation.yaw * radians * 0.5;
	const roll = rotation.roll * radians * 0.5;
	const sp = Math.sin(pitch);
	const cp = Math.cos(pitch);
	const sy = Math.sin(yaw);
	const cy = Math.cos(yaw);
	const sr = Math.sin(roll);
	const cr = Math.cos(roll);
	return {
		w: cr * cp * cy + sr * sp * sy,
		x: cr * sp * sy - sr * cp * cy,
		y: -cr * sp * cy - sr * cp * sy,
		z: cr * cp * sy - sr * sp * cy
	};
}

function multiplyQuaternions(left: ReviewQuaternion, right: ReviewQuaternion): ReviewQuaternion {
	return {
		w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
		x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
		y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
		z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w
	};
}

function inverseQuaternion(value: ReviewQuaternion): ReviewQuaternion {
	return { w: value.w, x: -value.x, y: -value.y, z: -value.z };
}

function rotateVector(
	rotation: ReviewQuaternion,
	vector: (typeof ApprovedPose.Type)["location"]
): (typeof ApprovedPose.Type)["location"] {
	const cross = {
		x: rotation.y * vector.z - rotation.z * vector.y,
		y: rotation.z * vector.x - rotation.x * vector.z,
		z: rotation.x * vector.y - rotation.y * vector.x
	};
	return {
		x: vector.x + 2 * (rotation.w * cross.x + rotation.y * cross.z - rotation.z * cross.y),
		y: vector.y + 2 * (rotation.w * cross.y + rotation.z * cross.x - rotation.x * cross.z),
		z: vector.z + 2 * (rotation.w * cross.z + rotation.x * cross.y - rotation.y * cross.x)
	};
}

function rotationFromQuaternion(
	quaternion: ReviewQuaternion
): (typeof ApprovedPose.Type)["rotation"] {
	const singularity = quaternion.z * quaternion.x - quaternion.w * quaternion.y;
	const yawY = 2 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y);
	const yawX = 1 - 2 * (quaternion.y ** 2 + quaternion.z ** 2);
	if (singularity < -0.4999995) {
		return {
			pitch: -90,
			roll: 0,
			yaw: -2 * Math.atan2(quaternion.x, quaternion.w) * degrees
		};
	}
	if (singularity > 0.4999995) {
		return {
			pitch: 90,
			roll: 0,
			yaw: 2 * Math.atan2(quaternion.x, quaternion.w) * degrees
		};
	}
	return {
		pitch: Math.asin(2 * singularity) * degrees,
		roll:
			Math.atan2(
				-2 * (quaternion.w * quaternion.x + quaternion.y * quaternion.z),
				1 - 2 * (quaternion.x ** 2 + quaternion.y ** 2)
			) * degrees,
		yaw: Math.atan2(yawY, yawX) * degrees
	};
}

/**
 * Applies the same rotator/quaternion transform composition Unreal uses. The relative pose remains
 * durable input; callers receive a newly derived world pose for a single realization only.
 */
export function realizeTargetRelativePose(args: {
	readonly relativePose: typeof ApprovedPose.Type;
	readonly targetTransform: ActorTransformSnapshot;
}): typeof ApprovedPose.Type {
	const targetRotation = quaternionFromRotation(args.targetTransform.rotation);
	const relativeRotation = quaternionFromRotation(args.relativePose.rotation);
	const rotatedLocation = rotateVector(targetRotation, args.relativePose.location);
	return ApprovedPose.make({
		...args.relativePose,
		location: {
			x: args.targetTransform.location.x + rotatedLocation.x,
			y: args.targetTransform.location.y + rotatedLocation.y,
			z: args.targetTransform.location.z + rotatedLocation.z
		},
		rotation: rotationFromQuaternion(multiplyQuaternions(targetRotation, relativeRotation))
	});
}

/** Converts an approved world pose into the durable pose relative to its actor target. */
export function targetRelativePoseFromWorldPose(args: {
	readonly targetTransform: ActorTransformSnapshot;
	readonly worldPose: typeof ApprovedPose.Type;
}): typeof ApprovedPose.Type {
	const targetRotation = quaternionFromRotation(args.targetTransform.rotation);
	const inverseTargetRotation = inverseQuaternion(targetRotation);
	return ApprovedPose.make({
		...args.worldPose,
		location: rotateVector(inverseTargetRotation, {
			x: args.worldPose.location.x - args.targetTransform.location.x,
			y: args.worldPose.location.y - args.targetTransform.location.y,
			z: args.worldPose.location.z - args.targetTransform.location.z
		}),
		rotation: rotationFromQuaternion(
			multiplyQuaternions(
				inverseTargetRotation,
				quaternionFromRotation(args.worldPose.rotation)
			)
		)
	});
}

/**
 * Captures the explicit anchoring provenance needed to approve an actor-following View. Clients
 * retain this value unchanged and call `realizeTargetRelativePose` with a fresh actor transform
 * for every capture.
 */
export function targetRelativeViewpointFromWorldPose(args: {
	readonly targetTransform: ActorTransformSnapshot;
	readonly worldPose: typeof ApprovedPose.Type;
}) {
	return {
		kind: "target_relative" as const,
		relativePose: targetRelativePoseFromWorldPose(args),
		targetSnapshot: args.targetTransform
	};
}

export interface ReviewSelection {
	readonly actorPath: string;
	readonly bounds: SubjectBounds;
	readonly displayName: string;
	readonly editorView?: typeof ApprovedPose.Type | undefined;
	readonly mapPath: string;
}

export const contextThreeQuarterGroupId = FramingGroupId.make("context_three_quarter");
export const facadeFrontGroupId = FramingGroupId.make("facade_front");
export const cardinalOrbitGroupId = FramingGroupId.make("cardinal_orbit");

export interface ArcFramingPresetOptions {
	readonly count?: number;
	readonly distanceScale?: number;
	readonly elevation?: number;
	readonly enabled?: boolean;
	readonly spreadDegrees?: number;
	readonly yawOffsetDegrees?: number;
}

export function contextThreeQuarterGroup(options: ArcFramingPresetOptions = {}): FramingGroup {
	return FramingGroup.make({
		displayName: "Context three-quarter",
		distanceScale: options.distanceScale ?? 1.8,
		elevation: options.elevation ?? 0.5,
		enabled: options.enabled ?? true,
		id: contextThreeQuarterGroupId,
		pattern: {
			count: options.count ?? 1,
			kind: "arc",
			spreadDegrees: options.spreadDegrees ?? 0,
			yawOffsetDegrees: options.yawOffsetDegrees ?? 42
		}
	});
}

export function facadeFrontGroup(options: ArcFramingPresetOptions = {}): FramingGroup {
	return FramingGroup.make({
		displayName: "Facade front",
		distanceScale: options.distanceScale ?? 1.25,
		elevation: options.elevation ?? 0.08,
		enabled: options.enabled ?? true,
		id: facadeFrontGroupId,
		pattern: {
			count: options.count ?? 1,
			kind: "arc",
			spreadDegrees: options.spreadDegrees ?? 0,
			yawOffsetDegrees: options.yawOffsetDegrees ?? 0
		}
	});
}

export function cardinalOrbitGroup(
	options: {
		readonly count?: number;
		readonly distanceScale?: number;
		readonly elevation?: number;
		readonly enabled?: boolean;
		readonly ringOffsetDegrees?: number;
	} = {}
): FramingGroup {
	return FramingGroup.make({
		displayName: "Cardinal orbit",
		distanceScale: options.distanceScale ?? 1.45,
		elevation: options.elevation ?? 0.18,
		enabled: options.enabled ?? true,
		id: cardinalOrbitGroupId,
		pattern: {
			count: options.count ?? 4,
			kind: "ring",
			ringOffsetDegrees: options.ringOffsetDegrees ?? 90
		}
	});
}

export function defaultFramingParameters(): FramingParametersDocument {
	return FramingParameters.make({
		fieldOfViewDegrees: defaultFieldOfViewDegrees,
		groups: [contextThreeQuarterGroup(), facadeFrontGroup(), cardinalOrbitGroup()],
		margin: defaultMargin
	});
}

function finiteBounds(bounds: SubjectBounds): boolean {
	return (
		[
			bounds.center.x,
			bounds.center.y,
			bounds.center.z,
			bounds.extent.x,
			bounds.extent.y,
			bounds.extent.z,
			bounds.rotation.pitch,
			bounds.rotation.roll,
			bounds.rotation.yaw
		].every(Number.isFinite) &&
		bounds.extent.x >= 0 &&
		bounds.extent.y >= 0 &&
		bounds.extent.z >= 0
	);
}

function aimAt(args: {
	readonly location: { readonly x: number; readonly y: number; readonly z: number };
	readonly target: { readonly x: number; readonly y: number; readonly z: number };
}) {
	const x = args.target.x - args.location.x;
	const y = args.target.y - args.location.y;
	const z = args.target.z - args.location.z;
	return {
		pitch: Math.atan2(z, Math.hypot(x, y)) * degrees,
		roll: 0,
		yaw: Math.atan2(y, x) * degrees
	};
}

function fitDistance(bounds: SubjectBounds, fieldOfViewDegrees: number, margin: number): number {
	const radius = Math.max(1, Math.hypot(bounds.extent.x, bounds.extent.y, bounds.extent.z));
	const usableFrame = 1 - margin * 2;
	return radius / Math.sin((fieldOfViewDegrees * radians) / 2) / usableFrame;
}

function groupYaw(args: {
	readonly group: FramingGroup;
	readonly index: number;
	readonly subjectYaw: number;
}): number {
	const { pattern } = args.group;
	if (pattern.kind === "ring") {
		return pattern.ringOffsetDegrees - ((args.index - 1) * 360) / pattern.count;
	}
	if (pattern.count === 1) return args.subjectYaw + pattern.yawOffsetDegrees;
	return (
		args.subjectYaw +
		pattern.yawOffsetDegrees -
		pattern.spreadDegrees / 2 +
		((args.index - 1) * pattern.spreadDegrees) / (pattern.count - 1)
	);
}

export function generateFramingCandidateId(args: {
	readonly groupId: FramingGroupId;
	readonly index: number;
}): typeof FramingCandidateId.Type {
	return FramingCandidateId.make(`preset/${args.groupId}/${args.index}`);
}

function candidateFromGroup(args: {
	readonly group: FramingGroup;
	readonly index: number;
	readonly overrides?: FramingCandidateOverrides | undefined;
	readonly parameters: FramingParametersDocument;
	readonly selection: ReviewSelection;
}): typeof FramingCandidate.Type {
	const fieldOfViewDegrees =
		args.overrides?.fieldOfViewDegrees ?? args.parameters.fieldOfViewDegrees;
	const margin = args.overrides?.margin ?? args.parameters.margin;
	const distanceScale = args.overrides?.distanceScale ?? args.group.distanceScale;
	const elevation = args.overrides?.elevation ?? args.group.elevation;
	const yaw =
		groupYaw({
			group: args.group,
			index: args.index,
			subjectYaw: args.selection.bounds.rotation.yaw
		}) + (args.overrides?.yawOffsetDegrees ?? 0);
	const distance = fitDistance(args.selection.bounds, fieldOfViewDegrees, margin) * distanceScale;
	const location = {
		x: args.selection.bounds.center.x + Math.cos(yaw * radians) * distance,
		y: args.selection.bounds.center.y + Math.sin(yaw * radians) * distance,
		z: args.selection.bounds.center.z + args.selection.bounds.extent.z * elevation
	};
	return FramingCandidate.make({
		approvedPose: ApprovedPose.make({
			aspectRatio: "16:9",
			fieldOfViewDegrees,
			location,
			projection: "perspective",
			rotation: aimAt({ location, target: args.selection.bounds.center })
		}),
		diagnostics: [
			{
				code: "bounds_snapshot",
				message: "Generated from the selected actor bounds captured in this session.",
				severity: "info"
			}
		],
		displayName:
			args.group.pattern.count === 1
				? args.group.displayName
				: `${args.group.displayName} ${args.index}`,
		id: generateFramingCandidateId({ groupId: args.group.id, index: args.index }),
		recipe: {
			...(args.overrides === undefined ? {} : { candidateOverrides: args.overrides }),
			groupId: args.group.id,
			groupIndex: args.index,
			kind: "preset",
			margin,
			parameters: args.parameters,
			preset: args.group.id,
			subjectBounds: args.selection.bounds,
			version: 2
		}
	});
}

export function generateFramingCandidates(
	selection: ReviewSelection,
	parameters: FramingParametersDocument = defaultFramingParameters()
): readonly (typeof FramingCandidate.Type)[] {
	if (!finiteBounds(selection.bounds)) return [];
	const generated = parameters.groups.flatMap((group) =>
		group.enabled
			? Array.from({ length: group.pattern.count }, (_, offset) =>
					candidateFromGroup({
						group,
						index: offset + 1,
						parameters,
						selection
					})
				)
			: []
	);
	if (!selection.editorView) return generated;
	return [
		...generated,
		FramingCandidate.make({
			approvedPose: selection.editorView,
			diagnostics: [
				{
					code: "bounds_snapshot",
					message: "Uses the active perspective viewport and selected actor bounds.",
					severity: "info"
				}
			],
			displayName: "Current editor view",
			id: FramingCandidateId.make("editor-view"),
			recipe: {
				kind: "preset",
				margin: defaultMargin,
				preset: "editor_view",
				subjectBounds: selection.bounds,
				version: 1
			}
		})
	];
}

export function applyCandidateOverrides(
	candidate: typeof FramingCandidate.Type,
	overrides: FramingCandidateOverrides
): typeof FramingCandidate.Type {
	const recipe = candidate.recipe;
	if (recipe.version !== 2 || !("groupId" in recipe)) return candidate;
	const group = recipe.parameters.groups.find((item) => item.id === recipe.groupId);
	if (group === undefined) return candidate;
	const generated = candidateFromGroup({
		group,
		index: recipe.groupIndex,
		overrides,
		parameters: recipe.parameters,
		selection: {
			actorPath: "",
			bounds: recipe.subjectBounds,
			displayName: candidate.displayName,
			mapPath: ""
		}
	});
	return FramingCandidate.make({
		...candidate,
		approvedPose: generated.approvedPose,
		recipe: generated.recipe
	});
}

function maximumDelta(left: SubjectBounds, right: SubjectBounds): number {
	return Math.max(
		Math.abs(left.center.x - right.center.x),
		Math.abs(left.center.y - right.center.y),
		Math.abs(left.center.z - right.center.z),
		Math.abs(left.extent.x - right.extent.x),
		Math.abs(left.extent.y - right.extent.y),
		Math.abs(left.extent.z - right.extent.z)
	);
}

export function framingDriftDiagnostics(args: {
	readonly approvedBounds: SubjectBounds;
	readonly currentBounds: SubjectBounds;
	readonly tolerance?: number;
}): readonly FramingDiagnostic[] {
	const tolerance = args.tolerance ?? 1;
	if (maximumDelta(args.approvedBounds, args.currentBounds) <= tolerance) return [];
	return [
		{
			code: "subject_bounds_changed",
			message:
				"The subject bounds changed after approval. The Approved Pose was retained; reframe explicitly to move it.",
			severity: "warning"
		}
	];
}

/**
 * Applies product framing policy to actual SceneCapture2D projection evidence. The engine reports
 * geometry only; this keeps the requested-margin decision reviewable and shared by headless and
 * maintained clients.
 */
export function realizationFramingDiagnostics(args: {
	readonly projection: ReviewSubjectProjection;
	readonly requestedMargin: number;
}): readonly FramingDiagnostic[] {
	if (args.projection.status === "unprojectable") {
		return [
			{
				code:
					args.projection.code === "behind_camera"
						? "subject_behind_camera"
						: "subject_near_plane_crossing",
				message: args.projection.message,
				severity: "warning"
			}
		];
	}
	if (args.projection.viewportStatus === "fully_outside_viewport") {
		return [
			{
				code: "subject_fully_outside_viewport",
				message:
					"The realized subject lies entirely outside the transient capture viewport.",
				severity: "warning"
			}
		];
	}
	if (args.projection.viewportStatus === "partially_outside_viewport") {
		return [
			{
				code: "subject_partially_outside_viewport",
				message: "The realized subject clips against the transient capture viewport.",
				severity: "warning"
			}
		];
	}
	const smallestMargin = Math.min(
		args.projection.margins.bottom,
		args.projection.margins.left,
		args.projection.margins.right,
		args.projection.margins.top
	);
	if (smallestMargin < args.requestedMargin) {
		return [
			{
				code: "subject_margin_below_requested",
				message: `The realized subject margin is ${smallestMargin.toFixed(3)}, below the requested ${args.requestedMargin.toFixed(3)}.`,
				severity: "warning"
			}
		];
	}
	return [
		{
			code: "subject_framing_within_margin",
			message: "The realized subject is fully visible within the requested framing margin.",
			severity: "info"
		}
	];
}

export type ApproveFramingCandidateResult =
	| { readonly status: "approved"; readonly reviewSet: ReviewSet }
	| { readonly status: "view_not_found"; readonly viewId: string };

function revisionMeaning(view: ReviewView): string {
	return JSON.stringify({
		captureProfileId: view.captureProfileId,
		target: view.target,
		viewpoint: view.viewpoint,
		visibilityOverrides: view.visibilityOverrides,
		visibilityPolicyId: view.visibilityPolicyId
	});
}

export function revisedReviewViewRevision(args: {
	readonly current: ReviewView;
	readonly next: ReviewView;
}): NumberedReviewViewRevision {
	return revisionMeaning(args.current) === revisionMeaning(args.next)
		? args.current.revision
		: nextReviewViewRevision(args.current.id, args.current.revision);
}

export type ReviseReviewViewResult =
	| { readonly reviewSet: ReviewSet; readonly status: "revised" }
	| { readonly reviewSet: ReviewSet; readonly status: "unchanged" }
	| { readonly status: "view_not_found"; readonly viewId: string };

/** Optional pure helper that gives a changed durable View definition a new revision identity. */
export function reviseReviewView(args: {
	readonly definition: ReviewViewDefinition;
	readonly reviewSet: ReviewSet;
	readonly viewId: ReviewViewId;
	readonly visibilityOverrides?: ReviewView["visibilityOverrides"];
	readonly visibilityPolicyId?: VisibilityPolicyId;
}): ReviseReviewViewResult {
	const index = args.reviewSet.views.findIndex((view) => view.id === args.viewId);
	if (index === -1) return { status: "view_not_found", viewId: args.viewId };
	const current = args.reviewSet.views[index]!;
	const next = ReviewView.make({
		...current,
		...args.definition,
		...(args.visibilityOverrides === undefined
			? {}
			: { visibilityOverrides: args.visibilityOverrides }),
		...(args.visibilityPolicyId === undefined
			? {}
			: { visibilityPolicyId: args.visibilityPolicyId })
	});
	const views = [...args.reviewSet.views];
	const revision = revisedReviewViewRevision({ current, next });
	views[index] = ReviewView.make({
		...next,
		revision
	});
	return {
		reviewSet: ReviewSet.make({ ...args.reviewSet, views }),
		status: revision.id === current.revision.id ? "unchanged" : "revised"
	};
}

export function createReviewViewFromCandidate(args: {
	readonly anchoring?:
		| { readonly mode: "world_fixed" }
		| {
				readonly mode: "target_relative";
				readonly targetTransform: ActorTransformSnapshot;
		  };
	readonly candidate: typeof FramingCandidate.Type;
	readonly captureProfileId: CaptureProfileId;
	readonly displayName: string;
	readonly manualPose?: typeof ApprovedPose.Type;
	readonly manualReason?: string;
	readonly purpose: string;
	readonly subject: SubjectLocator;
	readonly tags: readonly string[];
	readonly viewId: ReviewViewId;
	readonly visibilityPolicyId: VisibilityPolicyId;
}): ReviewView {
	const manuallyAdjusted = args.manualPose !== undefined;
	const recipe = {
		...args.candidate.recipe,
		...(manuallyAdjusted
			? {
					manualAdjustment: {
						reason: args.manualReason?.trim() || "Adjusted in Map Review authoring"
					}
				}
			: {})
	};
	const framingDiagnostics = [
		...args.candidate.diagnostics,
		...(manuallyAdjusted
			? [
					{
						code: "manual_adjustment" as const,
						message: recipe.manualAdjustment!.reason,
						severity: "info" as const
					}
				]
			: [])
	];
	const approvedWorldPose = args.manualPose ?? args.candidate.approvedPose;
	return ReviewView.make({
		captureProfileId: args.captureProfileId,
		displayName: args.displayName,
		framingDiagnostics,
		framingRecipe: recipe,
		id: args.viewId,
		purpose: args.purpose,
		revision: initialReviewViewRevision(args.viewId),
		tags: [...args.tags],
		target: { kind: "actor", subject: args.subject },
		viewpoint:
			args.anchoring?.mode === "target_relative"
				? targetRelativeViewpointFromWorldPose({
						targetTransform: args.anchoring.targetTransform,
						worldPose: approvedWorldPose
					})
				: { approvedPose: approvedWorldPose, kind: "world_fixed" },
		visibilityPolicyId: args.visibilityPolicyId
	});
}

/** Numeric/current-selection area authoring without requiring a persistent Unreal actor. */
export function createAreaReviewView(args: {
	readonly approvedPose: typeof ApprovedPose.Type;
	readonly bounds: SubjectBounds;
	readonly captureProfileId: CaptureProfileId;
	readonly displayName: string;
	readonly purpose: string;
	readonly tags: readonly string[];
	readonly viewId: ReviewViewId;
	readonly visibilityPolicyId: VisibilityPolicyId;
}): ReviewView {
	return ReviewView.make({
		captureProfileId: args.captureProfileId,
		displayName: args.displayName,
		framingDiagnostics: [
			{
				code: "bounds_snapshot",
				message: "Uses the portable oriented-area bounds approved for this View.",
				severity: "info"
			}
		],
		framingRecipe: { kind: "manual", version: 1 },
		id: args.viewId,
		purpose: args.purpose,
		revision: initialReviewViewRevision(args.viewId),
		tags: [...args.tags],
		target: { bounds: args.bounds, kind: "oriented_box" },
		viewpoint: { approvedPose: args.approvedPose, kind: "world_fixed" },
		visibilityPolicyId: args.visibilityPolicyId
	});
}

export function approveFramingCandidate(args: {
	readonly candidate: typeof FramingCandidate.Type;
	readonly manualPose?: typeof ApprovedPose.Type;
	readonly manualReason?: string;
	readonly reviewSet: ReviewSet;
	readonly subject?: SubjectLocator;
	readonly viewId: ReviewViewId;
}): ApproveFramingCandidateResult {
	const index = args.reviewSet.views.findIndex((view) => view.id === args.viewId);
	if (index === -1) return { status: "view_not_found", viewId: args.viewId };
	const views = [...args.reviewSet.views];
	const current = views[index]!;
	const subject = args.subject ?? reviewViewActorSubject(current);
	if (subject === undefined) {
		return { status: "view_not_found", viewId: args.viewId };
	}
	const next = createReviewViewFromCandidate({
		candidate: args.candidate,
		captureProfileId: current.captureProfileId,
		displayName: current.displayName,
		...(args.manualPose === undefined ? {} : { manualPose: args.manualPose }),
		...(args.manualReason === undefined ? {} : { manualReason: args.manualReason }),
		purpose: current.purpose,
		subject,
		tags: current.tags,
		viewId: current.id,
		visibilityPolicyId: current.visibilityPolicyId
	});
	views[index] = ReviewView.make({
		...next,
		revision: revisedReviewViewRevision({ current, next })
	});
	return {
		reviewSet: ReviewSet.make({ ...args.reviewSet, views }),
		status: "approved"
	};
}
