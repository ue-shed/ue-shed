import { Context, Effect, Layer, Schema } from "effect";

export class CliCommandError extends Schema.TaggedErrorClass<CliCommandError>()("CliCommandError", {
	message: Schema.String
}) {}

export interface CliRuntimeShape {
	readonly print: (value: string) => Effect.Effect<void>;
	readonly printError: (value: string) => Effect.Effect<void>;
	readonly setExitCode: (code: number) => Effect.Effect<void>;
}

export class CliRuntime extends Context.Service<CliRuntime, CliRuntimeShape>()(
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
	if (typeof cause === "object" && cause !== null && "message" in cause) {
		return String(cause.message);
	}
	return String(cause);
}

export function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

export function printJson(value: unknown): Effect.Effect<void, never, CliRuntime> {
	return Effect.flatMap(CliRuntime, (runtime) => runtime.print(json(value)));
}
