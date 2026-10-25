import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { type EngineAnswer, NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type { GameTextContract } from "@ue-shed/protocol";
import { openNativeTextQuery } from "./native-query.js";
import { corpus } from "./localization.test-support.js";
import { textCorpusQuery } from "./query.test-support.js";
import type { TextCorpusSearchPage } from "./schema.js";

const request = { query: "", capability: "all" as const, pageSize: 1 };
const configuration = {
	cacheRoot: tmpdir(),
	projectKey: "fixture",
	targetKey: "Game",
	sharedProject: false
};
const page = textCorpusQuery(corpus()).search(request);

/** An engine answer: `open`'s reply, or `reply` as the answer's one part. */
function outcome(
	request: GameTextContract.EngineRequest,
	reply: TextCorpusSearchPage | { readonly acceptance: string } | null,
	opened: Partial<GameTextContract.OpenReply> = {}
): EngineAnswer {
	const part =
		request.action === "open"
			? { reader: "reader", generation: "generation", joinedKey: "joined", ...opened }
			: reply;
	return {
		parts: part === null ? [] : [new TextEncoder().encode(JSON.stringify(part)).buffer],
		profile: {
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
		}
	};
}

/** An engine that answers every request, recording `action:reader`; `hold` runs before a dump. */
const engine = (calls: string[], hold: Effect.Effect<void> = Effect.void) =>
	NativeGameTextEngineClient.of({
		execute: (operation) =>
			Effect.gen(function* () {
				calls.push(`${operation.action}:${"reader" in operation ? operation.reader : ""}`);
				if (operation.action === "localization_corpus") {
					yield* hold;
					yield* Effect.promise(() => writeFile(operation.output, "[]"));
				}
				return outcome(
					operation,
					operation.action === "search"
						? page
						: operation.action === "findings_accept"
							? { acceptance: "acceptance-v1:digest" }
							: null
				);
			})
	});

it("reads concurrently through one reader, and closes it with the model", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const calls: string[] = [];
			const scope = yield* Scope.make();
			const query = yield* openNativeTextQuery({
				configuration,
				generation: "generation",
				joinedKey: "joined"
			}).pipe(
				Effect.provideService(
					NativeGameTextEngineClient,
					engine(
						calls,
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release))
						)
					)
				),
				Effect.provideService(Scope.Scope, scope)
			);
			const dump = yield* query.readLocalizationLines().pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			// The dump is still running; the search answers anyway.
			expect(yield* query.search(request)).toEqual(page);
			yield* Deferred.succeed(release, undefined);
			expect(yield* Fiber.join(dump)).toEqual([]);
			// An acceptance is registered once: every read uses the same reader.
			expect(yield* query.findingsAccept("findings-v2:layer", [])).toBe(
				"acceptance-v1:digest"
			);
			yield* Scope.close(scope, Exit.void);
			expect(calls).toEqual([
				"open:",
				"localization_corpus:reader",
				"search:reader",
				"findings_accept:reader",
				"close:reader"
			]);
		})
	);
});

it("interrupts a read at once, and keeps serving reads", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const interrupted = yield* Ref.make(false);
				let searches = 0;
				const client = NativeGameTextEngineClient.of({
					execute: (operation) =>
						Effect.gen(function* () {
							if (operation.action === "search" && searches++ === 0)
								yield* Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.onInterrupt(() => Ref.set(interrupted, true))
								);
							return outcome(operation, operation.action === "search" ? page : null);
						})
				});
				const query = yield* openNativeTextQuery({
					configuration,
					generation: "generation",
					joinedKey: "joined"
				}).pipe(Effect.provideService(NativeGameTextEngineClient, client));
				const first = yield* query.search(request).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(first);
				// The interruption reached the engine call, which cancels the request there.
				expect(yield* Ref.get(interrupted)).toBe(true);
				expect(yield* query.search(request)).toEqual(page);
			})
		)
	);
});

it("refuses a reader of a different snapshot, and closes it", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const calls: string[] = [];
				const answer = engine(calls);
				const failure = yield* openNativeTextQuery({
					configuration,
					generation: "generation",
					joinedKey: "joined"
				}).pipe(
					Effect.provideService(
						NativeGameTextEngineClient,
						NativeGameTextEngineClient.of({
							execute: (operation) =>
								operation.action === "open"
									? Effect.sync(() => {
											calls.push("open:");
											return outcome(operation, null, {
												generation: "stale"
											});
										})
									: answer.execute(operation)
						})
					),
					Effect.scoped,
					Effect.flip
				);
				expect(failure.code).toBe("index_failed");
				expect(calls).toEqual(["open:", "close:reader"]);
			})
		)
	);
});
