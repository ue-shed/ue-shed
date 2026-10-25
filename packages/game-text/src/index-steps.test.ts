import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Option } from "effect";
import { expect } from "vitest";
import { unlink, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GameTextIndexSteps, gameTextIndexStepsLayer } from "./index-steps.js";
import { GameTextIndexRefresh, GameTextIndexSource } from "./index-refresh.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";

import { SharedIndex, sharedIndexNodeLayer, sharedIndexDirectory } from "./shared-index.js";
import { makeRetainedGameTextIndex } from "./index-retained.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import { HostSliceScheduler } from "./host-slices.js";
import { performance } from "node:perf_hooks";
import { GameTextIndexBuilder } from "./index-builder.js";
import { GameTextIndexQuery } from "./index-query-native.js";
import { readJoinedTarget } from "./joined-target-reader.js";
import { GameTextIndexError } from "./index-contract.js";
import { SnapshotStore, snapshotStoreNodeLayer } from "./snapshot-store.js";

it.live(
	"prepares all inputs under one lease and releases a failed import before source recovery",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const underlying = yield* GameTextIndexBuilder.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			const queries = yield* GameTextIndexQuery.pipe(
				Effect.provide(typeScriptIndexBuilderLayer)
			);
			const sessions: string[] = [];
			const implementation = Layer.succeed(
				GameTextIndexBuilder,
				GameTextIndexBuilder.of({
					...underlying,
					withSession: (request, effect) => {
						sessions.push(JSON.stringify(request.configuration.projectView));
						return underlying.withSession(request, effect);
					}
				})
			).pipe(Layer.merge(Layer.succeed(GameTextIndexQuery, queries)));
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const prepared = yield* steps.prepareTarget(fixture.request);
				expect(prepared.view).toEqual({
					kind: "localization",
					target: fixture.target.name
				});
				expect(sessions).toHaveLength(1);
				sessions.length = 0;
				const recovered = yield* steps.prepareTarget(
					{ ...fixture.request, targetName: "Missing" },
					{ fallbackToSource: true }
				);
				expect(recovered.view).toEqual({ kind: "source" });
				expect(sessions).toHaveLength(2);
			}).pipe(Effect.provide(fixture.layer(fixture.source, implementation)));
		}).pipe(Effect.scoped)
);

