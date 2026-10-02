import { Schema } from "effect";
import { CameraArrangementId, CameraLayout, type CameraArrangement } from "./camera-arrangement.js";
import { SubjectLocator } from "./review-schema.js";

/** Native setup is a single bounded request to a connected, project-scoped host. */
export const CameraSetupIntent = Schema.Struct({
	id: CameraArrangementId,
	actorPath: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
	mapPath: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
	name: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
	layout: CameraLayout
});
export type CameraSetupIntent = typeof CameraSetupIntent.Type;
export const CameraSetupOutcome = Schema.Struct({
	id: CameraArrangementId,
	error: Schema.NullOr(Schema.String)
});

/** One saved, reopenable camera set that a host offers to the native panel. */
export const CameraSetupSavedSet = Schema.Struct({
	id: CameraArrangementId,
	name: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
	mapPath: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
	subject: SubjectLocator,
	cameras: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 }))
});
export type CameraSetupSavedSet = typeof CameraSetupSavedSet.Type;
const CameraSetupSavedSets = Schema.Array(CameraSetupSavedSet).check(Schema.isMaxLength(256));

/** A request, under its own identity, to open one of the host's listed sets. */
export const CameraSetupOpenIntent = Schema.Struct({
	id: CameraArrangementId,
	arrangementId: CameraArrangementId
});
export type CameraSetupOpenIntent = typeof CameraSetupOpenIntent.Type;

/**
 * Reopening is negotiated by the host: `reopen: true` on its poll (or status) request. Only then
 * does the bridge add `canOpen`, `sets`, `open` and `selection.actorGuid` to the reply, so hosts
 * that predate reopening keep receiving exactly the fields they decode.
 */
export const CameraSetupRequest = Schema.Union([
	Schema.Struct({
		version: Schema.Literal(1),
		operation: Schema.Literal("setup_status"),
		reopen: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({
		version: Schema.Literal(1),
		operation: Schema.Literal("setup_release"),
		hostId: CameraArrangementId
	}),
	Schema.Struct({
		version: Schema.Literal(1),
		operation: Schema.Literal("setup_create"),
		intent: CameraSetupIntent
	}),
	Schema.Struct({
		version: Schema.Literal(1),
		operation: Schema.Literal("setup_open"),
		intent: CameraSetupOpenIntent
	}),
	Schema.Struct({
		version: Schema.Literal(1),
		operation: Schema.Literal("setup_poll"),
		hostId: CameraArrangementId,
		projectName: Schema.NonEmptyString,
		outcome: Schema.optionalKey(CameraSetupOutcome),
		/** This host can open the sets it lists. */
		reopen: Schema.optionalKey(Schema.Boolean),
		/** The host's saved sets for the editor's map; replaces the previous list. */
		sets: Schema.optionalKey(CameraSetupSavedSets)
	})
]);
export const CameraSetupState = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literal("setup"),
	connected: Schema.Boolean,
	message: Schema.String,
	request: Schema.optionalKey(CameraSetupIntent),
	/** Present only for hosts that negotiated reopening. */
	canOpen: Schema.optionalKey(Schema.Boolean),
	/** The listed sets whose subject is the editor's single selected actor. */
	sets: Schema.optionalKey(CameraSetupSavedSets),
	open: Schema.optionalKey(CameraSetupOpenIntent),
	selection: Schema.optionalKey(
		Schema.Struct({
			actorPath: Schema.String,
			actorGuid: Schema.optionalKey(Schema.String),
			displayName: Schema.String,
			mapPath: Schema.String
		})
	)
});

/** The listing entry for a saved arrangement, for hosts that offer reopening. */
export function cameraSetupSavedSet(arrangement: CameraArrangement): CameraSetupSavedSet {
	return {
		id: arrangement.id,
		name: (arrangement.displayName ?? "").trim().slice(0, 256) || "Camera set",
		mapPath: arrangement.mapPath,
		subject: arrangement.subject,
		cameras: arrangement.cameras.length
	};
}
