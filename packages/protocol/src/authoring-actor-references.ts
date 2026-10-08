import { Schema } from "effect";
import { AutomationError, AutomationObjectPath } from "./automation.js";

export const AuthoringActorReferencesContract = Schema.Struct({
	name: Schema.Literal("unreal-authoring-actor-references"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});

export const AuthoringActorReferencesRequest = Schema.Struct({
	contract: AuthoringActorReferencesContract,
	worldObjectPath: AutomationObjectPath,
	tableObjectPath: AutomationObjectPath,
	rowName: Schema.NonEmptyString.check(
		Schema.isMaxLength(1023),
		// eslint-disable-next-line no-control-regex -- Unreal row names cannot contain control characters.
		Schema.isPattern(/^[^\u0000-\u001f]*$/)
	),
	maxActors: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100000 })),
	maxResults: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }))
}).annotate({ identifier: "AuthoringActorReferencesRequest" });
export type AuthoringActorReferencesRequest = typeof AuthoringActorReferencesRequest.Type;

export const AuthoringActorReferencesResult = Schema.Struct({
	contract: AuthoringActorReferencesContract,
	status: Schema.Literals(["ok", "rejected"]),
	worldObjectPath: Schema.String,
	tableObjectPath: Schema.String,
	rowName: Schema.String,
	actorObjectPaths: Schema.Array(Schema.NonEmptyString),
	scannedActorCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	isComplete: Schema.Boolean,
	errors: Schema.Array(AutomationError)
}).annotate({ identifier: "AuthoringActorReferencesResult" });
export type AuthoringActorReferencesResult = typeof AuthoringActorReferencesResult.Type;

export const decodeAuthoringActorReferencesRequest = Schema.decodeUnknownEffect(
	AuthoringActorReferencesRequest
);
export const decodeAuthoringActorReferencesResult = Schema.decodeUnknownEffect(
	AuthoringActorReferencesResult
);
