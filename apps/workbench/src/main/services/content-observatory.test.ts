import { describe, expect, it } from "@effect/vitest";
import {
	PerforceMapHistory,
	makeMapHistoryTestLayer,
	type MapHistoryShape
} from "@ue-shed/map-history";
import {
	ContentObservatoryHistoryRequest,
	type ContentObservatoryState
} from "@ue-shed/extension-content-observatory/client";
import { Deferred, Effect, Layer, Schema } from "effect";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import {
	WorkbenchContentObservatory,
	WorkbenchContentObservatoryLive
} from "./content-observatory.js";

const request = Schema.decodeUnknownSync(ContentObservatoryHistoryRequest)({
	limits: {
		maxChangelists: 250,
		maxConcurrency: 4,
		maxDurationMs: 120000,
		maxMaterializedFiles: 4000,
		maxPackages: 4000
	},
	mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
	range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" }
});

const history = Schema.decodeUnknownSync(PerforceMapHistory)({
	baseline: { status: "map_not_yet_created" },
	completeness: "complete",
	diagnostics: [],
	mapDepotPath: "//Project/Main/Content/Fixture/History/L_MapHistoryWorld.umap",
	query: {
		limits: request.limits,
		mapPath: request.mapPath,
		projectRoot: "C:/Project",
		range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" }
	},
	revisions: [],
	schemaVersion: 1
});

function stateLayer(source: MapHistoryShape) {
	return WorkbenchContentObservatoryLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				makeMapHistoryTestLayer(source),
				makeWorkbenchConfigurationLayer({
					authoringAsset: { status: "not_configured" },
					expectedProject: { status: "not_configured" },
					project: { projectRoot: "C:/Project", status: "configured" },
					remoteControlEndpoint: "http://127.0.0.1:30001",
					review: { projectRoot: "C:/Project", status: "project_configured" },
					savedWorldMaps: {
						maps: [
							{
								label: "Map History World",
								mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap"
							}
						],
						status: "configured"
					},
					sourceCheckout: { status: "not_configured" },
					textureAuditRules: { status: "not_configured" }
				})
			)
		)
	);
}

function idleProgress() {
	return { phase: "idle" as const, processedChangelists: 0, totalChangelists: 0 };
}

describe("WorkbenchContentObservatory", () => {
	it.effect("stays idle until the renderer explicitly starts a bounded query", () => {
		let calls = 0;
		return Effect.gen(function* () {
			const service = yield* WorkbenchContentObservatory;
			const initial = yield* service.status();
			expect(initial).toMatchObject({
				maps: [{ label: "Map History World" }],
				projectRoot: "C:/Project",
				status: "ready"
			});
			expect(calls).toBe(0);
			yield* service.start(request);
			yield* Effect.yieldNow;
			expect(calls).toBe(1);
		}).pipe(
			Effect.provide(
				stateLayer({
					progress: () => Effect.succeed(idleProgress()),
					readPerforceFastMapHistory: () =>
						Effect.die("Deep History Workbench route must not call Fast History."),
					readPerforceMapHistory: () =>
						Effect.sync(() => {
							calls += 1;
							return history;
						})
				})
			),
			Effect.scoped
		);
	});

	it.effect("interrupts the active reconstruction and reports cancellation", () =>
		Effect.gen(function* () {
			const interrupted = yield* Deferred.make<void>();
			const startedReading = yield* Deferred.make<void>();
			return yield* Effect.gen(function* () {
				const service = yield* WorkbenchContentObservatory;
				const started = yield* service.start(request);
				expect(started.status).toBe("running");
				yield* Deferred.await(startedReading);
				const cancelled = yield* service.cancel();
				expect(cancelled.status).toBe("cancelled");
				yield* Deferred.await(interrupted);
				const afterCancel: ContentObservatoryState = yield* service.status();
				expect(afterCancel.status).toBe("cancelled");
			}).pipe(
				Effect.provide(
					stateLayer({
						progress: () => Effect.succeed(idleProgress()),
						readPerforceFastMapHistory: () =>
							Effect.die("Deep History Workbench route must not call Fast History."),
						readPerforceMapHistory: () =>
							Deferred.succeed(startedReading, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(
									Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)
								)
							)
					})
				)
			);
		}).pipe(Effect.scoped)
	);
});
