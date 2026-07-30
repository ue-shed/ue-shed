import {
	textCorpusQuery,
	TextCorpusService,
	type TextCorpusFocusRequest,
	type TextCorpusFocusResult,
	type TextCorpusQuery,
	type TextCorpusQueryRunResult,
	type TextCorpusRunResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "@ue-shed/game-text";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Ref } from "effect";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchGameTextShape {
	readonly chooseAndRefresh: () => Effect.Effect<TextCorpusQueryRunResult>;
	readonly chooseAndScan: () => Effect.Effect<TextCorpusRunResult>;
	readonly configuredRefresh: () => Effect.Effect<TextCorpusQueryRunResult>;
	readonly configuredScan: () => Effect.Effect<TextCorpusRunResult>;
	readonly focus: (request: TextCorpusFocusRequest) => Effect.Effect<TextCorpusFocusResult>;
	readonly search: (request: TextCorpusSearchRequest) => Effect.Effect<TextCorpusSearchResult>;
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

function unavailableQueryProject(message: string, recovery: string): TextCorpusQueryRunResult {
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
		const queryModel = yield* Ref.make<TextCorpusQuery | undefined>(undefined);
		const scanCorpus = (projectRoot: string, index: SavedAssetScan) =>
			textCorpus.scanFromProjectIndex(index, { projectRoot });

		const runScan = (projectRoot: string, index: SavedAssetScan) =>
			scanCorpus(projectRoot, index).pipe(
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
		const runRefresh = (projectRoot: string, index: SavedAssetScan) =>
			scanCorpus(projectRoot, index).pipe(
				Effect.flatMap((corpus) => {
					const next = textCorpusQuery(corpus);
					return Ref.set(queryModel, next).pipe(
						Effect.as({ summary: next.summary(), status: "completed" as const })
					);
				}),
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

		const configuredRefresh = Effect.fn("Workbench.WorkbenchGameText.configuredRefresh")(
			function* () {
				const current = yield* project.current();
				if (current.status === "not_configured" || current.status === "cancelled") {
					return { status: "not_configured" as const };
				}
				if (current.status === "failed") {
					return unavailableQueryProject(current.error.message, current.error.recovery);
				}
				return yield* project.index().pipe(
					Effect.flatMap((index) => runRefresh(current.project.projectRoot, index)),
					Effect.catch((error) =>
						Effect.succeed(unavailableQueryProject(error.message, error.recovery))
					)
				);
			}
		);

		const chooseAndRefresh = Effect.fn("Workbench.WorkbenchGameText.chooseAndRefresh")(
			function* () {
				const choice = yield* project.choose();
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				if (choice.status === "not_configured")
					return { status: "not_configured" as const };
				if (choice.status === "failed") {
					return unavailableQueryProject(choice.error.message, choice.error.recovery);
				}
				return yield* project.index().pipe(
					Effect.flatMap((index) => runRefresh(choice.project.projectRoot, index)),
					Effect.catch((error) =>
						Effect.succeed(unavailableQueryProject(error.message, error.recovery))
					)
				);
			}
		);

		const search = Effect.fn("Workbench.WorkbenchGameText.search")(
			(request: TextCorpusSearchRequest) =>
				Ref.get(queryModel).pipe(
					Effect.map((model) =>
						model === undefined
							? { status: "not_ready" as const }
							: { page: model.search(request), status: "ready" as const }
					)
				)
		);

		const focus = Effect.fn("Workbench.WorkbenchGameText.focus")(
			(request: TextCorpusFocusRequest) =>
				Ref.get(queryModel).pipe(
					Effect.map((model) => {
						if (model === undefined) return { status: "not_ready" as const };
						const result = model.focus(request);
						return result === undefined
							? { status: "not_found" as const }
							: { focus: result, status: "found" as const };
					})
				)
		);

		return WorkbenchGameText.of({
			chooseAndRefresh,
			chooseAndScan,
			configuredRefresh,
			configuredScan,
			focus,
			search
		});
	})
);

export function makeWorkbenchGameTextTestLayer(
	service: Pick<WorkbenchGameTextShape, "chooseAndScan" | "configuredScan"> &
		Partial<Omit<WorkbenchGameTextShape, "chooseAndScan" | "configuredScan">>
): Layer.Layer<WorkbenchGameText> {
	return Layer.succeed(
		WorkbenchGameText,
		WorkbenchGameText.of({
			chooseAndRefresh: () => Effect.succeed({ status: "not_configured" }),
			configuredRefresh: () => Effect.succeed({ status: "not_configured" }),
			focus: () => Effect.succeed({ status: "not_ready" }),
			search: () => Effect.succeed({ status: "not_ready" }),
			...service
		})
	);
}
