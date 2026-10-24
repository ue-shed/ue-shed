import { ContractParseError } from "@ue-shed/protocol";
import { ErrorCauseFields } from "@ue-shed/protocol";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

export class CliCommandError extends Schema.TaggedError<CliCommandError>()("CliCommandError", {
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
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

/**
 * `json(value)`'s text in pieces: each top-level member, and each element of the `parts` arrays,
 * is serialized on its own. JSON strings never hold a raw line break, so nested lines are indented
 * by prefixing every line break.
 */
function* jsonPieces<Value extends object>(
	value: Value,
	parts: ReadonlySet<string>
): Generator<string> {
	// `JSON.stringify`'s member order, without the members it leaves out.
	const members: (
		| { readonly key: string; readonly text: string }
		| { readonly key: string; readonly items: readonly unknown[] }
	)[] = [];
	for (const [key, item] of Object.entries(value)) {
		if (parts.has(key) && Array.isArray(item)) members.push({ key, items: item });
		else {
			const text = JSON.stringify(item, null, "\t");
			if (text !== undefined) members.push({ key, text });
		}
	}
	if (members.length === 0) {
		yield "{}\n";
		return;
	}
	yield "{";
	for (const [index, member] of members.entries()) {
		yield `${index ? "," : ""}\n\t${JSON.stringify(member.key)}: `;
		if ("text" in member) yield member.text.replaceAll("\n", "\n\t");
		else if (member.items.length === 0) yield "[]";
		else {
			yield "[";
			for (const [at, item] of member.items.entries())
				yield `${at ? "," : ""}\n\t\t${(JSON.stringify(item, null, "\t") ?? "null").replaceAll("\n", "\n\t\t")}`;
			yield "\n\t]";
		}
	}
	yield "\n}\n";
}

/**
 * `printJson` for a report whose text is longer than one string can be: the same bytes, written in
 * chunks of about 1 MiB, with each element of the `parts` arrays serialized on its own.
 */
export function printJsonInParts<Value extends object>(
	value: Value,
	parts: readonly (keyof Value & string)[]
): Effect.Effect<void, never, CliRuntime> {
	return Effect.gen(function* () {
		const runtime = yield* CliRuntime;
		let chunk = "";
		for (const piece of jsonPieces(value, new Set<string>(parts))) {
			chunk += piece;
			if (chunk.length >= 1 << 20) {
				yield* runtime.print(chunk);
				chunk = "";
			}
		}
		yield* runtime.print(chunk);
	});
}
