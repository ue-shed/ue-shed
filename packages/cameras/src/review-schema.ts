import { contractParseError, contractParser } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import { CameraAuthoredVisibility } from "./camera-visibility.js";
import {
	CameraRenderPolicy,
	CameraFrameEvidence,
	CameraWorldVector,
	CameraWorldRotation
} from "./camera-render-schema.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SafeIdentifier = NonEmptyString.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
);
const SafeRevisionIdentifier = NonEmptyString.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u)
);
const SafeRelativePath = NonEmptyString.check(
	Schema.isPattern(/^(?![A-Za-z]:)(?![\\/])(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$)).+$/u)
);
const BoundedString = Schema.String.check(Schema.isMaxLength(1_024));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * Bounded /Game/ actor object path used by review subject locators. Path validity alone does
 * not prove that the actor exists or remains the same across reconstruction.
 */
export const ReviewSubjectActorPath = Schema.String.check(
	Schema.isMinCodePoints(7),
	Schema.isMaxLength(4_096),
	Schema.isStartingWith("/Game/")
);
export type ReviewSubjectActorPath = Schema.Schema.Type<typeof ReviewSubjectActorPath>;

/**
 * Unreal's durable authored-actor GUID format (`FGuid::UniqueObjectGuid`). Saved-world readers and
 * the editor capability use this exact representation so World Partition actor identity does not
 * depend on the transient live UObject path.
 */
export const ReviewSubjectActorGuid = Schema.String.check(
	Schema.isPattern(
		/^(?!00000000-00000000-00000000-00000000$)[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{8}){3}$/u
	)
).pipe(Schema.brand("ReviewSubjectActorGuid"));
export type ReviewSubjectActorGuid = Schema.Schema.Type<typeof ReviewSubjectActorGuid>;

/**
 * Non-zero UUID correlating a review capture mutation. Preserve it while polling/reconciling
 * an uncertain reply rather than issuing a new capture automatically.
 */
export const ReviewCaptureOperationId = Schema.String.check(
	Schema.isPattern(
		/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u
	)
);
export type ReviewCaptureOperationId = Schema.Schema.Type<typeof ReviewCaptureOperationId>;

/**
 * Branded identifier for a persisted review set. Construct from validated input and preserve
 * it across related requests; an identifier alone does not prove that the resource exists or
 * is still current.
 */
export const ReviewSetId = SafeIdentifier.pipe(Schema.brand("ReviewSetId"));
export type ReviewSetId = Schema.Schema.Type<typeof ReviewSetId>;

/**
 * Branded identifier for a approved view. Construct from validated input and preserve it
 * across related requests; an identifier alone does not prove that the resource exists or is
 * still current.
 */
export const ReviewViewId = SafeIdentifier.pipe(Schema.brand("ReviewViewId"));
export type ReviewViewId = Schema.Schema.Type<typeof ReviewViewId>;

/** Explicitly states whether authoring adds a durable observation or revises one already known. */
export const ReviewAuthoringDestination = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("append_view") }),
	Schema.Struct({ kind: Schema.Literal("revise_view"), viewId: ReviewViewId })
]);
export type ReviewAuthoringDestination = Schema.Schema.Type<typeof ReviewAuthoringDestination>;

/**
 * Branded identifier for a authored view revision. Construct from validated input and
 * preserve it across related requests; an identifier alone does not prove that the resource
 * exists or is still current.
 */
export const ReviewViewRevisionId = SafeRevisionIdentifier.pipe(
	Schema.brand("ReviewViewRevisionId")
);
export type ReviewViewRevisionId = Schema.Schema.Type<typeof ReviewViewRevisionId>;

/**
 * Branded identifier for a capture profile. Construct from validated input and preserve it
 * across related requests; an identifier alone does not prove that the resource exists or is
 * still current.
 */
export const CaptureProfileId = SafeIdentifier.pipe(Schema.brand("CaptureProfileId"));
export type CaptureProfileId = Schema.Schema.Type<typeof CaptureProfileId>;

/**
 * Branded identifier for a visibility policy. Construct from validated input and preserve it
 * across related requests; an identifier alone does not prove that the resource exists or is
 * still current.
 */
export const VisibilityPolicyId = SafeIdentifier.pipe(Schema.brand("VisibilityPolicyId"));
export type VisibilityPolicyId = Schema.Schema.Type<typeof VisibilityPolicyId>;

/**
 * Branded identifier for a capture invocation. Construct from validated input and preserve it
 * across related requests; an identifier alone does not prove that the resource exists or is
 * still current.
 */
export const CaptureInvocationId = SafeIdentifier.pipe(Schema.brand("CaptureInvocationId"));
export type CaptureInvocationId = Schema.Schema.Type<typeof CaptureInvocationId>;

/**
 * Branded identifier for a provisioned editor camera. Construct from validated input and
 * preserve it across related requests; an identifier alone does not prove that the resource
 * exists or is still current.
 */
export const ProvisionedCameraId = SafeIdentifier.pipe(Schema.brand("ProvisionedCameraId"));
export type ProvisionedCameraId = Schema.Schema.Type<typeof ProvisionedCameraId>;

/**
 * Branded identifier for a saved capture run. Construct from validated input and preserve it
 * across related requests; an identifier alone does not prove that the resource exists or is
 * still current.
 */
export const CaptureRunId = SafeIdentifier.pipe(Schema.brand("CaptureRunId"));
export type CaptureRunId = Schema.Schema.Type<typeof CaptureRunId>;

const FramingCandidateIdentifier = NonEmptyString.check(
	Schema.isMaxLength(384),
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
);

/**
 * Branded identifier for a generated framing candidate. Construct from validated input and
 * preserve it across related requests; an identifier alone does not prove that the resource
 * exists or is still current.
 */
export const FramingCandidateId = FramingCandidateIdentifier.pipe(
	Schema.brand("FramingCandidateId")
);
export type FramingCandidateId = Schema.Schema.Type<typeof FramingCandidateId>;

/**
 * Branded identifier for a configurable framing group. Construct from validated input and
 * preserve it across related requests; an identifier alone does not prove that the resource
 * exists or is still current.
 */
export const FramingGroupId = SafeIdentifier.pipe(Schema.brand("FramingGroupId"));
export type FramingGroupId = Schema.Schema.Type<typeof FramingGroupId>;

/**
 * Branded identifier for a persisted authoring session. Construct from validated input and
 * preserve it across related requests; an identifier alone does not prove that the resource
 * exists or is still current.
 */
export const ReviewAuthoringSessionId = SafeIdentifier.pipe(
	Schema.brand("ReviewAuthoringSessionId")
);
export type ReviewAuthoringSessionId = Schema.Schema.Type<typeof ReviewAuthoringSessionId>;

/**
 * Branded identifier for a capture artifact. Construct from validated input and preserve it
 * across related requests; an identifier alone does not prove that the resource exists or is
 * still current.
 */
export const ArtifactId = NonEmptyString.pipe(Schema.brand("ArtifactId"));
export type ArtifactId = Schema.Schema.Type<typeof ArtifactId>;

/**
 * Review world-space XYZ coordinates using the camera-render vector contract. Finite values
 * remain in Unreal world units without coordinate conversion.
 */
export const ReviewVector = CameraWorldVector;
export type ReviewVector = Schema.Schema.Type<typeof ReviewVector>;

/**
 * Review pitch/yaw/roll in Unreal degrees, shared with the camera-render contract. This is an
 * orientation value rather than a transform matrix.
 */
export const ReviewRotation = CameraWorldRotation;
export type ReviewRotation = Schema.Schema.Type<typeof ReviewRotation>;

const NonNegativeReviewVector = Schema.Struct({
	x: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	y: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	z: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
});

/**
 * Explicit perspective review camera at 16:9 with world location/rotation and FOV from 5
 * through 170 degrees. Approval records a pose; it does not prove that the actor remains
 * unchanged.
 */
export const ApprovedPose = Schema.Struct({
	aspectRatio: Schema.Literal("16:9"),
	fieldOfViewDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
	location: ReviewVector,
	projection: Schema.Literal("perspective"),
	rotation: ReviewRotation
});
export type ApprovedPose = Schema.Schema.Type<typeof ApprovedPose>;

/**
 * Review actor addressed by its saved /Game/ object path, with an optional diagnostic label.
 * For durable World Partition identity prefer an authored actor GUID when available.
 */
export const ActorPathSubjectLocator = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	diagnosticLabel: Schema.optional(NonEmptyString),
	kind: Schema.Literal("actor_path")
});
export type ActorPathSubjectLocator = Schema.Schema.Type<typeof ActorPathSubjectLocator>;

/**
 * Review actor addressed by durable authored GUID, with optional last-known path and label.
 * The last-known path is diagnostic evidence rather than a replacement identity.
 */
export const ActorGuidSubjectLocator = Schema.Struct({
	actorGuid: ReviewSubjectActorGuid,
	diagnosticLabel: Schema.optional(NonEmptyString),
	kind: Schema.Literal("actor_guid"),
	lastKnownActorPath: Schema.optional(ReviewSubjectActorPath)
});
export type ActorGuidSubjectLocator = Schema.Schema.Type<typeof ActorGuidSubjectLocator>;

/**
 * Actor subject identified by durable authored GUID or explicit /Game/ actor path. Consumers
 * must resolve the selected locator against the intended world.
 */
export const SubjectLocator = Schema.Union([ActorGuidSubjectLocator, ActorPathSubjectLocator]);
export type SubjectLocator = Schema.Schema.Type<typeof SubjectLocator>;

/** A target-specific actor/component locator reserved for visibility intervention evidence. */
export const ObjectLocator = ActorPathSubjectLocator;
export type ObjectLocator = Schema.Schema.Type<typeof ObjectLocator>;

/**
 * Oriented subject box with world center, non-negative half extents and rotation. Snapshot
 * bounds are evidence for framing and drift checks, not a live actor handle.
 */
export const SubjectBounds = Schema.Struct({
	center: ReviewVector,
	extent: NonNegativeReviewVector,
	rotation: ReviewRotation
});
export type SubjectBounds = Schema.Schema.Type<typeof SubjectBounds>;

/**
 * Actor review target retaining its explicit subject locator. Camera pose is defined
 * separately by the view's viewpoint.
 */
export const ActorTarget = Schema.Struct({
	kind: Schema.Literal("actor"),
	subject: SubjectLocator
});
export type ActorTarget = Schema.Schema.Type<typeof ActorTarget>;

/**
 * Actor-independent oriented-box review target. Area views use a world-fixed camera; they
 * cannot inherit an actor-relative transform.
 */
export const AreaTarget = Schema.Struct({
	bounds: SubjectBounds,
	kind: Schema.Literal("oriented_box")
});
export type AreaTarget = Schema.Schema.Type<typeof AreaTarget>;

/**
 * Actor or oriented-area target for a review view. Narrow by kind before resolving actor
 * identity or using explicit bounds.
 */
export const ReviewTarget = Schema.Union([ActorTarget, AreaTarget]);
export type ReviewTarget = Schema.Schema.Type<typeof ReviewTarget>;

/** Cross-language capture subject for a portable, map-scoped oriented area. */
export const OrientedBoundsSubject = Schema.Struct({
	bounds: SubjectBounds,
	kind: Schema.Literal("oriented_bounds")
});
export type OrientedBoundsSubject = Schema.Schema.Type<typeof OrientedBoundsSubject>;

const ReviewCaptureSubjectPrevious = Schema.Union([ActorPathSubjectLocator, OrientedBoundsSubject]);

/**
 * Wire capture subject supplied as actor locator or oriented bounds. It describes what is
 * assessed, independently of the camera viewpoint.
 */
export const ReviewCaptureSubject = Schema.Union([SubjectLocator, OrientedBoundsSubject]);
export type ReviewCaptureSubject = Schema.Schema.Type<typeof ReviewCaptureSubject>;

/**
 * World location/rotation captured when authoring an actor-relative view. Later realization
 * uses this evidence to interpret relative pose and subject movement.
 */
