import {
	ActorId,
	CatalogRevision,
	ObservationSessionId,
	PacketSequence,
	StreamActorIndex,
	type WorldActorSnapshot
} from "@ue-shed/observatory";
import type { SavedWorld } from "@ue-shed/protocol";
import { describe, expect, it } from "vitest";
import {
	WorldScoutRetainedStore,
	collectVisibleIndices,
	contentBounds,
	createWorldScoutPaintGate,
	hitTestVisibleActors,
	nearestVisibleActor,
	panViewportBy,
	paintWorldScout,
	projectVisibleActors,
	stabilizeViewport,
	worldScoutMarkerRadius,
	zoomViewportAt
} from "./world-scout-canvas.js";
import type { WorldScoutPaintContext } from "./world-scout-canvas.js";

function snapshot(actors: WorldActorSnapshot["actors"]): WorldActorSnapshot {
	return {
		actors,
		capturedAt: "2026-07-21T00:00:00.000Z",
		mapPath: "/Game/Fixture",
		sequence: 1,
		worldKind: "editor",
		worldSeconds: 1
	};
}

const actorA = {
	bounds: { center: { x: 0, y: 0, z: 0 }, extent: { x: 10, y: 10, z: 10 } },
	className: "Mover",
	displayName: "Alpha",
	id: ActorId.make("a"),
	location: { x: 0, y: 0, z: 0 },
	path: "/Game/Fixture.Alpha",
	rotation: { x: 0, y: 0, z: 0 }
};

const actorB = {
	...actorA,
	displayName: "Beta",
	id: ActorId.make("b"),
	location: { x: 100, y: 0, z: 0 },
	path: "/Game/Fixture.Beta"
};

