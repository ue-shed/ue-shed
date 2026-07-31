import { describe, expect, it } from "@effect/vitest";
import {
	PerforceFastMapHistory,
	PerforceMapHistory,
	makeMapHistoryTestLayer,
	type MapHistoryShape
} from "@ue-shed/map-history";
import { makeAssetReaderTestLayer, type AssetReaderTestShape } from "@ue-shed/unreal-assets";
import {
	ContentObservatoryHistoryRequest,
	type ContentObservatoryState
} from "@ue-shed/extension-content-observatory/client";
import type { SavedWorld } from "@ue-shed/protocol";
import { Deferred, Effect, Layer, Schema } from "effect";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import {
	WorkbenchContentObservatory,
	WorkbenchContentObservatoryLive
} from "./content-observatory.js";

const request = Schema.decodeUnknownSync(ContentObservatoryHistoryRequest)({
	mode: "deep",
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

const currentWorld: SavedWorld = {
	authority: { kind: "project_files", mapPackage: "/Game/Maps/L_MapHistoryWorld" },
	completeness: "complete",
	contract: { name: "unreal-saved-world", version: { major: 1, minor: 0 } },
	diagnostics: [],
	mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
	actors: [
		{
			actorGuid: "actor-npc-1",
			actorPath: "/Game/Maps/L_MapHistoryWorld.L_MapHistoryWorld:PersistentLevel.Npc",
			classPath: "/Script/Game.Npc",
			label: "North NPC",
			packageName: "/Game/Maps/L_MapHistoryWorld",
			position: { location: { x: 10, y: 20, z: 0 }, status: "resolved" }
		}
	],
	sourceKind: "level",
	summary: { failedPackages: 0, partialPackages: 0, resolvedActors: 1, scannedPackages: 1 }
};
const currentActor = currentWorld.actors[0]!;

const fastRequest = Schema.decodeUnknownSync(ContentObservatoryHistoryRequest)({
	mode: "fast",
	limits: request.limits,
	mapPath: request.mapPath,
	range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" },
	target: { identity: { actorGuid: "actor-npc-1", kind: "actor_guid" }, kind: "actor" }
}) as Extract<ContentObservatoryHistoryRequest, { mode: "fast" }>;

const fastClassRequest = Schema.decodeUnknownSync(ContentObservatoryHistoryRequest)({
	mode: "fast",
	limits: request.limits,
	mapPath: request.mapPath,
	range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" },
	target: { classPath: "/Script/Game.Npc", kind: "actor_class" }
}) as Extract<ContentObservatoryHistoryRequest, { mode: "fast" }>;

const fastHistory = Schema.decodeUnknownSync(PerforceFastMapHistory)({
	baseline: { status: "map_not_yet_created" },
	completeness: "complete",
	coverage: {
		acquiredPackages: [
			{
				depotFileSpec: "//Project/Main/Content/Fixture/History/L_MapHistoryWorld.umap",
				packageName: "/Game/Maps/L_MapHistoryWorld",
				role: "selected_map"
			}
		],
		claimsCompleteMapCoverage: false,
		claimsHistoricalClassCoverage: false,
		investigationTarget: {
			actorGuid: "actor-npc-1",
			actorPath: currentActor.actorPath,
			classPath: currentActor.classPath,
			identity: { actorGuid: "actor-npc-1", kind: "actor_guid" },
			kind: "actor",
			packageName: "/Game/Maps/L_MapHistoryWorld"
		},
		kind: "targeted"
	},
	diagnostics: [],
	mapDepotPath: "//Project/Main/Content/Fixture/History/L_MapHistoryWorld.umap",
	mode: "fast",
	query: {
		limits: fastRequest.limits,
		mapPath: fastRequest.mapPath,
		mode: "fast",
		projectRoot: "C:/Project",
		range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" },
		target: fastRequest.target
	},
	revisions: [],
	schemaVersion: 1
});

function stateLayer(source: MapHistoryShape, savedWorld: SavedWorld | undefined = undefined) {
	return WorkbenchContentObservatoryLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				makeAssetReaderTestLayer({
					discoverAssets: () => Effect.succeed([]),
					discoverTables: () =>
						Effect.succeed({
							diagnostics: [],
							projectRoot: "",
							scannedAssets: 0,
							tables: []
						}),
					readAsset: () => Effect.die("not used"),
					readTable: () => Effect.die("not used"),
					readSavedWorld: () =>
						savedWorld === undefined
							? Effect.die("saved-world target discovery is not used")
							: Effect.succeed(savedWorld),
					source: () => Effect.succeed("path" as const)
				} satisfies AssetReaderTestShape),
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
			expect((yield* service.status()).status).toBe("complete");
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

	it.effect(
		"loads current actors separately and routes Fast History to the targeted reader",
		() => {
			let deepCalls = 0;
			let fastCalls = 0;
			return Effect.gen(function* () {
				const service = yield* WorkbenchContentObservatory;
				const targets = yield* service.targets(request.mapPath);
				expect(targets.actors).toHaveLength(1);
				expect(targets.actors[0]?.label).toBe("North NPC");
				const started = yield* service.start(fastRequest);
				expect(started.status).toBe("running");
				yield* Effect.yieldNow;
				const complete = yield* service.status();
				expect(complete.status).toBe("complete");
				if (complete.status === "complete") {
					expect("mode" in complete.history ? complete.history.mode : undefined).toBe(
						"fast"
					);
				}
				expect(deepCalls).toBe(0);
				expect(fastCalls).toBe(1);
			}).pipe(
				Effect.provide(
					stateLayer(
						{
							progress: () => Effect.succeed(idleProgress()),
							readPerforceFastMapHistory: () =>
								Effect.sync(() => {
									fastCalls += 1;
									return fastHistory;
								}),
							readPerforceMapHistory: () =>
								Effect.sync(() => {
									deepCalls += 1;
									return history;
								})
						},
						currentWorld
					)
				),
				Effect.scoped
			);
		}
	);

	it.effect("passes an actor-class Fast History target to the map-history service", () => {
		let receivedTarget: unknown;
		return Effect.gen(function* () {
			const service = yield* WorkbenchContentObservatory;
			yield* service.start(fastClassRequest);
			yield* Effect.yieldNow;
			expect(receivedTarget).toEqual({ classPath: "/Script/Game.Npc", kind: "actor_class" });
		}).pipe(
			Effect.provide(
				stateLayer(
					{
						progress: () => Effect.succeed(idleProgress()),
						readPerforceFastMapHistory: (query) =>
							Effect.sync(() => {
								receivedTarget = query.target;
								return fastHistory;
							}),
						readPerforceMapHistory: () =>
							Effect.die("Actor-class Fast History must not call Deep History.")
					},
					currentWorld
				)
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
