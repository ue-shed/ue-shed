import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Metric, Schema, Scope } from "effect";
import { expect, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GameTextIndexSteps, gameTextIndexStepsLayer } from "./index-steps.js";
import { GameTextIndexRefresh, GameTextIndexSource } from "./index-refresh.js";
import { typeScriptIndexBuilderLayer } from "./index-builder.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";
import { makeRetainedGameTextIndex } from "./index-retained.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { TextUnitId } from "./identifiers.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import { HostSliceScheduler } from "./host-slices.js";
import { performance } from "node:perf_hooks";

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
	"falls back when a ready worker terminates before the host can dispatch its exit",
	() => {
		const messages = vi.spyOn(Worker.prototype, "postMessage");
		const wait = Atomics.wait;
		const waits = vi
			.spyOn(Atomics, "wait")
			.mockImplementation((array, index, value, timeout) => {
				// Fail the old 30-second bridge immediately instead of freezing this regression test.
				expect(timeout).toBeLessThanOrEqual(100);
				return wait(array, index, value, timeout);
			});
		return Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const request = { query: "Source", capability: "all" as const, pageSize: 10 };
				const expected = yield* model.search(request);
				const worker = messages.mock.contexts.at(-1);
				if (!(worker instanceof Worker))
					throw new Error("Expected the actual query worker.");
				let exited = false;
				worker.once("exit", () => {
					exited = true;
				});
				// There must be no yield between termination and this synchronous query.
				const termination = worker.terminate();
				expect(model.query.search(request)).toEqual(expected);
				expect(exited).toBe(false);
				const waited = waits.mock.calls.length;
				expect(waited).toBeGreaterThan(0);
				// Subsequent calls reuse the same pinned local query without waiting on the dead peer.
				expect(model.query.search(request)).toEqual(expected);
				expect(
					model.query.focus({ id: expected.units[0]!.id, pageSize: 10 })?.unit.id
				).toBe(expected.units[0]!.id);
				expect(waits).toHaveBeenCalledTimes(waited);
				yield* Effect.promise(() => termination);
			}).pipe(Effect.provide(fixture.layer(true)));
		}).pipe(
			Effect.scoped,
			Effect.ensuring(
				Effect.sync(() => {
					messages.mockRestore();
					waits.mockRestore();
				})
			)
		);
	},
	30_000
);

it.live(
	"replaces a dead worker on unchanged rescan without evicting its healthy replacement",
	() => {
		const messages = vi.spyOn(Worker.prototype, "postMessage");
		return Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const retained = yield* makeRetainedGameTextIndex();
				const started = Metric.counter("game_text.index.search_workers_started");
				const beforeStarted = (yield* Metric.value(started)).count;
				const prepare = () =>
					Effect.scoped(
						Effect.gen(function* () {
							const model = yield* retained.refresh(fixture.request);
							yield* model.retain;
							return model;
						})
					);
				const first = yield* prepare();
				const request = { query: "Source", capability: "all" as const, pageSize: 10 };
				const expected = yield* first.search(request);
				const worker = messages.mock.contexts.at(-1);
				if (!(worker instanceof Worker))
					throw new Error("Expected the actual query worker.");
				const oldPin = yield* Scope.make();
				yield* Effect.addFinalizer(() => Scope.close(oldPin, Exit.void));
				yield* first.borrow.pipe(Effect.provideService(Scope.Scope, oldPin));
				yield* Effect.promise(() => worker.terminate());
				expect(yield* first.search(request).pipe(Effect.flip)).toMatchObject({
					_tag: "SnapshotStoreError",
					code: "unavailable"
				});
				const replacement = yield* prepare();
				expect(replacement.queryRevision).toBe(first.queryRevision);
				expect(yield* replacement.search(request)).toEqual(expected);
				expect(first.query.search(request)).toEqual(expected);
				expect((yield* Metric.value(started)).count - beforeStarted).toBe(2);
				yield* Scope.close(oldPin, Exit.void);
				// Retiring the old instance must leave the new entry available to concurrent models.
				const project = yield* steps.refreshProject(fixture.request);
				const target = yield* steps.buildTarget(
					project,
					yield* steps.importTarget(project, fixture.request)
				);
				const overlapping = yield* Effect.all(
					[steps.openTarget(target), steps.openTarget(target)],
					{
						concurrency: 2
					}
				);
				for (const model of overlapping)
					expect(yield* model.search(request)).toEqual(expected);
				expect((yield* Metric.value(started)).count - beforeStarted).toBe(2);
			}).pipe(Effect.provide(fixture.layer(true)));
		}).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => messages.mockRestore())));
	},
	// Worker threads start slowly when the whole suite runs in parallel.
	30_000
);

