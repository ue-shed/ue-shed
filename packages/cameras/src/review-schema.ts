import { Effect, Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SafeIdentifier = NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SafeRevisionIdentifier = NonEmptyString.check(
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/)
);
const SafeRelativePath = NonEmptyString.check(
	Schema.isPattern(/^(?![A-Za-z]:)(?![\\/])(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$)).+$/)
);
const BoundedString = Schema.String.check(Schema.isMaxLength(1_024));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const ReviewSubjectActorPath = Schema.String.check(
	Schema.isMinLength(7),
	Schema.isMaxLength(4_096),
	Schema.isStartsWith("/Game/")
);
export type ReviewSubjectActorPath = Schema.Schema.Type<typeof ReviewSubjectActorPath>;

/**
 * Unreal's durable authored-actor GUID format (`FGuid::UniqueObjectGuid`). Saved-world readers and
 * the editor capability use this exact representation so World Partition actor identity does not
 * depend on the transient live UObject path.
 */
export const ReviewSubjectActorGuid = Schema.String.check(
	Schema.isPattern(/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{8}){3}$/)
).pipe(Schema.brand("ReviewSubjectActorGuid"));
export type ReviewSubjectActorGuid = Schema.Schema.Type<typeof ReviewSubjectActorGuid>;

export const ReviewSetId = SafeIdentifier.pipe(Schema.brand("ReviewSetId"));
export type ReviewSetId = Schema.Schema.Type<typeof ReviewSetId>;

export const ReviewViewId = SafeIdentifier.pipe(Schema.brand("ReviewViewId"));
export type ReviewViewId = Schema.Schema.Type<typeof ReviewViewId>;

/** Explicitly states whether authoring adds a durable observation or revises one already known. */
export const ReviewAuthoringDestination = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("append_view") }),
	Schema.Struct({ kind: Schema.Literal("revise_view"), viewId: ReviewViewId })
]);
export type ReviewAuthoringDestination = Schema.Schema.Type<typeof ReviewAuthoringDestination>;

export const ReviewViewRevisionId = SafeRevisionIdentifier.pipe(
	Schema.brand("ReviewViewRevisionId")
);
export type ReviewViewRevisionId = Schema.Schema.Type<typeof ReviewViewRevisionId>;

export const CaptureProfileId = SafeIdentifier.pipe(Schema.brand("CaptureProfileId"));
export type CaptureProfileId = Schema.Schema.Type<typeof CaptureProfileId>;

export const VisibilityPolicyId = SafeIdentifier.pipe(Schema.brand("VisibilityPolicyId"));
export type VisibilityPolicyId = Schema.Schema.Type<typeof VisibilityPolicyId>;

export const CaptureInvocationId = SafeIdentifier.pipe(Schema.brand("CaptureInvocationId"));
export type CaptureInvocationId = Schema.Schema.Type<typeof CaptureInvocationId>;

export const ProvisionedCameraId = SafeIdentifier.pipe(Schema.brand("ProvisionedCameraId"));
export type ProvisionedCameraId = Schema.Schema.Type<typeof ProvisionedCameraId>;

export const CaptureRunId = SafeIdentifier.pipe(Schema.brand("CaptureRunId"));
export type CaptureRunId = Schema.Schema.Type<typeof CaptureRunId>;

const FramingCandidateIdentifier = NonEmptyString.check(
	Schema.isMaxLength(384),
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
);

export const FramingCandidateId = FramingCandidateIdentifier.pipe(
	Schema.brand("FramingCandidateId")
);
export type FramingCandidateId = Schema.Schema.Type<typeof FramingCandidateId>;

export const FramingGroupId = SafeIdentifier.pipe(Schema.brand("FramingGroupId"));
export type FramingGroupId = Schema.Schema.Type<typeof FramingGroupId>;

export const ReviewAuthoringSessionId = SafeIdentifier.pipe(
	Schema.brand("ReviewAuthoringSessionId")
);
export type ReviewAuthoringSessionId = Schema.Schema.Type<typeof ReviewAuthoringSessionId>;

