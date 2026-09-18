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
export const CameraPanelEvent = Schema.Struct({
	id: CameraOperationId,
	expectedRevision: Schema.Int,
	action: CameraPanelAction
});
export type CameraPanelEvent = typeof CameraPanelEvent.Type;
export const CameraPanelProposal = Schema.Struct({
	expectedRevision: Schema.Int,
	cameras: CameraArrangement.fields.cameras,
	customized: Schema.Array(ArrangementCameraId),
	removed: Schema.Array(ArrangementCameraId),
	added: Schema.Array(ArrangementCameraId),
	recipe: Schema.optionalKey(CameraArrangementRecipe)
});
export type CameraPanelProposal = typeof CameraPanelProposal.Type;
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
export const CameraActorSelectionResult = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literal("selection"),
	actors: CameraVisibilityList.fields.hide,
	diagnostics: Schema.Array(CameraVisibilityDiagnostic),
	message: Schema.String
});
export const CameraVisibilityResolutionResult = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literal("visibility"),
	valid: Schema.Boolean,
	diagnostics: Schema.Array(CameraVisibilityDiagnostic),
	message: Schema.String
});
export const CameraPanelSelectionScope = CameraEditScope;
