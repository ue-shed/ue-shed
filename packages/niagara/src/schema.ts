import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }));
const FrameCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 }));
const SimulationRate = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 480 }));
const StartSeconds = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 3600 }));
const DurationSeconds = Schema.Number.check(Schema.isBetween({ minimum: 0.001, maximum: 600 }));

export const NiagaraPreviewRunId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
).pipe(Schema.brand("NiagaraPreviewRunId"));
export type NiagaraPreviewRunId = typeof NiagaraPreviewRunId.Type;

export const NiagaraSystemObjectPath = Schema.NonEmptyString.check(
	// Unreal object names may contain hyphens (e.g. `NS_GrassHit_Lv2-3`), so the object-name
	// segment accepts them like every other saved-path schema in the repo.
	Schema.isPattern(/^\/[A-Za-z0-9_]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+$/u),
	Schema.isMaxLength(1024)
).pipe(Schema.brand("NiagaraSystemObjectPath"));
export type NiagaraSystemObjectPath = typeof NiagaraSystemObjectPath.Type;

/** Saved packages exporting this class hold capturable Niagara Systems. */
export const NIAGARA_SYSTEM_CLASS = "/Script/Niagara.NiagaraSystem";

const RequestContract = Schema.Struct({
	name: Schema.Literal("ue-shed-niagara-preview-request"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([0, 1, 2]) })
});

const ReceiptContract = Schema.Struct({
	name: Schema.Literal("ue-shed-niagara-preview-receipt"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([0, 1, 2]) })
});

const RunContract = Schema.Struct({
	name: Schema.Literal("ue-shed-niagara-preview-run"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literals([0, 1, 2]) })
});

const CameraCoordinate = Schema.Number.check(Schema.isBetween({ minimum: -1e12, maximum: 1e12 }));
const PresentationSettings = {
	background: Schema.optionalKey(Schema.Literals(["default", "dark", "light"])),
	cameraOverride: Schema.optionalKey(
		Schema.Struct({
			location: Schema.Struct({
				x: CameraCoordinate,
				y: CameraCoordinate,
				z: CameraCoordinate
			}),
			rotation: Schema.Struct({
				pitch: CameraCoordinate,
				yaw: CameraCoordinate,
				roll: CameraCoordinate
			}),
			fieldOfViewDegrees: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 179 }))
		})
	),
	renderMode: Schema.optionalKey(Schema.Literals(["transparent", "scene"])),
	cameraMode: Schema.optionalKey(Schema.Literals(["saved", "auto_fit"])),
	sceneProfile: Schema.optionalKey(
		Schema.Literals(["ground_impact", "projectile", "aura", "environment"])
	),
	exposureCompensation: Schema.optionalKey(
		Schema.Number.check(Schema.isBetween({ minimum: -8, maximum: 8 }))
	),
	cameraPadding: Schema.optionalKey(
		Schema.Number.check(Schema.isBetween({ minimum: 1.05, maximum: 3 }))
	)
};

export const NiagaraPreviewSettings = Schema.Struct({
	...PresentationSettings,
	captureMode: Schema.optionalKey(Schema.Literals(["component_only", "full_scene"])),
	durationSeconds: Schema.optionalKey(DurationSeconds),
	frameCount: Schema.optionalKey(FrameCount),
	height: Schema.optionalKey(Dimension),
	simulationFramesPerSecond: Schema.optionalKey(SimulationRate),
	startSeconds: Schema.optionalKey(StartSeconds),
	width: Schema.optionalKey(Dimension)
});
export type NiagaraPreviewSettings = typeof NiagaraPreviewSettings.Type;

export const NiagaraPreviewProducerRequest = Schema.Struct({
	contract: RequestContract,
	runId: NiagaraPreviewRunId,
	settings: NiagaraPreviewSettings,
	systemObjectPath: NiagaraSystemObjectPath
});
export type NiagaraPreviewProducerRequest = typeof NiagaraPreviewProducerRequest.Type;

export const NiagaraPreviewEffectiveSettings = Schema.Struct({
	...PresentationSettings,
	captureMode: Schema.Literals(["component_only", "full_scene"]),
	durationSeconds: DurationSeconds,
	frameCount: FrameCount,
	frameIntervalSeconds: Schema.Number.check(Schema.isGreaterThan(0)),
	height: Dimension,
	playbackFramesPerSecond: Schema.Number.check(Schema.isGreaterThan(0)),
	simulationFramesPerSecond: SimulationRate,
	startSeconds: StartSeconds,
	width: Dimension
});
export type NiagaraPreviewEffectiveSettings = typeof NiagaraPreviewEffectiveSettings.Type;

const Vector3 = Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number });
const Rotator = Schema.Struct({ pitch: Schema.Number, roll: Schema.Number, yaw: Schema.Number });

