import { Schema } from "effect";

export const CompanionCapabilityManifest = Schema.Struct({
	assetAuditsObjectPath: Schema.optional(Schema.String),
	assetNavigationObjectPath: Schema.optional(Schema.String),
	authoringObjectPath: Schema.optional(Schema.String),
	camerasObjectPath: Schema.optional(Schema.String),
	playSessionObjectPath: Schema.optional(Schema.String),
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
	producerKind: Schema.Literal("unreal_editor"),
	projectName: Schema.optional(Schema.String),
	schemaVersion: Schema.Literal(1)
}).annotate({ identifier: "CompanionCapabilityManifest" });
export type CompanionCapabilityManifest = Schema.Schema.Type<typeof CompanionCapabilityManifest>;

export const decodeCompanionCapabilityManifest = Schema.decodeUnknownEffect(
	CompanionCapabilityManifest
);
