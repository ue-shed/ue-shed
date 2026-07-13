declare const identifierBrand: unique symbol;

type Identifier<Name extends string> = string & {
	readonly [identifierBrand]: Name;
};

export type ActorId = Identifier<"ActorId">;
export type CapabilityId = Identifier<"CapabilityId">;
export type ProducerId = Identifier<"ProducerId">;
export type SessionId = Identifier<"SessionId">;
export type WorldId = Identifier<"WorldId">;

export type IdentifierKind = "actor" | "capability" | "producer" | "session" | "world";

export class IdentifierValidationError extends Error {
	readonly kind: IdentifierKind;
	readonly input: string;

	constructor(args: { kind: IdentifierKind; input: string }) {
		super(`${args.kind} identifier must not be empty`);
		this.name = "IdentifierValidationError";
		this.kind = args.kind;
		this.input = args.input;
	}
}

function createIdentifier<Name extends string>(args: {
	kind: IdentifierKind;
	name: Name;
	input: string;
}): Identifier<Name> {
	const value = args.input.trim();
	if (value.length === 0) {
		throw new IdentifierValidationError({ kind: args.kind, input: args.input });
	}

	return value as Identifier<Name>;
}

export function createActorId(input: string): ActorId {
	return createIdentifier({ kind: "actor", name: "ActorId", input });
}

export function createCapabilityId(input: string): CapabilityId {
	return createIdentifier({ kind: "capability", name: "CapabilityId", input });
}

export function createProducerId(input: string): ProducerId {
	return createIdentifier({ kind: "producer", name: "ProducerId", input });
}

export function createSessionId(input: string): SessionId {
	return createIdentifier({ kind: "session", name: "SessionId", input });
}

export function createWorldId(input: string): WorldId {
	return createIdentifier({ kind: "world", name: "WorldId", input });
}

export interface ProtocolVersion {
	readonly major: number;
	readonly minor: number;
}

export const CURRENT_PROTOCOL_VERSION = {
	major: 0,
	minor: 1
} as const satisfies ProtocolVersion;

export type TransportKind = "remote-control-http" | "remote-control-websocket" | "named-pipe";

export interface CapabilityDescriptor {
	readonly id: CapabilityId;
	readonly version: ProtocolVersion;
	readonly transports: readonly TransportKind[];
}

export interface CapabilityManifest {
	readonly producerId: ProducerId;
	readonly displayName: string;
	readonly capabilities: readonly CapabilityDescriptor[];
}

export type ConnectionState =
	| { readonly status: "disconnected" }
	| { readonly status: "connecting"; readonly endpoint: string }
	| {
			readonly status: "connected";
			readonly sessionId: SessionId;
			readonly manifest: CapabilityManifest;
	  }
	| {
			readonly status: "recovering";
			readonly sessionId: SessionId;
			readonly reason: string;
	  }
	| {
			readonly status: "ended";
			readonly sessionId: SessionId;
			readonly reason: "requested" | "producer-exited" | "transport-lost";
	  }
	| { readonly status: "error"; readonly message: string };