export const ArtifactId = NonEmptyString.pipe(Schema.brand("ArtifactId"));
export type ArtifactId = Schema.Schema.Type<typeof ArtifactId>;

export const ReviewVector = Schema.Struct({
	x: Schema.Finite,
	y: Schema.Finite,
	z: Schema.Finite
});
export type ReviewVector = Schema.Schema.Type<typeof ReviewVector>;

export const ReviewRotation = Schema.Struct({
	pitch: Schema.Finite,
	roll: Schema.Finite,
	yaw: Schema.Finite
});
export type ReviewRotation = Schema.Schema.Type<typeof ReviewRotation>;

const NonNegativeReviewVector = Schema.Struct({
	x: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	y: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	z: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
});

export const ApprovedPose = Schema.Struct({
	aspectRatio: Schema.Literal("16:9"),
	fieldOfViewDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
	location: ReviewVector,
	projection: Schema.Literal("perspective"),
	rotation: ReviewRotation
});
export type ApprovedPose = Schema.Schema.Type<typeof ApprovedPose>;

export const ActorPathSubjectLocator = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	diagnosticLabel: Schema.optional(NonEmptyString),
	kind: Schema.Literal("actor_path")
});
export type ActorPathSubjectLocator = Schema.Schema.Type<typeof ActorPathSubjectLocator>;

export const ActorGuidSubjectLocator = Schema.Struct({
	actorGuid: ReviewSubjectActorGuid,
	diagnosticLabel: Schema.optional(NonEmptyString),
	kind: Schema.Literal("actor_guid"),
	lastKnownActorPath: Schema.optional(ReviewSubjectActorPath)
});
export type ActorGuidSubjectLocator = Schema.Schema.Type<typeof ActorGuidSubjectLocator>;

export const SubjectLocator = Schema.Union([ActorGuidSubjectLocator, ActorPathSubjectLocator]);
export type SubjectLocator = Schema.Schema.Type<typeof SubjectLocator>;

/** A target-specific actor/component locator reserved for visibility intervention evidence. */
export const ObjectLocator = ActorPathSubjectLocator;
export type ObjectLocator = Schema.Schema.Type<typeof ObjectLocator>;

export const SubjectBounds = Schema.Struct({
	center: ReviewVector,
	extent: NonNegativeReviewVector,
	rotation: ReviewRotation
});
export type SubjectBounds = Schema.Schema.Type<typeof SubjectBounds>;

export const ActorTarget = Schema.Struct({
	kind: Schema.Literal("actor"),
	subject: SubjectLocator
});
export type ActorTarget = Schema.Schema.Type<typeof ActorTarget>;

export const AreaTarget = Schema.Struct({
	bounds: SubjectBounds,
	kind: Schema.Literal("oriented_box")
});
export type AreaTarget = Schema.Schema.Type<typeof AreaTarget>;

export const ReviewTarget = Schema.Union([ActorTarget, AreaTarget]);
export type ReviewTarget = Schema.Schema.Type<typeof ReviewTarget>;

/** Cross-language capture subject for a portable, map-scoped oriented area. */
export const OrientedBoundsSubject = Schema.Struct({
	bounds: SubjectBounds,
	kind: Schema.Literal("oriented_bounds")
});
export type OrientedBoundsSubject = Schema.Schema.Type<typeof OrientedBoundsSubject>;

const ReviewCaptureSubjectPrevious = Schema.Union([ActorPathSubjectLocator, OrientedBoundsSubject]);

export const ReviewCaptureSubject = Schema.Union([SubjectLocator, OrientedBoundsSubject]);
export type ReviewCaptureSubject = Schema.Schema.Type<typeof ReviewCaptureSubject>;

export const ActorTransformSnapshot = Schema.Struct({
	location: ReviewVector,
	rotation: ReviewRotation
});
export type ActorTransformSnapshot = Schema.Schema.Type<typeof ActorTransformSnapshot>;

export const WorldFixedViewpoint = Schema.Struct({
	approvedPose: ApprovedPose,
	kind: Schema.Literal("world_fixed")
});
export type WorldFixedViewpoint = Schema.Schema.Type<typeof WorldFixedViewpoint>;