it.live("invalid project input retains its cause and requires input correction", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			for (const projectRoot of ["", join(fixture.projectRoot, "missing")]) {
				const error = yield* steps.openProject({ projectRoot }).pipe(Effect.flip);
				expect(error).toMatchObject({ nextStep: "fix_input", retrySafe: false });
				expect(error.cause).toBeDefined();
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live(
	"pins overlapping readers independently across changed generations",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const firstScope = yield* Scope.make();
				const secondScope = yield* Scope.make();
				yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
				yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
				const project = yield* steps.refreshProject(fixture.request);
				const target = yield* steps.buildTarget(
					project,
					yield* steps.importTarget(project, fixture.request)
				);
				const first = yield* steps
					.openTarget(target)
					.pipe(Effect.provideService(Scope.Scope, firstScope));
				const second = yield* steps
					.openTarget(target)
					.pipe(Effect.provideService(Scope.Scope, secondScope));
				expect(target.queryRevision).toBeDefined();
				expect(first.queryRevision).toBe(target.queryRevision);
				expect(second.queryRevision).toBe(target.queryRevision);
				const request = { query: "Source", capability: "all" as const, pageSize: 10 };
				const expected = yield* first.query.search(request);
				yield* Scope.close(firstScope, Exit.void);
				expect(yield* second.search(request)).toEqual(expected);
				fixture.setSource("Updated");
				const changedProject = yield* steps.refreshProject(fixture.request);
				const changed = yield* steps.openTarget(
					yield* steps.buildTarget(
						changedProject,
						yield* steps.importTarget(changedProject, fixture.request)
					)
				);
				expect(changed.queryRevision).not.toBe(second.queryRevision);
				// The old model has never searched this term; it must still use its pinned snapshot.
				expect(yield* second.search({ ...request, query: "Updated" })).toEqual(
					yield* second.query.search({ ...request, query: "Updated" })
				);
				expect(yield* changed.search({ ...request, query: "Updated" })).toEqual(
					yield* changed.query.search({ ...request, query: "Updated" })
				);
				yield* Scope.close(secondScope, Exit.void);
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	// Worker threads start slowly when the whole suite runs in parallel.
	30_000
);

it.live.each([
	{ broken: "missing", other: false },
	{ broken: "malformed", other: false },
	{ broken: "missing", other: true },
	{ broken: "malformed", other: true }
] as const)(
	"rejects a superseded $broken import after repair by another target: $other",
	({ broken, other }) =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const repairTarget = other ? fixture.addTarget("Other") : fixture.target;
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
				const initialImport = yield* steps.importTarget(project, fixture.request);
				const initialTarget = yield* steps.buildTarget(project, initialImport);
				const initial = yield* steps.openTarget(initialTarget);
				const path = join(fixture.projectRoot, "de.po");
				yield* Effect.promise(() =>
					broken === "missing" ? unlink(path) : writeFile(path, "not a PO file")
				);
				const old = yield* steps.importTarget(project, fixture.request);
				const failedTarget = yield* steps.buildTarget(project, old);
				const failed = yield* steps.openTarget(failedTarget);
				expect(
					yield* steps.buildTarget(project, initialImport).pipe(Effect.flip)
				).toMatchObject({
					_tag: "GameTextIndexError",
					operation: "localization"
				});
				expect(yield* steps.openTarget(initialTarget).pipe(Effect.flip)).toMatchObject({
					_tag: "GameTextIndexError",
					operation: "localization"
				});
				expect(
					failed.evidence.cultures.find((item) => item.culture === "de")?.po.status
				).toBe("failed");
				// Restore the exact original content: its historical active file key can be unchanged.
				yield* Effect.promise(() => writeFile(path, fixture.contents.po));
				const repairedImport = yield* steps.importTarget(project, {
					targetName: repairTarget.name
				});
				const repairedTarget = yield* steps.buildTarget(project, repairedImport);
				const repaired = yield* steps.openTarget(repairedTarget);
				expect(
					repaired.evidence.cultures.find((item) => item.culture === "de")?.po.status
				).toBe("read");
				expect(yield* steps.buildTarget(project, old).pipe(Effect.flip)).toMatchObject({
					_tag: "GameTextIndexError",
					operation: "localization"
				});
				const current = yield* steps.openTarget(repairedTarget);
				expect(yield* steps.openTarget(failedTarget).pipe(Effect.flip)).toMatchObject({
					_tag: "GameTextIndexError",
					operation: "localization"
				});
				expect(current.evidence).toEqual(repaired.evidence);
				expect(
					initial.evidence.cultures.find((item) => item.culture === "de")?.po.status
				).toBe("read");
				expect(
					failed.evidence.cultures.find((item) => item.culture === "de")?.po.status
				).toBe("failed");
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	15000
);

it.live(
	"composes source and concurrent target views over one verified project revision",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const other = fixture.addTarget("SavedText");
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
				const sourceImport = yield* steps.importTarget(project);
				const source = yield* steps.openTarget(
					yield* steps.buildTarget(project, sourceImport)
				);
				const imports = yield* Effect.all(
					[fixture.target, other].map((target) =>
						steps.importTarget(project, { targetName: target.name })
					),
					{ concurrency: 2 }
				);
				const targets = yield* Effect.all(
					imports.map((imported) => steps.buildTarget(project, imported)),
					{ concurrency: 2 }
				);
				const opened = yield* Effect.all(targets.map(steps.openTarget), { concurrency: 2 });
				expect(fixture.inventories()).toBe(1);
				expect(fixture.packageReads()).toBe(1);
				expect(opened.map((result) => result.localization.target)).toEqual([
					fixture.target.name,
					other.name
				]);
				const sourceAgain = yield* steps.buildTarget(project, sourceImport);
				expect(sourceAgain.join.rebuilt).toBe(false);
				expect(sourceAgain.join.key).toBe(source.join.key);
				const reordered = yield* SharedIndex.use((index) => index.inspect()).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: join(fixture.projectRoot, "cache"),
							projectKey: fixture.projectRoot,
							targetKey: fixture.target.name,
							projectView: { target: fixture.target.name, kind: "localization" }
						})
					)
				);
				expect(reordered.active.joined).toBe(targets[0]?.join.key);
				const compatibility = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				expect(yield* compatibility.corpus).toEqual(yield* opened[0]!.corpus);
				expect(yield* compatibility.localizationJoin).toEqual(
					yield* opened[0]!.localizationJoin
				);
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	15000
);

