import { Schema } from "effect";
import { CameraArrangementId, CameraLayout } from "./camera-arrangement.js";

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
export const CameraSetupRequest = Schema.Union([
	Schema.Struct({ version: Schema.Literal(1), operation: Schema.Literal("setup_status") }),
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
		operation: Schema.Literal("setup_poll"),
		hostId: CameraArrangementId,
		projectName: Schema.NonEmptyString,
		outcome: Schema.optionalKey(CameraSetupOutcome)
	})
]);
export const CameraSetupState = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literal("setup"),
	connected: Schema.Boolean,
	message: Schema.String,
	request: Schema.optionalKey(CameraSetupIntent),
	selection: Schema.optionalKey(
		Schema.Struct({
			actorPath: Schema.String,
			displayName: Schema.String,
			mapPath: Schema.String
		})
	)
});
