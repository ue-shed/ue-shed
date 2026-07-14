import { Schema } from "effect";

export const CompanionCapabilityManifest = Schema.Struct({
	authoringObjectPath: Schema.String,
	camerasObjectPath: Schema.optional(Schema.String),
	capabilities: Schema.Array(Schema.String),
	producerKind: Schema.Literal("unreal_editor"),
	schemaVersion: Schema.Literal(1)
}).annotations({ identifier: "CompanionCapabilityManifest" });
export type CompanionCapabilityManifest = Schema.Schema.Type<typeof CompanionCapabilityManifest>;

export const decodeCompanionCapabilityManifest = Schema.decodeUnknownSync(
	CompanionCapabilityManifest
);
