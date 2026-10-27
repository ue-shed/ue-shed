import { it } from "@effect/vitest";
import { GameTextIndexSteps } from "@ue-shed/game-text/index";
import { STARTER_GAME_TEXT_RULES } from "@ue-shed/game-text/rules";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { expect } from "vitest";
import { makeIndexRegressionFixture } from "../../../../../packages/game-text/src/index-refresh-regressions.test-support.js";
import { makeHost, request } from "./game-text-index-lifetime.test-support.js";
import { makeGameTextLocalization } from "./game-text-localization.js";
import { WorkbenchGameText } from "./game-text.js";
it.live(
	"target replacement preserves outstanding localization searches until they finish",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const other = fixture.addTarget("Other");
			const searching = yield* Deferred.make<void>();
			const allowSearch = yield* Deferred.make<void>();
			const retiring = yield* Deferred.make<void>();
			const indexed = Layer.effect(
				GameTextIndexSteps,
				Effect.gen(function* () {
					const real = yield* GameTextIndexSteps;
					return GameTextIndexSteps.of({
						...real,
						invalidate: real.invalidate,
						openTarget: Effect.fn("Test.GameText.targetRefresh")(function* (request) {
							if (request.imported.target.name === fixture.target.name)
								yield* Effect.addFinalizer(() =>
									Deferred.succeed(retiring, undefined)
								);
							const result = yield* real.openTarget(request);
							return {
								...result,
								search: Effect.fn("Test.GameText.targetSearch")(
									function* (request) {
										if (
											request.localization?.target === fixture.target.name &&
											request.query === "Source"
										) {
											yield* Deferred.succeed(searching, undefined);
											yield* Deferred.await(allowSearch);
										}
										return yield* result.search(request);
									}
								)
							};
						})
					});
				})
			).pipe(Layer.provide(fixture.layer()));
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
				const host = yield* makeGameTextLocalization(
					() => Effect.succeed("revision"),
					() => Effect.succeed(project)
				);
				expect((yield* Effect.scoped(host.select(fixture.target.name))).status).toBe(
					"ready"
				);
				const pending = yield* host
					.search({
						...request,
						query: "Source",
						localization: { target: fixture.target.name }
					})
					.pipe(Effect.scoped, Effect.forkChild);
				yield* Deferred.await(searching);
				expect((yield* Effect.scoped(host.select(other.name))).status).toBe("ready");
				expect(yield* Deferred.isDone(retiring)).toBe(false);
				yield* Deferred.succeed(allowSearch, undefined);
				expect((yield* Fiber.join(pending)).status).toBe("not_ready");
				yield* Deferred.await(retiring);
				expect(
					(yield* Effect.scoped(
						host.search({ ...request, localization: { target: other.name } })
					)).status
				).toBe("ready");
			}).pipe(
				Effect.ensuring(Deferred.succeed(allowSearch, undefined)),
				Effect.provide(indexed),
				Effect.provide(fixture.evidence)
			);
		}),
	15000
);
it.live(
	"supersession during localization retirement preserves the newer published generation",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("localization");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				expect((yield* host.configuredRefresh({})).status).toBe("completed");
				expect((yield* host.localizationTarget(test.fixture.target.name)).status).toBe(
					"ready"
				);
				test.armRetirement();
				test.fixture.setSource("Older");
				const older = yield* host.configuredRefresh({}).pipe(Effect.forkChild);
				yield* Deferred.await(test.retiring);
				yield* Ref.set(test.generation, 1);
				test.fixture.setSource("Newer");
				expect((yield* host.configuredRefresh({})).status).toBe("completed");
				const current = yield* host.search(request);
				expect(current).toMatchObject({
					status: "ready",
					page: { units: [{ source: { value: "Newer" } }] }
				});
				yield* Deferred.succeed(test.allowRetirement, undefined);
				// The shared primary target publishes before its last borrowed reader retires.
				expect((yield* Fiber.join(older)).status).toBe("completed");
				expect(yield* host.search(request)).toEqual(current);
			}).pipe(
				Effect.ensuring(Deferred.succeed(test.allowRetirement, undefined)),
				Effect.provide(test.layer)
			);
		}),
	15000
);
for (const release of [true, false])
	it.live(
		release
			? "a refresh superseded during source rule evaluation publishes and retains nothing"
			: "a superseded source rule evaluation is abandoned without waiting for it",
		() =>
			Effect.gen(function* () {
				const test = yield* makeHost("source");
				yield* Effect.gen(function* () {
					const host = yield* WorkbenchGameText;
					expect((yield* host.configuredRefresh({})).status).toBe("completed");
					expect((yield* host.previewQualityRules(STARTER_GAME_TEXT_RULES)).status).toBe(
						"completed"
					);
					const published = yield* host.qualitySearch({ filter: "all", pageSize: 50 });
					expect(published.status).toBe("ready");
					// A rescan of changed source carries the rules over and evaluates them on its
					// new model; an unchanged rescan keeps the published model and its quality.
					test.fixture.setSource("Changed");
					const pending = yield* host.configuredRefresh({}).pipe(Effect.forkChild);
					yield* Deferred.await(test.evaluating);
					yield* Ref.set(test.generation, 1);
					if (release) yield* Deferred.succeed(test.allowEvaluation, undefined);
					expect(yield* Fiber.join(pending)).toEqual({
						status: "failed",
						error: {
							code: "invalid_project",
							message: "The project changed during the scan.",
							recovery: "Refresh to read the current project generation.",
							retrySafe: true
						}
					});
					if (!release) yield* Deferred.await(test.evaluationInterrupted);
					// The superseded model retires; the published one stays, with its rules.
					yield* Deferred.await(test.secondRetired);
					yield* Ref.set(test.generation, 0);
					expect(yield* Deferred.isDone(test.retiring)).toBe(false);
					expect((yield* host.search(request)).status).toBe("ready");
					expect(yield* host.qualitySearch({ filter: "all", pageSize: 50 })).toEqual(
						published
					);
				}).pipe(
					Effect.ensuring(Deferred.succeed(test.allowEvaluation, undefined)),
					Effect.provide(test.layer)
				);
			}),
		15000
	);
it.live(
	"a source quality read that new rules replace meanwhile answers not ready",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("source-read");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				expect((yield* host.configuredRefresh({})).status).toBe("completed");
				expect((yield* host.previewQualityRules(STARTER_GAME_TEXT_RULES)).status).toBe(
					"completed"
				);
				test.armQualityRead();
				const stale = yield* host
					.qualitySearch({ filter: "all", pageSize: 50 })
					.pipe(Effect.forkChild);
				yield* Deferred.await(test.searching);
				const fewer = {
					...STARTER_GAME_TEXT_RULES,
					rules: STARTER_GAME_TEXT_RULES.rules.slice(1)
				};
				expect((yield* host.previewQualityRules(fewer)).status).toBe("completed");
				yield* Deferred.succeed(test.allowSearch, undefined);
				expect(yield* Fiber.join(stale)).toEqual({ status: "not_ready" });
				expect((yield* host.qualitySearch({ filter: "all", pageSize: 50 })).status).toBe(
					"ready"
				);
			}).pipe(
				Effect.ensuring(Deferred.succeed(test.allowSearch, undefined)),
				Effect.provide(test.layer)
			);
		}),
	15000
);