it.live(
	"prepares the query once in the worker and serves the host's synchronous query from it",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const preparations = Metric.counter("game_text.index.host_query_preparations");
			const open = (worker: boolean) =>
				Effect.gen(function* () {
					const steps = yield* GameTextIndexSteps;
					const project = yield* steps.refreshProject(fixture.request);
					const target = yield* steps.buildTarget(
						project,
						yield* steps.importTarget(project, fixture.request)
					);
					const before = (yield* Metric.value(preparations)).count;
					const model = yield* steps.openTarget(target);
					const prepared = (yield* Metric.value(preparations)).count - before;
					const target_ = fixture.request.targetName;
					const search = { query: "", capability: "all" as const, pageSize: 10 };
					const unpaged = { query: "", capability: "all" as const };
					const localized = { ...unpaged, localization: { target: target_ } };
					const page = model.query.search(search);
					const lines = model.query.localizationLines(localized);
					const unit = page.units[0]!;
					return {
						prepared,
						summary: model.query.summary(),
						page,
						lines,
						export: model.query.export(unpaged),
						focus: model.query.focus({ id: unit.id, pageSize: 10 }),
						missingFocus: model.query.focus({
							id: Schema.decodeUnknownSync(TextUnitId)(`${unit.id}-absent`),
							pageSize: 10
						}),
						lineFocus: model.query.localizationFocus(lines[0]!.id),
						invalid: yield* Effect.flip(
							Effect.try({
								try: () => model.query.localizationLines(unpaged),
								catch: (cause) => cause
							})
						)
					};
				}).pipe(Effect.scoped, Effect.provide(fixture.layer(worker)));
			const host = yield* open(false);
			const worker = yield* open(true);
			expect(host.prepared).toBe(1);
			// The worker's preparation is the only one: the host borrows it.
			expect(worker.prepared).toBe(0);
			expect(host.lines.length).toBeGreaterThan(0);
			expect(host.focus).toBeDefined();
			expect(host.missingFocus).toBeUndefined();
			expect(worker.invalid).toMatchObject({
				_tag: "GameTextLocalizationError",
				code: "invalid_selection"
			});
			const { prepared: _host, invalid: hostInvalid, ...hostResults } = host;
			const { prepared: _worker, invalid: workerInvalid, ...workerResults } = worker;
			expect(workerInvalid).toEqual(hostInvalid);
			expect(workerResults).toEqual(hostResults);
		}),
	// Worker threads start slowly when the whole suite runs in parallel.
	30_000
);

it.live(
	"shares query workers across overlapping unchanged models and pins changed generations",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const steps = yield* GameTextIndexSteps;
				const started = Metric.counter("game_text.index.search_workers_started");
				const stopped = Metric.counter("game_text.index.search_workers_stopped");
				const beforeStarted = (yield* Metric.value(started)).count;
				const beforeStopped = (yield* Metric.value(stopped)).count;
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
				expect((yield* Metric.value(started)).count - beforeStarted).toBe(1);
				const request = { query: "Source", capability: "all" as const, pageSize: 10 };
				const expected = first.query.search(request);
				yield* Scope.close(firstScope, Exit.void);
				expect((yield* Metric.value(stopped)).count - beforeStopped).toBe(0);
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
				expect((yield* Metric.value(started)).count - beforeStarted).toBe(2);
				// The old model has never searched this term; it must still use its pinned snapshot.
				expect(yield* second.search({ ...request, query: "Updated" })).toEqual(
					second.query.search({ ...request, query: "Updated" })
				);
				expect(yield* changed.search({ ...request, query: "Updated" })).toEqual(
					changed.query.search({ ...request, query: "Updated" })
				);
				yield* Scope.close(secondScope, Exit.void);
				expect((yield* Metric.value(stopped)).count - beforeStopped).toBe(1);
			}).pipe(Effect.provide(fixture.layer(true)));
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
				expect(opened.map((result) => result.localizationJoin.target)).toEqual([
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
				expect(compatibility.corpus).toEqual(opened[0]?.corpus);
				expect(compatibility.localizationJoin).toEqual(opened[0]?.localizationJoin);
			}).pipe(Effect.provide(fixture.layer(true)));
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
			expect(result.localizationJoin.lines).toHaveLength(1);
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
				const original = pinned.query.search(search);
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
				expect(updated.query.search({ ...search, query: "Updated" }).total).toBe(1);
				expect(pinned.query.search(search)).toEqual(original);
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
				result.query.search({ query: "Source", capability: "all", pageSize: 10 }).total
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
				const before = old.query.search(search);
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
				expect(next.query.search({ ...search, query: "Updated" }).total).toBe(1);
				expect(next.query.search(search).total).toBe(0);
				expect(old.query.search(search)).toEqual(before);
				expect(yield* old.search(search)).toEqual(before);
			}).pipe(
				Effect.provideService(GameTextIndexProgressReporter, report),
				Effect.provide(fixture.layer(true))
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
				result.localizationJoin.lines[0]?.cultures.some(
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
