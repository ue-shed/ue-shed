import { GameTextIndexSteps } from "@ue-shed/game-text/index";
import { Deferred, Effect, Layer, Ref, Option } from "effect";
import { makeIndexRegressionFixture } from "../../../../../packages/game-text/src/index-refresh-regressions.test-support.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { WorkbenchGameTextLive } from "./game-text.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
export const makeHost = Effect.fn("Test.GameText.productionHost")(function* (
	mode:
		| "retirement"
		| "search"
		| "rejected"
		| "localization"
		| "pipeline"
		| "source"
		| "cached"
		| "cached-open"
		| "cached-retirement"
) {
	const fixture = yield* makeIndexRegressionFixture();
	if (mode.startsWith("cached"))
		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* (yield* GameTextIndexSteps).prepareTarget(fixture.request);
			}).pipe(Effect.provide(fixture.layer()))
		);
	const cachedRetired = yield* Deferred.make<void>();
	const cacheOpening = yield* Deferred.make<void>();
	const allowCachedOpen = yield* Deferred.make<void>();
	const selectedRoot = yield* Ref.make<string | undefined>(fixture.projectRoot);
	let cacheOpens = 0;
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
				openCommitted: Effect.fn("Test.GameText.openCommitted")(function* (request) {
					cacheOpens++;
					const result = yield* real.openCommitted(request);
					if (Option.isSome(result)) {
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(cachedRetired, undefined).pipe(
								Effect.andThen(
									mode === "cached-retirement"
										? Deferred.await(allowRetirement)
										: Effect.void
								)
							)
						);
						yield* Deferred.succeed(cacheOpening, undefined);
						if (mode === "cached-open") yield* Deferred.await(allowCachedOpen);
					}
					return result;
				}),
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
		Effect.gen(function* () {
			const root = yield* Ref.get(selectedRoot);
			if (!root) return { status: "not_configured" as const };
			return {
				status: "ready" as const,
				project: {
					generation: yield* Ref.get(generation),
					inputAtlas: "ready" as const,
					mapCount: 0,
					packageCount: 1,
					projectName: "Fixture",
					projectRoot: root
				}
			};
		});
	const project = makeWorkbenchProjectTestLayer({
		current,
		...(mode.startsWith("cached")
			? {
					refresh: () =>
						Ref.update(generation, (value) => value + 1).pipe(Effect.andThen(current()))
				}
			: undefined),
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
		cachedRetired,
		cacheOpening,
		allowCachedOpen,
		selectedRoot,
		cacheOpens: () => cacheOpens,
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
export const request = { query: "", capability: "all" as const, pageSize: 10 };
