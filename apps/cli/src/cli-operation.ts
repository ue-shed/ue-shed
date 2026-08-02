import { observeOperation } from "@ue-shed/observability";
import { assetReaderLayer, AssetReaderLive } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { CliCommandError, messageOf } from "./cli-runtime.js";

export function readerLayer(reader?: string) {
	return reader === undefined ? AssetReaderLive : assetReaderLayer({ executable: reader });
}

export function observeCliOperation<A, E, R>(
	command: string,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, CliCommandError, R> {
	return observeOperation(`Cli.${command}`, effect).pipe(
		Effect.withSpan("cli.external_operation", {
			attributes: { "cli.command": command }
		}),
		Effect.mapError((cause) =>
			cause instanceof CliCommandError
				? cause
				: new CliCommandError({ message: messageOf(cause) })
		)
	);
}
