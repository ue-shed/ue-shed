import { describe, expect, it } from "vitest";
import { ActorId, type ObservedActor, WorldScoutRefreshRate, projectActors } from "./index.js";

function actor(id: string, x: number, y: number): ObservedActor {
	return {
		bounds: { center: { x, y, z: 0 }, extent: { x: 10, y: 10, z: 10 } },
		className: "FixtureMover",
		displayName: id,
		id: ActorId.make(id),
		location: { x, y, z: 0 },
		path: `/Game/Fixture.${id}`,
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

describe("world scout refresh rate", () => {
	it("accepts the supported 1-30 Hz range", () => {
		expect(WorldScoutRefreshRate.make(1)).toBe(1);
		expect(WorldScoutRefreshRate.make(30)).toBe(30);
		expect(() => WorldScoutRefreshRate.make(0)).toThrow();
		expect(() => WorldScoutRefreshRate.make(31)).toThrow();
	});
});
