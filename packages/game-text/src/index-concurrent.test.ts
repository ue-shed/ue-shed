import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { expect } from "vitest";
import { GameTextIndexSteps } from "./index-steps.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { GameTextIndexQuery, nativeIndexQueryLayer } from "./index-query-native.js";
import { AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";

it.live(
	"interrupting prepare finalizes both branches before releasing the writer session",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const readEntered = yield* Deferred.make<void>();
			const importEntered = yield* Deferred.make<void>();
			const events: string[] = [];
			fixture.pauseReads(
				Effect.gen(function* () {
					yield* Deferred.succeed(readEntered, undefined);
					yield* Effect.never;
				}).pipe(Effect.ensuring(Effect.sync(() => events.push("read-finalized"))))
			);
			const underlying = yield* GameTextIndexBuilder.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			const queries = yield* GameTextIndexQuery.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			const implementation = Layer.succeed(
				GameTextIndexBuilder,
				GameTextIndexBuilder.of({
					...underlying,
					withSession: (request, effect) =>
						underlying
							.withSession(request, effect)
							.pipe(
								Effect.ensuring(Effect.sync(() => events.push("session-released")))
							),
					importLocalizationTarget: (input) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(importEntered, undefined);
							yield* Effect.never;
							return yield* underlying.importLocalizationTarget(input);
						}).pipe(Effect.ensuring(Effect.sync(() => events.push("import-finalized"))))
				})
			).pipe(Layer.merge(Layer.succeed(GameTextIndexQuery, queries)));
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const running = yield* steps.prepareTarget(fixture.request).pipe(Effect.forkChild);
				yield* Deferred.await(readEntered);
				yield* Deferred.await(importEntered);
				yield* Fiber.interrupt(running).pipe(Effect.timeout("1 second"));
				expect(events).toContain("read-finalized");
				expect(events).toContain("import-finalized");
				expect(events.at(-1)).toBe("session-released");
				expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true);
			}).pipe(Effect.provide(fixture.layer(fixture.source, implementation)));
		}).pipe(Effect.scoped),
	10_000
);

it.live(
	"a localization failure interrupts a concurrent package read with the same error",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const readEntered = yield* Deferred.make<void>();
			const holdRead = yield* Deferred.make<void>();
			const allowFailure = yield* Deferred.make<void>();
			fixture.pauseReads(
				Deferred.succeed(readEntered, undefined).pipe(
					Effect.andThen(Deferred.await(holdRead))
				)
			);
			const underlying = yield* GameTextIndexBuilder.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			const queries = yield* GameTextIndexQuery.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			let armed = false;
			const implementation = Layer.succeed(
				GameTextIndexBuilder,
				GameTextIndexBuilder.of({
					...underlying,
					importLocalizationTarget: (input) =>
						armed
							? Deferred.await(allowFailure).pipe(
									Effect.andThen(underlying.importLocalizationTarget(input))
								)
							: underlying.importLocalizationTarget(input)
				})
			).pipe(Layer.merge(Layer.succeed(GameTextIndexQuery, queries)));
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const project = yield* steps.openProject({
					projectRoot: fixture.projectRoot
				});
				const expected = yield* steps
					.importTarget(project, { targetName: "Missing" })
					.pipe(Effect.flip);
				armed = true;
				const running = yield* steps
					.prepareTarget({ projectRoot: fixture.projectRoot, targetName: "Missing" })
					.pipe(Effect.forkChild);
				yield* Deferred.await(readEntered);
				yield* Deferred.succeed(allowFailure, undefined);
				const exit = yield* Fiber.await(running);
				expect(Exit.isFailure(exit)).toBe(true);
				const error = yield* Fiber.join(running).pipe(Effect.flip);
				expect(error).toMatchObject({
					_tag: expected._tag,
					code: expected.code,
					message: expected.message
				});
				expect(fixture.packageReads()).toBeGreaterThanOrEqual(1);
				fixture.pauseReads(Effect.void);
				const recovered = yield* steps.refreshProject({
					projectRoot: fixture.projectRoot
				});
				expect(recovered.packageKey).toBeTruthy();
			}).pipe(Effect.provide(fixture.layer(fixture.source, implementation)));
		}).pipe(Effect.scoped),
	30_000
);

it.live(
	"a localization publish between the package read and its publication matches a sequential build",
	() =>
		Effect.gen(function* () {
			const concurrentFixture = yield* makeIndexRegressionFixture();
			const sequentialFixture = yield* makeIndexRegressionFixture();
			const readEntered = yield* Deferred.make<void>();
			const holdRead = yield* Deferred.make<void>();
			const published = yield* Deferred.make<void>();
			const events: string[] = [];
			concurrentFixture.pauseReads(
				Effect.gen(function* () {
					events.push("read");
					yield* Deferred.succeed(readEntered, undefined);
					yield* Deferred.await(holdRead);
				})
			);
			const underlying = yield* GameTextIndexBuilder.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			const queryLayer = Layer.unwrap(
				Effect.flatMap(AssetReader, (reader) => reader.configuration()).pipe(
					Effect.map(nativeIndexQueryLayer),
					Effect.provide(AssetReaderLive),
					Effect.orDie
				)
			);
			const implementation = Layer.succeed(
				GameTextIndexBuilder,
				GameTextIndexBuilder.of({
					...underlying,
					importLocalizationTarget: (input) =>
						Deferred.await(readEntered).pipe(
							Effect.andThen(underlying.importLocalizationTarget(input)),
							Effect.tap(() =>
								Effect.sync(() => {
									events.push("localization");
								}).pipe(Effect.andThen(Deferred.succeed(published, undefined)))
							)
						)
				})
			).pipe(Layer.merge(queryLayer));
			const concurrent = yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const running = yield* steps
					.prepareTarget(concurrentFixture.request)
					.pipe(Effect.forkChild);
				yield* Deferred.await(readEntered);
				yield* Deferred.await(published);
				yield* Deferred.succeed(holdRead, undefined);
				const target = yield* Fiber.join(running);
				const opened = yield* steps.openTarget(target);
				const request = { query: "Source", capability: "all" as const, pageSize: 10 };
				return {
					target,
					search: yield* opened.query.search(request),
					lines: (yield* opened.localizationJoin).lines.length
				};
			}).pipe(
				Effect.provide(concurrentFixture.layer(concurrentFixture.source, implementation))
			);
			const sequential = yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const selected = yield* steps.openProject({
					projectRoot: sequentialFixture.projectRoot
				});
				const imported = yield* steps.importTarget(selected, sequentialFixture.request);
				const project = yield* steps.refreshProject(sequentialFixture.request);
				const target = yield* steps.buildTarget(project, imported);
				const opened = yield* steps.openTarget(target);
				const request = { query: "Source", capability: "all" as const, pageSize: 10 };
				return {
					target,
					search: yield* opened.query.search(request),
					lines: (yield* opened.localizationJoin).lines.length
				};
			}).pipe(Effect.provide(sequentialFixture.layer()));
			expect(events).toEqual(["read", "localization"]);
			const authoredKeys = (keys: typeof concurrent.target.fileKeys) =>
				Object.fromEntries(
					Object.entries(keys).filter(
						([name]) =>
							name !== "imported" && !name.startsWith("localization.observation.")
					)
				);
			expect(authoredKeys(concurrent.target.fileKeys)).toEqual(
				authoredKeys(sequential.target.fileKeys)
			);
			expect(concurrent.target.join.count).toEqual(sequential.target.join.count);
			expect(concurrent.search).toEqual(sequential.search);
			expect(concurrent.lines).toBe(sequential.lines);
		}).pipe(Effect.scoped),
	30_000
);
