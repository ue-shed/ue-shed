import {
	coActivationFromConfigAssets,
	discoverInputPlatforms,
	resolveDefaultContextsFromConfig,
	resolvePlatformViews,
	type CoActivationSourceStatus,
	type EnhancedInputHostAnalysis,
	type EnhancedInputReport,
	type EnhancedInputRunResult
} from "@ue-shed/enhanced-input";
import { ConfigExplorer } from "@ue-shed/config-explorer";
import { AssetReader } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer } from "effect";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchInputAtlasApi {
	readonly configuredScan: () => Effect.Effect<EnhancedInputRunResult>;
}

export class WorkbenchInputAtlas extends Context.Service<
	WorkbenchInputAtlas,
	WorkbenchInputAtlasApi
>()("@ue-shed/workbench/WorkbenchInputAtlas") {}

/**
 * Workbench's own policy for which platform's default contexts it reads: the platform it runs on.
 * Another host can choose differently; the library takes the platform as an argument.
 */
export function workbenchHostPlatform(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "Mac";
	if (platform === "linux") return "Linux";
	return "Windows";
}

export const WorkbenchInputAtlasLive = Layer.effect(
	WorkbenchInputAtlas,
	Effect.gen(function* () {
		const project = yield* WorkbenchProject;
		const configuration = yield* WorkbenchConfiguration;
		const explorer = yield* ConfigExplorer;
		const reader = yield* AssetReader;
		const engineRoot =
			configuration.unrealEngineRoot?.status === "configured"
				? configuration.unrealEngineRoot.path
				: undefined;

		/**
		 * Resolves the co-activation sources and platform views Workbench can read for the selected
		 * project. A source that cannot be read is reported in the result, never a scan failure.
		 */
		const analysis = Effect.fn("Workbench.WorkbenchInputAtlas.analysis")(function* (
			projectRoot: string,
			report: EnhancedInputReport
		) {
			const configAssetSets = coActivationFromConfigAssets(report);
			const configAssetStatus: CoActivationSourceStatus =
				configAssetSets.length > 0
					? {
							source: "config_asset",
							status: "resolved",
							sets: configAssetSets.length,
							detail: "Player mappable input config assets in the scan."
						}
					: {
							source: "config_asset",
							status: "absent",
							detail: "The scan found no config asset with readable contexts."
						};
			const defaults = yield* resolveDefaultContextsFromConfig({
				project: projectRoot,
				platform: workbenchHostPlatform(process.platform),
				...(engineRoot === undefined ? undefined : { engineRoot })
			});
			const platforms = yield* discoverInputPlatforms(projectRoot).pipe(
				Effect.catchTag("EnhancedInputAnalysisError", () => Effect.succeed([]))
			);
			const views = yield* resolvePlatformViews({
				project: projectRoot,
				projectRoot,
				platforms,
				...(engineRoot === undefined ? undefined : { engineRoot })
			});
			return {
				coActivation: {
					sets: [...configAssetSets, ...defaults.sets],
					sources: [
						configAssetStatus,
						defaults.status,
						{
							source: "host_document",
							status: "absent",
							detail: "Workbench reads no host co-activation document; use the CLI's --co-activation."
						}
					]
				},
				platforms: views
			} satisfies EnhancedInputHostAnalysis;
		});

		const configuredScan = Effect.fn("Workbench.WorkbenchInputAtlas.configuredScan")(
			function* () {
				// Without a selected project the route sends users to the shell's project picker.
				const current = yield* project.current();
				if (current.status === "not_configured" || current.status === "cancelled")
					return { status: "not_configured" as const };
				const result = yield* project.inputAtlas();
				if (result.status !== "completed") return result;
				return {
					...result,
					analysis: yield* analysis(result.projectRoot, result.report).pipe(
						Effect.provideService(ConfigExplorer, explorer),
						Effect.provideService(AssetReader, reader)
					)
				};
			}
		);

		return WorkbenchInputAtlas.of({ configuredScan });
	})
);

export function makeWorkbenchInputAtlasTestLayer(
	service: WorkbenchInputAtlasApi
): Layer.Layer<WorkbenchInputAtlas> {
	return Layer.succeed(WorkbenchInputAtlas, WorkbenchInputAtlas.of(service));
}