export const ActorTransformSnapshot = Schema.Struct({
	location: ReviewVector,
	rotation: ReviewRotation
});
export type ActorTransformSnapshot = Schema.Schema.Type<typeof ActorTransformSnapshot>;

/**
 * Approved camera pose fixed in world space. Actor movement does not automatically move this
 * viewpoint.
 */
export const WorldFixedViewpoint = Schema.Struct({
	approvedPose: ApprovedPose,
	kind: Schema.Literal("world_fixed")
});
export type WorldFixedViewpoint = Schema.Schema.Type<typeof WorldFixedViewpoint>;

/**
 * Camera pose relative to an actor target and the recorded target transform. Requires an
 * actor target; oriented-area targets cannot use it.
 */
export const TargetRelativeViewpoint = Schema.Struct({
	kind: Schema.Literal("target_relative"),
	relativePose: ApprovedPose,
	targetSnapshot: ActorTransformSnapshot
});
export type TargetRelativeViewpoint = Schema.Schema.Type<typeof TargetRelativeViewpoint>;

/**
 * Valid target/viewpoint pair: actor with world-fixed or relative pose, or oriented area with
 * world-fixed pose. Invalid area-relative combinations are excluded by the model.
 */
export const ReviewViewDefinition = Schema.Union([
	Schema.Struct({ target: ActorTarget, viewpoint: WorldFixedViewpoint }),
	Schema.Struct({ target: ActorTarget, viewpoint: TargetRelativeViewpoint }),
	Schema.Struct({ target: AreaTarget, viewpoint: WorldFixedViewpoint })
]);
export type ReviewViewDefinition = Schema.Schema.Type<typeof ReviewViewDefinition>;

/**
 * Positive authored view revision with stable revision identity. Captures retain this
 * revision so later view edits do not rewrite historical approval evidence.
 */
export const NumberedReviewViewRevision = Schema.Struct({
	id: ReviewViewRevisionId,
	number: PositiveInteger,
	status: Schema.Literal("numbered")
});
export type NumberedReviewViewRevision = Schema.Schema.Type<typeof NumberedReviewViewRevision>;

/**
 * Numbered view revision or explicit legacy_unversioned capture evidence. Migrated history
 * must not invent a revision that was never recorded.
 */
export const CapturedReviewViewRevision = Schema.Union([
	NumberedReviewViewRevision,
	Schema.Struct({ status: Schema.Literal("legacy_unversioned") })
]);
export type CapturedReviewViewRevision = Schema.Schema.Type<typeof CapturedReviewViewRevision>;

/**
 * Built-in named framing choices, including cardinal, facade, context and editor-view poses.
 * Hosts may use configurable framing groups instead of treating these names as fixed project
 * policy.
 */
export const FramingPreset = Schema.Literals([
	"context_three_quarter",
	"facade_front",
	"cardinal_north",
	"cardinal_east",
	"cardinal_south",
	"cardinal_west",
	"editor_view"
]);
export type FramingPreset = Schema.Schema.Type<typeof FramingPreset>;

/**
 * Positive candidate count distributed over a yaw arc with explicit spread/offset in degrees.
 * This is generation policy; it does not move an editor camera by itself.
 */
export const ArcFramingPattern = Schema.Struct({
	count: PositiveInteger,
	kind: Schema.Literal("arc"),
	spreadDegrees: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	yawOffsetDegrees: Schema.Finite
});
export type ArcFramingPattern = Schema.Schema.Type<typeof ArcFramingPattern>;

/**
 * Positive candidate count distributed around a full ring with an angular offset in degrees.
 * Candidate generation remains deterministic for the same subject and parameters.
 */
export const RingFramingPattern = Schema.Struct({
	count: PositiveInteger,
	kind: Schema.Literal("ring"),
	ringOffsetDegrees: Schema.Finite
});
export type RingFramingPattern = Schema.Schema.Type<typeof RingFramingPattern>;

/**
 * Arc or ring candidate-distribution policy. Narrow by kind to interpret spread/yaw-offset
 * versus ring-offset fields.
 */
export const FramingPattern = Schema.Union([ArcFramingPattern, RingFramingPattern]);
export type FramingPattern = Schema.Schema.Type<typeof FramingPattern>;

/**
 * Named enabled/disabled framing group with ID, distance scale, elevation and arc/ring
 * pattern. Hosts configure groups rather than modifying the generator for each project.
 */
export const FramingGroup = Schema.Struct({
	displayName: NonEmptyString,
	distanceScale: Schema.Finite.check(Schema.isGreaterThan(0)),
	elevation: Schema.Finite,
	enabled: Schema.Boolean,
	id: FramingGroupId,
	pattern: FramingPattern
});
export type FramingGroup = Schema.Schema.Type<typeof FramingGroup>;

/**
 * Candidate-generation policy with FOV, groups and normalized margin from zero through 0.45.
 * These are host/project choices rather than Unreal format constraints.
 */
export const FramingParameters = Schema.Struct({
	fieldOfViewDegrees: ApprovedPose.fields.fieldOfViewDegrees,
	groups: Schema.Array(FramingGroup),
	margin: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 }))
});
export type FramingParameters = Schema.Schema.Type<typeof FramingParameters>;

/**
 * Optional per-candidate distance, elevation, FOV, margin and yaw adjustments. Missing fields
 * inherit the group's generation parameters.
 */
export const FramingCandidateOverrides = Schema.Struct({
	distanceScale: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
	elevation: Schema.optional(Schema.Finite),
	fieldOfViewDegrees: Schema.optional(ApprovedPose.fields.fieldOfViewDegrees),
	margin: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 }))),
	yawOffsetDegrees: Schema.optional(Schema.Finite)
});
export type FramingCandidateOverrides = Schema.Schema.Type<typeof FramingCandidateOverrides>;

/**
 * Overrides bound to one deterministic candidate ID. Unrelated candidates retain their
 * inherited framing policy.
 */
export const FramingCandidateOverride = Schema.Struct({
	candidateId: FramingCandidateId,
	overrides: FramingCandidateOverrides
});
export type FramingCandidateOverride = Schema.Schema.Type<typeof FramingCandidateOverride>;

const ManualFramingRecipe = Schema.Struct({
	kind: Schema.Literal("manual"),
	note: Schema.optional(NonEmptyString),
	version: Schema.Literal(1)
});

/**
 * Legacy version-1 preset recipe retaining subject bounds, margin and optional
 * manual-adjustment reason. Kept for migration; current recipes additionally retain group
 * parameters.
 */
export const PresetFramingRecipeV1 = Schema.Struct({
	kind: Schema.Literal("preset"),
	margin: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 })),
	manualAdjustment: Schema.optional(Schema.Struct({ reason: NonEmptyString })),
	preset: FramingPreset,
	subjectBounds: SubjectBounds,
	version: Schema.Literal(1)
});

/**
 * Version-2 recipe retaining group identity/index, full generation parameters, subject bounds
 * and optional overrides/manual reason. This allows an approved pose's provenance to be
 * inspected later.
 */
export const PresetFramingRecipeV2 = Schema.Struct({
	candidateOverrides: Schema.optional(FramingCandidateOverrides),
	groupId: FramingGroupId,
	groupIndex: PositiveInteger,
	kind: Schema.Literal("preset"),
	margin: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 })),
	manualAdjustment: Schema.optional(Schema.Struct({ reason: NonEmptyString })),
	parameters: FramingParameters,
	preset: FramingGroupId,
	subjectBounds: SubjectBounds,
	version: Schema.Literal(2)
});

/**
 * Supported legacy/current preset framing provenance. Consumers must discriminate version
 * rather than assuming version-2 group fields exist in old saved reviews.
 */
export const PresetFramingRecipe = Schema.Union([PresetFramingRecipeV1, PresetFramingRecipeV2]);
export type PresetFramingRecipe = Schema.Schema.Type<typeof PresetFramingRecipe>;

/**
 * Manual or generated-preset framing provenance. Manual adjustments require their recorded
 * reason rather than being presented as an unchanged generated candidate.
 */
export const FramingRecipe = Schema.Union([ManualFramingRecipe, PresetFramingRecipe]);
export type FramingRecipe = Schema.Schema.Type<typeof FramingRecipe>;

/**
 * Informational/warning framing evidence, including bounds drift, margin and
 * viewport/near-plane conditions. Severity is diagnostic policy rather than an automatic
 * capture refusal.
 */
export const FramingDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"bounds_snapshot",
		"subject_bounds_changed",
		"manual_adjustment",
		"subject_framing_within_margin",
		"subject_margin_below_requested",
		"subject_partially_outside_viewport",
		"subject_fully_outside_viewport",
		"subject_near_plane_crossing",
		"subject_behind_camera"
	]),
	message: NonEmptyString,
	severity: Schema.Literals(["info", "warning"])
});
export type FramingDiagnostic = Schema.Schema.Type<typeof FramingDiagnostic>;

/**
 * Finite projected subject bounds with min/max X/Y. Values can extend beyond the viewport;
 * consumers use framing diagnostics to interpret clipping rather than clamping away evidence.
 */
const ReviewProjectedBounds = Schema.Struct({
	maxX: Schema.Finite,
	maxY: Schema.Finite,
	minX: Schema.Finite,
	minY: Schema.Finite
});
/** Normalized viewport bounds; out-of-frame coordinates are retained for clipping diagnostics. */
export type ReviewProjectedBounds = Schema.Schema.Type<typeof ReviewProjectedBounds>;

/**
 * Finite projected margins on each viewport edge. Negative margins can express a subject
 * extending outside the frame and must not be silently clamped.
 */
const ReviewProjectionMargins = Schema.Struct({
	bottom: Schema.Finite,
	left: Schema.Finite,
	right: Schema.Finite,
	top: Schema.Finite
});
/** Normalized viewport margins; negative values preserve evidence of framing outside an edge. */
export type ReviewProjectionMargins = Schema.Schema.Type<typeof ReviewProjectionMargins>;

const ReviewProjectedSubject = Schema.Struct({
	margins: ReviewProjectionMargins,
	normalizedBounds: ReviewProjectedBounds,
	status: Schema.Literal("projected"),
	viewportStatus: Schema.Literals([
		"fully_within_viewport",
		"partially_outside_viewport",
		"fully_outside_viewport"
	])
});

const ReviewUnprojectableSubject = Schema.Struct({
	code: Schema.Literals(["behind_camera", "near_plane_crossing"]),
	message: NonEmptyString,
	status: Schema.Literal("unprojectable")
});

/**
 * Post-realization evidence from the transient SceneCapture2D. Projected bounds are normalized
 * to the render target (0..1 at the viewport edges); no rectangle is fabricated when a corner
 * crosses the camera near plane or is behind the camera.
 */
export const ReviewSubjectProjection = Schema.Union([
	ReviewProjectedSubject,
	ReviewUnprojectableSubject
]);
export type ReviewSubjectProjection = Schema.Schema.Type<typeof ReviewSubjectProjection>;

/**
 * Deterministic candidate identity, proposed approved pose, generation recipe and
 * diagnostics. A generated candidate is not an approved persisted review view until the
 * explicit approval operation.
 */
export const FramingCandidate = Schema.Struct({
	approvedPose: ApprovedPose,
	diagnostics: Schema.Array(FramingDiagnostic),
	displayName: NonEmptyString,
	id: FramingCandidateId,
	recipe: PresetFramingRecipe
});
export type FramingCandidate = Schema.Schema.Type<typeof FramingCandidate>;

const ReviewSelectionContract = Schema.Struct({
	name: Schema.Literal("ue-shed-review-selection"),
	version: Schema.Struct({
		major: Schema.Literal(1),
		minor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
	})
});

const ReviewSelectionSuccess = Schema.Struct({
	actorGuid: Schema.optional(ReviewSubjectActorGuid),
	actorPath: ReviewSubjectActorPath,
	bounds: SubjectBounds,
	contract: ReviewSelectionContract,
	displayName: NonEmptyString,
	editorView: Schema.optional(ApprovedPose),
	mapPath: NonEmptyString,
	status: Schema.Literal("selected")
});

