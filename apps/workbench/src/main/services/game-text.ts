import { TextCorpusService, type TextCorpusRunResult } from "@ue-shed/game-text";
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

		const runScan = (projectRoot: string) =>
			textCorpus.scan({ projectRoot }).pipe(
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
				// `savedProject` is the already-built workspace inventory. Text still performs its
				// own selective property decode, but it must use the global project's cached root.
				const selected = yield* project.savedProject().pipe(
					Effect.catch(() =>
						Effect.succeed({
							projectRoot: current.project.projectRoot,
							maps: [] as const
						})
					)
				);
				return yield* runScan(selected.projectRoot);
			}
		);

		const chooseAndScan = Effect.fn("Workbench.WorkbenchGameText.chooseAndScan")(function* () {
			const choice = yield* project.choose();
			if (choice.status === "cancelled") return { status: "cancelled" as const };
			if (choice.status === "not_configured") return { status: "not_configured" as const };
			if (choice.status === "failed") {
				return unavailableProject(choice.error.message, choice.error.recovery);
			}
			return yield* runScan(choice.project.projectRoot);
		});

		return WorkbenchGameText.of({ chooseAndScan, configuredScan });
	})
);

export function makeWorkbenchGameTextTestLayer(
	service: WorkbenchGameTextShape
): Layer.Layer<WorkbenchGameText> {
	return Layer.succeed(WorkbenchGameText, WorkbenchGameText.of(service));
}
