import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
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

type EditorWorldOpenCommand = Extract<CliCommand, { readonly _tag: "EditorWorldOpen" }>;

export const runEditorWorldOpen = Effect.fn("Cli.workflow.editor_world_open")(
	(command: EditorWorldOpenCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const { EditorWorldControl, EditorWorldControlLive } = yield* Effect.promise(
					() => import("@ue-shed/engine-discovery")
				);
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const response = yield* Effect.gen(function* () {
					const control = yield* EditorWorldControl;
					return yield* control.open({
						endpoint: command.endpoint,
						operationId: command.operationId ?? randomUUID(),
						targetMapPath: command.mapPath
					});
				}).pipe(
					Effect.provide(
						EditorWorldControlLive.pipe(Layer.provide(RemoteControlClientLive))
					)
				);
				yield* printJson(response);
				if (response.outcome === "rejected") yield* runtime.setExitCode(1);
			})
		)
);