const ReviewSelectionFailure = Schema.Struct({
	code: Schema.Literals(["no_selection", "multiple_selection", "editor_unavailable"]),
	contract: ReviewSelectionContract,
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed")
});

/**
 * Selected actor/bounds evidence or explicit selection failure from the editor. Failure is an
 * ordinary response variant rather than an empty successful selection.
 */
export const ReviewSelectionResponse = Schema.Union([
	ReviewSelectionSuccess,
	ReviewSelectionFailure
]);
export type ReviewSelectionResponse = Schema.Schema.Type<typeof ReviewSelectionResponse>;

const ReviewSubjectInspectionFailure = Schema.Struct({
	code: Schema.Literals(["editor_unavailable", "map_mismatch", "subject_not_found"]),
	contract: ReviewSelectionContract,
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed")
});

/**
 * Resolved subject evidence or typed inspection failure. The response preserves
 * unavailable/missing subject state instead of fabricating bounds.
 */
export const ReviewSubjectInspectionResponse = Schema.Union([
	ReviewSelectionSuccess,
	ReviewSubjectInspectionFailure
]);
export type ReviewSubjectInspectionResponse = Schema.Schema.Type<
	typeof ReviewSubjectInspectionResponse
>;

/** Prefers durable authored identity while retaining a path only as inspectable fallback evidence. */
export function subjectLocatorFromSelection(
	selection: Schema.Schema.Type<typeof ReviewSelectionSuccess>
): SubjectLocator {
	return selection.actorGuid === undefined
		? ActorPathSubjectLocator.make({
				actorPath: selection.actorPath,
				diagnosticLabel: selection.displayName,
				kind: "actor_path"
			})
		: ActorGuidSubjectLocator.make({
				actorGuid: selection.actorGuid,
				diagnosticLabel: selection.displayName,
				kind: "actor_guid",
				lastKnownActorPath: selection.actorPath
			});
}

/**
 * Explicit candidate/view identity, source actor and proposed pose, with optional manually
 * adjusted pose/reason. Approval must validate these against current authoring-session
 * evidence.
 */
export const ApproveReviewCandidateIntent = Schema.Struct({
	candidateId: FramingCandidateId,
	candidatePose: ApprovedPose,
	manualPose: Schema.optional(ApprovedPose),
	manualReason: Schema.optional(NonEmptyString),
	sourceActorPath: ReviewSubjectActorPath,
	viewId: ReviewViewId
});
export type ApproveReviewCandidateIntent = Schema.Schema.Type<typeof ApproveReviewCandidateIntent>;

/**
 * Named PNG review output profile with bounded pixel resolution and optional complete render
 * policy. Legacy full_fidelity remains explicit; it is not a guarantee of backend support.
 */
export const CaptureProfile = Schema.Struct({
	renderPolicy: Schema.optionalKey(CameraRenderPolicy),
	id: CaptureProfileId,
	imageFormat: Schema.Literal("png"),
	renderProfile: Schema.Literal("full_fidelity"),
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	})
});
export type CaptureProfile = Schema.Schema.Type<typeof CaptureProfile>;

/**
 * Sparse, standard or dense sampling policy for ray-based assessment. Hosts choose assessment
 * cost/coverage rather than changing a fixed toolkit threshold.
 */
export const VisibilitySamplePreset = Schema.Literals(["sparse", "standard", "dense"]);
export type VisibilitySamplePreset = Schema.Schema.Type<typeof VisibilitySamplePreset>;

/**
 * Requested assessment strategy, including automatic capability selection and explicit ray,
 * mask or depth methods. Availability must be negotiated with the connected editor.
 */
export const ReviewAssessmentMethodName = Schema.Literals([
	"automatic",
	"ray_samples",
	"subject_mask",
	"depth_compare"
]);
export type ReviewAssessmentMethodName = Schema.Schema.Type<typeof ReviewAssessmentMethodName>;

/**
 * Automatic or explicit visibility measurement policy. Ray sampling additionally requires a
 * sample preset; measurement strategy is independent of low-visibility acceptance thresholds.
 */
export const VisibilityAssessment = Schema.Union([
	Schema.Struct({ method: Schema.Literal("automatic") }),
	Schema.Struct({ method: Schema.Literal("ray_samples"), samplePreset: VisibilitySamplePreset }),
	Schema.Struct({ method: Schema.Literal("subject_mask") }),
	Schema.Struct({ method: Schema.Literal("depth_compare") })
]);
export type VisibilityAssessment = Schema.Schema.Type<typeof VisibilityAssessment>;

const NaturalOnlyVisibilityOutput = Schema.Struct({ mode: Schema.Literal("natural_only") });
const NaturalAndClearVisibilityOutput = Schema.Struct({
	clearStrategy: Schema.Union([
		Schema.Struct({ type: Schema.Literal("isolate_target") }),
		Schema.Struct({ type: Schema.Literal("hide_explicit") })
	]),
	mode: Schema.Literal("natural_and_clear")
});

/**
 * Natural-only output or natural plus a clear companion according to its policy. Clear output
 * is separately evidenced rather than replacing the naturally occluded frame.
 */
export const VisibilityOutput = Schema.Union([
	NaturalOnlyVisibilityOutput,
	NaturalAndClearVisibilityOutput
]);
export type VisibilityOutput = Schema.Schema.Type<typeof VisibilityOutput>;

/**
 * Record, warn or fail policy, with a normalized threshold for warn/fail. Hosts configure
 * acceptance; the underlying measurement remains observable regardless of policy.
 */
export const VisibilityLowThresholdAction = Schema.Union([
	Schema.Struct({ action: Schema.Literal("record") }),
	Schema.Struct({ action: Schema.Literal("warn"), threshold: Fraction }),
	Schema.Struct({ action: Schema.Literal("fail"), threshold: Fraction })
]);
export type VisibilityLowThresholdAction = Schema.Schema.Type<typeof VisibilityLowThresholdAction>;

/**
 * Named assessment, output and low-visibility acceptance policy referenced by views. Projects
 * can replace policy without modifying Unreal capture behavior.
 */
export const VisibilityPolicy = Schema.Struct({
	assessment: VisibilityAssessment,
	id: VisibilityPolicyId,
	name: NonEmptyString,
	onLowVisibility: VisibilityLowThresholdAction,
	output: VisibilityOutput
});
export type VisibilityPolicy = Schema.Schema.Type<typeof VisibilityPolicy>;

function locatorIdentity(locator: ObjectLocator): string {
	return `${locator.kind}:${locator.actorPath}`;
}

/**
 * Bounded explicit hide/protect locators for clear companions. Rejects duplicates and
 * contradictions so an object cannot be both hidden and protected in the same request.
 */
export const VisibilityOverrides = Schema.Struct({
	hideInClear: Schema.Array(ObjectLocator).check(Schema.isMaxLength(32)),
	neverHide: Schema.Array(ObjectLocator).check(Schema.isMaxLength(32))
}).pipe(
	Schema.check(
		Schema.makeFilter((overrides) => {
			const hidden = new Set<string>();
			const protectedObjects = new Set<string>();
			for (const locator of overrides.hideInClear) {
				const identity = locatorIdentity(locator);
				if (hidden.has(identity)) {
					return {
						issue: "Hide in Clear cannot name the same object more than once.",
						path: ["hideInClear"]
					};
				}
				hidden.add(identity);
			}
			for (const locator of overrides.neverHide) {
				const identity = locatorIdentity(locator);
				if (protectedObjects.has(identity)) {
					return {
						issue: "Never hide cannot name the same object more than once.",
						path: ["neverHide"]
					};
				}
				if (hidden.has(identity)) {
					return {
						issue: "An object cannot be both hidden and protected in Clear capture.",
						path: ["neverHide"]
					};
				}
				protectedObjects.add(identity);
			}
			return undefined;
		})
	)
);
export type VisibilityOverrides = Schema.Schema.Type<typeof VisibilityOverrides>;

const maxRuntimeTriggerEncodedBytes = 8 * 1024;
const maxRuntimeTriggerDepth = 4;
const maxRuntimeTriggerKeys = 32;
const maxRuntimeTriggerArrayLength = 32;

function boundedJsonIssue(value: Schema.Json, depth = 0): string | undefined {
	if (depth > maxRuntimeTriggerDepth) return "Runtime trigger provenance is nested too deeply.";
	if (
		value === null ||
		Schema.is(Schema.Boolean)(value) ||
		(Schema.is(Schema.Number)(value) && Number.isFinite(value))
	) {
		return undefined;
	}
	if (Schema.is(Schema.String)(value)) {
		return value.length <= 1_024
			? undefined
			: "Runtime trigger strings are limited to 1024 characters.";
	}
	if (Array.isArray(value)) {
		if (value.length > maxRuntimeTriggerArrayLength) {
			return "Runtime trigger arrays are limited to 32 entries.";
		}
		for (const child of value) {
			const issue = boundedJsonIssue(child, depth + 1);
			if (issue !== undefined) return issue;
		}
		return undefined;
	}
	const entries = Object.entries(value);
	if (entries.length > maxRuntimeTriggerKeys) {
		return "Runtime trigger provenance is limited to 32 object keys.";
	}
	for (const [key, child] of entries) {
		if (key.length === 0 || key.length > 128) {
			return "Runtime trigger provenance keys must contain 1 through 128 characters.";
		}
		const issue = boundedJsonIssue(child, depth + 1);
		if (issue !== undefined) return issue;
	}
	return undefined;
}

/**
 * Runtime-trigger provenance JSON with bounded keys, structure and encoded size. This retains
 * trigger context without permitting an unbounded payload in saved capture history.
 */
export const BoundedJsonObject = Schema.Record(BoundedString, Schema.Json).pipe(
	Schema.check(
		Schema.makeFilter((value) => {
			const issue = boundedJsonIssue(value);
			if (issue !== undefined) return issue;
			return JSON.stringify(value).length <= maxRuntimeTriggerEncodedBytes
				? undefined
				: "Runtime trigger provenance exceeds the 8192-byte limit.";
		})
	)
);
export type BoundedJsonObject = Schema.Schema.Type<typeof BoundedJsonObject>;

/**
 * Manual, external automation or namespaced/versioned runtime-trigger provenance. Runtime
 * triggers carry bounded JSON; this records why capture ran rather than granting editor
 * authority.
 */
export const CaptureInvocationCause = Schema.Union([
	Schema.Struct({ type: Schema.Literal("manual") }),
	Schema.Struct({
		correlationId: Schema.optional(BoundedString),
		type: Schema.Literal("external_automation")
	}),
	Schema.Struct({
		namespace: NonEmptyString.check(Schema.isMaxLength(128)),
		provenance: BoundedJsonObject,
		schemaVersion: PositiveInteger,
		type: Schema.Literal("runtime_trigger")
	})
]);
export type CaptureInvocationCause = Schema.Schema.Type<typeof CaptureInvocationCause>;

/**
 * Capture identity, review-set identity and optional non-empty bounded view subset. Omitting
 * the subset means selection follows the review set; it does not change host project
 * selection.
 */
export const CaptureInvocation = Schema.Struct({
	cause: CaptureInvocationCause,
	id: CaptureInvocationId,
	reviewSetId: ReviewSetId,
	viewIds: Schema.optional(
		Schema.Array(ReviewViewId).check(Schema.isMinLength(1), Schema.isMaxLength(64))
	)
});
export type CaptureInvocation = Schema.Schema.Type<typeof CaptureInvocation>;

/**
 * Observed occluder locator, normalized confidence and explanation. This is assessment
 * evidence rather than permission to hide the object under every output policy.
 */
export const OccluderEvidence = Schema.Struct({
	confidence: Fraction,
	locator: ObjectLocator,
	reason: BoundedString
});
export type OccluderEvidence = Schema.Schema.Type<typeof OccluderEvidence>;

