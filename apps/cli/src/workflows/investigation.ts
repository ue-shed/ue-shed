import { refreshCliGameTextIndex } from "./game-text-index.js";
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
				const text = yield* Effect.promise(() => import("@ue-shed/game-text/corpus"));
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
								cause: cause,
								message: `Invalid investigation preset: ${cause.message}`,
								recovery: "Use a version 1 Game Text or Texture Audit preset.",
								retrySafe: true,
								nextStep: "fix_input"
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
						const indexed = yield* refreshCliGameTextIndex(
							{
								projectRoot: source.projectRoot,
								...(preset.query.localization
									? { targetName: preset.query.localization.target }
									: undefined)
							},
							command.reader
						);
						const localized = indexed.query;
						// Replays the Workbench quality list: the same index checks, review file and
						// rules, page by page, without reading the corpus or the join.
						const workspace =
							preset.query.mode === "quality" &&
							preset.query.workspaceFilter !== undefined &&
							preset.query.localization
								? text
										.localizationQualityWorkspaceOf(
											preset.rules
												? (yield* indexed.sourceQuality(
														preset.rules
													)).export("all")
												: undefined,
											yield* indexed.localizationQuality(preset.rules, {
												review: indexed.review.file
											})
										)
										.export({
											target: preset.query.localization.target,
											filter: preset.query.workspaceFilter,
											...(preset.query.localization.culture
												? { culture: preset.query.localization.culture }
												: undefined)
										})
								: undefined;
						const document = yield* text.exportGameTextInvestigation(
							{ sourceQuality: indexed.sourceQuality },
							preset,
							source,
							localized,
							workspace
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
