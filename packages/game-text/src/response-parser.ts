import { Effect, Schema } from "effect";

/**
 * A result a host sent (over Workbench IPC, a CLI JSON file or another transport) that does not
 * match the Game Text contract. The client and host disagree about the contract, so repeating the
 * same call returns the same mismatch.
 */
export class GameTextResponseError extends Schema.TaggedError<GameTextResponseError>()(
	"GameTextResponseError",
	{
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		code: Schema.Literal("invalid_response"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/**
 * A unary parser for one Game Text result: it decodes the host's encoded value and fails with a
 * `GameTextResponseError` naming `subject`, keeping the schema issue as its cause.
 */
export function gameTextResponseParser<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	subject: string
) {
	const decode = Schema.decodeUnknownEffect(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary: it decodes the host's value here.
		encoded: unknown
	): Effect.Effect<S["Type"], GameTextResponseError> =>
		decode(encoded).pipe(
			Effect.mapError(
				(cause) =>
					new GameTextResponseError({
						nextStep: "escalate",
						code: "invalid_response",
						message: `The ${subject} does not match the Game Text contract.`,
						recovery:
							"Run the host and the client from the same UE Shed version, then retry.",
						retrySafe: false,
						cause
					})
			)
		);
}