export const NiagaraPreviewCamera = Schema.Struct({
	aspectRatio: Schema.Number.check(Schema.isGreaterThan(0)),
	fieldOfViewDegrees: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 180 })),
	location: Vector3,
	orthoWidth: NonNegativeNumber,
	projection: Schema.Literals(["orthographic", "perspective"]),
	rotation: Rotator,
	usesCustomAspectRatio: Schema.Boolean
});
export type NiagaraPreviewCamera = typeof NiagaraPreviewCamera.Type;

const FrameRelativePath = Schema.String.check(Schema.isPattern(/^frames\/frame_[0-9]{4}\.png$/u));

export const NiagaraPreviewProducerFrame = Schema.Struct({
	activityScore: Schema.optionalKey(Fraction),
	edgePixelFraction: Schema.optionalKey(Fraction),
	index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	maximumRgb: Fraction,
	nonTransparentPixelFraction: Fraction,
	relativePath: FrameRelativePath,
	timeSeconds: NonNegativeNumber
});
export type NiagaraPreviewProducerFrame = typeof NiagaraPreviewProducerFrame.Type;

export const NiagaraPreviewProducerReceipt = Schema.Struct({
	missingMaterialCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	alphaPolicy: Schema.Literals(["scene_opacity_or_emissive_coverage_v1", "opaque_scene_v1"]),
	camera: NiagaraPreviewCamera,
	colorSpace: Schema.Literal("srgb"),
	contract: ReceiptContract,
	effectiveSettings: NiagaraPreviewEffectiveSettings,
	engineVersion: Schema.NonEmptyString,
	frames: Schema.Array(NiagaraPreviewProducerFrame).check(Schema.isMinLength(1)),
	generatedAtUtc: Schema.NonEmptyString,
	requestedSettings: NiagaraPreviewSettings,
	runId: NiagaraPreviewRunId,
	status: Schema.Literal("complete"),
	systemObjectPath: NiagaraSystemObjectPath
});
export type NiagaraPreviewProducerReceipt = typeof NiagaraPreviewProducerReceipt.Type;

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));

export const NiagaraPreviewArtifact = Schema.Struct({
	activityScore: Schema.optionalKey(Fraction),
	edgePixelFraction: Schema.optionalKey(Fraction),
	bytes: PositiveInt,
	height: Dimension,
	index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	maximumRgb: Fraction,
	mimeType: Schema.Literal("image/png"),
	nonTransparentPixelFraction: Fraction,
	relativePath: FrameRelativePath,
	sha256: Sha256,
	timeSeconds: NonNegativeNumber,
	width: Dimension
});
export type NiagaraPreviewArtifact = typeof NiagaraPreviewArtifact.Type;

export const NiagaraPreviewDiagnostic = Schema.Struct({
	code: Schema.Literals(["nearly_black", "nearly_empty", "missing_material"]),
	message: Schema.NonEmptyString
});
export type NiagaraPreviewDiagnostic = typeof NiagaraPreviewDiagnostic.Type;

export const NiagaraPreviewFailure = Schema.Struct({
	code: Schema.Literals([
		"invalid_request",
		"engine_discovery_failed",
		"commandlet_unavailable",
		"plugin_unavailable",
		"rendering_unavailable",
		"system_unavailable",
		"baker_camera_missing",
		"compilation_failed",
		"capture_failed",
		"process_failed",
		"process_timeout",
		"receipt_missing",
		"receipt_invalid",
		"artifact_invalid",
		"run_exists",
		"publish_failed"
	]),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	runId: Schema.optionalKey(Schema.String),
	stage: Schema.Literals(["validation", "capture", "publication"])
});
export interface NiagaraPreviewFailure extends Schema.Schema.Type<typeof NiagaraPreviewFailure> {}

export const NiagaraPreviewRunManifest = Schema.Struct({
	alphaPolicy: NiagaraPreviewProducerReceipt.fields.alphaPolicy,
	artifacts: Schema.Array(NiagaraPreviewArtifact).check(Schema.isMinLength(1)),
	camera: NiagaraPreviewCamera,
	colorSpace: NiagaraPreviewProducerReceipt.fields.colorSpace,
	contract: RunContract,
	diagnostics: Schema.Array(NiagaraPreviewDiagnostic),
	effectiveSettings: NiagaraPreviewEffectiveSettings,
	generatedAtUtc: Schema.NonEmptyString,
	producer: Schema.Struct({
		engineVersion: Schema.NonEmptyString,
		receiptContract: ReceiptContract
	}),
	requestedSettings: NiagaraPreviewSettings,
	runId: NiagaraPreviewRunId,
	status: Schema.Literal("complete"),
	systemObjectPath: NiagaraSystemObjectPath
});
export type NiagaraPreviewRunManifest = typeof NiagaraPreviewRunManifest.Type;

export const decodeNiagaraPreviewProducerRequest = Schema.decodeUnknownEffect(
	NiagaraPreviewProducerRequest
);
export const decodeNiagaraPreviewProducerReceipt = Schema.decodeUnknownEffect(
	NiagaraPreviewProducerReceipt
);
export const decodeNiagaraPreviewRunManifest =
	Schema.decodeUnknownEffect(NiagaraPreviewRunManifest);
