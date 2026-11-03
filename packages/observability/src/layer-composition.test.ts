import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { expect } from "vitest";

class Resource extends Context.Service<Resource, { readonly identity: object }>()(
	"LayerComposition.Resource"
) {}
class Consumer extends Context.Service<Consumer, { readonly resource: object }>()(
	"LayerComposition.Consumer"
) {}

function resources(events: string[]) {
	const identity = {};
	const resource = Layer.effect(
		Resource,
		Effect.acquireRelease(
			Effect.sync(() => {
				events.push("resource acquired");
				return { identity };
			}),
			() => Effect.sync(() => events.push("resource released"))
		)
	);
	const consumer = Layer.effect(
		Consumer,
		Effect.gen(function* () {
			const upstream = yield* Resource;
			return yield* Effect.acquireRelease(
				Effect.sync(() => {
					events.push("consumer acquired");
					return { resource: upstream.identity };
				}),
				() => Effect.sync(() => events.push("consumer released"))
			);
		})
	);
	return { consumer, identity, resource };
}

it.effect("provides dependencies before consumers and releases them after consumers", () =>
	Effect.gen(function* () {
		const events: string[] = [];
		const fixture = resources(events);
		yield* Effect.gen(function* () {
			const consumer = yield* Consumer;
			const resource = yield* Resource;
			expect(consumer.resource).toBe(resource.identity);
			expect(resource.identity).toBe(fixture.identity);
			events.push("work");
		}).pipe(Effect.provide(Layer.provideMerge(fixture.consumer, fixture.resource)));
		expect(events).toEqual([
			"resource acquired",
			"consumer acquired",
			"work",
			"consumer released",
			"resource released"
		]);
	})
);

it.effect("shares a repeated resource between exposed services and hidden dependencies", () =>
	Effect.gen(function* () {
		const events: string[] = [];
		const fixture = resources(events);
		const consumer = fixture.consumer.pipe(Layer.provide(fixture.resource));
		yield* Effect.gen(function* () {
			expect((yield* Consumer).resource).toBe((yield* Resource).identity);
		}).pipe(Effect.provide(Layer.provideMerge(consumer, fixture.resource)));
		expect(events.filter((event) => event === "resource acquired")).toHaveLength(1);
		expect(events.filter((event) => event === "resource released")).toHaveLength(1);
	})
);

it.effect("releases dependencies on acquisition failure without replacing the original error", () =>
	Effect.gen(function* () {
		const events: string[] = [];
		const fixture = resources(events);
		const original = { _tag: "AcquisitionRefused" } as const;
		const refused = Layer.effect(Consumer, Effect.fail(original));
		const failure = yield* Consumer.pipe(
			Effect.provide(Layer.provideMerge(refused, fixture.resource)),
			Effect.flip
		);
		expect(failure).toBe(original);
		expect(events).toEqual(["resource acquired", "resource released"]);
	})
);

it.effect("interrupts work and finalizes its consumers before their shared resources", () =>
	Effect.gen(function* () {
		const events: string[] = [];
		const fixture = resources(events);
		const started = yield* Deferred.make<void>();
		const fiber = yield* Effect.gen(function* () {
			yield* Consumer;
			yield* Deferred.succeed(started, undefined);
			return yield* Effect.never;
		}).pipe(
			Effect.provide(Layer.provideMerge(fixture.consumer, fixture.resource)),
			Effect.forkChild
		);
		yield* Deferred.await(started);
		yield* Fiber.interrupt(fiber);
		const exit = yield* Fiber.await(fiber);
		expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
		expect(events).toEqual([
			"resource acquired",
			"consumer acquired",
			"consumer released",
			"resource released"
		]);
	})
);

it.effect("keeps nearer service overrides for work without changing acquisition context", () =>
	Effect.gen(function* () {
		const outer = {};
		const inner = {};
		const dependency = Layer.succeed(Resource, { identity: outer });
		const override = Layer.effectContext(
			Effect.gen(function* () {
				expect((yield* Resource).identity).toBe(outer);
				return Context.make(Resource, { identity: inner });
			})
		);
		const actual = yield* Resource.pipe(
			Effect.provide(Layer.provideMerge(override, dependency))
		);
		expect(actual.identity).toBe(inner);
	})
);