export const TargetRelativeViewpoint = Schema.Struct({
	kind: Schema.Literal("target_relative"),
	relativePose: ApprovedPose,
	targetSnapshot: ActorTransformSnapshot
});
export type TargetRelativeViewpoint = Schema.Schema.Type<typeof TargetRelativeViewpoint>;

export const ReviewViewDefinition = Schema.Union([
	Schema.Struct({ target: ActorTarget, viewpoint: WorldFixedViewpoint }),
	Schema.Struct({ target: ActorTarget, viewpoint: TargetRelativeViewpoint }),
	Schema.Struct({ target: AreaTarget, viewpoint: WorldFixedViewpoint })
]);
export type ReviewViewDefinition = Schema.Schema.Type<typeof ReviewViewDefinition>;

export const NumberedReviewViewRevision = Schema.Struct({
	id: ReviewViewRevisionId,
	number: PositiveInteger,
	status: Schema.Literal("numbered")
});
export type NumberedReviewViewRevision = Schema.Schema.Type<typeof NumberedReviewViewRevision>;

export const CapturedReviewViewRevision = Schema.Union([
	NumberedReviewViewRevision,
	Schema.Struct({ status: Schema.Literal("legacy_unversioned") })
]);
export type CapturedReviewViewRevision = Schema.Schema.Type<typeof CapturedReviewViewRevision>;

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

export const ArcFramingPattern = Schema.Struct({
	count: PositiveInteger,
	kind: Schema.Literal("arc"),
	spreadDegrees: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	yawOffsetDegrees: Schema.Finite
});
export type ArcFramingPattern = Schema.Schema.Type<typeof ArcFramingPattern>;

export const RingFramingPattern = Schema.Struct({
	count: PositiveInteger,
	kind: Schema.Literal("ring"),
	ringOffsetDegrees: Schema.Finite
});
export type RingFramingPattern = Schema.Schema.Type<typeof RingFramingPattern>;

export const FramingPattern = Schema.Union([ArcFramingPattern, RingFramingPattern]);
export type FramingPattern = Schema.Schema.Type<typeof FramingPattern>;

export const FramingGroup = Schema.Struct({
	displayName: NonEmptyString,
	distanceScale: Schema.Finite.check(Schema.isGreaterThan(0)),
	elevation: Schema.Finite,
	enabled: Schema.Boolean,
	id: FramingGroupId,
	pattern: FramingPattern
});
export type FramingGroup = Schema.Schema.Type<typeof FramingGroup>;

export const FramingParameters = Schema.Struct({
	fieldOfViewDegrees: ApprovedPose.fields.fieldOfViewDegrees,
	groups: Schema.Array(FramingGroup),
	margin: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 }))
});
export type FramingParameters = Schema.Schema.Type<typeof FramingParameters>;

export const FramingCandidateOverrides = Schema.Struct({
	distanceScale: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
	elevation: Schema.optional(Schema.Finite),
	fieldOfViewDegrees: Schema.optional(ApprovedPose.fields.fieldOfViewDegrees),
	margin: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 }))),
	yawOffsetDegrees: Schema.optional(Schema.Finite)
});
export type FramingCandidateOverrides = Schema.Schema.Type<typeof FramingCandidateOverrides>;

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

export const PresetFramingRecipeV1 = Schema.Struct({
	kind: Schema.Literal("preset"),
	margin: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 })),
	manualAdjustment: Schema.optional(Schema.Struct({ reason: NonEmptyString })),
	preset: FramingPreset,
	subjectBounds: SubjectBounds,
	version: Schema.Literal(1)
});

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

export const PresetFramingRecipe = Schema.Union([PresetFramingRecipeV1, PresetFramingRecipeV2]);
export type PresetFramingRecipe = Schema.Schema.Type<typeof PresetFramingRecipe>;

export const FramingRecipe = Schema.Union([ManualFramingRecipe, PresetFramingRecipe]);
export type FramingRecipe = Schema.Schema.Type<typeof FramingRecipe>;

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

