import { Deferred, Effect, Fiber, Ref, Scope, Exit } from "effect";
import { expect, it } from "vitest";
import { NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type { GameTextEngineOutcome, GameTextEngineRequest } from "@ue-shed/protocol";
import { openNativeTextQuery } from "./native-query.js";
import { corpus } from "./localization.test-support.js";
import { textCorpusQuery } from "./query.test-support.js";

const request = { query: "", capability: "all" as const, pageSize: 1 };

it("cancels callers promptly, skips canceled queued reads and preserves an admitted native read", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const canceled = yield* Ref.make(false);
				const calls: string[] = [];
				const page = textCorpusQuery(corpus()).search(request);
				const client = NativeGameTextEngineClient.of({
					execute: (operation) =>
						Effect.gen(function* () {
							calls.push(operation.action);
							if (
								operation.action === "search" &&
								calls.filter((action) => action === "search").length === 1
							) {
								yield* Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.onInterrupt(() => Ref.set(canceled, true))
								);
							}
							return outcome(
								operation,
								operation.action === "search" ? JSON.stringify(page) : null
							);
						})
				});
				const query = yield* openNativeTextQuery({
					configuration: {
						cacheRoot: ".",
						projectKey: "fixture",
						targetKey: "Game",
						sharedProject: false
					},
					generation: "generation",
					joinedKey: "joined"
				}).pipe(Effect.provideService(NativeGameTextEngineClient, client));
				const first = yield* query.search(request).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(first);
				expect(yield* Ref.get(canceled)).toBe(false);
				const queued = yield* query.search(request).pipe(Effect.forkChild);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(queued);
				yield* Deferred.succeed(release, undefined);
				expect(yield* query.search(request)).toEqual(page);
				expect(calls.filter((action) => action === "search")).toHaveLength(2);
				expect(yield* Ref.get(canceled)).toBe(false);
			})
		)
	);
});

it("closing the model interrupts an active read before releasing its native reader", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const canceled = yield* Ref.make(false);
				const scope = yield* Scope.make();
				const client = NativeGameTextEngineClient.of({
					execute: (operation) =>
						Effect.gen(function* () {
							if (operation.action === "search") {
								return yield* Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.onInterrupt(() => Ref.set(canceled, true))
								);
							}
							if (operation.action === "close")
								expect(yield* Ref.get(canceled)).toBe(true);
							return outcome(operation, null);
						})
				});
				const query = yield* openNativeTextQuery({
					configuration: {
						cacheRoot: ".",
						projectKey: "fixture",
						targetKey: "Game",
						sharedProject: false
					},
					generation: "generation",
					joinedKey: "joined"
				}).pipe(
					Effect.provideService(NativeGameTextEngineClient, client),
					Effect.provideService(Scope.Scope, scope)
				);
				const caller = yield* query.search(request).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* Scope.close(scope, Exit.void);
				yield* Fiber.await(caller);
				expect(yield* Ref.get(canceled)).toBe(true);
			})
		)
	);
});

function outcome(request: GameTextEngineRequest, payload: string | null): GameTextEngineOutcome {
	return {
		action: request.action,
		capabilities: ["game_text_engine_v1"],
		reader: request.action === "open" ? "reader" : null,
		generation: request.action === "open" ? "generation" : null,
		joinedKey: request.action === "open" ? "joined" : null,
		payload,
		stageSeconds: {},
		io: {
			opens: 0,
			sectionLoads: 0,
			storedBytes: 0,
			rawBytes: 0,
			fullVerifies: 0,
			indexBytes: 0,
			writtenBytes: 0
		}
	};
}