/**
 * Concrete non-automatic measurement method and algorithm version used for a result. Retain
 * it with history so changes in assessment implementation remain inspectable.
 */
export const EffectiveVisibilityMethod = Schema.Struct({
	method: Schema.Literals(["ray_samples", "subject_mask", "depth_compare"]),
	version: PositiveInteger
});
export type EffectiveVisibilityMethod = Schema.Schema.Type<typeof EffectiveVisibilityMethod>;

const SupportedReviewAssessmentMethod = Schema.Struct({
	effectiveMethod: EffectiveVisibilityMethod,
	limitations: Schema.Array(BoundedString).check(Schema.isMaxLength(8)),
	requestedMethod: ReviewAssessmentMethodName,
	status: Schema.Literal("supported")
});

const UnsupportedReviewAssessmentMethod = Schema.Struct({
	reason: NonEmptyString,
	requestedMethod: ReviewAssessmentMethodName,
	status: Schema.Literal("unsupported")
});

/**
 * Versioned editor assessment capabilities with supported/unsupported methods and
 * depth-resolution limits. Negotiate this before selecting an automatic method or requesting
 * a larger assessment.
 */
export const ReviewAssessmentCapabilities = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-assessment-capabilities"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	depthCompareMaximumResolution: Schema.Struct({
		height: PositiveInteger,
		width: PositiveInteger
	}),
	methods: Schema.Array(
		Schema.Union([SupportedReviewAssessmentMethod, UnsupportedReviewAssessmentMethod])
	).check(Schema.isMinLength(1), Schema.isMaxLength(16))
});
export type ReviewAssessmentCapabilities = Schema.Schema.Type<typeof ReviewAssessmentCapabilities>;

const VisibilityNotAssessed = Schema.Struct({
	limitations: Schema.optional(Schema.Array(BoundedString).check(Schema.isMaxLength(8))),
	reason: NonEmptyString,
	status: Schema.Literal("not_assessed")
});

const VisibilityAssessedMeasurement = Schema.Struct({
	assessmentDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	limitations: Schema.Array(BoundedString).check(Schema.isMaxLength(8)),
	method: EffectiveVisibilityMethod,
	occluders: Schema.Array(OccluderEvidence).check(Schema.isMaxLength(32)),
	sampleCount: NonNegativeInteger,
	status: Schema.Literal("assessed"),
	visibleFraction: Fraction
});

const VisibilityAssessmentFailed = Schema.Struct({
	failure: Schema.Struct({
		code: NonEmptyString,
		message: NonEmptyString,
		recovery: NonEmptyString,
		retrySafe: Schema.Boolean
	}),
	status: Schema.Literal("assessment_failed")
});

/**
 * Not-assessed, assessed or failed visibility outcome. Missing measurement is not zero
 * visibility; preserve each variant when classifying or presenting results.
 */
export const VisibilityMeasurement = Schema.Union([
	VisibilityNotAssessed,
	VisibilityAssessedMeasurement,
	VisibilityAssessmentFailed
]);
export type VisibilityMeasurement = Schema.Schema.Type<typeof VisibilityMeasurement>;

/**
 * Clear, partial, blocked or not-visible presentation category. Classification depends on
 * explicit thresholds and does not replace the measured visibility evidence.
 */
export const VisibilityClassification = Schema.Literals([
	"clear",
	"partial",
	"blocked",
	"not_visible"
]);
export type VisibilityClassification = Schema.Schema.Type<typeof VisibilityClassification>;

const LegacyClassifiedVisibilityResult = Schema.Union([
	VisibilityNotAssessed,
	VisibilityAssessedMeasurement.pipe(
		Schema.fieldsAssign({ classification: VisibilityClassification })
	),
	VisibilityAssessmentFailed
]);

const LegacyVisibilityInterpretation = Schema.Struct({
	classification: VisibilityClassification,
	source: Schema.Literal("capture_run_pre_1_3")
});

const VisibilityAssessedResult = VisibilityAssessedMeasurement.pipe(
	Schema.fieldsAssign({
		legacyInterpretation: Schema.optional(LegacyVisibilityInterpretation)
	})
);

/**
 * Durable visibility evidence. New results remain raw; migrated pre-v1.3 results may retain their
 * old classification as explicitly legacy interpretation.
 */
export const VisibilityResult = Schema.Union([
	VisibilityNotAssessed,
	VisibilityAssessedResult,
	VisibilityAssessmentFailed
]);
export type VisibilityResult = Schema.Schema.Type<typeof VisibilityResult>;

/**
 * Normalized blocked/clear cutoffs, requiring blockedAtOrBelow to be lower than
 * clearAtOrAbove. Projects can change classification policy without changing measurement.
 */
export const VisibilityClassificationThresholds = Schema.Struct({
	blockedAtOrBelow: Fraction,
	clearAtOrAbove: Fraction
}).pipe(
	Schema.check(
		Schema.makeFilter((thresholds) =>
			thresholds.blockedAtOrBelow < thresholds.clearAtOrAbove
				? undefined
				: {
						issue: "Blocked visibility threshold must be lower than the clear threshold.",
						path: []
					}
		)
	)
);
export type VisibilityClassificationThresholds = Schema.Schema.Type<
	typeof VisibilityClassificationThresholds
>;

/** Optional consumer interpretation of raw visibility evidence using caller-owned thresholds. */
export function classifyVisibilityMeasurement(args: {
	readonly measurement: VisibilityMeasurement;
	readonly projection: ReviewSubjectProjection;
	readonly thresholds: VisibilityClassificationThresholds;
}): VisibilityClassification | undefined {
	if (args.measurement.status !== "assessed") return undefined;
	return args.projection.status === "unprojectable" ||
		args.projection.viewportStatus === "fully_outside_viewport"
		? "not_visible"
		: args.measurement.visibleFraction >= args.thresholds.clearAtOrAbove
			? "clear"
			: args.measurement.visibleFraction <= args.thresholds.blockedAtOrBelow
				? "blocked"
				: "partial";
}

const PreviousActorTarget = Schema.Struct({
	kind: Schema.Literal("actor"),
	subject: ActorPathSubjectLocator
});

const PreviousReviewTarget = Schema.Union([PreviousActorTarget, AreaTarget]);

const PreviousReviewView = Schema.Struct({
	captureProfileId: CaptureProfileId,
	displayName: NonEmptyString,
	framingDiagnostics: Schema.optional(Schema.Array(FramingDiagnostic)),
	framingRecipe: FramingRecipe,
	id: ReviewViewId,
	purpose: NonEmptyString,
	revision: NumberedReviewViewRevision,
	tags: Schema.Array(NonEmptyString),
	target: PreviousReviewTarget,
	viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint]),
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicyId: VisibilityPolicyId
}).pipe(
	Schema.check(
		Schema.makeFilter((view) =>
			view.target.kind === "oriented_box" && view.viewpoint.kind === "target_relative"
				? {
						issue: "Oriented-area Views must use a world-fixed viewpoint.",
						path: ["viewpoint"]
					}
				: undefined
		)
	)
);

/**
 * Approved named view with revision, target/viewpoint, framing provenance and referenced
 * capture/visibility policies. Area targets require world-fixed viewpoints; authored
 * visibility remains explicit.
 */
export const ReviewView = Schema.Struct({
	authoredVisibility: Schema.optionalKey(CameraAuthoredVisibility),
	authoring: Schema.optionalKey(
		Schema.Struct({ arrangementId: SafeIdentifier, cameraId: SafeIdentifier })
	),
	captureProfileId: CaptureProfileId,
	displayName: NonEmptyString,
	framingDiagnostics: Schema.optional(Schema.Array(FramingDiagnostic)),
	framingRecipe: FramingRecipe,
	id: ReviewViewId,
	purpose: NonEmptyString,
	revision: NumberedReviewViewRevision,
	tags: Schema.Array(NonEmptyString),
	target: ReviewTarget,
	viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint]),
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicyId: VisibilityPolicyId
}).pipe(
	Schema.check(
		Schema.makeFilter((view) => {
			if (view.target.kind === "oriented_box" && view.viewpoint.kind === "target_relative") {
				return {
					issue: "Oriented-area Views must use a world-fixed viewpoint.",
					path: ["viewpoint"]
				};
			}
			return undefined;
		})
	)
);
export type ReviewView = Schema.Schema.Type<typeof ReviewView>;

const ReviewSetCurrent = Schema.Struct({
	captureProfiles: Schema.Array(CaptureProfile).check(Schema.isMinLength(1)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([2, 3, 4, 5]) })
	}),
	description: Schema.optional(NonEmptyString),
	displayName: NonEmptyString,
	id: ReviewSetId,
	project: Schema.Struct({
		id: NonEmptyString,
		mapPath: NonEmptyString
	}),
	views: Schema.Array(ReviewView),
	visibilityPolicies: Schema.Array(VisibilityPolicy).check(Schema.isMinLength(1))
}).pipe(
	Schema.check(
		Schema.makeFilter((reviewSet) => {
			if (
				reviewSet.contract.version.minor < 5 &&
				reviewSet.views.some((view) => view.authoredVisibility !== undefined)
			)
				return {
					issue: "Authored visibility requires Review Set 1.5.",
					path: ["contract"]
				};
			if (
				reviewSet.contract.version.minor < 4 &&
				reviewSet.views.some((view) => view.authoring !== undefined)
			)
				return {
					issue: "Camera arrangement ownership requires Review Set 1.4.",
					path: ["contract"]
				};
			if (
				reviewSet.contract.version.minor < 3 &&
				reviewSet.captureProfiles.some((profile) => profile.renderPolicy !== undefined)
			)
				return {
					issue: "Explicit rendering policies require Review Set 1.3.",
					path: ["contract"]
				};
			const profileIds = new Set<string>();
			for (const profile of reviewSet.captureProfiles) {
				if (profileIds.has(profile.id)) {
					return {
						issue: "Capture Profile IDs must be unique.",
						path: ["captureProfiles"]
					};
				}
				profileIds.add(profile.id);
			}
			const policies = new Map<string, VisibilityPolicy>();
			for (const policy of reviewSet.visibilityPolicies) {
				if (policies.has(policy.id)) {
					return {
						issue: "Visibility Policy IDs must be unique.",
						path: ["visibilityPolicies"]
					};
				}
				policies.set(policy.id, policy);
			}
			const viewIds = new Set<string>();
			for (const view of reviewSet.views) {
				if (viewIds.has(view.id)) {
					return { issue: "Review View IDs must be unique.", path: ["views"] };
				}
				viewIds.add(view.id);
				if (!profileIds.has(view.captureProfileId)) {
					return {
						issue: "Review View references a missing Capture Profile.",
						path: ["views"]
					};
				}
				const policy = policies.get(view.visibilityPolicyId);
				if (policy === undefined) {
					return {
						issue: "Review View references a missing Visibility Policy.",
						path: ["views"]
					};
				}
				const overrides = view.visibilityOverrides;
				if (
					overrides !== undefined &&
					(overrides.hideInClear.length > 0 || overrides.neverHide.length > 0) &&
					policy.output.mode === "natural_only"
				) {
					return {
						issue: "Natural-only policy cannot carry Clear visibility overrides.",
						path: ["views"]
					};
				}
				if (
					policy.output.mode === "natural_and_clear" &&
					policy.output.clearStrategy.type === "hide_explicit" &&
					(overrides === undefined || overrides.hideInClear.length === 0)
				) {
					return {
						issue: "Explicit-hide Clear policy requires at least one Hide in Clear object.",
						path: ["views"]
					};
				}
				if (view.target.kind === "oriented_box" && policy.output.mode !== "natural_only") {
					return {
						issue: "Area Views support Natural-only visibility in this version.",
						path: ["views"]
					};
				}
			}
			return undefined;
		})
	)
);