describe("world scout canvas store", () => {
	it("installs a snapshot and projects visible actors without per-sample allocations escaping", () => {
		const store = new WorldScoutRetainedStore();
		store.installSnapshot(snapshot([actorA, actorB]));
		collectVisibleIndices(store, "", new Set(), store.visibleIndices);
		expect(store.visibleIndices).toEqual([0, 1]);
		const bounds = contentBounds(store, store.visibleIndices);
		store.viewport = stabilizeViewport(undefined, bounds);
		projectVisibleActors(store, store.viewport, 200, 200, store.visibleIndices);
		expect(store.xs[0]).toBeTypeOf("number");
		expect(store.ys[1]).toBeTypeOf("number");
	});

	it("projects resolved saved actors without inventing a live actor identity", () => {
		const world: SavedWorld = {
			authority: {
				kind: "project_files",
				mapPackage: "/Game/Fixture/Offline/L_OfflineWorld"
			},
			completeness: "partial",
			contract: { name: "unreal-saved-world", version: { major: 1, minor: 0 } },
			diagnostics: [],
			externalActorRoot: "Content/__ExternalActors__/Fixture/Offline/L_OfflineWorld",
			mapPath: "Content/Fixture/Offline/L_OfflineWorld.umap",
			sourceKind: "world_partition",
			actors: [
				{
					actorGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					actorPath:
						"/Game/Fixture/Offline/L_OfflineWorld.L_OfflineWorld:PersistentLevel.Hub",
					classPath: "/Script/Engine.StaticMeshActor",
					label: "Offline Hub",
					packageName: "/Game/__ExternalActors__/Fixture/Offline/L_OfflineWorld/Hub",
					position: { location: { x: 120, y: -80, z: 40 }, status: "resolved" }
				},
				{
					actorPath:
						"/Game/Fixture/Offline/L_OfflineWorld.L_OfflineWorld:PersistentLevel.Missing",
					classPath: "/Script/Engine.StaticMeshActor",
					packageName: "/Game/__ExternalActors__/Fixture/Offline/L_OfflineWorld/Missing",
					position: { status: "missing_root_component" }
				}
			],
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 1,
				scannedPackages: 2
			}
		};
		const store = new WorldScoutRetainedStore();
		store.installSavedWorld(world);

		expect(store.count).toBe(1);
		expect(store.mapPath).toBe("/Game/Fixture/Offline/L_OfflineWorld");
		expect(store.worldKind).toBe("saved");
		expect(store.actorAt(0)).toMatchObject({
			className: "StaticMeshActor",
			displayName: "Offline Hub",
			packageName: "/Game/__ExternalActors__/Fixture/Offline/L_OfflineWorld/Hub"
		});
		expect(store.actorAt(0)?.id).toBeUndefined();
		expect(store.materialize(0)).toBeUndefined();
		expect(store.locationX[0]).toBe(120);
		expect(store.locationY[0]).toBe(-80);
	});

	it("keeps viewport size stable under small motion (hysteresis)", () => {
		const first = stabilizeViewport(undefined, {
			minX: 0,
			maxX: 100,
			minY: 0,
			maxY: 100
		});
		const nudged = stabilizeViewport(first, {
			minX: 2,
			maxX: 102,
			minY: 1,
			maxY: 101
		});
		expect(nudged.size).toBe(first.size);
		expect(nudged.centerX).toBe(first.centerX);
	});

	it("hit-tests the nearest projected actor within the pick radius", () => {
		const store = new WorldScoutRetainedStore();
		store.installSnapshot(snapshot([actorA, actorB]));
		collectVisibleIndices(store, "", new Set(), store.visibleIndices);
		store.viewport = { centerX: 50, centerY: 0, size: 200 };
		projectVisibleActors(store, store.viewport, 200, 200, store.visibleIndices);
		const hit = hitTestVisibleActors(
			store,
			store.visibleIndices.length,
			store.xs[0] ?? 0,
			store.ys[0] ?? 0,
			200,
			200
		);
		expect(hit).toBe(0);
	});

	it("moves keyboard focus among visible actors", () => {
		const store = new WorldScoutRetainedStore();
		store.installSnapshot(snapshot([actorA, actorB]));
		collectVisibleIndices(store, "", new Set(), store.visibleIndices);
		expect(nearestVisibleActor(store, 0, "next")).toBe(1);
		expect(nearestVisibleActor(store, 1, "next")).toBe(0);
		expect(nearestVisibleActor(store, 1, "previous")).toBe(0);
	});

	it("coalesces multiple dirty marks into one scheduled paint", () => {
		const callbacks: Array<() => void> = [];
		let paints = 0;
		const gate = createWorldScoutPaintGate(
			() => {
				paints += 1;
			},
			(callback) => {
				callbacks.push(callback);
				return callbacks.length;
			},
			() => undefined
		);
		gate.markDirty();
		gate.markDirty();
		gate.markDirty();
		expect(gate.scheduledCount()).toBe(1);
		expect(paints).toBe(0);
		callbacks[0]?.();
		expect(paints).toBe(1);
	});

	it("sizes markers larger for sparse views and smaller but still readable for dense fits", () => {
		const sparse = worldScoutMarkerRadius(8, 800, 800, false);
		const dense = worldScoutMarkerRadius(4_096, 800, 800, false);
		const denseSelected = worldScoutMarkerRadius(4_096, 800, 800, true);
		expect(sparse).toBeGreaterThan(dense);
		expect(dense).toBeGreaterThanOrEqual(3.5);
		expect(dense).toBeLessThanOrEqual(8);
		expect(denseSelected).toBeGreaterThan(dense);
		expect(denseSelected).toBeLessThanOrEqual(10);
	});

	it("starts each batched marker as a separate canvas subpath", () => {
		const store = new WorldScoutRetainedStore();
		store.installSnapshot(snapshot([actorA, actorB]));
		store.visibleIndices.push(0, 1);
		store.xs[0] = 20;
		store.ys[0] = 30;
		store.xs[1] = 80;
		store.ys[1] = 70;
		const moves: Array<readonly [number, number]> = [];
		const context: WorldScoutPaintContext = {
			arc: () => undefined,
			beginPath: () => undefined,
			clearRect: () => undefined,
			fill: () => undefined,
			fillStyle: "",
			lineWidth: 0,
			moveTo: (x, y) => moves.push([x, y]),
			stroke: () => undefined,
			strokeStyle: ""
		};

		paintWorldScout(context, store, 2, undefined, 100, 100);

		expect(moves).toHaveLength(2);
		expect(moves[0]?.[0]).toBeGreaterThan(20);
		expect(moves[1]?.[0]).toBeGreaterThan(80);
	});

	it("zooms around a CSS anchor and pans by pixel deltas", () => {
		const start = { centerX: 0, centerY: 0, size: 1_000 };
		const zoomed = zoomViewportAt(start, 200, 200, 100, 100, 2);
		expect(zoomed.size).toBe(500);
		expect(zoomed.centerX).toBeCloseTo(0);
		expect(zoomed.centerY).toBeCloseTo(0);
		const panned = panViewportBy(start, 200, 200, 20, 0);
		expect(panned.centerX).toBeCloseTo(-100);
		expect(panned.size).toBe(1_000);
	});

	it("seeds draw locations from catalog bounds before transforms arrive", () => {
		const store = new WorldScoutRetainedStore();
		store.installCatalog({
			catalog: {
				capturedAt: "2026-07-21T00:00:00.000Z",
				entries: [
					{
						bounds: {
							center: { x: 250, y: -100, z: 40 },
							extent: { x: 10, y: 10, z: 10 }
						},
						className: "Mover",
						displayName: "Seeded",
						id: ActorId.make("seeded"),
						path: "/Game/Fixture.Seeded",
						streamIndex: StreamActorIndex.make(0)
					}
				],
				mapPath: "/Game/Fixture",
				revision: CatalogRevision.make(1n),
				sessionId: ObservationSessionId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
				worldKind: "pie",
				worldSeconds: 0
			},
			health: { producerReplacements: 0, rejectedBatches: 0, sequenceGaps: 0 },
			lastSequence: PacketSequence.make(0n),
			sampleWorldSeconds: 0,
			transforms: new Map()
		});
		expect(store.locationX[0]).toBe(250);
		expect(store.locationY[0]).toBe(-100);
	});
});
