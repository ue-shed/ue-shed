import { Effect, Schema } from "effect";

export class CliSignalError extends Schema.TaggedErrorClass<CliSignalError>()("CliSignalError", {
	signal: Schema.Literals(["SIGINT", "SIGTERM"])
}) {}

/**
 * Waits for a process signal and removes both listeners when the surrounding Effect scope ends.
 * The race winner interrupts the command fiber, which propagates the AbortSignal to external
 * operations such as child processes and fetch requests.
 */
function awaitCliSignal(): Effect.Effect<never, CliSignalError> {
	return Effect.callback((resume, signal) => {
		let resumed = false;
		const handlers = {
			SIGINT: () => {
				if (resumed) return;
				resumed = true;
				resume(Effect.fail(new CliSignalError({ signal: "SIGINT" })));
			},
			SIGTERM: () => {
				if (resumed) return;
				resumed = true;
				resume(Effect.fail(new CliSignalError({ signal: "SIGTERM" })));
			}
		};
		const removeListeners = () => {
			process.removeListener("SIGINT", handlers.SIGINT);
			process.removeListener("SIGTERM", handlers.SIGTERM);
			signal.removeEventListener("abort", removeListeners);
		};
		process.once("SIGINT", handlers.SIGINT);
		process.once("SIGTERM", handlers.SIGTERM);
		signal.addEventListener("abort", removeListeners, { once: true });
		return Effect.sync(removeListeners);
	});
}

export function withCliSignalHandling<A, E, R>(
	command: Effect.Effect<A, E, R>
): Effect.Effect<A, E | CliSignalError, R> {
	return command.pipe(Effect.raceFirst(awaitCliSignal()), Effect.withSpan("cli.signal_scope"));
}
