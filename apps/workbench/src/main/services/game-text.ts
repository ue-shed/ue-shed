import { TextCorpusService, type TextCorpusRunResult } from "@ue-shed/game-text";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer } from "effect";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchGameTextShape {
	readonly chooseAndScan: () => Effect.Effect<TextCorpusRunResult>;
	readonly configuredScan: () => Effect.Effect<TextCorpusRunResult>;
}

export class WorkbenchGameText extends Context.Service<WorkbenchGameText, WorkbenchGameTextShape>()(
	"@ue-shed/workbench/WorkbenchGameText"
) {}

function unavailableProject(message: string, recovery: string): TextCorpusRunResult {
	return {
		error: { code: "invalid_project", message, recovery, retrySafe: true },
		status: "failed"
	};
}

export const WorkbenchGameTextLive = Layer.effect(
	WorkbenchGameText,
	Effect.gen(function* () {
		const project = yield* WorkbenchProject;
		const textCorpus = yield* TextCorpusService;

		const runScan = (projectRoot: string, index: SavedAssetScan) =>
			textCorpus.scanFromProjectIndex(index, { projectRoot }).pipe(
				Effect.map((corpus) => ({ corpus, status: "completed" as const })),
				Effect.catch((error) =>
					Effect.succeed({
						error: {
							code: error.code,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						},
						status: "failed" as const
					})
				)
			);

		const configuredScan = Effect.fn("Workbench.WorkbenchGameText.configuredScan")(
			function* () {
				const current = yield* project.current();
				if (current.status === "not_configured" || current.status === "cancelled") {
					return { status: "not_configured" as const };
				}
				if (current.status === "failed") {
					return unavailableProject(current.error.message, current.error.recovery);
				}
				return yield* project.index().pipe(
					Effect.flatMap((index) => runScan(current.project.projectRoot, index)),
					Effect.catch((error) =>
						Effect.succeed(unavailableProject(error.message, error.recovery))
					)
				);
			}
		);

		const chooseAndScan = Effect.fn("Workbench.WorkbenchGameText.chooseAndScan")(function* () {
			const choice = yield* project.choose();
			if (choice.status === "cancelled") return { status: "cancelled" as const };
			if (choice.status === "not_configured") return { status: "not_configured" as const };
			if (choice.status === "failed") {
				return unavailableProject(choice.error.message, choice.error.recovery);
			}
			return yield* project.index().pipe(
				Effect.flatMap((index) => runScan(choice.project.projectRoot, index)),
				Effect.catch((error) =>
					Effect.succeed(unavailableProject(error.message, error.recovery))
				)
			);
		});

		return WorkbenchGameText.of({ chooseAndScan, configuredScan });
	})
);

export function makeWorkbenchGameTextTestLayer(
	service: WorkbenchGameTextShape
): Layer.Layer<WorkbenchGameText> {
	return Layer.succeed(WorkbenchGameText, WorkbenchGameText.of(service));
}