const PreviousReviewSet = Schema.Struct({
	captureProfiles: Schema.Array(CaptureProfile).check(Schema.isMinLength(1)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(1) })
	}),
	description: Schema.optional(NonEmptyString),
	displayName: NonEmptyString,
	id: ReviewSetId,
	project: Schema.Struct({
		id: NonEmptyString,
		mapPath: NonEmptyString
	}),
	views: Schema.Array(PreviousReviewView),
	visibilityPolicies: Schema.Array(VisibilityPolicy).check(Schema.isMinLength(1))
}).pipe(
	Schema.check(
		Schema.makeFilter((reviewSet) => {
			const profileIds = new Set<string>();
			for (const profile of reviewSet.captureProfiles) {
				if (profileIds.has(profile.id)) {
					return {
						issue: "Capture Profile IDs must be unique.",
						path: ["captureProfiles"]
					};
				}
				profileIds.add(profile.id);
			}
			const policies = new Map<string, VisibilityPolicy>();
			for (const policy of reviewSet.visibilityPolicies) {
				if (policies.has(policy.id)) {
					return {
						issue: "Visibility Policy IDs must be unique.",
						path: ["visibilityPolicies"]
					};
				}
				policies.set(policy.id, policy);
			}
			const viewIds = new Set<string>();
			for (const view of reviewSet.views) {
				if (viewIds.has(view.id)) {
					return { issue: "Review View IDs must be unique.", path: ["views"] };
				}
				viewIds.add(view.id);
				if (!profileIds.has(view.captureProfileId)) {
					return {
						issue: "Review View references a missing Capture Profile.",
						path: ["views"]
					};
				}
				const policy = policies.get(view.visibilityPolicyId);
				if (policy === undefined) {
					return {
						issue: "Review View references a missing Visibility Policy.",
						path: ["views"]
					};
				}
				const overrides = view.visibilityOverrides;
				if (
					overrides !== undefined &&
					(overrides.hideInClear.length > 0 || overrides.neverHide.length > 0) &&
					policy.output.mode === "natural_only"
				) {
					return {
						issue: "Natural-only policy cannot carry Clear visibility overrides.",
						path: ["views"]
					};
				}
				if (
					policy.output.mode === "natural_and_clear" &&
					policy.output.clearStrategy.type === "hide_explicit" &&
					(overrides === undefined || overrides.hideInClear.length === 0)
				) {
					return {
						issue: "Explicit-hide Clear policy requires at least one Hide in Clear object.",
						path: ["views"]
					};
				}
				if (view.target.kind === "oriented_box" && policy.output.mode !== "natural_only") {
					return {
						issue: "Area Views support Natural-only visibility in this version.",
						path: ["views"]
					};
				}
			}
			return undefined;
		})
	)
);

const LegacyCaptureProfile = Schema.Struct({
	id: CaptureProfileId,
	imageFormat: Schema.Literal("png"),
	renderProfile: Schema.Literal("full_fidelity"),
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	variantPolicy: Schema.Literal("pure_only")
});

const LegacyReviewView = Schema.Struct({
	approvedPose: ApprovedPose,
	captureProfileId: CaptureProfileId,
	displayName: NonEmptyString,
	framingDiagnostics: Schema.optional(Schema.Array(FramingDiagnostic)),
	framingRecipe: FramingRecipe,
	id: ReviewViewId,
	purpose: NonEmptyString,
	subject: ActorPathSubjectLocator,
	tags: Schema.Array(NonEmptyString)
});

const LegacyReviewSet = Schema.Struct({
	captureProfiles: Schema.Array(LegacyCaptureProfile).check(Schema.isMinLength(1)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	description: Schema.optional(NonEmptyString),
	displayName: NonEmptyString,
	id: ReviewSetId,
	project: Schema.Struct({
		id: NonEmptyString,
		mapPath: NonEmptyString
	}),
	views: Schema.Array(LegacyReviewView)
});

/**
 * Creates the default automatic-assessment, natural-only policy that records low visibility.
 * This pure helper does not require clear companions or impose a project-wide failure
 * threshold.
 */
export function defaultNaturalOnlyVisibilityPolicy(): VisibilityPolicy {
	return VisibilityPolicy.make({
		assessment: { method: "automatic" },
		id: VisibilityPolicyId.make("default-natural-only"),
		name: "Default Natural-only",
		onLowVisibility: { action: "record" },
		output: { mode: "natural_only" }
	});
}

/**
 * Creates numbered revision one with an ID derived from the view ID. Use revision updates
 * after definition changes rather than reinitializing an existing approved view.
 */
export function initialReviewViewRevision(viewId: ReviewViewId): NumberedReviewViewRevision {
	return NumberedReviewViewRevision.make({
		id: ReviewViewRevisionId.make(`${viewId}-r1`),
		number: 1,
		status: "numbered"
	});
}

/** Creates the next immutable history boundary for a deliberately revised Review View. */
export function nextReviewViewRevision(
	viewId: ReviewViewId,
	previous: NumberedReviewViewRevision
): NumberedReviewViewRevision {
	const number = previous.number + 1;
	return NumberedReviewViewRevision.make({
		id: ReviewViewRevisionId.make(`${viewId}-r${number}`),
		number,
		status: "numbered"
	});
}

function migrateLegacyReviewSet(legacy: Schema.Schema.Type<typeof LegacyReviewSet>): ReviewSet {
	const policy = defaultNaturalOnlyVisibilityPolicy();
	return ReviewSetCurrent.make({
		captureProfiles: legacy.captureProfiles.map(
			({ variantPolicy: _variantPolicy, ...profile }) => CaptureProfile.make(profile)
		),
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 2 } },
		...(legacy.description === undefined ? undefined : { description: legacy.description }),
		displayName: legacy.displayName,
		id: legacy.id,
		project: legacy.project,
		views: legacy.views.map((view) =>
			ReviewView.make({
				captureProfileId: view.captureProfileId,
				displayName: view.displayName,
				...(view.framingDiagnostics === undefined
					? undefined
					: { framingDiagnostics: view.framingDiagnostics }),
				framingRecipe: view.framingRecipe,
				id: view.id,
				purpose: view.purpose,
				revision: initialReviewViewRevision(view.id),
				tags: view.tags,
				target: { kind: "actor", subject: view.subject },
				viewpoint: { approvedPose: view.approvedPose, kind: "world_fixed" },
				visibilityPolicyId: policy.id
			})
		),
		visibilityPolicies: [policy]
	});
}

function migratePreviousReviewSet(
	previous: Schema.Schema.Type<typeof PreviousReviewSet>
): ReviewSet {
	return ReviewSetCurrent.make({
		...previous,
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 2 } },
		views: previous.views.map((view) => ReviewView.make(view))
	});
}

/**
 * Current persisted review-set contract with map, approved views and referenced
 * policies/profiles. Load historical documents through the migration parser rather than
 * assuming every saved file is current.
 */
export const ReviewSet = ReviewSetCurrent;
export type ReviewSet = Schema.Schema.Type<typeof ReviewSet>;

const ReviewSetContractHeader = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Union([
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(1) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(2) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(3) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(4) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(5) })
		])
	})
});

type DecodedReviewSet =
	| { readonly migrated: false; readonly reviewSet: ReviewSet }
	| { readonly migrated: true; readonly reviewSet: ReviewSet };

/**
 * Validates supported review-set versions and migrates legacy definitions to the current
 * model, returning an explicit migrated flag. Fails with ContractParseError on invalid/unsupported
 * evidence and performs no file write.
 */
export function decodeReviewSetWithMigration<Input>(input: Input) {
	return Schema.decodeUnknownEffect(ReviewSetContractHeader)(input).pipe(
		Effect.flatMap(({ contract }) => {
			if (contract.version.minor >= 2) {
				return Schema.decodeUnknownEffect(ReviewSetCurrent)(input).pipe(
					Effect.map((reviewSet): DecodedReviewSet => ({ migrated: false, reviewSet }))
				);
			}
			if (contract.version.minor === 1) {
				return Schema.decodeUnknownEffect(PreviousReviewSet)(input).pipe(
					Effect.map(
						(reviewSet): DecodedReviewSet => ({
							migrated: true as const,
							reviewSet: migratePreviousReviewSet(reviewSet)
						})
					)
				);
			}
			return Schema.decodeUnknownEffect(LegacyReviewSet)(input).pipe(
				Effect.map(
					(reviewSet): DecodedReviewSet => ({
						migrated: true as const,
						reviewSet: migrateLegacyReviewSet(reviewSet)
					})
				)
			);
		}),
		Effect.mapError((cause) => contractParseError("ReviewSet", cause))
	);
}

const ClearCompanionNotRequested = Schema.Struct({
	status: Schema.Literal("not_requested")
});

const ClearCompanionIsolateTargetRequest = Schema.Struct({
	status: Schema.Literal("requested"),
	strategy: Schema.Literal("isolate_target")
});

const ClearCompanionHideExplicitRequest = Schema.Struct({
	actors: Schema.Array(ReviewSubjectActorPath).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(32)
	),
	status: Schema.Literal("requested"),
	strategy: Schema.Literal("hide_explicit")
}).pipe(
	Schema.check(
		Schema.makeFilter((request) =>
			new Set(request.actors).size === request.actors.length
				? undefined
				: {
						issue: "Explicit Clear actors must be unique.",
						path: ["actors"]
					}
		)
	)
);

/**
 * The cross-language instruction for one optional Clear companion. It contains only what the
 * Unreal producer needs to render the companion; consumer-owned policy and thresholds stay out
 * of this request.
 */
export const ReviewClearCompanionRequest = Schema.Union([
	ClearCompanionNotRequested,
	ClearCompanionIsolateTargetRequest,
	ClearCompanionHideExplicitRequest
]);
export type ReviewClearCompanionRequest = Schema.Schema.Type<typeof ReviewClearCompanionRequest>;

const ReviewCaptureRequestLegacy = Schema.Struct({
	approvedPose: ApprovedPose,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
		})
	}),
	expectedMapPath: NonEmptyString,
	operationId: ReviewCaptureOperationId,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: ActorPathSubjectLocator,
	viewId: ReviewViewId
});

/**
 * Current correlated review-capture request with map, subject, viewpoint, assessment and
 * bounded resolution. Version-specific render/visibility fields must agree with the contract
 * minor version.
 */
export const ReviewCaptureRequestCurrent = Schema.Struct({
	authoredVisibility: Schema.optionalKey(CameraAuthoredVisibility),
	renderPolicy: Schema.optionalKey(CameraRenderPolicy),
	assessment: VisibilityAssessment,
	clearCompanion: ReviewClearCompanionRequest,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([5, 6, 7]) })
	}),
	expectedMapPath: NonEmptyString,
	operationId: ReviewCaptureOperationId,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: ReviewCaptureSubject,
	viewId: ReviewViewId,
	viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint])
}).pipe(
	Schema.check(
		Schema.makeFilter((request) =>
			request.contract.version.minor >= 6 === (request.renderPolicy !== undefined) &&
			(request.authoredVisibility === undefined || request.contract.version.minor === 7) &&
			request.renderPolicy?.visibility === undefined &&
			(!request.authoredVisibility || request.clearCompanion.status === "not_requested")
				? undefined
				: {
						issue: "Capture 1.6 requires renderPolicy; older capture versions cannot carry it.",
						path: ["renderPolicy"]
					}
		),
		Schema.makeFilter((request) =>
			request.subject.kind === "oriented_bounds"
				? request.viewpoint.kind === "target_relative"
					? {
							issue: "Oriented bounds cannot use a target-relative capture viewpoint.",
							path: ["viewpoint"]
						}
					: request.clearCompanion.status === "requested"
						? {
								issue: "Oriented bounds support Natural-only capture in this version.",
								path: ["clearCompanion"]
							}
						: undefined
				: undefined
		)
	)
);

