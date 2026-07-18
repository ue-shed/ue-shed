import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { expect } from "vitest";
import { makeUnrealOperationCoordinator } from "./unreal-operation-coordinator.js";

it.effect("coalesces polling while an exclusive operation is pending", () =>
	Effect.gen(function* () {
		const coordinator = yield* makeUnrealOperationCoordinator;
		const releasePoll = yield* Deferred.make<void>();
		const pollFiber = yield* coordinator
			.poll(Deferred.await(releasePoll).pipe(Effect.as("sample")))
			.pipe(Effect.forkChild);
		const exclusiveFiber = yield* coordinator
			.exclusive(Effect.succeed("capture"))
			.pipe(Effect.forkChild);
		yield* Effect.yieldNow;

		const coalesced = yield* coordinator.poll(Effect.succeed("late sample"));
		expect(Option.isNone(coalesced)).toBe(true);

		yield* Deferred.succeed(releasePoll, undefined);
		expect(yield* Fiber.join(pollFiber)).toEqual(Option.some("sample"));
		expect(yield* Fiber.join(exclusiveFiber)).toBe("capture");
	})
);
