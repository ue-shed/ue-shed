import { contractParser } from "./contract-parser.js";
import { Schema } from "effect";

/**
 * Which Unreal process answered: its engine version, OS process ID, a per-launch session ID and
 * the UE Shed plugins it loaded, so a host can tell a restarted or different editor apart.
 */
export const CompanionProducerIdentity = Schema.Struct({
	engineVersion: Schema.NonEmptyString,
	processId: Schema.Int.check(Schema.isGreaterThan(0)),
	sessionId: Schema.NonEmptyString,
	plugins: Schema.Array(
		Schema.Struct({
			name: Schema.NonEmptyString,
			version: Schema.String,
			loadedModules: Schema.Array(Schema.NonEmptyString)
		})
	)
});
export type CompanionProducerIdentity = Schema.Schema.Type<typeof CompanionProducerIdentity>;
/**
 * What a connected Unreal process offers, read from UEShedCore before any feature call. Each
 * `*ObjectPath` is the Remote Control object to call for one plugin and is absent when that
 * plugin is not loaded; hosts enable a feature only when its path and capability are present.
 * The optional limits are the editor's own bounds for authoring, scenarios and map-tile capture.
 */
export const CompanionCapabilityManifest = Schema.Struct({
	identity: Schema.optionalKey(CompanionProducerIdentity),
	assetAuditsObjectPath: Schema.optional(Schema.String),
	assetNavigationObjectPath: Schema.optional(Schema.String),
	authoringObjectPath: Schema.optional(Schema.String),
	automationObjectPath: Schema.optionalKey(Schema.NonEmptyString),
	cameraReviewObjectPath: Schema.optional(Schema.String),
	cameraAuthoringObjectPath: Schema.optionalKey(Schema.String),
	camerasObjectPath: Schema.optional(Schema.String),
	gameTextObjectPath: Schema.optionalKey(Schema.NonEmptyString),
	playSessionObjectPath: Schema.optional(Schema.String),
	worldControlObjectPath: Schema.optional(Schema.String),
	windowActivationObjectPath: Schema.optional(Schema.String),
	foregroundResponsivenessObjectPath: Schema.optionalKey(Schema.NonEmptyString),
	worldPreparationObjectPath: Schema.optionalKey(Schema.String),
	scenariosObjectPath: Schema.optional(Schema.String),
	capabilities: Schema.Array(Schema.String),
	authoringLimits: Schema.optional(
		Schema.Struct({
			maxCommands: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			maxPayloadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			maxTables: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	scenarioLimits: Schema.optional(
		Schema.Struct({
			maxActions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			maxDurationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			maxEvidence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			maxKeyframes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	mapTileCaptureLimits: Schema.optional(
		Schema.Struct({
			maxGutterPixels: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			maxTilePixels: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
			maxTilesPerRequest: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
		})
	),
	producerKind: Schema.Literals(["unreal_editor", "unreal_runtime"]),
	projectName: Schema.optional(Schema.String),
	schemaVersion: Schema.Literal(1)
}).annotate({ identifier: "CompanionCapabilityManifest" });
export type CompanionCapabilityManifest = Schema.Schema.Type<typeof CompanionCapabilityManifest>;

/**
 * Decodes a manifest; fails with a schema error when the producer speaks another schema version
 * or the reply is malformed, which hosts treat as an incompatible or missing UEShedCore.
 */
export const decodeCompanionCapabilityManifest = contractParser(
	CompanionCapabilityManifest,
	"CompanionCapabilityManifest"
);
