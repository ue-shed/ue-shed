import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const SafeIdentifier = NonEmptyString.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));

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
	fieldOfViewDegrees: Schema.Number.pipe(Schema.between(5, 170)),
	location: ReviewVector,
	projection: Schema.Literal("perspective"),
	rotation: ReviewRotation
});
export type ApprovedPose = Schema.Schema.Type<typeof ApprovedPose>;

export const SubjectLocator = Schema.Struct({
	actorPath: NonEmptyString,
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

export const FramingPreset = Schema.Literal(
	"context_three_quarter",
	"facade_front",
	"cardinal_north",
	"cardinal_east",
	"cardinal_south",
	"cardinal_west",
	"editor_view"
);
export type FramingPreset = Schema.Schema.Type<typeof FramingPreset>;

const ManualFramingRecipe = Schema.Struct({
	kind: Schema.Literal("manual"),
	note: Schema.optional(NonEmptyString),
	version: Schema.Literal(1)
});

const PresetFramingRecipe = Schema.Struct({
	kind: Schema.Literal("preset"),
	margin: Schema.Number.pipe(Schema.between(0, 0.45)),
	manualAdjustment: Schema.optional(Schema.Struct({ reason: NonEmptyString })),
	preset: FramingPreset,
	subjectBounds: SubjectBounds,
	version: Schema.Literal(1)
});

export const FramingRecipe = Schema.Union(ManualFramingRecipe, PresetFramingRecipe);
export type FramingRecipe = Schema.Schema.Type<typeof FramingRecipe>;

export const FramingDiagnostic = Schema.Struct({
	code: Schema.Literal("bounds_snapshot", "subject_bounds_changed", "manual_adjustment"),
	message: NonEmptyString,
	severity: Schema.Literal("info", "warning")
});
export type FramingDiagnostic = Schema.Schema.Type<typeof FramingDiagnostic>;

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
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.NonNegativeInt })
});

const ReviewSelectionSuccess = Schema.Struct({
	actorPath: NonEmptyString,
	bounds: SubjectBounds,
	contract: ReviewSelectionContract,
	displayName: NonEmptyString,
	editorView: Schema.optional(ApprovedPose),
	mapPath: NonEmptyString,
	status: Schema.Literal("selected")
});

const ReviewSelectionFailure = Schema.Struct({
	code: Schema.Literal("no_selection", "multiple_selection", "editor_unavailable"),
	contract: ReviewSelectionContract,
	message: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed")
});

export const ReviewSelectionResponse = Schema.Union(ReviewSelectionSuccess, ReviewSelectionFailure);
export type ReviewSelectionResponse = Schema.Schema.Type<typeof ReviewSelectionResponse>;

export const ApproveReviewCandidateIntent = Schema.Struct({
	candidateId: FramingCandidateId,
	candidatePose: ApprovedPose,
	manualPose: Schema.optional(ApprovedPose),
	manualReason: Schema.optional(NonEmptyString),
	sourceActorPath: NonEmptyString,
	viewId: ReviewViewId
});
export type ApproveReviewCandidateIntent = Schema.Schema.Type<typeof ApproveReviewCandidateIntent>;

export const CaptureProfile = Schema.Struct({
	id: CaptureProfileId,
	imageFormat: Schema.Literal("png"),
	renderProfile: Schema.Literal("full_fidelity"),
	resolution: Schema.Struct({
		height: Schema.Number.pipe(Schema.int(), Schema.between(90, 2160)),
		width: Schema.Number.pipe(Schema.int(), Schema.between(160, 3840))
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
	captureProfiles: Schema.Array(CaptureProfile).pipe(Schema.minItems(1)),
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-set"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.NonNegativeInt })
	}),
	description: Schema.optional(NonEmptyString),
	displayName: NonEmptyString,
	id: ReviewSetId,
	project: Schema.Struct({
		id: NonEmptyString,
		mapPath: NonEmptyString
	}),
	views: Schema.Array(ReviewView).pipe(Schema.minItems(1))
});
export type ReviewSet = Schema.Schema.Type<typeof ReviewSet>;

