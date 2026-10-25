import { Deferred, Effect, Fiber, Ref, Scope, Exit } from "effect";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type EngineAnswer, NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type { GameTextContract } from "@ue-shed/protocol";
import { openNativeTextQuery } from "./native-query.js";
import { corpus } from "./localization.test-support.js";
import { textCorpusQuery } from "./query.test-support.js";
import type { TextCorpusSearchPage } from "./schema.js";

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
							return outcome(operation, operation.action === "search" ? page : null);
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

describe("bulk reads", () => {
	const configuration = {
		cacheRoot: tmpdir(),
		projectKey: "fixture",
		targetKey: "Game",
		sharedProject: false
	};
	const page = textCorpusQuery(corpus()).search(request);
	const client = (
		name: string,
		calls: string[],
		onDump: (operation: GameTextContract.EngineRequest) => Effect.Effect<void> = () =>
			Effect.void
	) =>
		NativeGameTextEngineClient.of({
			execute: (operation) =>
				Effect.gen(function* () {
					calls.push(
						`${name}:${operation.action}:${"reader" in operation ? operation.reader : ""}`
					);
					if (operation.action === "localization_corpus") {
						yield* onDump(operation);
						yield* Effect.promise(() => writeFile(operation.output, "[]"));
					}
					return outcome(
						operation,
						operation.action === "search"
							? page
							: operation.action === "findings_accept"
								? { acceptance: "acceptance-v1:digest" }
								: null,
						{ reader: `${name}-reader` }
					);
				})
		});

	it("run in their own process, so a dump never holds a search", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const calls: string[] = [];
				const scope = yield* Scope.make();
				const query = yield* openNativeTextQuery({
					configuration,
					generation: "generation",
					joinedKey: "joined",
					bulkEngine: Effect.acquireRelease(
						Effect.sync(() =>
							client("bulk", calls, () =>
								Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release))
								)
							)
						),
						() => Effect.sync(() => calls.push("bulk:process-closed"))
					)
				}).pipe(
					Effect.provideService(NativeGameTextEngineClient, client("main", calls)),
					Effect.provideService(Scope.Scope, scope)
				);
				const dump = yield* query.readLocalizationLines().pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				// The dump is still running in the bulk process; the search answers anyway.
				expect(yield* query.search(request)).toEqual(page);
				yield* Deferred.succeed(release, undefined);
				expect(yield* Fiber.join(dump)).toEqual([]);
				expect(yield* query.readLocalizationLines()).toEqual([]);
				yield* Scope.close(scope, Exit.void);
				// One bulk reader, opened on first use, read with its own handle and closed with
				// the model before its process.
				expect(calls).toEqual([
					"main:open:",
					"bulk:open:",
					"bulk:localization_corpus:bulk-reader",
					"main:search:main-reader",
					"bulk:localization_corpus:bulk-reader",
					"bulk:close:bulk-reader",
					"bulk:process-closed",
					"main:close:main-reader"
				]);
			})
		);
	});

	it("register an acceptance on both readers, since Browse reads it on the interactive one", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const calls: string[] = [];
				const scope = yield* Scope.make();
				const query = yield* openNativeTextQuery({
					configuration,
					generation: "generation",
					joinedKey: "joined",
					bulkEngine: Effect.sync(() => client("bulk", calls))
				}).pipe(
					Effect.provideService(NativeGameTextEngineClient, client("main", calls)),
					Effect.provideService(Scope.Scope, scope)
				);
				expect(yield* query.findingsAccept("findings-v2:layer", [])).toBe(
					"acceptance-v1:digest"
				);
				yield* Scope.close(scope, Exit.void);
				expect(calls.filter((call) => call.includes("findings_accept"))).toEqual([
					"bulk:findings_accept:bulk-reader",
					"main:findings_accept:main-reader"
				]);
			})
		);
	});
	it("releases an acquired bulk process immediately when its reader cannot open", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const calls: string[] = [];
					let releases = 0;
					const bulk = client("bulk", calls);
					const query = yield* openNativeTextQuery({
						configuration,
						generation: "generation",
						joinedKey: "joined",
						bulkEngine: Effect.acquireRelease(
							Effect.succeed(
								NativeGameTextEngineClient.of({
									execute: (operation) =>
										operation.action === "open"
											? Effect.succeed(
													outcome(operation, null, {
														generation: "stale"
													})
												)
											: bulk.execute(operation)
								})
							),
							() =>
								Effect.sync(() => {
									releases++;
								})
						)
					}).pipe(
						Effect.provideService(NativeGameTextEngineClient, client("main", calls))
					);
					expect(yield* query.readLocalizationLines()).toEqual([]);
					expect(releases).toBe(1);
					expect(yield* query.readLocalizationLines()).toEqual([]);
					expect(releases).toBe(1);
					expect(yield* query.search(request)).toEqual(page);
				})
			)
		);
	});

	it("share the interactive reader when the bulk process cannot open", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const calls: string[] = [];
					const query = yield* openNativeTextQuery({
						configuration,
						generation: "generation",
						joinedKey: "joined",
						bulkEngine: Effect.fail("no process")
					}).pipe(
						Effect.provideService(NativeGameTextEngineClient, client("main", calls))
					);
					expect(yield* query.readLocalizationLines()).toEqual([]);
					expect(yield* query.readLocalizationLines()).toEqual([]);
					expect(calls).toEqual([
						"main:open:",
						"main:localization_corpus:main-reader",
						"main:localization_corpus:main-reader"
					]);
				})
			)
		);
	});
});
