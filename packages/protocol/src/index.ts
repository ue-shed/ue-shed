import { Effect, Schema } from "effect";

export const IdentifierKind = Schema.Literals([
	"actor",
	"capability",
	"producer",
	"session",
	"world"
]);
export type IdentifierKind = Schema.Schema.Type<typeof IdentifierKind>;

export class IdentifierValidationError extends Schema.TaggedErrorClass<IdentifierValidationError>()(
	"IdentifierValidationError",
	{
		kind: IdentifierKind,
		input: Schema.String,
		recovery: Schema.String
	}
) {}

const IdentifierString = Schema.Trim.check(Schema.isNonEmpty());

export const ActorId = IdentifierString.pipe(Schema.brand("ActorId"));
export type ActorId = Schema.Schema.Type<typeof ActorId>;

export const CapabilityId = IdentifierString.pipe(Schema.brand("CapabilityId"));
export type CapabilityId = Schema.Schema.Type<typeof CapabilityId>;

export const ProducerId = IdentifierString.pipe(Schema.brand("ProducerId"));
export type ProducerId = Schema.Schema.Type<typeof ProducerId>;

export const SessionId = IdentifierString.pipe(Schema.brand("SessionId"));
export type SessionId = Schema.Schema.Type<typeof SessionId>;

export const WorldId = IdentifierString.pipe(Schema.brand("WorldId"));
export type WorldId = Schema.Schema.Type<typeof WorldId>;

function identifierError(kind: IdentifierKind, input: string): IdentifierValidationError {
	return new IdentifierValidationError({
		kind,
		input,
		recovery: `Provide a non-empty ${kind} identifier.`
	});
}

function decodeIdentifier<S extends Schema.ConstraintDecoder<string>>(
	schema: S,
	kind: IdentifierKind,
	input: string
): Effect.Effect<S["Type"], IdentifierValidationError, S["DecodingServices"]> {
	return Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => identifierError(kind, input))
	);
}

function createIdentifier<S extends Schema.ConstraintDecoder<string>>(
	schema: S,
	kind: IdentifierKind,
	input: string
): S["Type"] {
	try {
		return Schema.decodeUnknownSync(schema)(input);
	} catch {
		throw identifierError(kind, input);
	}
}

export const decodeActorId = (input: string) => decodeIdentifier(ActorId, "actor", input);
export const decodeCapabilityId = (input: string) =>
	decodeIdentifier(CapabilityId, "capability", input);
export const decodeProducerId = (input: string) => decodeIdentifier(ProducerId, "producer", input);
export const decodeSessionId = (input: string) => decodeIdentifier(SessionId, "session", input);
export const decodeWorldId = (input: string) => decodeIdentifier(WorldId, "world", input);

export function createActorId(input: string): ActorId {
	return createIdentifier(ActorId, "actor", input);
}

export function createCapabilityId(input: string): CapabilityId {
	return createIdentifier(CapabilityId, "capability", input);
}

export function createProducerId(input: string): ProducerId {
	return createIdentifier(ProducerId, "producer", input);
}

export function createSessionId(input: string): SessionId {
	return createIdentifier(SessionId, "session", input);
}

export function createWorldId(input: string): WorldId {
	return createIdentifier(WorldId, "world", input);
}

export const ProtocolVersion = Schema.Struct({
	major: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type ProtocolVersion = Schema.Schema.Type<typeof ProtocolVersion>;

export const CURRENT_PROTOCOL_VERSION = ProtocolVersion.make({ major: 0, minor: 1 });

export const TransportKind = Schema.Literals([
	"remote-control-http",
	"remote-control-websocket",
	"named-pipe"
]);
export type TransportKind = Schema.Schema.Type<typeof TransportKind>;

export const CapabilityDescriptor = Schema.Struct({
	id: CapabilityId,
	version: ProtocolVersion,
	transports: Schema.Array(TransportKind)
});
export type CapabilityDescriptor = Schema.Schema.Type<typeof CapabilityDescriptor>;

export const CapabilityManifest = Schema.Struct({
	producerId: ProducerId,
	displayName: Schema.String,
	capabilities: Schema.Array(CapabilityDescriptor)
});
export type CapabilityManifest = Schema.Schema.Type<typeof CapabilityManifest>;

export const ConnectionState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("disconnected") }),
	Schema.Struct({ status: Schema.Literal("connecting"), endpoint: Schema.String }),
	Schema.Struct({
		status: Schema.Literal("connected"),
		sessionId: SessionId,
		manifest: CapabilityManifest
	}),
	Schema.Struct({
		status: Schema.Literal("recovering"),
		sessionId: SessionId,
		reason: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("ended"),
		sessionId: SessionId,
		reason: Schema.Literals(["requested", "producer-exited", "transport-lost"])
	}),
	Schema.Struct({ status: Schema.Literal("error"), message: Schema.String })
]);
export type ConnectionState = Schema.Schema.Type<typeof ConnectionState>;

export const decodeCapabilityManifest = Schema.decodeUnknownEffect(CapabilityManifest);
export const decodeConnectionState = Schema.decodeUnknownEffect(ConnectionState);

export * from "./authoring.js";
export * from "./authoring-review.js";
export * from "./companion.js";
export * from "./cameras.js";
export * from "./editor-play-session.js";
export * from "./editor-world-control.js";
export * from "./editor-asset-navigation.js";
export * from "./saved-world.js";
export * from "./uasset-io.js";
export * from "./uasset-inspection.js";
