import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { GameTextIndexSteps } from "@ue-shed/game-text/index";
import { STARTER_GAME_TEXT_RULES } from "@ue-shed/game-text/rules";
import { makeIndexRegressionFixture } from "../../../../../packages/game-text/src/index-refresh-regressions.test-support.js";
import { WorkbenchGameText, WorkbenchGameTextLive } from "./game-text.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { makeGameTextLocalization } from "./game-text-localization.js";

const makeHost = Effect.fn("Test.GameText.productionHost")(function* (
	mode: "retirement" | "search" | "rejected" | "localization" | "pipeline" | "source"
) {
	const fixture = yield* makeIndexRegressionFixture();
	const retiring = yield* Deferred.make<void>();
	const allowRetirement = yield* Deferred.make<void>();
	const searching = yield* Deferred.make<void>();
	const allowSearch = yield* Deferred.make<void>();
	const prepared = yield* Deferred.make<void>();
	const allowPublication = yield* Deferred.make<void>();
	const evaluating = yield* Deferred.make<void>();
	const allowEvaluation = yield* Deferred.make<void>();
	const evaluationInterrupted = yield* Deferred.make<void>();
	const secondRetired = yield* Deferred.make<void>();
	const generation = yield* Ref.make(0);
	let calls = 0;
	let pauseRetirement = false;
	const indexed = Layer.effect(
		GameTextIndexSteps,
		Effect.gen(function* () {
			const real = yield* GameTextIndexSteps;
			return GameTextIndexSteps.of({
				...real,
				invalidate: real.invalidate,
				openTarget: Effect.fn("Test.GameText.productionRefresh")(function* (request) {
					const call = ++calls;
					if (call === 1)
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(retiring, undefined).pipe(
								Effect.andThen(
									mode === "retirement" && pauseRetirement
										? Deferred.await(allowRetirement)
										: Effect.void
								)
							)
						);
					if (
						mode === "localization" &&
						call === 1 &&
						request.imported.target.name === fixture.target.name
					)
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(retiring, undefined).pipe(
								Effect.andThen(
									pauseRetirement ? Deferred.await(allowRetirement) : Effect.void
								)
							)
						);
					if (call === 2 && mode === "source")
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(secondRetired, undefined)
						);
					const result = yield* real.openTarget(request);
					if (call === 2 && mode === "rejected") {
						yield* Deferred.succeed(prepared, undefined);
						yield* Deferred.await(allowPublication);
					}
					const sourceQuality = result.sourceQuality;
					return {
						...result,
						// The second model's source rules wait for the test before evaluating.
						...(call === 2 && mode === "source" && sourceQuality
							? {
									sourceQuality: (...args: Parameters<typeof sourceQuality>) => {
										const evaluate = sourceQuality(...args);
										return Effect.gen(function* () {
											yield* Effect.gen(function* () {
												yield* Deferred.succeed(evaluating, undefined);
												yield* Deferred.await(allowEvaluation);
											}).pipe(
												Effect.onInterrupt(() =>
													Deferred.succeed(
														evaluationInterrupted,
														undefined
													)
												)
											);
											return yield* evaluate;
										});
									}
								}
							: undefined),
						search: Effect.fn("Test.GameText.productionSearch")(function* (request) {
							if (call === 1 && mode === "search") {
								yield* Deferred.succeed(searching, undefined);
								yield* Deferred.await(allowSearch);
							}
							return yield* result.search(request);
						})
					};
				})
			});
		})
	).pipe(Layer.provide(fixture.layer(true)));
	const current = () =>
		Ref.get(generation).pipe(
			Effect.map((generation) => ({
				status: "ready" as const,
				project: {
					generation,
					inputAtlas: "ready" as const,
					mapCount: 0,
					packageCount: 1,
					projectName: "Fixture",
					projectRoot: fixture.projectRoot
				}
			}))
		);
	const project = makeWorkbenchProjectTestLayer({
		current,
		choose: current,
		inputAtlas: () => Effect.die("Not used"),
		savedTables: () => Effect.die("Not used"),
		savedProject: () => Effect.succeed({ maps: [], projectRoot: fixture.projectRoot }),
		candidates: () =>
			Ref.get(generation).pipe(
				Effect.map((generation) => ({
					generation,
					assets: [],
					failures: [],
					summary: {
						cacheHits: 0,
						depth: "header" as const,
						diagnostics: [],
						emittedAssets: 0,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot: fixture.projectRoot,
						roots: [],
						scannedAssets: 0,
						schema_version: 8 as const,
						skippedAssets: 0
					}
				}))
			)
	});
	const adapters = Layer.mergeAll(
		makeLocalFilesTestLayer(),
		Layer.succeed(
			ElectronDialog,
			ElectronDialog.of({
				chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
				chooseFile: () => Effect.succeed({ status: "cancelled" }),
				chooseFiles: () => Effect.succeed({ status: "cancelled" }),
				chooseSaveFile: () => Effect.succeed({ status: "cancelled" })
			})
		)
	);
	return {
		armRetirement: () => {
			pauseRetirement = true;
		},
		fixture,
		modelOpens: () => calls,
		retiring,
		allowRetirement,
		searching,
		allowSearch,
		prepared,
		allowPublication,
		evaluating,
		allowEvaluation,
		evaluationInterrupted,
		secondRetired,
		generation,
		layer: WorkbenchGameTextLive.pipe(
			Layer.provide(indexed),
			Layer.provide(project),
			Layer.provide(adapters),
			Layer.provide(fixture.evidence)
		)
	};
});