const ReviewCaptureRequestClearPrevious = Schema.Struct({
	assessment: VisibilityAssessment,
	clearCompanion: ReviewClearCompanionRequest,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(4) })
	}),
	expectedMapPath: NonEmptyString,
	operationId: ReviewCaptureOperationId,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: ReviewCaptureSubjectPrevious,
	viewId: ReviewViewId,
	viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint])
}).pipe(
	Schema.check(
		Schema.makeFilter((request) =>
			request.subject.kind === "oriented_bounds"
				? request.viewpoint.kind === "target_relative"
					? {
							issue: "Oriented bounds cannot use a target-relative capture viewpoint.",
							path: ["viewpoint"]
						}
					: request.clearCompanion.status === "requested"
						? {
								issue: "Oriented bounds support Natural-only capture in this version.",
								path: ["clearCompanion"]
							}
						: undefined
				: undefined
		)
	)
);

const ReviewCaptureRequestPreviousCurrent = Schema.Struct({
	assessment: VisibilityAssessment,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(3) })
	}),
	expectedMapPath: NonEmptyString,
	operationId: ReviewCaptureOperationId,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: ReviewCaptureSubjectPrevious,
	viewId: ReviewViewId,
	viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint])
}).pipe(
	Schema.check(
		Schema.makeFilter((request) =>
			request.subject.kind === "oriented_bounds" &&
			request.viewpoint.kind === "target_relative"
				? {
						issue: "Oriented bounds cannot use a target-relative capture viewpoint.",
						path: ["viewpoint"]
					}
				: undefined
		)
	)
);

const ReviewCaptureRequestPrevious = Schema.Struct({
	assessment: VisibilityAssessment,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(2) })
	}),
	expectedMapPath: NonEmptyString,
	operationId: ReviewCaptureOperationId,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: ReviewCaptureSubjectPrevious,
	viewId: ReviewViewId,
	viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint])
}).pipe(
	Schema.check(
		Schema.makeFilter((request) =>
			request.subject.kind === "oriented_bounds" &&
			request.viewpoint.kind === "target_relative"
				? {
						issue: "Oriented bounds cannot use a target-relative capture viewpoint.",
						path: ["viewpoint"]
					}
				: undefined
		)
	)
);

/**
 * Supported current and legacy review-capture wire requests. Strict parsing rejects
 * incompatible extra fields; compatibility support does not imply every legacy request has
 * current fidelity evidence.
 */
export const ReviewCaptureRequest = Schema.Union([
	ReviewCaptureRequestCurrent,
	ReviewCaptureRequestClearPrevious,
	ReviewCaptureRequestPreviousCurrent,
	ReviewCaptureRequestPrevious,
	ReviewCaptureRequestLegacy
]);
export type ReviewCaptureRequest = Schema.Schema.Type<typeof ReviewCaptureRequest>;

const ReviewCaptureSuccessLegacy = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
		})
	}),
	height: PositiveInteger,
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	stagingPath: NonEmptyString,
	status: Schema.Literal("captured"),
	subjectProjection: Schema.optional(ReviewSubjectProjection),
	viewId: ReviewViewId,
	width: PositiveInteger
});

/**
 * Actor-path subject realized against the editor world, including its observed transform.
 * Retain realization separately from the authored locator for historical comparisons.
 */
export const ResolvedActorSubject = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	kind: Schema.Literal("actor_path"),
	transform: ActorTransformSnapshot
});
export type ResolvedActorSubject = Schema.Schema.Type<typeof ResolvedActorSubject>;

/**
 * GUID subject resolved to its current object path and transform. The durable GUID remains
 * the identity when the transient world path changes.
 */
export const ResolvedActorGuidSubject = Schema.Struct({
	actorGuid: ReviewSubjectActorGuid,
	actorPath: ReviewSubjectActorPath,
	kind: Schema.Literal("actor_guid"),
	transform: ActorTransformSnapshot
});
export type ResolvedActorGuidSubject = Schema.Schema.Type<typeof ResolvedActorGuidSubject>;

const ResolvedReviewSubjectPrevious = Schema.Union([ResolvedActorSubject, OrientedBoundsSubject]);

/**
 * Resolved actor/area or explicit unresolved-actor evidence. A missing subject remains
 * distinguishable from a successfully captured empty area.
 */
export const ResolvedReviewSubject = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("unresolved_actor"),
		subject: SubjectLocator,
		reason: NonEmptyString
	}),
	ResolvedActorGuidSubject,
	ResolvedActorSubject,
	OrientedBoundsSubject
]);
export type ResolvedReviewSubject = Schema.Schema.Type<typeof ResolvedReviewSubject>;

const StagedCaptureArtifact = Schema.Struct({
	stagingPath: NonEmptyString,
	variant: Schema.Literals(["pure", "clear", "authored"])
});

function stagedArtifactVariantIssue(response: {
	readonly stagedArtifacts: ReadonlyArray<Schema.Schema.Type<typeof StagedCaptureArtifact>>;
	readonly authoredVisibility?: typeof CameraAuthoredVisibility.Type;
}) {
	const variants = new Set<string>();
	for (const artifact of response.stagedArtifacts) {
		if (variants.has(artifact.variant)) {
			return {
				issue: "A capture response may contain only one staged artifact of each variant.",
				path: ["stagedArtifacts"]
			};
		}
		variants.add(artifact.variant);
	}
	if (response.authoredVisibility) {
		const output = response.authoredVisibility.output;
		const expected =
			output === "natural_only"
				? ["pure"]
				: output === "authored_only"
					? ["authored"]
					: ["pure", "authored"];
		return expected.length === variants.size &&
			expected.every((variant) => variants.has(variant))
			? undefined
			: {
					issue: "Artifacts must exactly match authored visibility output.",
					path: ["stagedArtifacts"]
				};
	}
	return variants.has("pure") && !variants.has("authored")
		? undefined
		: {
				issue: "A capture response must retain its staged Pure artifact.",
				path: ["stagedArtifacts"]
			};
}

const ClearIntervention = Schema.Union([
	Schema.Struct({
		subject: ObjectLocator,
		type: Schema.Literal("show_only_subject_components")
	}),
	Schema.Struct({
		target: ObjectLocator,
		type: Schema.Literal("hide_actor_components")
	})
]);

const ClearRestorationRestored = Schema.Struct({
	method: Schema.Literal("transient_capture_component_lists"),
	status: Schema.Literal("restored")
});

const ClearRestorationFailed = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	recovery: NonEmptyString,
	status: Schema.Literal("failed")
});

const ClearRestoration = Schema.Union([ClearRestorationRestored, ClearRestorationFailed]);

const ClearCompanionFailure = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean
});

const ClearCompanionCaptured = Schema.Struct({
	interventions: Schema.Array(ClearIntervention).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(32)
	),
	restoration: ClearRestorationRestored,
	status: Schema.Literal("captured"),
	strategy: Schema.Literals(["isolate_target", "hide_explicit"])
});

const ClearCompanionFailed = Schema.Struct({
	failure: ClearCompanionFailure,
	interventions: Schema.Array(ClearIntervention).check(Schema.isMaxLength(32)),
	restoration: ClearRestoration,
	status: Schema.Literal("failed"),
	strategy: Schema.Literals(["isolate_target", "hide_explicit"])
}).pipe(
	Schema.check(
		Schema.makeFilter((companion) =>
			companion.restoration.status === "failed" &&
			companion.failure.code !== "clear_restoration_failed"
				? {
						issue: "A failed Clear restoration must report clear_restoration_failed.",
						path: ["failure", "code"]
					}
				: undefined
		)
	)
);

/**
 * Clear companion not requested, captured or failed, with its own realization evidence. A
 * companion failure does not erase the naturally captured frame.
 */
export const ClearCompanionResult = Schema.Union([
	ClearCompanionNotRequested,
	ClearCompanionCaptured,
	ClearCompanionFailed
]);
export type ClearCompanionResult = Schema.Schema.Type<typeof ClearCompanionResult>;

const ReviewCaptureSuccessCurrent = Schema.Struct({
	authoredVisibility: Schema.optionalKey(CameraAuthoredVisibility),
	authoredEvidence: Schema.optionalKey(CameraFrameEvidence),
	renderEvidence: Schema.optionalKey(CameraFrameEvidence),
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	clearCompanion: ClearCompanionResult,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([5, 6, 7]) })
	}),
	effectiveWorldPose: ApprovedPose,
	height: PositiveInteger,
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	resolvedSubject: ResolvedReviewSubject,
	stagedArtifacts: Schema.Array(StagedCaptureArtifact).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(2)
	),
	status: Schema.Literal("captured"),
	subjectProjection: Schema.optionalKey(ReviewSubjectProjection),
	viewId: ReviewViewId,
	visibility: VisibilityMeasurement,
	width: PositiveInteger
}).pipe(
	Schema.check(
		Schema.makeFilter((response) => {
			if (
				response.contract.version.minor === 5 &&
				(response.subjectProjection === undefined ||
					response.resolvedSubject.kind === "unresolved_actor" ||
					response.renderEvidence !== undefined)
			)
				return {
					issue: "Capture 1.5 requires resolved subject evidence and cannot contain renderer evidence.",
					path: []
				};
			if (
				(response.authoredVisibility !== undefined ||
					response.authoredEvidence !== undefined) &&
				response.contract.version.minor < 7
			)
				return { issue: "Authored output requires Capture 1.7.", path: ["contract"] };
			if (response.contract.version.minor >= 6 && response.renderEvidence === undefined)
				return {
					issue: "Capture 1.6 requires renderer evidence.",
					path: ["renderEvidence"]
				};
			if (
				response.stagedArtifacts.some((artifact) => artifact.variant === "authored") !==
				(response.authoredEvidence !== undefined)
			)
				return {
					issue: "Authored artifacts require their own renderer evidence.",
					path: ["authoredEvidence"]
				};
			if (
				response.authoredEvidence &&
				(JSON.stringify(response.authoredEvidence.policy.visibility) !==
					JSON.stringify(response.authoredVisibility?.actors) ||
					response.authoredEvidence.visibilityDiagnostics?.some(
						(entry) => entry.status !== "resolved"
					))
			)
				return {
					issue: "Authored renderer evidence must confirm the saved visibility policy without unresolved exclusions.",
					path: ["authoredEvidence"]
				};
			if (
				response.stagedArtifacts.some((artifact) => artifact.variant === "pure") &&
				response.renderEvidence?.policy.visibility !== undefined
			)
				return {
					issue: "Pure evidence cannot contain authored exclusions.",
					path: ["renderEvidence"]
				};
			const issue = stagedArtifactVariantIssue(response);
			if (issue !== undefined) return issue;
			const hasClearArtifact = response.stagedArtifacts.some(
				(artifact) => artifact.variant === "clear"
			);
			return response.clearCompanion.status === "captured" && !hasClearArtifact
				? {
						issue: "A captured Clear companion requires a staged Clear artifact.",
						path: ["stagedArtifacts"]
					}
				: response.clearCompanion.status !== "captured" && hasClearArtifact
					? {
							issue: "Only a captured Clear companion may expose a staged Clear artifact.",
							path: ["stagedArtifacts"]
						}
					: undefined;
		})
	)
);

const ReviewCaptureSuccessClearPrevious = Schema.Struct({
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	clearCompanion: ClearCompanionResult,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(4) })
	}),
	effectiveWorldPose: ApprovedPose,
	height: PositiveInteger,
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	resolvedSubject: ResolvedReviewSubjectPrevious,
	stagedArtifacts: Schema.Array(StagedCaptureArtifact).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(2)
	),
	status: Schema.Literal("captured"),
	subjectProjection: ReviewSubjectProjection,
	viewId: ReviewViewId,
	visibility: VisibilityMeasurement,
	width: PositiveInteger
}).pipe(
	Schema.check(
		Schema.makeFilter((response) => {
			const issue = stagedArtifactVariantIssue(response);
			if (issue !== undefined) return issue;
			const hasClearArtifact = response.stagedArtifacts.some(
				(artifact) => artifact.variant === "clear"
			);
			return response.clearCompanion.status === "captured" && !hasClearArtifact
				? {
						issue: "A captured Clear companion requires a staged Clear artifact.",
						path: ["stagedArtifacts"]
					}
				: response.clearCompanion.status !== "captured" && hasClearArtifact
					? {
							issue: "Only a captured Clear companion may expose a staged Clear artifact.",
							path: ["stagedArtifacts"]
						}
					: undefined;
		})
	)
);

