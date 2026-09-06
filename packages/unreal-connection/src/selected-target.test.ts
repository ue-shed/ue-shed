import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import { makeSelectedUnrealTarget } from "./selected-target.js";

it.effect(
	"pins in-flight operations and their children while new work follows target selection",
	() =>
		Effect.gen(function* () {
			const target = yield* makeSelectedUnrealTarget("http://editor-a:30010");
			const started = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const operation = yield* target
				.withCurrent(
					Effect.gen(function* () {
						const before = yield* target.endpoint();
						yield* Deferred.succeed(started, undefined);
						yield* Deferred.await(resume);
						const child = yield* target
							.withCurrent(target.endpoint())
							.pipe(Effect.forkChild);
						return [before, yield* target.endpoint(), yield* Fiber.join(child)];
					})
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(started);
			yield* target.select("http://editor-b:31010");
			expect(yield* target.withCurrent(target.endpoint())).toBe("http://editor-b:31010");
			yield* Deferred.succeed(resume, undefined);
			expect(yield* Fiber.join(operation)).toEqual(Array(3).fill("http://editor-a:30010"));
		})
);

it.effect("keeps independent hosts' target selections isolated", () =>
	Effect.gen(function* () {
		const first = yield* makeSelectedUnrealTarget("http://editor-a:30010");
		const second = yield* makeSelectedUnrealTarget("http://editor-b:30010");
		yield* first.select("http://editor-c:30010");
		expect(yield* second.endpoint()).toBe("http://editor-b:30010");
		expect(
			yield* first.withCurrent(
				second.withCurrent(Effect.all([first.endpoint(), second.endpoint()]))
			)
		).toEqual(["http://editor-c:30010", "http://editor-b:30010"]);
	})
);
