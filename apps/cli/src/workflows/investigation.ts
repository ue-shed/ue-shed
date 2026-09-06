import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
	readInvestigationPresetJson,
	writeInvestigationFile
} from "@ue-shed/unreal-assets/investigation-files";
import { InvestigationError } from "@ue-shed/unreal-assets/investigation";
import { CliRuntime, json } from "../cli-runtime.js";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

export const runInvestigation = Effect.fn("Cli.workflow.investigation")(
	(command: Extract<CliCommand, { readonly _tag: "InvestigationRun" }>) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const text = yield* Effect.promise(() => import("@ue-shed/game-text"));
				const textures = yield* Effect.promise(() => import("@ue-shed/asset-audits"));
				const input = yield* readInvestigationPresetJson(command.preset);
				const preset = yield* Schema.decodeUnknownEffect(
					Schema.Union([
						text.GameTextInvestigationPreset,
						textures.TextureInvestigationPreset
					])
				)(input).pipe(
					Effect.mapError(
						(cause) =>
							new InvestigationError({
								message: `Invalid investigation preset: ${cause.message}`,
								recovery: "Use a version 1 Game Text or Texture Audit preset."
							})
					)
				);
				const source = {
					projectRoot: resolve(command.projectRoot),
					generation: null,
					authority: "project_files" as const
				};
				const contents = yield* Effect.gen(function* () {
					if (preset.kind === "game_text") {
						const corpus = yield* Effect.flatMap(text.TextCorpusService, (service) =>
							service.scan({ projectRoot: source.projectRoot })
						).pipe(
							Effect.provide(text.TextCorpusServiceLive),
							Effect.provide(readerLayer(command.reader))
						);
						const document = yield* text.exportGameTextInvestigation(
							corpus,
							preset,
							source
						);
						return command.format === "json"
							? json(document)
							: text.gameTextInvestigationCsv(document);
					}
					const report = yield* Effect.flatMap(textures.TextureAudit, (service) =>
						service.scan({ projectRoot: source.projectRoot, rules: preset.rules })
					).pipe(
						Effect.provide(textures.TextureAuditLive),
						Effect.provide(readerLayer(command.reader))
					);
					const document = textures.exportTextureInvestigation(
						textures.textureAuditQuery(report),
						preset,
						source
					);
					return command.format === "json"
						? json(document)
						: textures.textureInvestigationCsv(document);
				});
				if (command.output) yield* writeInvestigationFile(command.output, contents);
				else yield* Effect.flatMap(CliRuntime, (runtime) => runtime.print(contents));
			})
		)
);
