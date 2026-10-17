import { observeOperation } from "@ue-shed/observability";
import { assetReaderLayer, AssetReaderLive } from "@ue-shed/unreal-assets";
import { Effect, type Scope } from "effect";
import { CliCommandError, isCliCommandError, messageOf } from "./cli-runtime.js";

export function readerLayer(reader?: string) {
	return reader === undefined ? AssetReaderLive : assetReaderLayer({ executable: reader });
}

export function observeCliOperation<A, E, R>(
	command: string,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, CliCommandError, Exclude<R, Scope.Scope>> {
	return observeOperation(`Cli.${command}`, effect).pipe(
		Effect.scoped,
		Effect.withSpan("cli.external_operation", {
			attributes: { "cli.command": command }
		}),
		Effect.mapError((cause) =>
			isCliCommandError(cause)
				? cause
				: new CliCommandError({
						cause: cause,
						recovery:
							"Inspect the command context and original cause before deciding whether to retry.",
						retrySafe: false,
						nextStep: "escalate",
						code: "cli_command_failed",
						message: messageOf(cause)
					})
		)
	);
}
