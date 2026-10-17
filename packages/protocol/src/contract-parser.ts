import { Effect, Result, Schema } from "effect";
import { ErrorCauseFields, ErrorGuidanceFields } from "./error-guidance.js";

/**
 * An untrusted value violates a named wire or persisted-document contract. `contract` identifies
 * the boundary; `cause` retains the schema issue, including the failing field and expected value.
 * Repeating the same value cannot repair a version or shape mismatch.
 */
export class ContractParseError extends Schema.TaggedError<ContractParseError>()(
	"ContractParseError",
	{
		code: Schema.Literal("invalid_contract"),
		contract: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

const invalidContract = (contract: string, cause: Schema.SchemaError) =>
	new ContractParseError({
		code: "invalid_contract",
		contract,
		message: `The value does not satisfy the ${contract} contract.`,
		recovery:
			"Inspect the failing field in the cause. Correct the input or use matching producer and consumer contract versions before retrying.",
		retrySafe: false,
		nextStep: "fix_input",
		cause
	});

/**
 * Creates a unary parser for an external contract. Unknown fields keep the schema's normal
 * forward-compatible behavior; callers needing strict validation configure the schema itself.
 * Failures carry the contract name and original schema issue instead of exposing SchemaError.
 */
export function contractParser<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	contract: string
) {
	const decode = Schema.decodeUnknownEffect(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the external value boundary.
		input: unknown
	): Effect.Effect<S["Type"], ContractParseError> =>
		decode(input).pipe(Effect.mapError((cause) => invalidContract(contract, cause)));
}

/**
 * Synchronous counterpart for filesystem and recording boundaries that cannot suspend. Throws
 * ContractParseError directly, preserving the same context and schema cause as contractParser.
 */
export function contractParserSync<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	contract: string
) {
	const decode = Schema.decodeUnknownResult(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the external value boundary.
		input: unknown
	): S["Type"] => {
		const result = decode(input);
		if (Result.isFailure(result)) throw invalidContract(contract, result.failure);
		return result.success;
	};
}
