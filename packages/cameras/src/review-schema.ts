import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const SafeIdentifier = NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SafeRelativePath = NonEmptyString.check(
	Schema.isPattern(/^(?![A-Za-z]:)(?![\\/])(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$)).+$/)
);
export const ReviewSubjectActorPath = Schema.String.check(
	Schema.isMinLength(7),
	Schema.isMaxLength(4_096),
	Schema.isStartsWith("/Game/")
);
export type ReviewSubjectActorPath = Schema.Schema.Type<typeof ReviewSubjectActorPath>;

export const ReviewSetId = SafeIdentifier.pipe(Schema.brand("ReviewSetId"));
export type ReviewSetId = Schema.Schema.Type<typeof ReviewSetId>;

export const ReviewViewId = SafeIdentifier.pipe(Schema.brand("ReviewViewId"));
export type ReviewViewId = Schema.Schema.Type<typeof ReviewViewId>;

export const CaptureProfileId = SafeIdentifier.pipe(Schema.brand("CaptureProfileId"));
export type CaptureProfileId = Schema.Schema.Type<typeof CaptureProfileId>;

export const CaptureRunId = SafeIdentifier.pipe(Schema.brand("CaptureRunId"));
export type CaptureRunId = Schema.Schema.Type<typeof CaptureRunId>;

export const FramingCandidateId = SafeIdentifier.pipe(Schema.brand("FramingCandidateId"));
export type FramingCandidateId = Schema.Schema.Type<typeof FramingCandidateId>;

export const ReviewAuthoringSessionId = SafeIdentifier.pipe(
	Schema.brand("ReviewAuthoringSessionId")
);
export type ReviewAuthoringSessionId = Schema.Schema.Type<typeof ReviewAuthoringSessionId>;

export const ArtifactId = NonEmptyString.pipe(Schema.brand("ArtifactId"));
export type ArtifactId = Schema.Schema.Type<typeof ArtifactId>;

export const ReviewVector = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	z: Schema.Number
});
export type ReviewVector = Schema.Schema.Type<typeof ReviewVector>;

export const ReviewRotation = Schema.Struct({
	pitch: Schema.Number,
	roll: Schema.Number,
	yaw: Schema.Number
});
export type ReviewRotation = Schema.Schema.Type<typeof ReviewRotation>;

export const ApprovedPose = Schema.Struct({
	aspectRatio: Schema.Literal("16:9"),
	fieldOfViewDegrees: Schema.Number.check(Schema.isBetween({ minimum: 5, maximum: 170 })),
	location: ReviewVector,
	projection: Schema.Literal("perspective"),
	rotation: ReviewRotation
});
export type ApprovedPose = Schema.Schema.Type<typeof ApprovedPose>;

export const SubjectLocator = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	diagnosticLabel: Schema.optional(NonEmptyString),
	kind: Schema.Literal("actor_path")
});
export type SubjectLocator = Schema.Schema.Type<typeof SubjectLocator>;

export const SubjectBounds = Schema.Struct({
	center: ReviewVector,
	extent: ReviewVector,
	rotation: ReviewRotation
});
export type SubjectBounds = Schema.Schema.Type<typeof SubjectBounds>;

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

const ManualFramingRecipe = Schema.Struct({
	kind: Schema.Literal("manual"),
	note: Schema.optional(NonEmptyString),
	version: Schema.Literal(1)
});

const PresetFramingRecipe = Schema.Struct({
	kind: Schema.Literal("preset"),
	margin: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0.45 })),
	manualAdjustment: Schema.optional(Schema.Struct({ reason: NonEmptyString })),
	preset: FramingPreset,
	subjectBounds: SubjectBounds,
	version: Schema.Literal(1)
});

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
		minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	})
});

const ReviewSelectionSuccess = Schema.Struct({
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
	}),
	variantPolicy: Schema.Literal("pure_only")
});
export type CaptureProfile = Schema.Schema.Type<typeof CaptureProfile>;

export const ReviewView = Schema.Struct({
	approvedPose: ApprovedPose,
	captureProfileId: CaptureProfileId,
	displayName: NonEmptyString,
	framingDiagnostics: Schema.optional(Schema.Array(FramingDiagnostic)),
	framingRecipe: FramingRecipe,
	id: ReviewViewId,
	purpose: NonEmptyString,
	subject: SubjectLocator,
	tags: Schema.Array(NonEmptyString)
});
export type ReviewView = Schema.Schema.Type<typeof ReviewView>;

