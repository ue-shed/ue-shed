import {
	MapHistory,
	ProjectRoot,
	PerforceFastMapHistoryQuery,
	PerforceMapHistoryQuery,
	MapHistoryError
} from "@ue-shed/map-history";
import { AssetReader, type AssetReaderError } from "@ue-shed/unreal-assets";
import type {
	ContentObservatoryHistoryRequest,
	ContentObservatoryProgress,
	ContentObservatoryState
} from "@ue-shed/extension-content-observatory/client";
import { Context, Effect, Fiber, Layer, Option, Ref } from "effect";
import { WorkbenchProject, type WorkbenchProjectShape } from "./project-workspace.js";

export interface WorkbenchContentObservatoryShape {
	readonly cancel: () => Effect.Effect<ContentObservatoryState>;
	readonly start: (
		request: ContentObservatoryHistoryRequest
	) => Effect.Effect<ContentObservatoryState>;
	readonly status: () => Effect.Effect<ContentObservatoryState>;
	readonly targets: (
		mapPath: string
	) => Effect.Effect<
		import("@ue-shed/extension-content-observatory/client").ContentObservatoryTargetCatalog,
		MapHistoryError
	>;
}

export class WorkbenchContentObservatory extends Context.Service<
	WorkbenchContentObservatory,
	WorkbenchContentObservatoryShape
>()("@ue-shed/workbench/WorkbenchContentObservatory") {}

type ActiveJob = Fiber.Fiber<unknown, unknown>;

type SavedProject = Effect.Success<ReturnType<WorkbenchProjectShape["savedProject"]>>;

function readyState(project: SavedProject): Extract<ContentObservatoryState, { status: "ready" }> {
	return {
		maps: project.maps.map((map) => ({ label: map.label, mapPath: map.mapPath })),
		projectRoot: project.projectRoot,
		status: "ready"
	};
}

function errorState(error: MapHistoryError) {
	return {
		kind: error.kind,
		message: error.message,
		recovery: error.recovery,
		retrySafe: error.retrySafe
	};
}

function targetCatalogError(operation: string, error: AssetReaderError): MapHistoryError {
	return new MapHistoryError({
		kind: error.kind === "resource_limit" ? "resource_limit" : "saved_world_decode",
		message: `${operation}: ${error.message}`,
		recovery:
			error.kind === "resource_limit"
				? "Narrow the selected map or raise the saved-world package limit explicitly."
				: "Confirm the selected map's saved files can be read, then retry.",
		retrySafe: error.retrySafe
	});
}

