import { CameraRenderPolicy } from "./camera-render-schema.js";
import { Schema } from "effect";
import { ApprovedPose, ReviewViewId } from "./review-schema.js";
import {
	ArrangementCameraId,
	CameraArrangement,
	CameraArrangementCommand,
	CameraArrangementRecipe,
	CameraEditScope,
	CameraLayout,
	CameraOperationId
} from "./camera-arrangement.js";
import { CameraVisibilityDiagnostic, CameraVisibilityList } from "./camera-visibility.js";

/**
 * Explicit editor panel intent for scoped edits, activation, approval, layouts and policy
 * import/export. Destructive regeneration remains a proposal/confirmation workflow tied to
 * revision.
 */
export const CameraPanelAction = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("import_visibility"),
		path: Schema.NonEmptyString,
		scope: CameraEditScope
	}),
	Schema.Struct({
		kind: Schema.Literal("export_visibility"),
		path: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		scope: CameraEditScope
	}),
	Schema.Struct({
		kind: Schema.Literal("remove"),
		cameraIds: Schema.Array(ArrangementCameraId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		)
	}),
	Schema.Struct({ kind: Schema.Literal("command"), command: CameraArrangementCommand }),
	Schema.Struct({ kind: Schema.Literal("activate"), cameraId: ArrangementCameraId }),
	Schema.Struct({
		kind: Schema.Literal("approve"),
		cameraIds: Schema.Array(ArrangementCameraId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		),
		removeRetiredViewIds: Schema.Array(ReviewViewId)
	}),
	Schema.Struct({
		kind: Schema.Literal("layout"),
		layout: CameraLayout,
		retainExisting: Schema.Boolean
	}),
	Schema.Struct({ kind: Schema.Literal("add_viewport"), pose: ApprovedPose }),
	Schema.Struct({ kind: Schema.Literal("import_recipe"), path: Schema.NonEmptyString }),
	Schema.Struct({
		kind: Schema.Literal("export_recipe"),
		path: Schema.NonEmptyString,
		name: Schema.NonEmptyString
	}),
	Schema.Struct({ kind: Schema.Literal("accept_proposal") }),
	Schema.Struct({ kind: Schema.Literal("cancel_proposal") })
]);
export type CameraPanelAction = typeof CameraPanelAction.Type;
/**
 * Unique operation identity and expected revision wrapping one panel action. Replay handling
 * and stale checks use these fields rather than timing or UI state.
 */
export const CameraPanelEvent = Schema.Struct({
	id: CameraOperationId,
	expectedRevision: Schema.Int,
	action: CameraPanelAction
});
export type CameraPanelEvent = typeof CameraPanelEvent.Type;
/**
 * Revision-bound proposed camera replacement with added/removed/customized identities and
 * optional recipe. Present customization risk before committing regeneration.
 */
export const CameraPanelProposal = Schema.Struct({
	expectedRevision: Schema.Int,
	cameras: CameraArrangement.fields.cameras,
	customized: Schema.Array(ArrangementCameraId),
	removed: Schema.Array(ArrangementCameraId),
	added: Schema.Array(ArrangementCameraId),
	recipe: Schema.optionalKey(CameraArrangementRecipe)
});
export type CameraPanelProposal = typeof CameraPanelProposal.Type;
/**
 * Resolved panel model with arrangement, active camera, effective render/visibility policy
 * and draft/approval paths. Hosts render this state without inventing a second project
 * selection.
 */
export const CameraPanelState = Schema.Struct({
	renderPolicy: CameraRenderPolicy,
	arrangement: CameraArrangement,
	activeCameraId: ArrangementCameraId,
	cameras: Schema.Array(
		Schema.Struct({
			id: ArrangementCameraId,
			pose: ApprovedPose,
			visibility: CameraVisibilityList,
			approved: Schema.Boolean
		})
	),
	retiredViews: Schema.Array(Schema.Struct({ id: ReviewViewId, name: Schema.String })),
	proposal: Schema.optionalKey(CameraPanelProposal),
	notice: Schema.String,
	draftPath: Schema.String,
	approvalPath: Schema.String
});
export type CameraPanelState = typeof CameraPanelState.Type;
/**
 * Versioned selected actor locators and resolution diagnostics from the editor. A selection
 * result does not itself add actors to a hide/protect policy.
 */
export const CameraActorSelectionResult = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literal("selection"),
	actors: CameraVisibilityList.fields.hide,
	diagnostics: Schema.Array(CameraVisibilityDiagnostic),
	message: Schema.String
});
/**
 * Versioned validity and per-locator diagnostics for authored visibility. Missing/unloaded or
 * ambiguous actors remain explicit rather than silently removed from policy.
 */
export const CameraVisibilityResolutionResult = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literal("visibility"),
	valid: Schema.Boolean,
	diagnostics: Schema.Array(CameraVisibilityDiagnostic),
	message: Schema.String
});
/**
 * Panel alias for explicit arrangement/group/camera edit scope. Resolve it against current
 * arrangement ownership before executing a batch action.
 */
export const CameraPanelSelectionScope = CameraEditScope;