const ReviewCaptureSuccessPreviousCurrent = Schema.Struct({
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(3) })
	}),
	effectiveWorldPose: ApprovedPose,
	height: PositiveInteger,
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	resolvedSubject: ResolvedReviewSubjectPrevious,
	stagingPath: NonEmptyString,
	status: Schema.Literal("captured"),
	subjectProjection: ReviewSubjectProjection,
	viewId: ReviewViewId,
	visibility: VisibilityMeasurement,
	width: PositiveInteger
});

const ReviewCaptureSuccessPrevious = Schema.Struct({
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(2) })
	}),
	effectiveWorldPose: ApprovedPose,
	height: PositiveInteger,
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	resolvedSubject: ResolvedReviewSubjectPrevious,
	stagingPath: NonEmptyString,
	status: Schema.Literal("captured"),
	subjectProjection: ReviewSubjectProjection,
	viewId: ReviewViewId,
	visibility: LegacyClassifiedVisibilityResult,
	width: PositiveInteger
});

const ReviewCaptureFailure = Schema.Struct({
	code: NonEmptyString,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))
		})
	}),
	message: NonEmptyString,
	operationId: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed"),
	viewId: ReviewViewId
});

/**
 * Supported review-capture success versions or explicit failure. Preserve per-version
 * fidelity and restoration evidence rather than assuming legacy replies recorded current
 * measurements.
 */
export const ReviewCaptureResponse = Schema.Union([
	ReviewCaptureSuccessCurrent,
	ReviewCaptureSuccessClearPrevious,
	ReviewCaptureSuccessPreviousCurrent,
	ReviewCaptureSuccessPrevious,
	ReviewCaptureSuccessLegacy,
	ReviewCaptureFailure
]);
export type ReviewCaptureResponse = Schema.Schema.Type<typeof ReviewCaptureResponse>;

/**
 * Observed editor projection/render evidence for a framing candidate at a recorded time. It
 * supplements the generated pose and can reveal current-world drift before approval.
 */
export const ReviewCandidateRealization = Schema.Struct({
	renderEvidence: Schema.optionalKey(CameraFrameEvidence),
	candidateId: FramingCandidateId,
	diagnostics: Schema.Array(FramingDiagnostic),
	projection: ReviewSubjectProjection,
	recordedAt: Schema.String
});
export type ReviewCandidateRealization = Schema.Schema.Type<typeof ReviewCandidateRealization>;

/**
 * Persisted candidate-authoring state with review-set/subject evidence, selection, overrides
 * and realizations. Lifecycle records active, stale, approved or discarded instead of
 * inferring readiness from file existence.
 */
export const ReviewAuthoringSession = Schema.Struct({
	candidates: Schema.Array(FramingCandidate).check(Schema.isMinLength(1)),
	candidateOverrides: Schema.optional(Schema.Array(FramingCandidateOverride)),
	pendingReviewSet: Schema.optional(ReviewSet),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-authoring-session"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	createdAt: Schema.String,
	diagnostics: Schema.Array(FramingDiagnostic),
	discardedCandidateIds: Schema.Array(FramingCandidateId),
	draftPose: Schema.optional(ApprovedPose),
	framingParameters: Schema.optional(FramingParameters),
	id: ReviewAuthoringSessionId,
	lifecycle: Schema.Literals(["active", "stale", "approved", "discarded"]),
	manualReason: Schema.optional(Schema.String),
	realizations: Schema.Array(ReviewCandidateRealization),
	reviewSet: Schema.Struct({
		id: ReviewSetId,
		mapPath: NonEmptyString,
		path: NonEmptyString
	}),
	selectedCandidateId: Schema.optional(FramingCandidateId),
	subject: Schema.Struct({
		actorGuid: Schema.optional(ReviewSubjectActorGuid),
		actorPath: ReviewSubjectActorPath,
		bounds: SubjectBounds,
		displayName: NonEmptyString,
		mapPath: NonEmptyString
	}),
	updatedAt: Schema.String,
	viewId: ReviewViewId
});
export type ReviewAuthoringSession = Schema.Schema.Type<typeof ReviewAuthoringSession>;

/**
 * Explicit candidate selection/discards, framing overrides and draft-pose/reason changes for
 * an authoring session. Updating a draft does not by itself approve or capture a review view.
 */
export const ReviewAuthoringSessionPatch = Schema.Struct({
	candidateOverrides: Schema.optional(Schema.Array(FramingCandidateOverride)),
	discardedCandidateIds: Schema.Array(FramingCandidateId),
	draftPose: Schema.optional(ApprovedPose),
	framingParameters: Schema.optional(FramingParameters),
	manualReason: Schema.String,
	selectedCandidateId: Schema.optional(FramingCandidateId)
});
export type ReviewAuthoringSessionPatch = Schema.Schema.Type<typeof ReviewAuthoringSessionPatch>;

/**
 * Resumable, stale, missing-review-set or corrupt recovery outcome. Stale sessions retain
 * reasons and evidence; hosts must reconcile them before approving an old candidate.
 */
export const ReviewAuthoringSessionRecovery = Schema.Union([
	Schema.Struct({ status: Schema.Literal("resumable"), session: ReviewAuthoringSession }),
	Schema.Struct({
		recovery: NonEmptyString,
		reasons: Schema.Array(
			Schema.Literals([
				"actor_missing",
				"bounds_changed",
				"map_changed",
				"review_set_missing",
				"review_set_changed"
			])
		).check(Schema.isMinLength(1)),
		session: ReviewAuthoringSession,
		status: Schema.Literal("stale")
	}),
	Schema.Struct({
		path: NonEmptyString,
		recovery: NonEmptyString,
		status: Schema.Literal("missing_review_set")
	}),
	Schema.Struct({
		message: NonEmptyString,
		path: NonEmptyString,
		recovery: NonEmptyString,
		status: Schema.Literal("corrupt")
	})
]);
export type ReviewAuthoringSessionRecovery = Schema.Schema.Type<
	typeof ReviewAuthoringSessionRecovery
>;

/**
 * Saved PNG identity, relative path, SHA-256 hash, dimensions and pure/clear/authored
 * variant. Repository ingestion verifies source ownership and bytes before treating it as
 * trusted history.
 */
export const CaptureArtifact = Schema.Struct({
	byteLength: NonNegativeInteger,
	contentHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
	height: PositiveInteger,
	id: ArtifactId,
	mediaType: Schema.Literal("image/png"),
	relativePath: SafeRelativePath,
	variant: Schema.Literals(["pure", "clear", "authored"]),
	width: PositiveInteger
});
export type CaptureArtifact = Schema.Schema.Type<typeof CaptureArtifact>;

/**
 * Effective world pose/subject evidence for current captures or explicit legacy_not_recorded
 * provenance. Migration does not invent a pose that older captures never recorded.
 */
export const CaptureRealization = Schema.Union([
	Schema.Struct({
		effectiveWorldPose: ApprovedPose,
		resolvedSubject: ResolvedReviewSubject,
		status: Schema.Literal("resolved"),
		viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint])
	}),
	Schema.Struct({
		resolvedActorPath: Schema.optional(NonEmptyString),
		status: Schema.Literal("legacy_not_recorded")
	})
]);
export type CaptureRealization = Schema.Schema.Type<typeof CaptureRealization>;

const CaptureRealizationPrevious = Schema.Union([
	Schema.Struct({
		effectiveWorldPose: ApprovedPose,
		resolvedSubject: ResolvedReviewSubjectPrevious,
		status: Schema.Literal("resolved"),
		viewpoint: Schema.Union([WorldFixedViewpoint, TargetRelativeViewpoint])
	}),
	Schema.Struct({
		resolvedActorPath: Schema.optional(NonEmptyString),
		status: Schema.Literal("legacy_not_recorded")
	})
]);

function capturedArtifactVariantIssue(result: {
	readonly artifacts: ReadonlyArray<CaptureArtifact>;
	readonly authoredVisibility?: typeof CameraAuthoredVisibility.Type;
	readonly authoredEvidence?: typeof CameraFrameEvidence.Type;
}) {
	if (
		result.authoredVisibility &&
		result.artifacts.some((artifact) => artifact.variant === "authored") &&
		(!result.authoredEvidence ||
			JSON.stringify(result.authoredEvidence.policy.visibility) !==
				JSON.stringify(result.authoredVisibility.actors))
	)
		return {
			issue: "Saved Authored artifacts require matching renderer visibility evidence.",
			path: ["authoredEvidence"]
		};
	if (result.authoredVisibility)
		return stagedArtifactVariantIssue({
			stagedArtifacts: result.artifacts.map((artifact) => ({
				variant: artifact.variant,
				stagingPath: artifact.relativePath
			})),
			authoredVisibility: result.authoredVisibility
		});
	const variants = new Set<string>();
	for (const artifact of result.artifacts) {
		if (variants.has(artifact.variant)) {
			return {
				issue: "A View Result may contain only one artifact of each variant.",
				path: ["artifacts"]
			};
		}
		variants.add(artifact.variant);
	}
	return variants.has("pure") && !variants.has("authored")
		? undefined
		: {
				issue: "A captured View Result must retain its Pure artifact.",
				path: ["artifacts"]
			};
}

const CapturedViewResult = Schema.Struct({
	authoredVisibility: Schema.optionalKey(CameraAuthoredVisibility),
	authoredEvidence: Schema.optionalKey(CameraFrameEvidence),
	renderEvidence: Schema.optionalKey(CameraFrameEvidence),
	artifacts: Schema.Array(CaptureArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	clearCompanion: ClearCompanionResult,
	realization: CaptureRealization,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId,
	viewRevision: CapturedReviewViewRevision,
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicy: Schema.optional(VisibilityPolicy),
	visibility: VisibilityResult
}).pipe(Schema.check(Schema.makeFilter(capturedArtifactVariantIssue)));

const FailedViewResult = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed"),
	viewId: ReviewViewId,
	viewRevision: CapturedReviewViewRevision
});

/**
 * Captured or failed result for one requested review view. Batch capture can retain
 * successful views alongside failures rather than discarding the whole run.
 */
export const ViewResult = Schema.Union([CapturedViewResult, FailedViewResult]);
export type ViewResult = Schema.Schema.Type<typeof ViewResult>;

const CaptureRunCurrent = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([5, 6, 7]) })
	}),
	id: CaptureRunId,
	invocation: CaptureInvocation,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(ViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
}).check(
	Schema.makeFilter((run) =>
		run.contract.version.minor < 7 &&
		run.results.some(
			(result) => result.status === "captured" && result.authoredVisibility !== undefined
		)
			? "Authored results require Capture Run 1.7."
			: undefined
	)
);

const PreviousClearCapturedViewResult = Schema.Struct({
	artifacts: Schema.Array(CaptureArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	clearCompanion: ClearCompanionResult,
	realization: CaptureRealizationPrevious,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId,
	viewRevision: CapturedReviewViewRevision,
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicy: Schema.optional(VisibilityPolicy),
	visibility: VisibilityResult
}).pipe(Schema.check(Schema.makeFilter(capturedArtifactVariantIssue)));

const PreviousClearViewResult = Schema.Union([PreviousClearCapturedViewResult, FailedViewResult]);

const PreviousClearCaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(4) })
	}),
	id: CaptureRunId,
	invocation: CaptureInvocation,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(PreviousClearViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});

const PreviousCurrentCapturedViewResult = Schema.Struct({
	artifacts: Schema.Array(CaptureArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	realization: CaptureRealizationPrevious,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId,
	viewRevision: CapturedReviewViewRevision,
	visibility: VisibilityResult
}).pipe(Schema.check(Schema.makeFilter(capturedArtifactVariantIssue)));

const PreviousCurrentViewResult = Schema.Union([
	PreviousCurrentCapturedViewResult,
	FailedViewResult
]);

const PreviousCurrentCaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(3) })
	}),
	id: CaptureRunId,
	invocation: CaptureInvocation,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(PreviousCurrentViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});

