import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import { GameTextIndexError } from "./index-contract.js";
import { makeRetainedGameTextIndexWith } from "./index-retained.js";

it.effect("releases a failed retained acquisition before returning its typed error", () =>
	Effect.gen(function* () {
		let releases = 0;
		const failure = new GameTextIndexError({
			nextStep: "escalate",
			retrySafe: false,
			code: "index_failed",
			operation: "prepare",
			message: "Preparation failed.",
			recovery: "Retry preparation."
		});
		const retained = yield* makeRetainedGameTextIndexWith(() =>
			Effect.acquireRelease(Effect.void, () =>
				Effect.sync(() => {
					releases++;
				})
			).pipe(Effect.andThen(Effect.fail(failure)))
		);
		const result = yield* retained.refresh({ projectRoot: "fixture" }).pipe(Effect.flip);
		expect(result).toBe(failure);
		expect(releases).toBe(1);
	}).pipe(Effect.scoped)
);

it.effect("releases an interrupted retained acquisition before its borrower exits", () =>
	Effect.gen(function* () {
		let releases = 0;
		const acquired = yield* Deferred.make<void>();
		const retained = yield* makeRetainedGameTextIndexWith(() =>
			Effect.gen(function* () {
				yield* Effect.acquireRelease(Effect.void, () =>
					Effect.sync(() => {
						releases++;
					})
				);
				yield* Deferred.succeed(acquired, undefined);
				return yield* Effect.never;
			})
		);
		const fiber = yield* retained.refresh({ projectRoot: "fixture" }).pipe(Effect.forkScoped);
		yield* Deferred.await(acquired);
		yield* Fiber.interrupt(fiber);
		expect(releases).toBe(1);
	}).pipe(Effect.scoped)
);
