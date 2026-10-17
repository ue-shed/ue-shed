import { Schema } from "effect";
/**
 * Unavailable selection or ready map bounds with selected actor identities and skipped paths.
 * Ready requires at least one supported actor; selection remains editor evidence, not a host
 * project choice.
 */
export const MapCaptureSelection = Schema.Union([
	Schema.Struct({
		schemaVersion: Schema.Literal(1),
		status: Schema.Literal("unavailable"),
		code: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}),
	Schema.Struct({
		schemaVersion: Schema.Literal(1),
		status: Schema.Literal("ready"),
		mapPath: Schema.NonEmptyString,
		bounds: Schema.Struct({
			minX: Schema.Finite,
			maxX: Schema.Finite,
			minY: Schema.Finite,
			maxY: Schema.Finite,
			minZ: Schema.Finite,
			maxZ: Schema.Finite
		}).check(
			Schema.makeFilter((b) => b.minX <= b.maxX && b.minY <= b.maxY && b.minZ <= b.maxZ)
		),
		actors: Schema.Array(
			Schema.Struct({
				path: Schema.NonEmptyString,
				label: Schema.String,
				actorGuid: Schema.optionalKey(
					Schema.String.check(Schema.isPattern(/^[0-9A-Fa-f]{32}$/u))
				)
			})
		).check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
		skippedActorPaths: Schema.Array(Schema.String).check(Schema.isMaxLength(1024))
	})
]);
export type MapCaptureSelection = typeof MapCaptureSelection.Type;
/**
 * Lit-camera backend readiness with actual map and blockers. Validation requires ready to
 * agree with the absence of blockers so callers cannot ignore contradictory evidence.
 */
export const MapCaptureReadiness = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	backend: Schema.Literal("lit_camera_tiles"),
	ready: Schema.Boolean,
	actualMapPath: Schema.optionalKey(Schema.NonEmptyString),
	blockers: Schema.Array(
		Schema.Struct({ code: Schema.NonEmptyString, message: Schema.NonEmptyString })
	)
}).check(Schema.makeFilter((r) => r.ready === (r.blockers.length === 0)));
export type MapCaptureReadiness = typeof MapCaptureReadiness.Type;