export const WorkbenchContentObservatoryLive = Layer.effect(
	WorkbenchContentObservatory,
	Effect.gen(function* () {
		const mapHistory = yield* MapHistory;
		const assetReader = yield* AssetReader;
		const project = yield* WorkbenchProject;
		const layerScope = yield* Effect.scope;
		const state = yield* Ref.make<ContentObservatoryState>({ status: "not_configured" });
		const activeJob = yield* Ref.make<Option.Option<ActiveJob>>(Option.none());
		const nextJobId = yield* Ref.make(0);

		const interruptActive = Effect.fn("Workbench.ContentObservatory.interruptActive")(
			function* () {
				const current = yield* Ref.getAndSet(activeJob, Option.none());
				if (Option.isSome(current)) yield* Fiber.interrupt(current.value);
			}
		);

		const resolveProjectState = Effect.fn("Workbench.ContentObservatory.resolveProjectState")(
			function* () {
				return yield* project.savedProject().pipe(
					Effect.map(readyState),
					Effect.catch(() => Effect.succeed({ status: "not_configured" as const }))
				);
			}
		);
		const readProgress = Effect.fn("Workbench.ContentObservatory.readProgress")(
			(): Effect.Effect<ContentObservatoryProgress> =>
				Effect.all({
					history: mapHistory.progress(),
					savedWorld: assetReader.savedWorldProgress()
				}).pipe(Effect.map(({ history, savedWorld }) => ({ ...history, savedWorld })))
		);

		const status = Effect.fn("Workbench.ContentObservatory.status")(function* () {
			const current = yield* Ref.get(state);
			const latestProject = yield* resolveProjectState();
			if (latestProject.status === "not_configured") {
				if (current.status === "running") yield* interruptActive();
				yield* Ref.set(state, latestProject);
				return latestProject;
			}
			if (current.status !== "running") {
				if (
					!("projectRoot" in current) ||
					current.projectRoot !== latestProject.projectRoot
				) {
					yield* Ref.set(state, latestProject);
					return latestProject;
				}
				const refreshed = {
					...current,
					maps: latestProject.maps
				} as ContentObservatoryState;
				yield* Ref.set(state, refreshed);
				return refreshed;
			}
			if (current.projectRoot !== latestProject.projectRoot) {
				yield* interruptActive();
				yield* Ref.set(state, latestProject);
				return latestProject;
			}
			const progress = yield* readProgress();
			return yield* Ref.modify(state, (latest) => {
				if (latest.status !== "running" || latest.jobId !== current.jobId) {
					return [latest, latest];
				}
				const refreshed = { ...latest, maps: latestProject.maps, progress } as const;
				return [refreshed, refreshed];
			});
		});

		const targets = Effect.fn("Workbench.ContentObservatory.targets")(function* (
			mapPath: string
		) {
			const selectedProject = yield* project.savedProject().pipe(
				Effect.mapError(
					() =>
						new MapHistoryError({
							kind: "invalid_target",
							message:
								"No Workbench project is configured for current actor discovery.",
							recovery: "Configure a project, then retry loading current actors.",
							retrySafe: false
						})
				)
			);
			if (!selectedProject.maps.some((map) => map.mapPath === mapPath)) {
				return yield* Effect.fail(
					new MapHistoryError({
						kind: "invalid_target",
						message: `Saved map ${mapPath} is not configured for current actor discovery.`,
						recovery: "Choose one of the configured maps, then retry.",
						retrySafe: false
					})
				);
			}
			return yield* assetReader
				.readSavedWorld({
					concurrency: 8,
					mapPath,
					projectRoot: selectedProject.projectRoot
				})
				.pipe(
					Effect.mapError((error) => targetCatalogError("Current actor discovery", error))
				);
		});

		const cancel = Effect.fn("Workbench.ContentObservatory.cancel")(function* () {
			const current = yield* Ref.get(state);
			if (current.status !== "running") return current;
			yield* interruptActive();
			const cancelled: ContentObservatoryState = { ...current, status: "cancelled" };
			yield* Ref.set(state, cancelled);
			return cancelled;
		});

		const start = Effect.fn("Workbench.ContentObservatory.start")(function* (
			request: ContentObservatoryHistoryRequest
		) {
			const selectedProject = yield* resolveProjectState();
			if (selectedProject.status === "not_configured") {
				return selectedProject;
			}
			const maps = selectedProject.maps;
			const projectRoot = selectedProject.projectRoot;
			yield* interruptActive();
			const jobId = `map-history-${(yield* Ref.updateAndGet(nextJobId, (value) => value + 1)).toString()}`;
			const running: ContentObservatoryState = {
				jobId,
				maps,
				progress: yield* readProgress(),
				projectRoot,
				request,
				status: "running"
			};
			yield* Ref.set(state, running);

			const complete = (
				request.mode === "fast"
					? mapHistory.readPerforceFastMapHistory(
							PerforceFastMapHistoryQuery.make({
								limits: request.limits,
								mapPath: request.mapPath,
								mode: "fast",
								projectRoot: ProjectRoot.make(projectRoot),
								range: request.range,
								target: request.target
							})
						)
					: mapHistory.readPerforceMapHistory(
							PerforceMapHistoryQuery.make({
								limits: request.limits,
								mapPath: request.mapPath,
								projectRoot: ProjectRoot.make(projectRoot),
								range: request.range
							})
						)
			).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Ref.set(state, {
							error: errorState(error),
							jobId,
							maps,
							projectRoot,
							request,
							status: "failed"
						}),
					onSuccess: (history) =>
						Ref.set(state, {
							history,
							jobId,
							maps,
							projectRoot,
							request,
							status: "complete"
						})
				}),
				Effect.andThen(Ref.set(activeJob, Option.none()))
			);
			const fiber = yield* complete.pipe(Effect.forkIn(layerScope));
			yield* Ref.set(activeJob, Option.some(fiber));
			return running;
		});

		return WorkbenchContentObservatory.of({ cancel, start, status, targets });
	})
);

export function makeWorkbenchContentObservatoryTestLayer(
	service: WorkbenchContentObservatoryShape
): Layer.Layer<WorkbenchContentObservatory> {
	return Layer.succeed(WorkbenchContentObservatory, WorkbenchContentObservatory.of(service));
}