const ReviewProjectedBounds = Schema.Struct({
	maxX: Schema.Finite,
	maxY: Schema.Finite,
	minX: Schema.Finite,
	minY: Schema.Finite
});
export type ReviewProjectedBounds = Schema.Schema.Type<typeof ReviewProjectedBounds>;

const ReviewProjectionMargins = Schema.Struct({
	bottom: Schema.Finite,
	left: Schema.Finite,
	right: Schema.Finite,
	top: Schema.Finite
});
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

export const ApproveReviewCandidateIntent = Schema.Struct({
	candidateId: FramingCandidateId,
	candidatePose: ApprovedPose,
	manualPose: Schema.optional(ApprovedPose),
	manualReason: Schema.optional(NonEmptyString),
	sourceActorPath: ReviewSubjectActorPath,
	viewId: ReviewViewId
});
export type ApproveReviewCandidateIntent = Schema.Schema.Type<typeof ApproveReviewCandidateIntent>;

export const CaptureProfile = Schema.Struct({
	id: CaptureProfileId,
	imageFormat: Schema.Literal("png"),
	renderProfile: Schema.Literal("full_fidelity"),
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	})
});
export type CaptureProfile = Schema.Schema.Type<typeof CaptureProfile>;

export const VisibilitySamplePreset = Schema.Literals(["sparse", "standard", "dense"]);
export type VisibilitySamplePreset = Schema.Schema.Type<typeof VisibilitySamplePreset>;

export const ReviewAssessmentMethodName = Schema.Literals([
	"automatic",
	"ray_samples",
	"subject_mask",
	"depth_compare"
]);
export type ReviewAssessmentMethodName = Schema.Schema.Type<typeof ReviewAssessmentMethodName>;

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

export const VisibilityOutput = Schema.Union([
	NaturalOnlyVisibilityOutput,
	NaturalAndClearVisibilityOutput
]);
export type VisibilityOutput = Schema.Schema.Type<typeof VisibilityOutput>;

export const VisibilityLowThresholdAction = Schema.Union([
	Schema.Struct({ action: Schema.Literal("record") }),
	Schema.Struct({ action: Schema.Literal("warn"), threshold: Fraction }),
	Schema.Struct({ action: Schema.Literal("fail"), threshold: Fraction })
]);
export type VisibilityLowThresholdAction = Schema.Schema.Type<typeof VisibilityLowThresholdAction>;

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

export const CaptureInvocation = Schema.Struct({
	cause: CaptureInvocationCause,
	id: CaptureInvocationId,
	reviewSetId: ReviewSetId,
	viewIds: Schema.optional(
		Schema.Array(ReviewViewId).check(Schema.isMinLength(1), Schema.isMaxLength(64))
	)
});
export type CaptureInvocation = Schema.Schema.Type<typeof CaptureInvocation>;

export const OccluderEvidence = Schema.Struct({
	confidence: Fraction,
	locator: ObjectLocator,
	reason: BoundedString
});
export type OccluderEvidence = Schema.Schema.Type<typeof OccluderEvidence>;

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

export const VisibilityMeasurement = Schema.Union([
	VisibilityNotAssessed,
	VisibilityAssessedMeasurement,
	VisibilityAssessmentFailed
]);
export type VisibilityMeasurement = Schema.Schema.Type<typeof VisibilityMeasurement>;

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

export const ReviewView = Schema.Struct({
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
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(2) })
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

export function defaultNaturalOnlyVisibilityPolicy(): VisibilityPolicy {
	return VisibilityPolicy.make({
		assessment: { method: "automatic" },
		id: VisibilityPolicyId.make("default-natural-only"),
		name: "Default Natural-only",
		onLowVisibility: { action: "record" },
		output: { mode: "natural_only" }
	});
}

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

export const ReviewSet = ReviewSetCurrent;
export type ReviewSet = Schema.Schema.Type<typeof ReviewSet>;

const ReviewSetContractHeader = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Union([
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(1) }),
			Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(2) })
		])
	})
});

type DecodedReviewSet =
	| { readonly migrated: false; readonly reviewSet: ReviewSet }
	| { readonly migrated: true; readonly reviewSet: ReviewSet };