it.live("unchanged partial imports reuse failed observations from the published target", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
			yield* steps.buildTarget(project, yield* steps.importTarget(project, fixture.request));
			yield* Effect.promise(() =>
				writeFile(join(fixture.projectRoot, "de.po"), "not a PO file")
			);
			const failed = yield* steps.importTarget(project, fixture.request);
			const target = yield* steps.buildTarget(project, failed);
			const partial = yield* steps.importTarget(project, {
				...fixture.request,
				changedFiles: []
			});
			expect(partial.fileKeys).toEqual(failed.fileKeys);
			const unchanged = yield* steps.buildTarget(project, failed);
			expect(unchanged.join.key).toBe(target.join.key);
			expect(unchanged.join.rebuilt).toBe(false);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live.each(["missing", "malformed"] as const)(
	"partial imports cannot resurrect %s failures after another target repairs a shared input",
	(broken) =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const other = fixture.addTarget("Other");
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
				yield* steps.buildTarget(
					project,
					yield* steps.importTarget(project, fixture.request)
				);
				yield* Effect.promise(() =>
					broken === "missing"
						? unlink(join(fixture.projectRoot, "de.po"))
						: writeFile(join(fixture.projectRoot, "de.po"), "not a PO file")
				);
				yield* steps.buildTarget(
					project,
					yield* steps.importTarget(project, fixture.request)
				);
				yield* Effect.promise(() =>
					writeFile(join(fixture.projectRoot, "de.po"), fixture.contents.po)
				);
				const repaired = yield* steps.buildTarget(
					project,
					yield* steps.importTarget(project, { targetName: other.name })
				);
				expect(
					yield* steps
						.importTarget(project, { ...fixture.request, changedFiles: [] })
						.pipe(Effect.flip)
				).toMatchObject({
					_tag: "GameTextIndexError",
					operation: "localization"
				});
				expect(
					(yield* steps.openTarget(repaired)).evidence.cultures.find(
						(item) => item.culture === "de"
					)?.po.status
				).toBe("read");
				const refreshed = yield* steps.openTarget(
					yield* steps.buildTarget(
						project,
						yield* steps.importTarget(project, fixture.request)
					)
				);
				expect(
					refreshed.evidence.cultures.find((item) => item.culture === "de")?.po.status
				).toBe("read");
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped)
);

it.live("imports and validates localization without starting package discovery", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			const selected = yield* steps.openProject({ projectRoot: fixture.projectRoot });
			const imported = yield* steps.importTarget(selected, {
				targetName: fixture.target.name,
				requireManifest: true
			});
			expect(fixture.inventories()).toBe(0);
			expect(fixture.packageReads()).toBe(0);
			const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
			const result = yield* steps.openTarget(yield* steps.buildTarget(project, imported));
			expect((yield* result.localizationJoin).lines).toHaveLength(1);
			expect(fixture.inventories()).toBe(1);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live(
	"rejects stale project revisions and invalidated target handles, preserving pinned queries",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
				const imported = yield* steps.importTarget(project, fixture.request);
				const target = yield* steps.buildTarget(project, imported);
				const pinned = yield* steps.openTarget(target);
				const search = { query: "Source", capability: "all" as const, pageSize: 10 };
				const original = yield* pinned.query.search(search);
				yield* steps.invalidate(fixture.request);
				expect(yield* steps.openTarget(target).pipe(Effect.flip)).toMatchObject({
					_tag: "GameTextIndexError",
					operation: "target",
					retrySafe: true
				});
				fixture.setSource("Updated");
				const next = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
				expect(yield* steps.buildTarget(project, imported).pipe(Effect.flip)).toMatchObject(
					{
						_tag: "GameTextIndexError",
						operation: "project"
					}
				);
				const updated = yield* steps.openTarget(yield* steps.buildTarget(next, imported));
				expect((yield* updated.query.search({ ...search, query: "Updated" })).total).toBe(
					1
				);
				expect(yield* pinned.query.search(search)).toEqual(original);
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped)
);

