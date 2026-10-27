import { ErrorNextStep, ContractParseError } from "@ue-shed/protocol";
import { ErrorCauseFields } from "@ue-shed/protocol";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

export class CliCommandError extends Schema.TaggedError<CliCommandError>()("CliCommandError", {
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: ErrorNextStep,
	code: Schema.Literal("cli_command_failed"),
	message: Schema.String,
	...ErrorCauseFields
}) {}

/** Matches a {@link CliCommandError} by its tag and schema, never by `instanceof`. */
export const isCliCommandError = Schema.is(CliCommandError);

/** Node errno code of a filesystem failure, when the cause carries one. */
export function errnoCode(cause: unknown): string | undefined {
	return cause instanceof Object && "code" in cause && Predicate.isString(cause.code)
		? cause.code
		: undefined;
}

/**
 * Classified message for a JSON input file the user named: missing, unreadable, or not JSON. The
 * original failure stays in the error's `cause`.
 */
export function jsonInputFileMessage(label: string, path: string, cause: unknown): string {
	if (
		cause instanceof SyntaxError ||
		Schema.isSchemaError(cause) ||
		Schema.is(ContractParseError)(cause)
	) {
		return `${label} ${path} is not valid JSON.`;
	}
	const code = errnoCode(cause);
	if (code === "ENOENT") return `${label} ${path} does not exist.`;
	if (code === "EACCES" || code === "EPERM") {
		return `Permission was denied to read ${label} ${path}.`;
	}
	if (code === "EISDIR") return `${label} ${path} is a directory, not a file.`;
	return `Could not read ${label} ${path}.`;
}

/** Issue detail the CLI prints under a classified message when the user's input failed a schema. */
export function inputIssueDetail(error: { readonly cause?: unknown }): string | undefined {
	const cause = Schema.is(ContractParseError)(error.cause) ? error.cause.cause : error.cause;
	return Schema.isSchemaError(cause) ? cause.message : undefined;
}

export interface CliRuntimeApi {
	readonly print: (value: string) => Effect.Effect<void>;
	readonly printError: (value: string) => Effect.Effect<void>;
	readonly setExitCode: (code: number) => Effect.Effect<void>;
}

export class CliRuntime extends Context.Service<CliRuntime, CliRuntimeApi>()(
	"@ue-shed/cli/CliRuntime"
) {}

export const CliRuntimeLive = Layer.succeed(
	CliRuntime,
	CliRuntime.of({
		print: Effect.fn("CliRuntime.print")((value) =>
			Effect.sync(() => process.stdout.write(value)).pipe(Effect.asVoid)
		),
		printError: Effect.fn("CliRuntime.printError")((value) =>
			Effect.sync(() => process.stderr.write(value)).pipe(Effect.asVoid)
		),
		setExitCode: Effect.fn("CliRuntime.setExitCode")((code) =>
			Effect.sync(() => {
				process.exitCode = code;
			})
		)
	})
);

export function messageOf(cause: unknown): string {
	if (cause instanceof Object && "message" in cause) {
		return String(cause.message);
	}
	return String(cause);
}

export function json<Value>(value: Value): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

export function printJson<Value>(value: Value): Effect.Effect<void, never, CliRuntime> {
	return Effect.flatMap(CliRuntime, (runtime) => runtime.print(json(value)));
}
