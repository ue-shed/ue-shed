import { describe, expect, it } from "vitest";
import {
	ActorId,
	applyTransformBatch,
	applyWorldObservationEvent,
	CatalogRevision,
	catalogFromSnapshot,
	connectingState,
	materializeObservedActor,
	ObservationSessionId,
	PacketSequence,
	StreamActorIndex,
	WorldActorCatalog,
	WorldActorCatalogEntry,
	WorldActorSnapshot,
	WorldIndexedTransform,
	WorldTransform,
	WorldTransformBatch,
	type ObservedActor,
	type WorldObservationState
} from "./index.js";

function actor(id: string, x: number, y: number, path = `/Game/Fixture.${id}`): ObservedActor {
	return {
		bounds: { center: { x, y, z: 0 }, extent: { x: 10, y: 10, z: 10 } },
		className: "FixtureMover",
		displayName: id,
		id: ActorId.make(id),
		location: { x, y, z: 0 },
		path,
		rotation: { x: 0, y: 0, z: 0 }
	};
}

function snapshot(actors: ReadonlyArray<ObservedActor>): WorldActorSnapshot {
	return WorldActorSnapshot.make({
		actors: [...actors],
		capturedAt: "2026-07-21T00:00:00.000Z",
		mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
		sequence: 1,
		worldKind: "pie",
		worldSeconds: 12.5
	});
}

const sessionA = ObservationSessionId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const sessionB = ObservationSessionId.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const revision1 = CatalogRevision.make(1n);

function liveFromActors(actors: ReadonlyArray<ObservedActor>): WorldObservationState {
	const { catalog, transforms } = catalogFromSnapshot(snapshot(actors), sessionA, revision1);
	const result = applyWorldObservationEvent(connectingState(), {
		_tag: "catalog",
		catalog,
		initialTransforms: transforms
	});
	expect(result.accepted).toBe(true);
	return result.state;
}

function batch(args: {
	readonly sequence: bigint;
	readonly sessionId?: ObservationSessionId;
	readonly revision?: CatalogRevision;
	readonly transforms: ReadonlyArray<{
		readonly streamIndex: number;
		readonly x: number;
		readonly y: number;
	}>;
	readonly producerReplacements?: number;
}): WorldTransformBatch {
	return WorldTransformBatch.make({
		actorsChanged: args.transforms.length,
		actorsSampled: 2,
		producerMonotonicMs: 100,
		producerReplacements: args.producerReplacements ?? 0,
		revision: args.revision ?? revision1,
		sequence: PacketSequence.make(args.sequence),
		sessionId: args.sessionId ?? sessionA,
		transforms: args.transforms.map((item) =>
			WorldIndexedTransform.make({
				streamIndex: StreamActorIndex.make(item.streamIndex),
				transform: WorldTransform.make({
					location: { x: item.x, y: item.y, z: 0 },
					rotation: { x: 0, y: 0, z: 90 }
				})
			})
		),
		worldSeconds: 13
	});
}

describe("world observation catalog materialization", () => {
	it("builds dense stream indices from a discovery snapshot", () => {
		const { catalog, transforms } = catalogFromSnapshot(
			snapshot([actor("a", 1, 2), actor("b", 3, 4)]),
			sessionA,
			revision1
		);
		expect(catalog.entries).toHaveLength(2);
		expect(catalog.entries[0]?.streamIndex).toBe(0);
		expect(catalog.entries[1]?.streamIndex).toBe(1);
		expect(transforms).toHaveLength(2);
		expect(transforms[1]?.transform.location).toEqual({ x: 3, y: 4, z: 0 });
	});

	it("materializes one ObservedActor without rebuilding the catalog", () => {
		const entry = WorldActorCatalogEntry.make({
			bounds: { center: { x: 0, y: 0, z: 0 }, extent: { x: 5, y: 5, z: 5 } },
			className: "FixtureMover",
			displayName: "flyer",
			id: ActorId.make("flyer"),
			path: "/Game/Fixture.flyer",
			streamIndex: StreamActorIndex.make(0)
		});
		const observed = materializeObservedActor(
			entry,
			WorldTransform.make({
				location: { x: 10, y: -20, z: 30 },
				rotation: { x: 1, y: 2, z: 3 }
			})
		);
		expect(observed).toEqual({
			bounds: entry.bounds,
			className: "FixtureMover",
			displayName: "flyer",
			id: entry.id,
			location: { x: 10, y: -20, z: 30 },
			path: entry.path,
			rotation: { x: 1, y: 2, z: 3 }
		});
	});
});