it.live("cancellation releases the project writer so a queued refresh can complete", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const reading = yield* Deferred.make<void>();
		const hold = yield* Deferred.make<void>();
		fixture.pauseReads(
			Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(hold)))
		);
		yield* Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			const first = yield* steps
				.refreshProject({ projectRoot: fixture.projectRoot })
				.pipe(Effect.forkChild);
			yield* Deferred.await(reading);
			fixture.pauseReads(Effect.void);
			const queued = yield* steps
				.refreshProject({ projectRoot: fixture.projectRoot })
				.pipe(Effect.forkChild);
			yield* Fiber.interrupt(first);
			const project = yield* Fiber.join(queued);
			const result = yield* steps.openTarget(
				yield* steps.buildTarget(project, yield* steps.importTarget(project))
			);
			expect(
				(yield* result.query.search({ query: "Source", capability: "all", pageSize: 10 }))
					.total
			).toBe(1);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live(
	"cancels a join at a host-slice yield with an old reader pinned and a second writer queued",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const joining = Deferred.makeUnsafe<void>();
			let holdSlice = false;
			const report = (event: GameTextIndexProgress) => {
				if (!holdSlice || event.phase !== "joining") return;
				holdSlice = false;
				// Spend the host slice so the scheduler suspends the join at its next yield point.
				const until = performance.now() + 2 * new HostSliceScheduler().budgetMs;
				while (performance.now() < until);
				Deferred.doneUnsafe(joining, Effect.void);
			};
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const build = Effect.gen(function* () {
					const project = yield* steps.refreshProject(fixture.request);
					return yield* steps.buildTarget(
						project,
						yield* steps.importTarget(project, fixture.request)
					);
				});
				const search = { query: "Source", capability: "all" as const, pageSize: 10 };
				// The old model pins its generation's reader and worker for the whole test.
				const old = yield* steps.openTarget(yield* build);
				const before = yield* old.query.search(search);
				expect(before.total).toBe(1);
				fixture.setSource("Updated");
				holdSlice = true;
				const cancelled = yield* Effect.forkChild(build);
				yield* Deferred.await(joining);
				// Queued behind the cancelled build's project writer.
				const queued = yield* Effect.forkChild(build);
				yield* Fiber.interrupt(cancelled);
				expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true);
				const next = yield* steps.openTarget(yield* Fiber.join(queued));
				expect(next.join.rebuilt).toBe(true);
				expect((yield* next.query.search({ ...search, query: "Updated" })).total).toBe(1);
				expect((yield* next.query.search(search)).total).toBe(0);
				expect(yield* old.query.search(search)).toEqual(before);
				expect(yield* old.search(search)).toEqual(before);
			}).pipe(
				Effect.provideService(GameTextIndexProgressReporter, report),
				Effect.provide(fixture.layer())
			);
		}).pipe(Effect.scoped),
	// Worker threads start slowly when the whole suite runs in parallel.
	30_000
);

it.live("rejects an import superseded by another localization publication", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			const project = yield* steps.refreshProject({ projectRoot: fixture.projectRoot });
			const old = yield* steps.importTarget(project, fixture.request);
			yield* Effect.promise(() =>
				writeFile(
					join(fixture.projectRoot, "de.po"),
					fixture.contents.po.replace("Shipped", "New")
				)
			);
			const current = yield* steps.importTarget(project, fixture.request);
			expect(yield* steps.buildTarget(project, old).pipe(Effect.flip)).toMatchObject({
				_tag: "GameTextIndexError",
				operation: "localization",
				nextStep: "reconcile",
				retrySafe: true
			});
			const result = yield* steps.openTarget(yield* steps.buildTarget(project, current));
			expect(
				(yield* result.localizationJoin).lines[0]?.cultures.some(
					(culture) => culture.poTranslation === "New"
				)
			).toBe(true);
			expect(fixture.inventories()).toBe(1);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("a paused project writer does not block a different project's refresh", () =>
	Effect.gen(function* () {
		const firstProject = yield* makeIndexRegressionFixture();
		const otherProject = yield* makeIndexRegressionFixture();
		const reading = yield* Deferred.make<void>();
		const hold = yield* Deferred.make<void>();
		firstProject.pauseReads(
			Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(hold)))
		);
		const firstSource = yield* GameTextIndexSource.pipe(Effect.provide(firstProject.source));
		const otherSource = yield* GameTextIndexSource.pipe(Effect.provide(otherProject.source));
		const source = Layer.succeed(GameTextIndexSource, {
			inventory: (request) =>
				(request.projectRoot === firstProject.projectRoot
					? firstSource
					: otherSource
				).inventory(request),
			read: (root, entries) =>
				(root === firstProject.projectRoot ? firstSource : otherSource).read(root, entries)
		});
		yield* Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			const paused = yield* steps
				.refreshProject({ projectRoot: firstProject.projectRoot })
				.pipe(Effect.forkChild);
			yield* Deferred.await(reading);
			const independent = yield* steps.refreshProject({
				projectRoot: otherProject.projectRoot
			});
			expect(independent.projectRoot).toBe(otherProject.projectRoot);
			expect(otherProject.packageReads()).toBe(1);
			yield* Fiber.interrupt(paused);
		}).pipe(
			Effect.provide(
				gameTextIndexStepsLayer(join(firstProject.projectRoot, "cache")).pipe(
					Layer.provide(source),
					Layer.provide(typeScriptIndexBuilderLayer),
					Layer.provide(firstProject.evidence)
				)
			)
		);
	}).pipe(Effect.scoped)
);

