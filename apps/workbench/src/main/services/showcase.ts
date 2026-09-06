import { AssetReader } from "@ue-shed/unreal-assets";
import { RuntimeHealthService } from "@ue-shed/observability";
import { Context, Effect, Layer } from "effect";
import { LocalFiles } from "../adapters/local-files.js";
import type { ShowcaseContext } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface ShowcaseApi {
	readonly context: () => Effect.Effect<ShowcaseContext>;
}

export class Showcase extends Context.Service<Showcase, ShowcaseApi>()(
	"@ue-shed/workbench/Showcase"
) {}

export const ShowcaseLive = Layer.effect(
	Showcase,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const assetReader = yield* AssetReader;
		const localFiles = yield* LocalFiles;
		const health = yield* RuntimeHealthService;
		const project = yield* WorkbenchProject;

		const projectEvidence = Effect.fn("Workbench.Showcase.projectEvidence")(function* () {
			const current = yield* project.current();
			if (current.status === "not_configured" || current.status === "cancelled") {
				return { status: "not_configured" as const };
			}
			if (current.status === "failed") {
				return {
					message: current.error.message,
					recovery: current.error.recovery,
					status: "failed" as const
				};
			}

			const candidates = yield* Effect.all(
				[
					project.candidateCount("saved_tables"),
					project.candidateCount("enhanced_input"),
					project.candidateCount("game_text"),
					project.candidateCount("texture")
				] as const,
				{ concurrency: 2 }
			).pipe(
				Effect.map(([dataTables, enhancedInput, gameText, textures]) => ({
					dataTablePackages: dataTables,
					enhancedInputPackages: enhancedInput,
					gameTextPackages: gameText,
					status: "ready" as const,
					texturePackages: textures
				})),
				Effect.catch((error) =>
					Effect.succeed({
						message: error.message,
						recovery: error.recovery,
						status: "failed" as const
					})
				)
			);
			return {
				candidates,
				mapCount: current.project.mapCount,
				packageCount: current.project.packageCount,
				projectName: current.project.projectName,
				projectRoot: current.project.projectRoot,
				status: "ready" as const
			};
		});

		const context = Effect.fn("Workbench.Showcase.context")(function* () {
			const [runtimeHealth, reader, evidence] = yield* Effect.all(
				[health.snapshot(), assetReader.source(), projectEvidence()] as const,
				{ concurrency: 3 }
			);
			const projectRoot =
				configuration.project.status === "configured"
					? configuration.project.projectRoot
					: undefined;
			const ruleFile =
				configuration.textureAuditRules.status === "configured"
					? configuration.textureAuditRules.path
					: undefined;
			const projectExists = projectRoot ? yield* localFiles.exists(projectRoot) : false;
			const ruleFileExists = ruleFile ? yield* localFiles.exists(ruleFile) : false;
			return {
				fixtureConfigured: Boolean(
					projectRoot && ruleFile && projectExists && ruleFileExists
				),
				health: runtimeHealth,
				project: evidence,
				...(projectRoot ? { projectRoot } : undefined),
				reader,
				...(ruleFile ? { ruleFile } : undefined)
			} satisfies ShowcaseContext;
		});

		return Showcase.of({ context });
	})
);

export function makeShowcaseTestLayer(service: ShowcaseApi): Layer.Layer<Showcase> {
	return Layer.succeed(Showcase, Showcase.of(service));
}
