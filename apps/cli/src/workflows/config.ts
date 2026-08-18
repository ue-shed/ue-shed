import {
	ConfigCompareRequest,
	ConfigExplainRequest,
	ConfigExplorer,
	ConfigExplorerNodeLive
} from "@ue-shed/config-explorer";
import { Effect, Result, Schema } from "effect";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;

function printConfigOutcome<A>(effect: Effect.Effect<A, { readonly code: string }>) {
	return Effect.gen(function* () {
		const runtime = yield* CliRuntime;
		const result = yield* Effect.result(effect);
		if (Result.isFailure(result)) {
			yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
			yield* runtime.setExitCode(2);
			return;
		}
		return yield* printJson(result.success);
	});
}

export const runConfigExplain = Effect.fn("Cli.workflow.config_explain")(
	(command: Command<"ConfigExplain">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(ConfigExplainRequest)({
					project: command.project,
					platform: command.platform,
					section: command.section,
					key: command.key,
					...(command.engineRoot === undefined
						? undefined
						: { engineRoot: command.engineRoot }),
					...(command.family === undefined ? undefined : { family: command.family })
				});
				const explorer = yield* ConfigExplorer;
				return yield* printConfigOutcome(explorer.explain(request));
			}).pipe(Effect.provide(ConfigExplorerNodeLive))
		)
);

export const runConfigCompare = Effect.fn("Cli.workflow.config_compare")(
	(command: Command<"ConfigCompare">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(ConfigCompareRequest)({
					project: command.project,
					leftPlatform: command.leftPlatform,
					rightPlatform: command.rightPlatform,
					section: command.section,
					key: command.key,
					...(command.engineRoot === undefined
						? undefined
						: { engineRoot: command.engineRoot }),
					...(command.family === undefined ? undefined : { family: command.family })
				});
				const explorer = yield* ConfigExplorer;
				return yield* printConfigOutcome(explorer.compare(request));
			}).pipe(Effect.provide(ConfigExplorerNodeLive))
		)
);