it.live("retains existing refresh adapters that do not return project-step metadata", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const legacy = Layer.effect(
			GameTextIndexRefresh,
			Effect.gen(function* () {
				const real = yield* GameTextIndexRefresh;
				return GameTextIndexRefresh.of({
					invalidate: real.invalidate,
					refresh: (request) =>
						real.refresh(request).pipe(
							Effect.map((result) => {
								const value = { ...result };
								delete value.project;
								return value;
							})
						)
				});
			})
		).pipe(Layer.provide(fixture.layer()));
		yield* Effect.gen(function* () {
			const retained = yield* makeRetainedGameTextIndex();
			const model = yield* retained.refresh({ projectRoot: fixture.projectRoot });
			yield* model.retain;
			expect(model.project).toBeUndefined();
			expect(
				(yield* model.search({ query: "Source", capability: "all", pageSize: 10 })).total
			).toBe(1);
		}).pipe(Effect.provide(legacy));
	}).pipe(Effect.scoped)
);

it.live("opens a committed target after restart without inventory, imports or a writer lease", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const expected = yield* Effect.scoped(
			Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const target = yield* steps.prepareTarget(fixture.request);
				return (yield* steps.openTarget(target)).summary;
			}).pipe(Effect.provide(fixture.layer()))
		);
		const configuration = {
			cacheRoot: join(fixture.projectRoot, "cache"),
			projectKey: fixture.projectRoot,
			targetKey: fixture.target.name,
			projectView: { kind: "localization" as const, target: fixture.target.name }
		};
		const directory = sharedIndexDirectory(configuration);
		const before = yield* Effect.promise(() => readFile(join(directory, "manifest.json")));
		yield* Effect.gen(function* () {
			// A held lease proves reopen cannot wait for, or acquire, the writer.
			yield* (yield* SharedIndex).writer();
			const opened = yield* (yield* GameTextIndexSteps).openCommitted(fixture.request);
			expect(Option.isSome(opened)).toBe(true);
			if (Option.isNone(opened)) throw new Error("Expected committed target");
			expect(opened.value.summary).toEqual(expected);
			expect(
				(yield* opened.value.search({ query: "Source", capability: "all", pageSize: 50 }))
					.total
			).toBe(1);
			expect(opened.value.packages.readPackages).toBe(0);
			expect(fixture.inventories()).toBe(1);
			expect(fixture.packageReads()).toBe(1);
		}).pipe(
			Effect.provide(fixture.layer()),
			Effect.provide(sharedIndexNodeLayer(configuration)),
			Effect.scoped
		);
		expect(yield* Effect.promise(() => readFile(join(directory, "manifest.json")))).toEqual(
			before
		);
	}).pipe(Effect.scoped)
);

