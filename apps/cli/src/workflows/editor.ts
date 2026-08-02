import { Effect, Layer } from "effect";
import { CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type EditorPlaySessionCommand = Extract<CliCommand, { readonly _tag: "EditorPlaySession" }>;

export const runEditorPlaySession = Effect.fn("Cli.workflow.editor_play_session")(
	(command: EditorPlaySessionCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const { EditorPlaySession, EditorPlaySessionLive } = yield* Effect.promise(
					() => import("@ue-shed/engine-discovery")
				);
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const session = yield* EditorPlaySession;
					if (command.action === "status") {
						return yield* session
							.status(command.endpoint)
							.pipe(Effect.flatMap(printJson));
					}
					const response =
						command.action === "start"
							? yield* session.start(command.endpoint, "play")
							: command.action === "simulate"
								? yield* session.start(command.endpoint, "simulate")
								: command.action === "pause"
									? yield* session.pause(command.endpoint)
									: command.action === "resume"
										? yield* session.resume(command.endpoint)
										: yield* session.stop(command.endpoint);
					yield* printJson(response);
					if (response.outcome === "rejected") yield* runtime.setExitCode(1);
				});
				return yield* program.pipe(
					Effect.provide(
						EditorPlaySessionLive.pipe(Layer.provide(RemoteControlClientLive))
					)
				);
			})
		)
);
