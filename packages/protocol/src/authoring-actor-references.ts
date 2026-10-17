import { Schema } from "effect";
import { AutomationError, AutomationObjectPath } from "./automation.js";

/** Contract envelope for actor-reference scans; only version 1.0 decodes. */
export const AuthoringActorReferencesContract = Schema.Struct({
	name: Schema.Literal("unreal-authoring-actor-references"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});

/**
 * Asks the editor which loaded actors in one world reference a DataTable row through
 * `FDataTableRowHandle`. `rowName` is 1 to 1023 characters with no control characters;
 * `maxActors` (1 to 100000) and `maxResults` (1 to 10000) bound the scan.
 */
export const AuthoringActorReferencesRequest = Schema.Struct({
	contract: AuthoringActorReferencesContract,
	worldObjectPath: AutomationObjectPath,
	tableObjectPath: AutomationObjectPath,
	rowName: Schema.NonEmptyString.check(
		Schema.isMaxLength(1023),
		// eslint-disable-next-line no-control-regex -- Unreal row names cannot contain control characters.
		Schema.isPattern(/^[^\u0000-\u001f]*$/u)
	),
	maxActors: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100000 })),
	maxResults: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }))
}).annotate({ identifier: "AuthoringActorReferencesRequest" });
export type AuthoringActorReferencesRequest = typeof AuthoringActorReferencesRequest.Type;

/**
 * Outcome of an actor-reference scan over the world's loaded actors only. `isComplete` is false
 * when a bound truncated the scan and always false for a `rejected` request; `errors` explains why.
 */
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

/** Decodes untrusted input; fails with a `SchemaError` when it breaks the request's bounds. */
export const decodeAuthoringActorReferencesRequest = Schema.decodeUnknownEffect(
	AuthoringActorReferencesRequest
);
/** Decodes a producer reply; fails with a `SchemaError` on another contract version or shape. */
export const decodeAuthoringActorReferencesResult = Schema.decodeUnknownEffect(
	AuthoringActorReferencesResult
);
