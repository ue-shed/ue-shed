import {
	ActorId,
	CatalogRevision,
	ObservationSessionId,
	PacketSequence,
	StreamActorIndex,
	WorldTransform,
	applyWorldObservationEvent,
	catalogFromSnapshot,
	connectingState,
	type WorldObservationState
} from "@ue-shed/observatory/browser";
import { describe, expect, it } from "vitest";
import { reconcileSparseTransformChanges } from "./map-review-client.js";

describe("reconcileSparseTransformChanges", () => {
	it("restores every changed index when the renderer's sliding queue skips an event", () => {
		const sessionId = ObservationSessionId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		const revision = CatalogRevision.make(1n);
		const snapshot = {
			actors: [
				{
					bounds: { center: { x: 0, y: 0, z: 0 }, extent: { x: 1, y: 1, z: 1 } },
					className: "FixtureMover",
					displayName: "A",
					id: ActorId.make("a"),
					location: { x: 0, y: 0, z: 0 },
					path: "/Game/Fixture.A",
					rotation: { x: 0, y: 0, z: 0 }
				},
				{
					bounds: { center: { x: 10, y: 0, z: 0 }, extent: { x: 1, y: 1, z: 1 } },
					className: "FixtureMover",
					displayName: "B",
					id: ActorId.make("b"),
					location: { x: 10, y: 0, z: 0 },
					path: "/Game/Fixture.B",
					rotation: { x: 0, y: 0, z: 0 }
				}
			],
			capturedAt: "2026-07-22T00:00:00.000Z",
			mapPath: "/Game/Fixture",
			sequence: 0,
			worldKind: "pie" as const,
			worldSeconds: 0
		};
		const { catalog, transforms } = catalogFromSnapshot(snapshot, sessionId, revision);
		const initial = applyWorldObservationEvent(connectingState(), {
			_tag: "catalog",
			catalog,
			initialTransforms: transforms
		}).state;
		const move = (state: WorldObservationState, sequence: bigint, index: number, x: number) =>
			applyWorldObservationEvent(state, {
				_tag: "transforms",
				batch: {
					actorsChanged: 1,
					actorsSampled: 2,
					producerMonotonicMs: Number(sequence),
					producerReplacements: 0,
					revision,
					sequence: PacketSequence.make(sequence),
					sessionId,
					transforms: [
						{
							streamIndex: StreamActorIndex.make(index),
							transform: WorldTransform.make({
								location: { x, y: 0, z: 0 },
								rotation: { x: 0, y: 0, z: 0 }
							})
						}
					],
					worldSeconds: Number(sequence)
				}
			}).state;
		const afterFirstMove = move(initial, 1n, 0, 1);
		const afterSecondMove = move(afterFirstMove, 2n, 1, 11);

		const reconciled = reconcileSparseTransformChanges(initial, {
			...afterSecondMove,
			changedTransforms: [
				{
					streamIndex: StreamActorIndex.make(1),
					transform: WorldTransform.make({
						location: { x: 11, y: 0, z: 0 },
						rotation: { x: 0, y: 0, z: 0 }
					})
				}
			]
		});

		expect(reconciled.changedTransforms?.map((entry) => entry.streamIndex)).toEqual([0, 1]);
	});
});