export const ReviewCaptureRequest = Schema.Struct({
	approvedPose: ApprovedPose,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.NonNegativeInt })
	}),
	expectedMapPath: NonEmptyString,
	operationId: NonEmptyString,
	resolution: Schema.Struct({
		height: Schema.Number.pipe(Schema.int(), Schema.between(90, 2160)),
		width: Schema.Number.pipe(Schema.int(), Schema.between(160, 3840))
	}),
	subject: SubjectLocator,
	viewId: ReviewViewId
});
export type ReviewCaptureRequest = Schema.Schema.Type<typeof ReviewCaptureRequest>;

const ReviewCaptureSuccess = Schema.Struct({
	actorPath: NonEmptyString,
	captureDurationMs: Schema.NonNegative,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.NonNegativeInt })
	}),
	height: Schema.Number.pipe(Schema.int(), Schema.positive()),
	mapPackageDirtyAfter: Schema.Boolean,
	mapPackageDirtyBefore: Schema.Boolean,
	mapPath: NonEmptyString,
	operationId: NonEmptyString,
	stagingPath: NonEmptyString,
	status: Schema.Literal("captured"),
	viewId: ReviewViewId,
	width: Schema.Number.pipe(Schema.int(), Schema.positive())
});

const ReviewCaptureFailure = Schema.Struct({
	code: NonEmptyString,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-review-capture"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.NonNegativeInt })
	}),
	message: NonEmptyString,
	operationId: NonEmptyString,
	recovery: NonEmptyString,
	retrySafe: Schema.Boolean,
	status: Schema.Literal("failed"),
	viewId: ReviewViewId
});

export const ReviewCaptureResponse = Schema.Union(ReviewCaptureSuccess, ReviewCaptureFailure);
export type ReviewCaptureResponse = Schema.Schema.Type<typeof ReviewCaptureResponse>;

export const CaptureArtifact = Schema.Struct({
	byteLength: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
	contentHash: Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/)),
	height: Schema.Number.pipe(Schema.int(), Schema.positive()),
	id: ArtifactId,
	mediaType: Schema.Literal("image/png"),
	relativePath: NonEmptyString,
	variant: Schema.Literal("pure"),
	width: Schema.Number.pipe(Schema.int(), Schema.positive())
});
export type CaptureArtifact = Schema.Schema.Type<typeof CaptureArtifact>;

const CapturedViewResult = Schema.Struct({
	artifact: CaptureArtifact,
	captureDurationMs: Schema.NonNegative,
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

export const ViewResult = Schema.Union(CapturedViewResult, FailedViewResult);
export type ViewResult = Schema.Schema.Type<typeof ViewResult>;

export const CaptureRun = Schema.Struct({
	completedAt: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-capture-run"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.NonNegativeInt })
	}),
	id: CaptureRunId,
	project: Schema.Struct({ id: NonEmptyString, mapPath: NonEmptyString }),
	results: Schema.Array(ViewResult).pipe(Schema.minItems(1)),
	reviewSetId: ReviewSetId,
	startedAt: Schema.String,
	status: Schema.Literal("completed", "completed_with_failures", "failed")
});
export type CaptureRun = Schema.Schema.Type<typeof CaptureRun>;

export const decodeReviewSet = Schema.decodeUnknownSync(ReviewSet);
export const decodeReviewCaptureResponse = Schema.decodeUnknownSync(ReviewCaptureResponse);
export const decodeReviewSelectionResponse = Schema.decodeUnknownSync(ReviewSelectionResponse);
export const decodeApproveReviewCandidateIntent = Schema.decodeUnknownSync(
	ApproveReviewCandidateIntent
);
export const decodeCaptureRun = Schema.decodeUnknownSync(CaptureRun);
