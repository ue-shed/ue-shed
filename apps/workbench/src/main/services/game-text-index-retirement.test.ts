import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { expect } from "vitest";
import { makeHost, request } from "./game-text-index-lifetime.test-support.js";
import { WorkbenchGameText } from "./game-text.js";
it.live(
	"publishes the replacement before old native reader finalization completes",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("retirement");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				const before = yield* host.search(request);
				if (before.status !== "ready") throw new Error("Expected initial search");
				const id = before.page.units[0]!.id;
				test.armRetirement();
				test.fixture.setSource("Replacement");
				const refresh = yield* host.configuredRefresh().pipe(Effect.forkChild);
				yield* Deferred.await(test.retiring);
				const focus = yield* host.focus({ id, pageSize: 10 });
				expect(focus).toMatchObject({
					status: "found",
					focus: { unit: { source: { value: "Replacement" } } }
				});
				const searched = yield* host.search(request);
				expect(searched).toMatchObject({
					status: "ready",
					page: { units: [{ source: { value: "Replacement" } }] }
				});
				yield* Deferred.succeed(test.allowRetirement, undefined);
				expect((yield* Fiber.join(refresh)).status).toBe("completed");
			}).pipe(
				Effect.ensuring(Deferred.succeed(test.allowRetirement, undefined)),
				Effect.provide(test.layer)
			);
		}),
	15000
);
it.live(
	"keeps an outstanding search pinned while publishing a rescan",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("search");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				const pending = yield* host.search(request).pipe(Effect.forkChild);
				yield* Deferred.await(test.searching);
				test.fixture.setSource("Replacement");
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect(yield* Deferred.isDone(test.retiring)).toBe(false);
				yield* Deferred.succeed(test.allowSearch, undefined);
				expect((yield* Fiber.join(pending)).status).toBe("not_ready");
				yield* Deferred.await(test.retiring);
				expect((yield* host.search(request)).status).toBe("ready");
			}).pipe(
				Effect.ensuring(Deferred.succeed(test.allowSearch, undefined)),
				Effect.provide(test.layer)
			);
		}),
	15000
);
it.live(
	"a rejected prepared refresh preserves the previously published native reader",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("rejected");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				const pending = yield* host.configuredRefresh().pipe(Effect.forkChild);
				yield* Deferred.await(test.prepared);
				yield* Ref.set(test.generation, 1);
				yield* Deferred.succeed(test.allowPublication, undefined);
				expect((yield* Fiber.join(pending)).status).toBe("failed");
				yield* Ref.set(test.generation, 0);
				expect((yield* host.search(request)).status).toBe("ready");
				expect(yield* Deferred.isDone(test.retiring)).toBe(false);
			}).pipe(
				Effect.ensuring(Deferred.succeed(test.allowPublication, undefined)),
				Effect.provide(test.layer)
			);
		}),
	15000
);
