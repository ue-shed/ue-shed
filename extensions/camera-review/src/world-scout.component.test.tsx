// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { ActorId, type ObservedActor, type WorldScoutRefreshRate } from "@ue-shed/observatory";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MapReviewClientShape } from "./map-review-client.js";
import { WorldScout } from "./world-scout.js";

const observed: ObservedActor = {
	bounds: {
		center: { x: 120, y: -80, z: 30 },
		extent: { x: 25, y: 25, z: 30 }
	},
	className: "UEShedFixtureMover",
	displayName: "Orbit 07",
	id: ActorId.make("/Game/Fixture.Map:PersistentLevel.Orbit_07"),
	location: { x: 120, y: -80, z: 30 },
	path: "/Game/Fixture.Map:PersistentLevel.Orbit_07",
	rotation: { x: 0, y: 0, z: 90 }
};

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("WorldScout", () => {
	it("selects a live actor, then focuses or follows it through explicit actions", async () => {
		let focused: string | undefined;
		const foregroundRequests: Array<boolean> = [];
		const refreshRates: Array<WorldScoutRefreshRate> = [];
		let framed: ObservedActor | undefined;
		const result = {
			status: "ready" as const,
			snapshot: {
				actors: [observed],
				capturedAt: "2026-07-18T10:00:00.000Z",
				mapPath: "/Game/Fixture/Observatory",
				sequence: 4,
				worldKind: "editor" as const,
				worldSeconds: 12.5
			}
		};
		const client = {
			connectWorld: () => Effect.succeed(result),
			focusActor: (actorId, bringToFront) =>
				Effect.sync(() => {
					focused = actorId;
					foregroundRequests.push(bringToFront);
					return {
						actorId,
						authoringSubject: "selected" as const,
						status: "focused" as const
					};
				}),
			worldSnapshots: (refreshRate) => {
				refreshRates.push(refreshRate);
				return Stream.make(result);
			}
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldSnapshots">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					onActorFocused={(actor) => {
						framed = actor;
					}}
				/>
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		expect(refreshRates).toEqual([5]);
		const rate = await screen.findByRole("slider", { name: "World refresh rate" });
		fireEvent.input(rate, { target: { value: "30" } });
		expect(refreshRates.at(-1)).toBe(30);
		await user.click(await screen.findByRole("button", { name: "Select Orbit 07" }));
		expect(focused).toBeUndefined();
		await user.click(screen.getByRole("button", { name: "GO TO ACTOR ↗" }));
		expect(focused).toBe(observed.id);
		expect(foregroundRequests).toEqual([true]);
		expect(framed).toBe(observed);
		expect(screen.getByText("FOCUSED IN UNREAL")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "FOLLOW ACTOR" }));
		expect(foregroundRequests).toEqual([true, true]);
		expect(screen.getByRole("button", { name: "STOP FOLLOWING" })).toBeDefined();
	});

	it("keeps the last good world visible while the connection recovers", async () => {
		const ready = {
			status: "ready" as const,
			snapshot: {
				actors: [observed],
				capturedAt: new Date().toISOString(),
				mapPath: "/Game/Fixture/Observatory",
				sequence: 5,
				worldKind: "editor" as const,
				worldSeconds: 13
			}
		};
		const unavailable = {
			message: "Editor restarted",
			recovery: "Waiting for Remote Control",
			status: "unavailable" as const
		};
		const client = {
			connectWorld: () => Effect.succeed(ready),
			focusActor: (actorId) =>
				Effect.succeed({
					actorId,
					authoringSubject: "selected" as const,
					status: "focused" as const
				}),
			worldSnapshots: () => Stream.make(ready, unavailable)
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldSnapshots">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout client={client} onActorFocused={() => undefined} />
			</EffectRuntimeProvider>
		));

		expect(await screen.findByText("RECONNECTING")).toBeDefined();
		expect(screen.getByRole("button", { name: "Select Orbit 07" })).toBeDefined();
		expect(screen.getByText("/Game/Fixture/Observatory")).toBeDefined();
	});

	it("focuses a runtime-only PIE actor without starting editor authoring", async () => {
		const ready = {
			status: "ready" as const,
			snapshot: {
				actors: [observed],
				capturedAt: new Date().toISOString(),
				mapPath: "/Game/Fixture/Observatory",
				sequence: 6,
				worldKind: "pie" as const,
				worldSeconds: 14
			}
		};
		let authoringRequests = 0;
		const client = {
			connectWorld: () => Effect.succeed(ready),
			focusActor: (actorId) =>
				Effect.succeed({
					actorId,
					authoringSubject: "runtime_only" as const,
					status: "focused" as const
				}),
			worldSnapshots: () => Stream.make(ready)
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldSnapshots">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					onActorFocused={() => {
						authoringRequests += 1;
					}}
				/>
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "Select Orbit 07" }));
		await user.click(screen.getByRole("button", { name: "GO TO ACTOR ↗" }));

		expect(await screen.findByText("FOCUSED RUNTIME ACTOR")).toBeDefined();
		expect(authoringRequests).toBe(0);
	});
});