export const ReviewSet = Schema.Struct({
	captureProfiles: Schema.Array(CaptureProfile).check(Schema.isMinLength(1)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	description: Schema.optional(NonEmptyString),
	displayName: NonEmptyString,
	id: ReviewSetId,
	project: Schema.Struct({
		id: NonEmptyString,
		mapPath: NonEmptyString
	}),
	views: Schema.Array(ReviewView)
});
export type ReviewSet = Schema.Schema.Type<typeof ReviewSet>;

export const ReviewCaptureRequest = Schema.Struct({
	approvedPose: ApprovedPose,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	expectedMapPath: NonEmptyString,
	operationId: NonEmptyString,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 2160 })),
		width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 3840 }))
	}),
	subject: SubjectLocator,
	viewId: ReviewViewId
});
export type ReviewCaptureRequest = Schema.Schema.Type<typeof ReviewCaptureRequest>;

const ReviewCaptureSuccess = Schema.Struct({
	actorPath: ReviewSubjectActorPath,
	captureDurationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	height: Schema.Int.check(Schema.isGreaterThan(0)),
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	stagingPath: NonEmptyString,
	status: Schema.Literal("captured"),
	subjectProjection: Schema.optional(ReviewSubjectProjection),
	viewId: ReviewViewId,
	width: Schema.Int.check(Schema.isGreaterThan(0))
});

const ReviewCaptureFailure = Schema.Struct({
	code: NonEmptyString,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	message: NonEmptyString,
	operationId: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed"),
	viewId: ReviewViewId
});

export const ReviewCaptureResponse = Schema.Union([ReviewCaptureSuccess, ReviewCaptureFailure]);
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
	pendingReviewSet: Schema.optional(ReviewSet),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-authoring-session"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	createdAt: Schema.String,
	diagnostics: Schema.Array(FramingDiagnostic),
	discardedCandidateIds: Schema.Array(FramingCandidateId),
	draftPose: Schema.optional(ApprovedPose),
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
	discardedCandidateIds: Schema.Array(FramingCandidateId),
	draftPose: Schema.optional(ApprovedPose),
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
	byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	contentHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
	height: Schema.Int.check(Schema.isGreaterThan(0)),
	id: ArtifactId,
	mediaType: Schema.Literal("image/png"),
	relativePath: SafeRelativePath,
	variant: Schema.Literal("pure"),
	width: Schema.Int.check(Schema.isGreaterThan(0))
});
export type CaptureArtifact = Schema.Schema.Type<typeof CaptureArtifact>;

const CapturedViewResult = Schema.Struct({
	artifact: CaptureArtifact,
	captureDurationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
	resolvedActorPath: NonEmptyString,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId
});

const FailedViewResult = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed"),
	viewId: ReviewViewId
});

export const ViewResult = Schema.Union([CapturedViewResult, FailedViewResult]);
export type ViewResult = Schema.Schema.Type<typeof ViewResult>;

export const CaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	id: CaptureRunId,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(ViewResult).check(Schema.isMinLength(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literals(["completed", "completed_with_failures", "failed"])
});
export type CaptureRun = Schema.Schema.Type<typeof CaptureRun>;

export const decodeReviewSet = Schema.decodeUnknownEffect(ReviewSet);
export const decodeReviewCaptureRequest = Schema.decodeUnknownEffect(ReviewCaptureRequest);
export const decodeReviewCaptureResponse = Schema.decodeUnknownEffect(ReviewCaptureResponse);
export const decodeReviewSelectionResponse = Schema.decodeUnknownEffect(ReviewSelectionResponse);
export const decodeReviewSubjectInspectionResponse = Schema.decodeUnknownEffect(
	ReviewSubjectInspectionResponse
);
export const decodeApproveReviewCandidateIntent = Schema.decodeUnknownEffect(
	ApproveReviewCandidateIntent
);
export const decodeCaptureRun = Schema.decodeUnknownEffect(CaptureRun);
export const decodeReviewAuthoringSession = Schema.decodeUnknownEffect(ReviewAuthoringSession);