describe("world observation state transitions", () => {
	it("installs a catalog and applies indexed transforms", () => {
		let state = liveFromActors([actor("a", 0, 0), actor("b", 10, 10)]);
		expect(state.status).toBe("live");
		const applied = applyTransformBatch(
			state,
			batch({ sequence: 1n, transforms: [{ streamIndex: 1, x: 40, y: 50 }] })
		);
		expect(applied.accepted).toBe(true);
		expect(applied.sequenceGap).toBe(false);
		state = applied.state;
		expect(state.status).toBe("live");
		if (state.status !== "live") return;
		expect(state.sample.transforms.get(StreamActorIndex.make(0))?.location).toEqual({
			x: 0,
			y: 0,
			z: 0
		});
		expect(state.sample.transforms.get(StreamActorIndex.make(1))?.location).toEqual({
			x: 40,
			y: 50,
			z: 0
		});
		expect(state.sample.lastSequence).toBe(1n);
	});

	it("rejects wrong session, wrong revision, regressing and duplicate sequences", () => {
		const state = liveFromActors([actor("a", 0, 0)]);
		const advanced = applyTransformBatch(
			state,
			batch({ sequence: 2n, transforms: [{ streamIndex: 0, x: 1, y: 1 }] })
		);
		expect(advanced.accepted).toBe(true);

		expect(
			applyTransformBatch(
				advanced.state,
				batch({
					sequence: 3n,
					sessionId: sessionB,
					transforms: [{ streamIndex: 0, x: 2, y: 2 }]
				})
			)
		).toMatchObject({ accepted: false, reason: "wrong_session" });

		expect(
			applyTransformBatch(
				advanced.state,
				batch({
					sequence: 3n,
					revision: CatalogRevision.make(99n),
					transforms: [{ streamIndex: 0, x: 2, y: 2 }]
				})
			)
		).toMatchObject({ accepted: false, reason: "wrong_revision" });

		expect(
			applyTransformBatch(
				advanced.state,
				batch({ sequence: 1n, transforms: [{ streamIndex: 0, x: 2, y: 2 }] })
			)
		).toMatchObject({ accepted: false, reason: "regressing_sequence" });

		expect(
			applyTransformBatch(
				advanced.state,
				batch({ sequence: 2n, transforms: [{ streamIndex: 0, x: 2, y: 2 }] })
			)
		).toMatchObject({ accepted: false, reason: "duplicate_sequence" });
	});

	it("rejects out-of-range and duplicate stream indices in one batch", () => {
		const state = liveFromActors([actor("a", 0, 0)]);
		expect(
			applyTransformBatch(
				state,
				batch({ sequence: 1n, transforms: [{ streamIndex: 3, x: 1, y: 1 }] })
			)
		).toMatchObject({ accepted: false, reason: "out_of_range_index" });

		const duplicate = WorldTransformBatch.make({
			actorsChanged: 2,
			actorsSampled: 1,
			producerMonotonicMs: 1,
			producerReplacements: 0,
			revision: revision1,
			sequence: PacketSequence.make(1n),
			sessionId: sessionA,
			transforms: [
				WorldIndexedTransform.make({
					streamIndex: StreamActorIndex.make(0),
					transform: WorldTransform.make({
						location: { x: 1, y: 1, z: 0 },
						rotation: { x: 0, y: 0, z: 0 }
					})
				}),
				WorldIndexedTransform.make({
					streamIndex: StreamActorIndex.make(0),
					transform: WorldTransform.make({
						location: { x: 2, y: 2, z: 0 },
						rotation: { x: 0, y: 0, z: 0 }
					})
				})
			],
			worldSeconds: 1
		});
		expect(applyTransformBatch(state, duplicate)).toMatchObject({
			accepted: false,
			reason: "duplicate_index"
		});
	});

	it("marks a sequence gap but still applies the newest valid state", () => {
		const state = liveFromActors([actor("a", 0, 0)]);
		const first = applyTransformBatch(
			state,
			batch({ sequence: 1n, transforms: [{ streamIndex: 0, x: 1, y: 1 }] })
		);
		const gapped = applyTransformBatch(
			first.state,
			batch({ sequence: 4n, transforms: [{ streamIndex: 0, x: 9, y: 9 }] })
		);
		expect(gapped.accepted).toBe(true);
		expect(gapped.sequenceGap).toBe(true);
		expect(gapped.state.status).toBe("live");
		if (gapped.state.status !== "live") return;
		expect(gapped.state.sample.health.sequenceGaps).toBe(1);
		expect(gapped.state.sample.transforms.get(StreamActorIndex.make(0))?.location).toEqual({
			x: 9,
			y: 9,
			z: 0
		});
	});

	it("retains the last sample as stale across reset and unavailable", () => {
		let state = liveFromActors([actor("a", 5, 6)]);
		state = applyTransformBatch(
			state,
			batch({ sequence: 1n, transforms: [{ streamIndex: 0, x: 7, y: 8 }] })
		).state;

		const reset = applyWorldObservationEvent(state, {
			_tag: "reset",
			message: "Catalog invalidated.",
			recovery: "Reacquire a complete catalog."
		});
		expect(reset.state.status).toBe("stale");
		if (reset.state.status !== "stale") return;
		expect(reset.state.sample.transforms.get(StreamActorIndex.make(0))?.location).toEqual({
			x: 7,
			y: 8,
			z: 0
		});

		const unavailable = applyWorldObservationEvent(reset.state, {
			_tag: "unavailable",
			message: "Editor closed.",
			recovery: "Open the map and reconnect."
		});
		expect(unavailable.state.status).toBe("unavailable");
		if (unavailable.state.status !== "unavailable") return;
		expect(
			unavailable.state.sample?.transforms.get(StreamActorIndex.make(0))?.location
		).toEqual({
			x: 7,
			y: 8,
			z: 0
		});
	});

	it("resumes live after a fresh catalog replaces a stale sample", () => {
		const stale = applyWorldObservationEvent(liveFromActors([actor("a", 0, 0)]), {
			_tag: "reset",
			message: "PIE started.",
			recovery: "Wait for the new catalog."
		}).state;
		const next = catalogFromSnapshot(
			snapshot([actor("a", 0, 0), actor("b", 1, 1)]),
			sessionB,
			CatalogRevision.make(2n)
		);
		const resumed = applyWorldObservationEvent(stale, {
			_tag: "catalog",
			catalog: next.catalog,
			initialTransforms: next.transforms
		});
		expect(resumed.state.status).toBe("live");
		if (resumed.state.status !== "live") return;
		expect(resumed.state.sample.catalog.sessionId).toBe(sessionB);
		expect(resumed.state.sample.catalog.entries).toHaveLength(2);
	});

	it("enters explicit polling fallback without clearing prior snapshot data", () => {
		const prior = snapshot([actor("a", 1, 2)]);
		const result = applyWorldObservationEvent(connectingState(), {
			_tag: "polling_fallback",
			cadenceHz: 5,
			message: "Named-pipe observation is unavailable on this host.",
			snapshot: prior
		});
		expect(result.state).toEqual({
			status: "polling_fallback",
			cadenceHz: 5,
			message: "Named-pipe observation is unavailable on this host.",
			snapshot: prior
		});
	});

	it("rejects transform batches before a catalog is installed", () => {
		expect(
			applyTransformBatch(
				connectingState(),
				batch({ sequence: 1n, transforms: [{ streamIndex: 0, x: 1, y: 1 }] })
			)
		).toMatchObject({ accepted: false, reason: "no_catalog" });
	});
});

describe("world observation selection across transform updates", () => {
	it("keeps catalog identity stable while only transforms change", () => {
		const state = liveFromActors([actor("keep", 0, 0), actor("move", 10, 10)]);
		if (state.status !== "live") throw new Error("expected live");
		const entry = state.sample.catalog.entries[1];
		expect(entry).toBeDefined();
		if (entry === undefined) return;
		const updated = applyTransformBatch(
			state,
			batch({ sequence: 1n, transforms: [{ streamIndex: 1, x: 100, y: 200 }] })
		);
		expect(updated.state.status).toBe("live");
		if (updated.state.status !== "live") return;
		expect(updated.state.sample.catalog).toBe(state.sample.catalog);
		const transform = updated.state.sample.transforms.get(entry.streamIndex);
		expect(transform).toBeDefined();
		if (transform === undefined) return;
		const selected = materializeObservedActor(entry, transform);
		expect(selected.id).toBe(entry.id);
		expect(selected.location).toEqual({ x: 100, y: 200, z: 0 });
		expect(WorldActorCatalog.make(updated.state.sample.catalog).entries[1]?.displayName).toBe(
			"move"
		);
	});
});
