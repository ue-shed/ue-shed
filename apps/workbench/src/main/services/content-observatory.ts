import {
	MapHistory,
	ProjectRoot,
	PerforceMapHistoryQuery,
	type MapHistoryError
} from "@ue-shed/map-history";
import type {
	ContentObservatoryHistoryRequest,
	ContentObservatoryState
} from "@ue-shed/extension-content-observatory/client";
import { Context, Effect, Fiber, Layer, Option, Ref } from "effect";
import { WorkbenchConfiguration, type WorkbenchConfigurationShape } from "../workbench-config.js";

export interface WorkbenchContentObservatoryShape {
	readonly cancel: () => Effect.Effect<ContentObservatoryState>;
	readonly start: (
		request: ContentObservatoryHistoryRequest
	) => Effect.Effect<ContentObservatoryState>;
	readonly status: () => Effect.Effect<ContentObservatoryState>;
}

export class WorkbenchContentObservatory extends Context.Service<
	WorkbenchContentObservatory,
	WorkbenchContentObservatoryShape
>()("@ue-shed/workbench/WorkbenchContentObservatory") {}

type ActiveJob = Fiber.Fiber<unknown, unknown>;

function configuredMaps(configuration: WorkbenchConfigurationShape) {
	if (configuration.savedWorldMaps?.status !== "configured") return [];
	return configuration.savedWorldMaps.maps.map((map) => ({
		label: map.label,
		mapPath: map.mapPath
	}));
}

function readyState(configuration: WorkbenchConfigurationShape): ContentObservatoryState {
	if (configuration.project.status !== "configured") return { status: "not_configured" };
	return {
		maps: configuredMaps(configuration),
		projectRoot: configuration.project.projectRoot,
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

export const WorkbenchContentObservatoryLive = Layer.effect(
	WorkbenchContentObservatory,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const mapHistory = yield* MapHistory;
		const layerScope = yield* Effect.scope;
		const maps = configuredMaps(configuration);
		const state = yield* Ref.make<ContentObservatoryState>(readyState(configuration));
		const activeJob = yield* Ref.make<Option.Option<ActiveJob>>(Option.none());
		const nextJobId = yield* Ref.make(0);

		const interruptActive = Effect.fn("Workbench.ContentObservatory.interruptActive")(
			function* () {
				const current = yield* Ref.getAndSet(activeJob, Option.none());
				if (Option.isSome(current)) yield* Fiber.interrupt(current.value);
			}
		);

		const status = Effect.fn("Workbench.ContentObservatory.status")(function* () {
			const current = yield* Ref.get(state);
			if (current.status !== "running") return current;
			const progress = yield* mapHistory.progress();
			const refreshed = { ...current, progress } as const;
			yield* Ref.set(state, refreshed);
			return refreshed;
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
			const project = configuration.project;
			if (project.status !== "configured") return yield* Ref.get(state);
			const projectRoot = project.projectRoot;
			yield* interruptActive();
			const jobId = `map-history-${(yield* Ref.updateAndGet(nextJobId, (value) => value + 1)).toString()}`;
			const query = PerforceMapHistoryQuery.make({
				limits: request.limits,
				mapPath: request.mapPath,
				projectRoot: ProjectRoot.make(projectRoot),
				range: request.range
			});
			const running: ContentObservatoryState = {
				jobId,
				maps,
				progress: yield* mapHistory.progress(),
				projectRoot,
				request,
				status: "running"
			};
			yield* Ref.set(state, running);

			const complete = mapHistory.readPerforceMapHistory(query).pipe(
				Effect.match({
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

		return WorkbenchContentObservatory.of({ cancel, start, status });
	})
);

export function makeWorkbenchContentObservatoryTestLayer(
	service: WorkbenchContentObservatoryShape
): Layer.Layer<WorkbenchContentObservatory> {
	return Layer.succeed(WorkbenchContentObservatory, WorkbenchContentObservatory.of(service));
}