export function decodeReviewSetWithMigration<Input>(input: Input) {
	return Schema.decodeUnknownEffect(ReviewSetContractHeader)(input).pipe(
		Effect.flatMap(({ contract }) => {
			if (contract.version.minor === 2) {
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
		})
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
	operationId: NonEmptyString,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: ActorPathSubjectLocator,
	viewId: ReviewViewId
});

export const ReviewCaptureRequestCurrent = Schema.Struct({
	assessment: VisibilityAssessment,
	clearCompanion: ReviewClearCompanionRequest,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(5) })
	}),
	expectedMapPath: NonEmptyString,
	operationId: NonEmptyString,
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
	operationId: NonEmptyString,
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
	operationId: NonEmptyString,
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
	operationId: NonEmptyString,
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

export const ResolvedActorSubject = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	kind: Schema.Literal("actor_path"),
	transform: ActorTransformSnapshot
});
export type ResolvedActorSubject = Schema.Schema.Type<typeof ResolvedActorSubject>;

export const ResolvedActorGuidSubject = Schema.Struct({
	actorGuid: ReviewSubjectActorGuid,
	actorPath: ReviewSubjectActorPath,
	kind: Schema.Literal("actor_guid"),
	transform: ActorTransformSnapshot
});
export type ResolvedActorGuidSubject = Schema.Schema.Type<typeof ResolvedActorGuidSubject>;

const ResolvedReviewSubjectPrevious = Schema.Union([ResolvedActorSubject, OrientedBoundsSubject]);

export const ResolvedReviewSubject = Schema.Union([
	ResolvedActorGuidSubject,
	ResolvedActorSubject,
	OrientedBoundsSubject
]);
export type ResolvedReviewSubject = Schema.Schema.Type<typeof ResolvedReviewSubject>;

const StagedCaptureArtifact = Schema.Struct({
	stagingPath: NonEmptyString,
	variant: Schema.Literals(["pure", "clear"])
});

function stagedArtifactVariantIssue(response: {
	readonly stagedArtifacts: ReadonlyArray<Schema.Schema.Type<typeof StagedCaptureArtifact>>;
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
	return variants.has("pure")
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

export const ClearCompanionResult = Schema.Union([
	ClearCompanionNotRequested,
	ClearCompanionCaptured,
	ClearCompanionFailed
]);
export type ClearCompanionResult = Schema.Schema.Type<typeof ClearCompanionResult>;

const ReviewCaptureSuccessCurrent = Schema.Struct({
	captureDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	clearCompanion: ClearCompanionResult,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(5) })
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
			minor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
		})
	}),
	message: NonEmptyString,
	operationId: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed"),
	viewId: ReviewViewId
});

export const ReviewCaptureResponse = Schema.Union([
	ReviewCaptureSuccessCurrent,
	ReviewCaptureSuccessClearPrevious,
	ReviewCaptureSuccessPreviousCurrent,
	ReviewCaptureSuccessPrevious,
	ReviewCaptureSuccessLegacy,
	ReviewCaptureFailure
]);
export type ReviewCaptureResponse = Schema.Schema.Type<typeof ReviewCaptureResponse>;

export const ReviewCandidateRealization = Schema.Struct({
	candidateId: FramingCandidateId,
	diagnostics: Schema.Array(FramingDiagnostic),
	projection: ReviewSubjectProjection,
	recordedAt: Schema.String
});
export type ReviewCandidateRealization = Schema.Schema.Type<typeof ReviewCandidateRealization>;

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

export const ReviewAuthoringSessionPatch = Schema.Struct({
	candidateOverrides: Schema.optional(Schema.Array(FramingCandidateOverride)),
	discardedCandidateIds: Schema.Array(FramingCandidateId),
	draftPose: Schema.optional(ApprovedPose),
	framingParameters: Schema.optional(FramingParameters),
	manualReason: Schema.String,
	selectedCandidateId: Schema.optional(FramingCandidateId)
});
export type ReviewAuthoringSessionPatch = Schema.Schema.Type<typeof ReviewAuthoringSessionPatch>;

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

