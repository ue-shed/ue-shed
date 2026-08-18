import { Context, Effect, Layer, Schema } from "effect";

export class CliCommandError extends Schema.TaggedErrorClass<CliCommandError>()("CliCommandError", {
	message: Schema.String
}) {}

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
