import { Argument, Command } from "effect/unstable/cli";
import { optionalFlag, optionalValue } from "./options.js";
import { runEditorPlaySession, runEditorWorldOpen } from "../workflows/editor.js";

const playActions = ["status", "start", "simulate", "pause", "resume", "stop"] as const;
type PlayAction = (typeof playActions)[number];

function makePlayCommand(action: PlayAction) {
	return Command.make(action, { endpoint: Argument.string("endpoint") }, ({ endpoint }) =>
		runEditorPlaySession({ _tag: "EditorPlaySession", action, endpoint })
	).pipe(Command.withDescription(`Run the editor play-session ${action} operation.`));
}

export const editorCommand = Command.make("editor").pipe(
	Command.withDescription("Control a connected Unreal Editor session."),
	Command.withSubcommands([
		Command.make("play").pipe(
			Command.withDescription("Inspect or control Play In Editor."),
			Command.withSubcommands(playActions.map(makePlayCommand))
		),
		Command.make("world").pipe(
			Command.withDescription("Control the editor world without player input."),
			Command.withSubcommands([
				Command.make(
					"open",
					{
						endpoint: Argument.string("endpoint"),
						mapPath: Argument.string("map-path"),
						operationId: optionalFlag("operation")
					},
					({ endpoint, mapPath, operationId }) => {
						const operation = optionalValue(operationId);
						return runEditorWorldOpen({
							_tag: "EditorWorldOpen",
							endpoint,
							mapPath,
							...(operation === undefined ? {} : { operationId: operation })
						});
					}
				).pipe(
					Command.withDescription(
						"Open an explicit /Game/ map, refusing active play or dirty world packages."
					)
				)
			])
		)
	])
);