for (const damaged of [
	"missing",
	"identity",
	"format",
	"corrupt",
	"invalidated",
	"shared-version",
	"meta-version",
	"meta-project",
	"dependencies"
] as const) {
	it.live(`treats a ${damaged} committed cache as absent`, () =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const configuration = {
				cacheRoot: join(fixture.projectRoot, "cache"),
				projectKey: fixture.projectRoot,
				targetKey: fixture.target.name,
				projectView: { kind: "localization" as const, target: fixture.target.name }
			};
			const directory = sharedIndexDirectory(configuration);
			if (damaged !== "missing") {
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* (yield* GameTextIndexSteps).prepareTarget(fixture.request);
					}).pipe(Effect.provide(fixture.layer()))
				);
				if (damaged === "identity" || damaged === "format") {
					yield* Effect.promise(async () => {
						const path = join(directory, "manifest.json");
						const manifest = JSON.parse(await readFile(path, "utf8"));
						if (damaged === "identity")
							manifest.identity = JSON.stringify(["other", "project"]);
						else manifest.formatVersion = -1;
						await writeFile(path, JSON.stringify(manifest));
					});
				} else if (damaged === "shared-version") {
					yield* Effect.scoped(
						Effect.gen(function* () {
							const writer = yield* (yield* SnapshotStore).writer();
							yield* writer.publish(
								{
									columns: [
										{
											name: "index.meta",
											kind: "bytes",
											load: async () =>
												new TextEncoder().encode(
													JSON.stringify({
														version: -1,
														generation: "old",
														active: {},
														segments: [],
														layers: {}
													})
												)
										}
									]
								},
								{}
							);
						}).pipe(
							Effect.provide(
								snapshotStoreNodeLayer({
									...configuration,
									targetKey: "shared-project-text-v1"
								})
							)
						)
					);
				} else if (damaged === "corrupt") {
					yield* Effect.promise(async () => {
						const layer = (await readdir(directory)).find((name) =>
							name.startsWith("layer-")
						);
						if (!layer) throw new Error("Expected a layer");
						await writeFile(join(directory, layer), "broken");
					});
				} else {
					yield* Effect.scoped(
						Effect.gen(function* () {
							const index = yield* SharedIndex;
							const joined = yield* readJoinedTarget(yield* index.open());
							const writer = yield* index.writer();
							if (damaged === "invalidated") {
								yield* writer.publish("joined.invalidated", "invalidated", {
									columns: [
										{
											name: "invalidate",
											kind: "bytes",
											load: async () => Uint8Array.of(1)
										}
									]
								});
							} else {
								const meta = {
									...joined.meta,
									aliases: {},
									...(damaged === "meta-version" ? { version: -1 } : undefined),
									...(damaged === "meta-project"
										? {
												input: {
													...joined.meta.input,
													projectRoot: "other-project"
												}
											}
										: undefined),
									...(damaged === "dependencies"
										? { dependencies: { missing: "key" } }
										: undefined)
								};
								yield* writer.publish("joined", "damaged", {
									columns: [
										{
											name: "join.meta",
											kind: "bytes",
											load: async () =>
												new TextEncoder().encode(JSON.stringify(meta))
										}
									]
								});
							}
						}).pipe(Effect.provide(sharedIndexNodeLayer(configuration)))
					);
				}
			}
			const opened = yield* Effect.scoped(
				Effect.gen(function* () {
					return yield* (yield* GameTextIndexSteps).openCommitted(fixture.request);
				}).pipe(Effect.provide(fixture.layer()))
			);
			expect(Option.isNone(opened)).toBe(true);
			expect(fixture.inventories()).toBe(damaged === "missing" ? 0 : 1);
		}).pipe(Effect.scoped)
	);
}

it.live("discards a committed cache when the native query store disagrees", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* (yield* GameTextIndexSteps).prepareTarget(fixture.request);
			}).pipe(Effect.provide(fixture.layer()))
		);
		const queries = Layer.succeed(
			GameTextIndexQuery,
			GameTextIndexQuery.of({
				open: () =>
					Effect.fail(
						new GameTextIndexError({
							code: "index_failed",
							operation: "query_store",
							message: "Store disagreement",
							recovery: "Rebuild",
							nextStep: "reconcile",
							retrySafe: true
						})
					)
			})
		);
		const opened = yield* Effect.scoped(
			Effect.gen(function* () {
				return yield* (yield* GameTextIndexSteps).openCommitted(fixture.request);
			}).pipe(
				Effect.provide(
					gameTextIndexStepsLayer(join(fixture.projectRoot, "cache")).pipe(
						Layer.provide(queries),
						Layer.provide(typeScriptIndexBuilderLayer),
						Layer.provide(fixture.source),
						Layer.provide(fixture.evidence)
					)
				)
			)
		);
		expect(Option.isNone(opened)).toBe(true);
	}).pipe(Effect.scoped)
);