const PreviousCapturedViewResult = Schema.Struct({
	artifacts: Schema.Array(CaptureArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	realization: CaptureRealizationPrevious,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId,
	viewRevision: CapturedReviewViewRevision,
	visibility: LegacyClassifiedVisibilityResult
}).pipe(Schema.check(Schema.makeFilter(capturedArtifactVariantIssue)));

const PreviousViewResult = Schema.Union([PreviousCapturedViewResult, FailedViewResult]);

const PreviousCaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(2) })
	}),
	id: CaptureRunId,
	invocation: CaptureInvocation,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(PreviousViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});

const PreviousLegacyCapturedViewResult = Schema.Struct({
	artifacts: Schema.Array(CaptureArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	resolvedActorPath: NonEmptyString,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId,
	viewRevision: CapturedReviewViewRevision,
	visibility: LegacyClassifiedVisibilityResult
});

const PreviousLegacyViewResult = Schema.Union([PreviousLegacyCapturedViewResult, FailedViewResult]);

const PreviousLegacyCaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(1) })
	}),
	id: CaptureRunId,
	invocation: CaptureInvocation,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(PreviousLegacyViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});

const LegacyCaptureArtifact = Schema.Struct({
	byteLength: NonNegativeInteger,
	contentHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
	height: PositiveInteger,
	id: ArtifactId,
	mediaType: Schema.Literal("image/png"),
	relativePath: SafeRelativePath,
	variant: Schema.Literal("pure"),
	width: PositiveInteger
});

const LegacyViewResult = Schema.Union([
	Schema.Struct({
		artifact: LegacyCaptureArtifact,
		captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
		resolvedActorPath: NonEmptyString,
		status: Schema.Literal("captured"),
		viewId: ReviewViewId
	}),
	Schema.Struct({
		code: NonEmptyString,
		message: NonEmptyString,
		recovery: NonEmptyString,
		retrySafe: Schema.Boolean,
		status: Schema.Literal("failed"),
		viewId: ReviewViewId
	})
]);

const LegacyCaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	id: CaptureRunId,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(LegacyViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});

function legacyInvocation(run: Schema.Schema.Type<typeof LegacyCaptureRun>): CaptureInvocation {
	return CaptureInvocation.make({
		cause: { type: "manual" },
		id: CaptureInvocationId.make(`legacy-${run.id}`),
		reviewSetId: run.reviewSetId
	});
}

function migrateLegacyVisibility(
	visibility: Schema.Schema.Type<typeof LegacyClassifiedVisibilityResult>
): VisibilityResult {
	if (visibility.status !== "assessed") return visibility;
	const { classification, ...measurement } = visibility;
	return VisibilityResult.make({
		...measurement,
		legacyInterpretation: {
			classification,
			source: "capture_run_pre_1_3"
		}
	});
}

const noClearCompanion = { status: "not_requested" as const };

function migratePreviousClearCaptureRun(
	previous: Schema.Schema.Type<typeof PreviousClearCaptureRun>
): CaptureRun {
	return CaptureRunCurrent.make({
		...previous,
		contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 5 } }
	});
}

function migratePreviousCurrentCaptureRun(
	previous: Schema.Schema.Type<typeof PreviousCurrentCaptureRun>
): CaptureRun {
	return CaptureRunCurrent.make({
		...previous,
		contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 5 } },
		results: previous.results.map((result) =>
			result.status === "captured" ? { ...result, clearCompanion: noClearCompanion } : result
		)
	});
}

function migratePreviousCaptureRun(
	previous: Schema.Schema.Type<typeof PreviousCaptureRun>
): CaptureRun {
	return CaptureRunCurrent.make({
		...previous,
		contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 5 } },
		results: previous.results.map((result) =>
			result.status === "captured"
				? {
						...result,
						clearCompanion: noClearCompanion,
						visibility: migrateLegacyVisibility(result.visibility)
					}
				: result
		)
	});
}

function migratePreviousLegacyCaptureRun(
	previous: Schema.Schema.Type<typeof PreviousLegacyCaptureRun>
): CaptureRun {
	return CaptureRunCurrent.make({
		...previous,
		contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 5 } },
		results: previous.results.map((result) =>
			result.status === "captured"
				? {
						artifacts: result.artifacts,
						captureDurationMs: result.captureDurationMs,
						clearCompanion: noClearCompanion,
						realization: {
							resolvedActorPath: result.resolvedActorPath,
							status: "legacy_not_recorded" as const
						},
						status: result.status,
						viewId: result.viewId,
						viewRevision: result.viewRevision,
						visibility: migrateLegacyVisibility(result.visibility)
					}
				: result
		)
	});
}

function migrateLegacyCaptureRun(legacy: Schema.Schema.Type<typeof LegacyCaptureRun>): CaptureRun {
	return CaptureRunCurrent.make({
		completedAt: legacy.completedAt,
		contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 5 } },
		id: legacy.id,
		invocation: legacyInvocation(legacy),
		project: legacy.project,
		results: legacy.results.map((result) =>
			result.status === "captured"
				? {
						artifacts: [CaptureArtifact.make(result.artifact)],
						captureDurationMs: result.captureDurationMs,
						clearCompanion: noClearCompanion,
						realization: {
							resolvedActorPath: result.resolvedActorPath,
							status: "legacy_not_recorded" as const
						},
						status: "captured" as const,
						viewId: result.viewId,
						viewRevision: { status: "legacy_unversioned" as const },
						visibility: {
							reason: "Legacy capture completed before visibility assessment was available.",
							status: "not_assessed" as const
						}
					}
				: {
						code: result.code,
						message: result.message,
						recovery: result.recovery,
						retrySafe: result.retrySafe,
						status: "failed" as const,
						viewId: result.viewId,
						viewRevision: { status: "legacy_unversioned" as const }
					}
		),
		reviewSetId: legacy.reviewSetId,
		startedAt: legacy.startedAt,
		status: legacy.status
	});
}

/**
 * Current saved capture-run contract with invocation, view outcomes and artifacts. Historical
 * files require the migration parser so missing legacy evidence remains explicit.
 */
export const CaptureRun = CaptureRunCurrent;
export type CaptureRun = Schema.Schema.Type<typeof CaptureRun>;

/**
 * Validates current or supported historical capture runs and returns the current model plus
 * migrated flag. Invalid evidence fails with ContractParseError; migration preserves unknown legacy
 * realization instead of inventing it.
 */
export function decodeCaptureRunWithMigration<Input>(input: Input) {
	return Schema.decodeUnknownEffect(CaptureRunCurrent)(input).pipe(
		Effect.map((run) => ({ migrated: false as const, run })),
		Effect.catchTag("SchemaError", () =>
			Schema.decodeUnknownEffect(PreviousClearCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousClearCaptureRun(run)
				}))
			)
		),
		Effect.catchTag("SchemaError", () =>
			Schema.decodeUnknownEffect(PreviousCurrentCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousCurrentCaptureRun(run)
				}))
			)
		),
		Effect.catchTag("SchemaError", () =>
			Schema.decodeUnknownEffect(PreviousCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousCaptureRun(run)
				}))
			)
		),
		Effect.catchTag("SchemaError", () =>
			Schema.decodeUnknownEffect(PreviousLegacyCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousLegacyCaptureRun(run)
				}))
			)
		),
		Effect.catchTag("SchemaError", () =>
			Schema.decodeUnknownEffect(LegacyCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migrateLegacyCaptureRun(run)
				}))
			)
		),
		Effect.mapError((cause) => contractParseError("CaptureRun", cause))
	);
}

/**
 * Returns an actor locator for actor-targeted views, otherwise undefined for oriented areas.
 * This pure helper does not resolve the actor in an editor.
 */
export function reviewViewActorSubject(view: ReviewView): SubjectLocator | undefined {
	return view.target.kind === "actor" ? view.target.subject : undefined;
}

/**
 * Returns the authored world-fixed pose, or undefined for target-relative views. Relative
 * views require current subject realization before a world camera pose can be computed.
 */
export function reviewViewApprovedPose(view: ReviewView): ApprovedPose | undefined {
	return view.viewpoint.kind === "world_fixed" ? view.viewpoint.approvedPose : undefined;
}

/**
 * Parses supported review-set versions and returns the normalized current model. Fails with
 * ContractParseError; use decodeReviewSetWithMigration when the caller must know whether persistence
 * should be upgraded.
 */
export const decodeReviewSet = <Input>(input: Input) =>
	decodeReviewSetWithMigration(input).pipe(Effect.map(({ reviewSet }) => reviewSet));
/**
 * Strictly validates a supported review-capture wire request, failing with ContractParseError.
 * Excess fields are rejected so incompatible version-specific policy is not silently ignored.
 */
export const decodeReviewCaptureRequest = <Input>(input: Input) =>
	Schema.decodeUnknownEffect(ReviewCaptureRequest)(input, { onExcessProperty: "error" }).pipe(
		Effect.mapError((cause) => contractParseError("ReviewCaptureRequest", cause))
	);
/**
 * Strictly validates a supported review-capture wire response, failing with ContractParseError. A
 * successfully parsed failed response remains a domain outcome rather than a parser failure.
 */
export const decodeReviewCaptureResponse = <Input>(input: Input) =>
	Schema.decodeUnknownEffect(ReviewCaptureResponse)(input, { onExcessProperty: "error" }).pipe(
		Effect.mapError((cause) => contractParseError("ReviewCaptureResponse", cause))
	);
/**
 * Validates untrusted editor visibility-assessment capabilities. Shape failures return
 * ContractParseError retaining the schema issue; successful failure/stale variants remain
 * ordinary values for the caller to reconcile.
 */
export const decodeReviewAssessmentCapabilities = contractParser(
	ReviewAssessmentCapabilities,
	"ReviewAssessmentCapabilities"
);
/**
 * Validates untrusted editor selection outcome. Shape failures return ContractParseError
 * retaining the schema issue; successful failure/stale variants remain ordinary values for
 * the caller to reconcile.
 */
export const decodeReviewSelectionResponse = contractParser(
	ReviewSelectionResponse,
	"ReviewSelectionResponse"
);
/**
 * Validates untrusted subject inspection outcome. Shape failures return ContractParseError
 * retaining the schema issue; successful failure/stale variants remain ordinary values for
 * the caller to reconcile.
 */
export const decodeReviewSubjectInspectionResponse = contractParser(
	ReviewSubjectInspectionResponse,
	"ReviewSubjectInspectionResponse"
);
/**
 * Validates untrusted candidate approval intent. Shape failures return ContractParseError
 * retaining the schema issue; successful failure/stale variants remain ordinary values for
 * the caller to reconcile.
 */
export const decodeApproveReviewCandidateIntent = contractParser(
	ApproveReviewCandidateIntent,
	"ApproveReviewCandidateIntent"
);
/**
 * Validates untrusted capture invocation/provenance. Shape failures return ContractParseError
 * retaining the schema issue; successful failure/stale variants remain ordinary values for
 * the caller to reconcile.
 */
export const decodeCaptureInvocation = contractParser(CaptureInvocation, "CaptureInvocation");
/**
 * Parses supported capture-run versions and returns the normalized current model. Fails with
 * ContractParseError; use the migration variant when upgrade status is needed.
 */
export const decodeCaptureRun = <Input>(input: Input) =>
	decodeCaptureRunWithMigration(input).pipe(Effect.map(({ run }) => run));
/**
 * Validates untrusted persisted authoring session. Shape failures return ContractParseError
 * retaining the schema issue; successful failure/stale variants remain ordinary values for
 * the caller to reconcile.
 */
export const decodeReviewAuthoringSession = contractParser(
	ReviewAuthoringSession,
	"ReviewAuthoringSession"
);
