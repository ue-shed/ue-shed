import { NodeServices } from "@effect/platform-node";
import { CURRENT_PROTOCOL_VERSION } from "@ue-shed/protocol";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import { Cause, Console, Effect, Exit, Layer, Option } from "effect";
import { CliCommandError, CliRuntime } from "./cli-runtime.js";
import {
	CliCommand as CliCommandSchema,
	type CliCommand as CliCommandType
} from "./command-model.js";
import { assetsCommand, inputCommand, textCommand } from "./commands/asset.js";
import { auditCommand } from "./commands/audit.js";
import { authoringCommand } from "./commands/authoring.js";
import { configCommand } from "./commands/config.js";
import { custodianCommand } from "./commands/custodian.js";
import { doctorCommand, versionCommand } from "./commands/core.js";
import { editorCommand } from "./commands/editor.js";
import { mapCommand } from "./commands/map.js";
import { mapCaptureCommand } from "./commands/map-capture.js";
import { niagaraCommand } from "./commands/niagara.js";
import { pluginsCommand } from "./commands/plugins.js";
import { projectIndexCommand } from "./commands/project-index.js";
import { reviewCommand } from "./commands/review.js";
import { scenarioCommand } from "./commands/scenario.js";

export const CliCommand = CliCommandSchema;
export type CliCommand = CliCommandType;

const version = `0.0.0 (protocol ${CURRENT_PROTOCOL_VERSION.major}.${CURRENT_PROTOCOL_VERSION.minor})`;

export const cliCommand = Command.make("ue-shed").pipe(
	Command.withDescription("UE Shed — External tools for Unreal Engine development."),
	Command.withSubcommands([
		versionCommand,
		doctorCommand,
		custodianCommand,
		configCommand,
		editorCommand,
		scenarioCommand,
		auditCommand,
		authoringCommand,
		assetsCommand,
		textCommand,
		inputCommand,
		mapCommand,
		mapCaptureCommand,
		niagaraCommand,
		projectIndexCommand,
		reviewCommand,
		pluginsCommand
	])
);

const cliFormatter = (() => {
	const formatter = CliOutput.defaultFormatter({ colors: false });
	return CliOutput.layer({
		...formatter,
		formatErrors: (errors) =>
			errors.map((error) => `ue-shed: ${formatter.formatCliError(error)}`).join("\n"),
		formatVersion: (name, value) => `${name} ${value}`
	});
})();

function makeBufferedConsole(help: string[], errors: string[]): Console.Console {
	return {
		...globalThis.console,
		log: (...args) => help.push(args.map(String).join(" ")),
		error: (...args) => errors.push(args.map(String).join(" "))
	};
}

function normalizeArgs(args: readonly string[]): ReadonlyArray<string> {
	return args.length === 0 || args[0] === "help" ? ["--help"] : args;
}

export function runCli(args: readonly string[]): Effect.Effect<void, CliCommandError, CliRuntime> {
	return Effect.gen(function* () {
		const runtime = yield* CliRuntime;
		const help: string[] = [];
		const errors: string[] = [];
		const consoleLayer = Layer.succeed(Console.Console, makeBufferedConsole(help, errors));
		const result = yield* Effect.exit(
			Command.runWith(cliCommand, { version })(normalizeArgs(args)).pipe(
				Effect.provide(cliFormatter),
				Effect.provide(consoleLayer),
				Effect.provide(NodeServices.layer)
			)
		);
		if (Exit.isSuccess(result)) {
			for (const message of help) yield* runtime.print(`${message}\n`);
			return;
		}
		const error = Cause.findErrorOption(result.cause);
		if (Option.isSome(error) && CliError.isCliError(error.value)) {
			if (errors.length > 0) {
				yield* runtime.printError(`${errors.join("\n")}\n`);
			} else {
				yield* runtime.printError(`ue-shed: ${error.value.message}\n`);
			}
			yield* runtime.setExitCode(2);
			return;
		}
		if (Option.isSome(error) && error.value instanceof CliCommandError) {
			return yield* Effect.fail<CliCommandError>(error.value);
		}
		return yield* Effect.die(error);
	});
}
