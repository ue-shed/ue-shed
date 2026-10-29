import { EngineInstallationDiscoveryLive } from "@ue-shed/engine";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { AssetReader, nativeGameTextEngineClientLayer } from "@ue-shed/unreal-assets";
import { scanCodeText } from "@ue-shed/code";
import { Effect, Layer } from "effect";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";
import { resolveCodeEngine } from "./code-engine.js";

type CodeTextCommand = Extract<CliCommand, { readonly _tag: "CodeText" }>;

export const runCodeText = Effect.fn("Cli.workflow.code_text")((command: CodeTextCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const { engine, engineRoot } = yield* resolveCodeEngine(command);
			const scanned = yield* scanCodeText({
				projectRoot: command.projectRoot,
				engine,
				engineRoot,
				targets: command.targets,
				cacheRoot: command.cacheRoot,
				refreshEngineWrappers: command.refreshEngineWrappers
			});
			yield* printJson(scanned);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					EngineInstallationDiscoveryLive,
					LocalizationEvidenceNodeLive,
					Layer.unwrap(
						Effect.gen(function* () {
							const reader = yield* AssetReader;
							return nativeGameTextEngineClientLayer(yield* reader.configuration());
						})
					).pipe(Layer.provide(readerLayer(command.reader)))
				)
			)
		)
	)
);
