// The package root loads every Node service module (about 0.75 s of CLI startup).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { runtimeObservabilityLayer } from "@ue-shed/observability";
import { Cause, Effect, Exit, Layer } from "effect";
import {
	cliExit,
	cliFailureCode,
	cliFailureExit,
	cliFailureRecovery,
	readCliFailure
} from "./cli-exit.js";
import { CliCommandError, CliRuntime, CliRuntimeLive, inputIssueDetail } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { withCliSignalHandling } from "./signal.js";

export type CliError = CliCommandError;

export function main(args: readonly string[]): Effect.Effect<void, CliError, CliRuntime> {
	return withCliSignalHandling(runCli(args)).pipe(
		Effect.catchTag("CliSignalError", (error) =>
			Effect.fail(
				new CliCommandError({
					cause: error,
					recovery:
						"Inspect the command context and original cause before deciding whether to retry.",
					retrySafe: false,
					nextStep: "escalate",
					code: "cli_command_failed",
					message: `Received ${error.signal}; operation cancelled.`
				})
			)
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
		const report = readCliFailure(failure.value);
		const code = cliFailureCode(report);
		process.stderr.write(
			`ue-shed: ${failure.value.message}${code === undefined ? "" : ` (${code})`}\n`
		);
		const detail = inputIssueDetail(failure.value);
		if (detail !== undefined) process.stderr.write(`${detail}\n`);
		const recovery = cliFailureRecovery(report);
		if (recovery !== undefined) process.stderr.write(`${recovery}\n`);
		process.exitCode = cliFailureExit(report);
		return;
	}
	process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
	// A crash is never a check's verdict, so it never exits 1.
	process.exitCode = cliExit("crashed");
});