const request = { query: "", capability: "all" as const, pageSize: 10 };

it.live("keeps the selected target as the primary view across catalog generations", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("pipeline");
		const other = test.fixture.addTarget("Other");
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			yield* host.configuredRefresh();
			yield* host.localizationTarget(other.name);
			expect(test.modelOpens()).toBe(2);
			yield* Ref.set(test.generation, 1);
			expect((yield* host.configuredRefresh()).status).toBe("completed");
			expect((yield* host.localizationTarget(other.name)).status).toBe("ready");
			expect(test.modelOpens()).toBe(3);
			expect(
				yield* host.search({ ...request, localization: { target: other.name } })
			).toMatchObject({ status: "ready", page: { total: 1 } });
		}).pipe(Effect.provide(test.layer));
	})
);

it.live(
	"prepares one source and localization model and verifies changed PO content on rescan",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("pipeline");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect((yield* host.localizationTarget(test.fixture.target.name)).status).toBe(
					"ready"
				);
				expect(test.modelOpens()).toBe(1);
				const original = yield* host.search(request);
				expect(original).toMatchObject({
					status: "ready",
					page: { units: [{ source: { value: "Source" } }] }
				});
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect((yield* host.localizationTarget(test.fixture.target.name)).status).toBe(
					"ready"
				);
				expect(test.modelOpens()).toBe(2);
				yield* Effect.promise(() =>
					writeFile(
						join(test.fixture.projectRoot, "de.po"),
						test.fixture.contents.po.replace("Shipped", "Pending")
					)
				);
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect(yield* host.localizationTarget(test.fixture.target.name)).toMatchObject({
					status: "ready",
					notSynced: 1
				});
				expect(test.modelOpens()).toBe(3);
				expect(test.fixture.packageReads()).toBe(1);
				expect(yield* host.search(request)).toEqual(original);
			}).pipe(Effect.provide(test.layer));
		})
);

it.live(
	"keeps source browsing available when targets disappear or discovery exceeds its bounds",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("pipeline");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				yield* host.configuredRefresh();
				yield* host.localizationTarget(test.fixture.target.name);
				test.fixture.setTargets([]);
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect(yield* host.localizationTargets()).toEqual({ status: "ready", targets: [] });
				expect(yield* host.search(request)).toMatchObject({
					status: "ready",
					page: { total: 1 }
				});
				for (let index = 0; index < 51; index++) test.fixture.addTarget(`Target${index}`);
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect(yield* host.localizationTargets()).toMatchObject({
					status: "failed",
					code: "bounds_exceeded"
				});
				expect(yield* host.search(request)).toMatchObject({
					status: "ready",
					page: { total: 1 }
				});
			}).pipe(Effect.provide(test.layer));
		})
);

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
			).pipe(Layer.provide(fixture.layer(true)));
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
				expect((yield* host.configuredRefresh()).status).toBe("completed");
				expect((yield* host.localizationTarget(test.fixture.target.name)).status).toBe(
					"ready"
				);
				test.armRetirement();
				test.fixture.setSource("Older");
				const older = yield* host.configuredRefresh().pipe(Effect.forkChild);
				yield* Deferred.await(test.retiring);
				yield* Ref.set(test.generation, 1);
				test.fixture.setSource("Newer");
				expect((yield* host.configuredRefresh()).status).toBe("completed");
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
					expect((yield* host.configuredRefresh()).status).toBe("completed");
					expect((yield* host.previewQualityRules(STARTER_GAME_TEXT_RULES)).status).toBe(
						"completed"
					);
					const published = yield* host.qualitySearch({ filter: "all", pageSize: 50 });
					expect(published.status).toBe("ready");
					// The rescan carries the rules over and evaluates them on its new model.
					const pending = yield* host.configuredRefresh().pipe(Effect.forkChild);
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
