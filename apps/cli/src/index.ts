import { NodeServices } from "@effect/platform-node";
import { runtimeObservabilityLayer } from "@ue-shed/observability";
import { Cause, Effect, Exit, Layer } from "effect";
import { CliCommandError, CliRuntime, CliRuntimeLive } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { CliSignalError, withCliSignalHandling } from "./signal.js";

export type CliError = CliCommandError;

export function main(args: readonly string[]): Effect.Effect<void, CliError, CliRuntime> {
	return withCliSignalHandling(runCli(args)).pipe(
		Effect.mapError((error) =>
			error instanceof CliSignalError
				? new CliCommandError({ message: `Received ${error.signal}; operation cancelled.` })
				: error
		),
		Effect.withSpan("cli.command_process")
	);
}

const CliLive = Layer.mergeAll(
	CliRuntimeLive,
	NodeServices.layer,
	runtimeObservabilityLayer({ serviceName: "ue-shed-cli", serviceVersion: "0.0.0" })
);

Effect.runPromiseExit(main(process.argv.slice(2)).pipe(Effect.provide(CliLive))).then((exit) => {
	if (Exit.isSuccess(exit)) return;
	const failure = Cause.findErrorOption(exit.cause);
	if (failure._tag === "Some") {
		process.stderr.write(`ue-shed: ${failure.value.message}\n`);
		process.exitCode = 2;
		return;
	}
	process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
	process.exitCode = 1;
});
