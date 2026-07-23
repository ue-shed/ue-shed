// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	ActorId,
	CatalogRevision,
	ObservationSessionId,
	PacketSequence,
	WorldIndexedTransform,
	WorldObservationHealth,
	WorldTransform,
	catalogFromSnapshot,
	type ObservedActor,
	type WorldActorSnapshot,
	type WorldObservationState,
	type WorldScoutRefreshRate,
	type WorldScoutResult
} from "@ue-shed/observatory";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MapReviewClientShape } from "./map-review-client.js";
import { shouldRequestFollowUpdate, WorldScout } from "./world-scout.js";

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

function readyResult(snapshot: WorldActorSnapshot): WorldScoutResult {
	return { status: "ready", snapshot };
}

function fallbackObservation(snapshot: WorldActorSnapshot): WorldObservationState {
	return {
		status: "polling_fallback",
		cadenceHz: 5,
		message: "test",
		snapshot
	};
}

function syncPaintScheduler() {
	const queue: Array<() => void> = [];
	return {
		cancel: () => undefined,
		flush: () => {
			while (queue.length > 0) queue.shift()?.();
		},
		schedule: (callback: () => void) => {
			queue.push(callback);
			return queue.length;
		}
	};
}

function mockCanvasContext() {
	HTMLCanvasElement.prototype.getContext = (() =>
		({
			arc: () => undefined,
			beginPath: () => undefined,
			clearRect: () => undefined,
			fill: () => undefined,
			setTransform: () => undefined,
			moveTo: () => undefined,
			stroke: () => undefined,
			fillStyle: "",
			lineWidth: 1,
			strokeStyle: ""
		}) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

mockCanvasContext();

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("WorldScout", () => {
	it("limits Follow actor control updates to five requests per second", () => {
		expect(shouldRequestFollowUpdate(Number.NEGATIVE_INFINITY, 0)).toBe(true);
		expect(shouldRequestFollowUpdate(1_000, 1_199)).toBe(false);
		expect(shouldRequestFollowUpdate(1_000, 1_200)).toBe(true);
	});

	it("defaults to 30 Hz and selects actors from the canvas", async () => {
		let focused: string | undefined;
		const foregroundRequests: Array<boolean> = [];
		const refreshRates: Array<WorldScoutRefreshRate> = [];
		let framed: ObservedActor | undefined;
		const snapshot = {
			actors: [observed],
			capturedAt: "2026-07-18T10:00:00.000Z",
			mapPath: "/Game/Fixture/Observatory",
			sequence: 4,
			worldKind: "editor" as const,
			worldSeconds: 12.5
		};
		const observation = fallbackObservation(snapshot);
		const paint = syncPaintScheduler();
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshot)),
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
			worldObservations: (refreshRate) => {
				refreshRates.push(refreshRate);
				return Stream.make(observation);
			},
			setWorldObservationRate: (refreshRate) =>
				Effect.sync(() => {
					refreshRates.push(refreshRate);
					return refreshRate;
				})
		} satisfies Pick<
			MapReviewClientShape,
			"connectWorld" | "focusActor" | "setWorldObservationRate" | "worldObservations"
		>;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					paintScheduler={paint}
					onActorFocused={(actor) => {
						framed = actor;
					}}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();
		const user = userEvent.setup();
		expect(refreshRates).toEqual([30]);
		const rate = await screen.findByRole("slider", { name: "World refresh rate" });
		expect(rate.getAttribute("max")).toBe("10");
		fireEvent.input(rate, { target: { value: "8" } });
		expect(refreshRates.at(-1)).toBe(8);

		const canvas = await screen.findByRole("application", { name: "Top-down actor map" });
		Object.defineProperty(canvas, "getBoundingClientRect", {
			value: () => ({
				width: 400,
				height: 400,
				left: 0,
				top: 0,
				right: 400,
				bottom: 400,
				x: 0,
				y: 0,
				toJSON: () => undefined
			})
		});
		fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 200, pointerId: 1 });
		fireEvent.pointerUp(canvas, { button: 0, clientX: 200, clientY: 200, pointerId: 1 });
		paint.flush();
		expect(await screen.findByRole("heading", { name: "Orbit 07" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "GO TO ACTOR ↗" }));
		expect(focused).toBe(observed.id);
		expect(foregroundRequests).toEqual([true]);
		expect(framed).toBeDefined();
		expect(screen.getByText("FOCUSED IN UNREAL")).toBeDefined();
	});

	it("keeps the last good world visible while the connection recovers", async () => {
		const snapshot = {
			actors: [observed],
			capturedAt: new Date().toISOString(),
			mapPath: "/Game/Fixture/Observatory",
			sequence: 5,
			worldKind: "editor" as const,
			worldSeconds: 13
		};
		const ready = fallbackObservation(snapshot);
		const unavailable: WorldObservationState = {
			message: "Editor restarted",
			recovery: "Waiting for Remote Control",
			status: "unavailable"
		};
		const paint = syncPaintScheduler();
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshot)),
			focusActor: (actorId) =>
				Effect.succeed({
					actorId,
					authoringSubject: "selected" as const,
					status: "focused" as const
				}),
			worldObservations: () => Stream.make(ready, unavailable)
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					paintScheduler={paint}
					onActorFocused={() => undefined}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();

		expect(await screen.findByText("RECONNECTING")).toBeDefined();
		expect(screen.getByText("/Game/Fixture/Observatory")).toBeDefined();
		expect(screen.getByRole("application", { name: "Top-down actor map" })).toBeDefined();
	});

	it("supports keyboard selection on the canvas application control", async () => {
		const second: ObservedActor = {
			...observed,
			displayName: "Orbit 08",
			id: ActorId.make("/Game/Fixture.Map:PersistentLevel.Orbit_08"),
			location: { x: 220, y: -80, z: 30 },
			path: "/Game/Fixture.Map:PersistentLevel.Orbit_08"
		};
		const snapshot = {
			actors: [observed, second],
			capturedAt: new Date().toISOString(),
			mapPath: "/Game/Fixture/Observatory",
			sequence: 6,
			worldKind: "pie" as const,
			worldSeconds: 14
		};
		const paint = syncPaintScheduler();
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshot)),
			focusActor: (actorId) =>
				Effect.succeed({
					actorId,
					authoringSubject: "runtime_only" as const,
					status: "focused" as const
				}),
			worldObservations: () => Stream.make(fallbackObservation(snapshot))
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					paintScheduler={paint}
					onActorFocused={() => undefined}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();
		const canvas = await screen.findByRole("application", { name: "Top-down actor map" });
		expect(screen.getByLabelText(/^\d+ visible of \d+ observed actors$/)).toBeDefined();
		canvas.focus();
		fireEvent.keyDown(canvas, { key: "ArrowRight" });
		paint.flush();
		expect(await screen.findByRole("heading", { name: /Orbit 0[78]/ })).toBeDefined();
		fireEvent.keyDown(canvas, { key: "Enter" });
		expect(await screen.findByText("FOCUSED RUNTIME ACTOR")).toBeDefined();
	});

	it("reports explicit focus unavailable when Go To and Follow cannot focus", async () => {
		const focusCalls: Array<{ actorId: string; bringToFront: boolean }> = [];
		const snapshot = {
			actors: [observed],
			capturedAt: new Date().toISOString(),
			mapPath: "/Game/Fixture/Observatory",
			sequence: 7,
			worldKind: "editor" as const,
			worldSeconds: 15
		};
		const paint = syncPaintScheduler();
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshot)),
			focusActor: (actorId, bringToFront) =>
				Effect.sync(() => {
					focusCalls.push({ actorId, bringToFront });
					return { actorId, status: "not_supported" as const };
				}),
			worldObservations: () => Stream.make(fallbackObservation(snapshot))
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					paintScheduler={paint}
					onActorFocused={() => undefined}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();
		const canvas = await screen.findByRole("application", { name: "Top-down actor map" });
		canvas.focus();
		fireEvent.keyDown(canvas, { key: "ArrowRight" });
		paint.flush();
		expect(await screen.findByRole("heading", { name: "Orbit 07" })).toBeDefined();
		fireEvent.keyDown(canvas, { key: "Enter" });
		expect(await screen.findByText("FOCUS UNAVAILABLE")).toBeDefined();
		expect(focusCalls).toEqual([{ actorId: observed.id, bringToFront: true }]);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "FOLLOW ACTOR" }));
		expect(await screen.findByText("FOCUS UNAVAILABLE")).toBeDefined();
		expect(screen.getByRole("button", { name: "FOLLOW ACTOR" })).toBeDefined();
		expect(focusCalls).toEqual([
			{ actorId: observed.id, bringToFront: true },
			{ actorId: observed.id, bringToFront: true }
		]);
	});

	it("keeps selection across transform-only updates and coalesces paints", async () => {
		const snapshots: Array<WorldActorSnapshot> = Array.from({ length: 100 }, (_, sequence) => ({
			actors: [
				{
					...observed,
					location: { x: 120 + sequence, y: -80, z: 30 }
				}
			],
			capturedAt: new Date(Date.UTC(2026, 6, 18, 10, 0, sequence % 60)).toISOString(),
			mapPath: "/Game/Fixture/Observatory",
			sequence,
			worldKind: "editor",
			worldSeconds: sequence
		}));
		const frames = snapshots.map(fallbackObservation);
		let scheduled = 0;
		const queue: Array<() => void> = [];
		const paint = {
			cancel: () => undefined,
			flush: () => {
				while (queue.length > 0) queue.shift()?.();
			},
			schedule: (callback: () => void) => {
				scheduled += 1;
				queue.push(callback);
				return scheduled;
			}
		};
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshots[0]!)),
			focusActor: (actorId) =>
				Effect.succeed({
					actorId,
					authoringSubject: "selected" as const,
					status: "focused" as const
				}),
			worldObservations: () => Stream.fromIterable(frames)
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					paintScheduler={paint}
					onActorFocused={() => undefined}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();
		const canvas = await screen.findByRole("application", { name: "Top-down actor map" });
		Object.defineProperty(canvas, "getBoundingClientRect", {
			value: () => ({
				width: 400,
				height: 400,
				left: 0,
				top: 0,
				right: 400,
				bottom: 400,
				x: 0,
				y: 0,
				toJSON: () => undefined
			})
		});
		fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 200, pointerId: 1 });
		fireEvent.pointerUp(canvas, { button: 0, clientX: 200, clientY: 200, pointerId: 1 });
		paint.flush();
		expect(screen.getByText("SELECTED FOR REVIEW")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Orbit 07" })).toBeDefined();
		expect(scheduled).toBeLessThan(frames.length);
		expect(document.querySelectorAll("canvas")).toHaveLength(1);
	});

	it("applies only the renderer batch's changed transforms", async () => {
		const second: ObservedActor = {
			...observed,
			displayName: "Orbit 08",
			id: ActorId.make("/Game/Fixture.Map:PersistentLevel.Orbit_08"),
			location: { x: 220, y: -80, z: 30 },
			path: "/Game/Fixture.Map:PersistentLevel.Orbit_08"
		};
		const snapshot: WorldActorSnapshot = {
			actors: [observed, second],
			capturedAt: new Date().toISOString(),
			mapPath: "/Game/Fixture/Observatory",
			sequence: 1,
			worldKind: "pie",
			worldSeconds: 1
		};
		const built = catalogFromSnapshot(
			snapshot,
			ObservationSessionId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
			CatalogRevision.make(1n)
		);
		const initialTransforms = new Map(
			built.transforms.map((entry) => [entry.streamIndex, entry.transform] as const)
		);
		const secondEntry = built.catalog.entries[1];
		if (secondEntry === undefined) throw new Error("Expected the second fixture actor");
		const changedTransform = WorldIndexedTransform.make({
			streamIndex: secondEntry.streamIndex,
			transform: WorldTransform.make({
				location: { x: 260, y: -80, z: 30 },
				rotation: second.rotation
			})
		});
		const nextTransforms = new Map(initialTransforms);
		nextTransforms.set(changedTransform.streamIndex, changedTransform.transform);
		const health = WorldObservationHealth.make({
			producerReplacements: 0,
			rejectedBatches: 0,
			sequenceGaps: 0
		});
		const initial: WorldObservationState = {
			status: "live",
			sample: {
				catalog: built.catalog,
				health,
				lastSequence: PacketSequence.make(0n),
				sampleWorldSeconds: 1,
				transforms: initialTransforms
			}
		};
		const next = {
			status: "live" as const,
			changedTransforms: [changedTransform],
			sample: {
				catalog: built.catalog,
				health,
				lastSequence: PacketSequence.make(1n),
				sampleWorldSeconds: 2,
				transforms: nextTransforms
			}
		};
		const appliedCounts: number[] = [];
		const paint = syncPaintScheduler();
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshot)),
			focusActor: (actorId) => Effect.succeed({ actorId, status: "not_supported" as const }),
			worldObservations: () => Stream.make(initial, next)
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					onActorFocused={() => undefined}
					onTransformBatchApplied={(count) => appliedCounts.push(count)}
					paintScheduler={paint}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();
		await screen.findByRole("button", { name: "UEShedFixtureMover 2" });
		expect(appliedCounts).toEqual([1]);
	});

	it("reports polling fallback cadence instead of offering the stream max", async () => {
		const snapshot = {
			actors: [observed],
			capturedAt: new Date().toISOString(),
			mapPath: "/Game/Fixture/Observatory",
			sequence: 1,
			worldKind: "editor" as const,
			worldSeconds: 1
		};
		const paint = syncPaintScheduler();
		const client = {
			connectWorld: () => Effect.succeed(readyResult(snapshot)),
			focusActor: (actorId) =>
				Effect.succeed({
					actorId,
					authoringSubject: "selected" as const,
					status: "focused" as const
				}),
			worldObservations: () =>
				Stream.make({
					status: "polling_fallback" as const,
					cadenceHz: 5,
					message: "Named-pipe observation is unavailable on this host.",
					snapshot
				})
		} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<WorldScout
					client={client}
					paintScheduler={paint}
					onActorFocused={() => undefined}
				/>
			</EffectRuntimeProvider>
		));
		paint.flush();
		const rate = await screen.findByRole("slider", { name: "World refresh rate" });
		expect(rate.getAttribute("max")).toBe("10");
		expect(screen.getByText(/FALLBACK 5 HZ/)).toBeDefined();
	});
});
