import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	ActorId,
	Observatory,
	ObservatoryLive,
	actorInstanceKey,
	type ObservedActor,
	WorldScoutRefreshRate,
	projectActors,
	remapObservedActorId
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

describe("actor spatial projection", () => {
	it("maps Unreal X/Y positions into a padded top-down canvas", () => {
		const projection = projectActors([
			actor("south-west", -100, -50),
			actor("north-east", 100, 50)
		]);
		const southWest = projection.points[0];
		const northEast = projection.points[1];
		expect(southWest?.xPercent).toBeLessThan(northEast?.xPercent ?? 0);
		expect(southWest?.yPercent).toBeGreaterThan(northEast?.yPercent ?? 100);
		expect(projection.width / projection.height).toBeCloseTo(220 / 120);
	});

	it("keeps a single actor centered without zero-sized extents", () => {
		const projection = projectActors([actor("only", 42, -7)]);
		expect(projection.points[0]?.xPercent).toBeCloseTo(50);
		expect(projection.points[0]?.yPercent).toBeCloseTo(50);
		expect(projection.width).toBeGreaterThan(0);
		expect(projection.height).toBeGreaterThan(0);
	});
});

describe("actor instance identity", () => {
	it("matches the same placed actor across editor and PIE path prefixes", () => {
		const editor = actor(
			"editor",
			0,
			0,
			"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.UEShedFixtureMover_57"
		);
		const pie = actor(
			"pie",
			0,
			0,
			"/Game/Fixture/Cameras/UEDPIE_0_L_CameraLoad.L_CameraLoad:PersistentLevel.UEShedFixtureMover_57"
		);
		expect(actorInstanceKey(editor)).toBe(actorInstanceKey(pie));
	});

	it("remaps a scout selection when PLAY swaps actor ids", () => {
		const editorId = ActorId.make("editor-path");
		const pieId = ActorId.make("pie-path");
		const editorActors = [
			actor("editor-path", 0, 0, "/Game/Map.Map:PersistentLevel.Flying_03")
		];
		const pieActors = [
			actor("pie-path", 10, 10, "/Game/UEDPIE_0_Map.Map:PersistentLevel.Flying_03")
		];
		expect(remapObservedActorId(editorId, editorActors, pieActors)).toBe(pieId);
		expect(remapObservedActorId(pieId, pieActors, editorActors)).toBe(editorId);
	});
});

describe("world scout refresh rate", () => {
	it("accepts the supported 1-60 Hz range", () => {
		expect(WorldScoutRefreshRate.make(1)).toBe(1);
		expect(WorldScoutRefreshRate.make(30)).toBe(30);
		expect(WorldScoutRefreshRate.make(60)).toBe(60);
		expect(() => WorldScoutRefreshRate.make(0)).toThrow();
		expect(() => WorldScoutRefreshRate.make(61)).toThrow();
	});
});

describe("coded stream failures", () => {
	const cadence = (value: Schema.Json) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const observatory = yield* Observatory;
				return yield* observatory.setObservationCadence(
					"http://127.0.0.1:30010",
					Schema.decodeUnknownSync(WorldScoutRefreshRate)(10)
				);
			}).pipe(
				Effect.provide(ObservatoryLive),
				Effect.provide(makeRemoteControlClientTestLayer(() => Effect.succeed(value)))
			)
		);

	it("keeps the plugin's code and retry safety", async () => {
		await expect(
			cadence({
				status: "failed",
				code: "stream_inactive",
				message: "No actor observation stream is active.",
				recovery: "Start actor observation before changing its sampling cadence.",
				retrySafe: false
			})
		).rejects.toMatchObject({ code: "stream_inactive", retrySafe: false });
	});

	it("reads an older plugin's prose-only failure as retry-safe", async () => {
		await expect(
			cadence({ status: "failed", message: "Missing cadenceHz.", recovery: "Provide one." })
		).rejects.toMatchObject({ message: "Missing cadenceHz.", retrySafe: true });
	});
});