export const CaptureArtifact = Schema.Struct({
	byteLength: NonNegativeInteger,
	contentHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
	height: PositiveInteger,
	id: ArtifactId,
	mediaType: Schema.Literal("image/png"),
	relativePath: SafeRelativePath,
	variant: Schema.Literals(["pure", "clear"]),
	width: PositiveInteger
});
export type CaptureArtifact = Schema.Schema.Type<typeof CaptureArtifact>;

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
}) {
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
	return variants.has("pure")
		? undefined
		: {
				issue: "A captured View Result must retain its Pure artifact.",
				path: ["artifacts"]
			};
}

const CapturedViewResult = Schema.Struct({
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

export const ViewResult = Schema.Union([CapturedViewResult, FailedViewResult]);
export type ViewResult = Schema.Schema.Type<typeof ViewResult>;

const CaptureRunCurrent = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(5) })
	}),
	id: CaptureRunId,
	invocation: CaptureInvocation,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(ViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});

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
	contentHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
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

export const CaptureRun = CaptureRunCurrent;
export type CaptureRun = Schema.Schema.Type<typeof CaptureRun>;

export function decodeCaptureRunWithMigration<Input>(input: Input) {
	return Schema.decodeUnknownEffect(CaptureRunCurrent)(input).pipe(
		Effect.map((run) => ({ migrated: false as const, run })),
		Effect.catch(() =>
			Schema.decodeUnknownEffect(PreviousClearCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousClearCaptureRun(run)
				}))
			)
		),
		Effect.catch(() =>
			Schema.decodeUnknownEffect(PreviousCurrentCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousCurrentCaptureRun(run)
				}))
			)
		),
		Effect.catch(() =>
			Schema.decodeUnknownEffect(PreviousCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousCaptureRun(run)
				}))
			)
		),
		Effect.catch(() =>
			Schema.decodeUnknownEffect(PreviousLegacyCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migratePreviousLegacyCaptureRun(run)
				}))
			)
		),
		Effect.catch(() =>
			Schema.decodeUnknownEffect(LegacyCaptureRun)(input).pipe(
				Effect.map((run) => ({
					migrated: true as const,
					run: migrateLegacyCaptureRun(run)
				}))
			)
		)
	);
}

export function reviewViewActorSubject(view: ReviewView): SubjectLocator | undefined {
	return view.target.kind === "actor" ? view.target.subject : undefined;
}

export function reviewViewApprovedPose(view: ReviewView): ApprovedPose | undefined {
	return view.viewpoint.kind === "world_fixed" ? view.viewpoint.approvedPose : undefined;
}

export const decodeReviewSet = <Input>(input: Input) =>
	decodeReviewSetWithMigration(input).pipe(Effect.map(({ reviewSet }) => reviewSet));
export const decodeReviewCaptureRequest = <Input>(input: Input) =>
	Schema.decodeUnknownEffect(ReviewCaptureRequest)(input, { onExcessProperty: "error" });
export const decodeReviewCaptureResponse = <Input>(input: Input) =>
	Schema.decodeUnknownEffect(ReviewCaptureResponse)(input, { onExcessProperty: "error" });
export const decodeReviewAssessmentCapabilities = Schema.decodeUnknownEffect(
	ReviewAssessmentCapabilities
);
export const decodeReviewSelectionResponse = Schema.decodeUnknownEffect(ReviewSelectionResponse);
export const decodeReviewSubjectInspectionResponse = Schema.decodeUnknownEffect(
	ReviewSubjectInspectionResponse
);
export const decodeApproveReviewCandidateIntent = Schema.decodeUnknownEffect(
	ApproveReviewCandidateIntent
);
export const decodeCaptureInvocation = Schema.decodeUnknownEffect(CaptureInvocation);
export const decodeCaptureRun = <Input>(input: Input) =>
	decodeCaptureRunWithMigration(input).pipe(Effect.map(({ run }) => run));
export const decodeReviewAuthoringSession = Schema.decodeUnknownEffect(ReviewAuthoringSession);
