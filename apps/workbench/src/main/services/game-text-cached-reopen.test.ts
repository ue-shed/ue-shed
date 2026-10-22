import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { TextCorpusQueryRunResult } from "@ue-shed/game-text/schema";
import { GameTextIndexSteps } from "@ue-shed/game-text/index";
import { STARTER_GAME_TEXT_RULES } from "@ue-shed/game-text/rules";
import { makeHost, request } from "./game-text-index-lifetime.test-support.js";
import { WorkbenchGameText } from "./game-text.js";

it.live(
	"reopens a persisted target immediately, then replaces and releases its cached reader",
	() =>
		Effect.gen(function* () {
			const test = yield* makeHost("cached");
			yield* Effect.gen(function* () {
				const host = yield* WorkbenchGameText;
				const result = yield* host.configuredRefresh(false);
				expect(result).toMatchObject({ status: "completed", cached: true });
				expect(yield* Schema.decodeUnknownEffect(TextCorpusQueryRunResult)(result)).toEqual(
					result
				);
				expect(test.fixture.inventories()).toBe(1);
				expect(test.modelOpens()).toBe(0);
				const before = yield* host.search(request);
				if (before.status !== "ready") throw new Error("Expected cached search");
				const id = before.page.units[0]!.id;
				test.fixture.setSource("Replacement");
				test.fixture.pauseReads(
					Deferred.succeed(test.prepared, undefined).pipe(
						Effect.andThen(Deferred.await(test.allowPublication))
					)
				);
				const refresh = yield* host.configuredRefresh(true).pipe(Effect.forkChild);
				yield* Deferred.await(test.prepared);
				expect(yield* Ref.get(test.generation)).toBe(1);
				expect(yield* host.configuredRefresh(false)).toMatchObject({
					status: "completed",
					cached: true
				});
				expect(
					yield* host.search({ ...request, facets: { origins: true, assets: true } })
				).toMatchObject({
					status: "ready",
					page: { units: [{ source: { value: "Source" } }], facets: {} }
				});
				expect(yield* host.focus({ id, pageSize: 10 })).toMatchObject({
					status: "found",
					focus: { unit: { source: { value: "Source" } } }
				});
				// The source refresh holds the writer here. Selecting translations must borrow the cache.
				expect((yield* host.localizationTarget(test.fixture.target.name)).status).toBe(
					"ready"
				);
				expect(
					(yield* host.search({
						...request,
						localization: { target: test.fixture.target.name }
					})).status
				).toBe("ready");
				expect(yield* host.previewQualityRules(STARTER_GAME_TEXT_RULES)).toEqual({
					status: "not_ready"
				});
				expect(yield* host.operationTarget(test.fixture.target.name)).toBeUndefined();
				expect(
					(yield* host.investigationExport(
						{ mode: "corpus", query: "", capability: "all", qualityFilter: "all" },
						"json"
					)).status
				).toBe("failed");
				expect(yield* Deferred.isDone(test.cachedRetired)).toBe(false);
				yield* Deferred.succeed(test.allowPublication, undefined);
				expect(yield* Fiber.join(refresh)).toMatchObject({ status: "completed" });
				yield* Deferred.await(test.cachedRetired);
				expect(yield* host.configuredRefresh(false)).not.toHaveProperty("cached");
				expect(yield* host.search(request)).toMatchObject({
					status: "ready",
					page: { units: [{ source: { value: "Replacement" } }] }
				});
			}).pipe(
				Effect.ensuring(Deferred.succeed(test.allowPublication, undefined)),
				Effect.provide(test.layer)
			);
		}).pipe(Effect.scoped)
);

for (const deselect of [false, true]) {
	it.live(
		`releases the cached reader when the shell ${deselect ? "clears" : "switches"} its project`,
		() =>
			Effect.gen(function* () {
				const test = yield* makeHost("cached");
				yield* Effect.gen(function* () {
					const host = yield* WorkbenchGameText;
					expect(yield* host.configuredRefresh(false)).toMatchObject({ cached: true });
					yield* host.localizationTarget(test.fixture.target.name);
					yield* Ref.set(
						test.selectedRoot,
						deselect ? undefined : join(test.fixture.projectRoot, "Other")
					);
					expect(yield* host.search(request)).toEqual({ status: "not_ready" });
					yield* Deferred.await(test.cachedRetired);
					expect(test.modelOpens()).toBe(0);
				}).pipe(Effect.provide(test.layer));
			}).pipe(Effect.scoped)
	);
}

it.live("does not publish a cached open superseded by a completed refresh", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("cached-open");
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			const opening = yield* host.configuredRefresh(false).pipe(Effect.forkChild);
			yield* Deferred.await(test.cacheOpening);
			test.fixture.setSource("Replacement");
			expect((yield* host.configuredRefresh(true)).status).toBe("completed");
			yield* Deferred.succeed(test.allowCachedOpen, undefined);
			expect(yield* Fiber.join(opening)).toEqual({ status: "not_scanned" });
			yield* Deferred.await(test.cachedRetired);
			expect(yield* host.search(request)).toMatchObject({
				status: "ready",
				page: { units: [{ source: { value: "Replacement" } }] }
			});
		}).pipe(
			Effect.ensuring(Deferred.succeed(test.allowCachedOpen, undefined)),
			Effect.provide(test.layer)
		);
	}).pipe(Effect.scoped)
);

it.live("does not publish a cached open when the shell switches projects during the read", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("cached-open");
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			const opening = yield* host.configuredRefresh(false).pipe(Effect.forkChild);
			yield* Deferred.await(test.cacheOpening);
			yield* Ref.set(test.selectedRoot, undefined);
			yield* Deferred.succeed(test.allowCachedOpen, undefined);
			expect(yield* Fiber.join(opening)).toEqual({ status: "not_scanned" });
			yield* Deferred.await(test.cachedRetired);
			expect(yield* host.search(request)).toEqual({ status: "not_ready" });
		}).pipe(
			Effect.ensuring(Deferred.succeed(test.allowCachedOpen, undefined)),
			Effect.provide(test.layer)
		);
	}).pipe(Effect.scoped)
);

it.live("keeps a scanned model queryable across a Project Index generation change", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("pipeline");
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			yield* host.configuredRefresh();
			const before = yield* host.search(request);
			yield* Ref.set(test.generation, 1);
			expect(yield* host.search(request)).toEqual(before);
		}).pipe(Effect.provide(test.layer));
	}).pipe(Effect.scoped)
);

it.live("does not open a disk cache while an unpublished scan is running", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("cached");
		test.fixture.setSource("Replacement");
		test.fixture.pauseReads(
			Deferred.succeed(test.prepared, undefined).pipe(
				Effect.andThen(Deferred.await(test.allowPublication))
			)
		);
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			const refresh = yield* host.configuredRefresh(true).pipe(Effect.forkChild);
			yield* Deferred.await(test.prepared);
			expect(yield* host.configuredRefresh(false)).toEqual({ status: "not_scanned" });
			expect(test.cacheOpens()).toBe(0);
			yield* Deferred.succeed(test.allowPublication, undefined);
			expect((yield* Fiber.join(refresh)).status).toBe("completed");
		}).pipe(
			Effect.ensuring(Deferred.succeed(test.allowPublication, undefined)),
			Effect.provide(test.layer)
		);
	}).pipe(Effect.scoped)
);

it.live("falls back to the committed source view when the preferred target has no join", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("pipeline");
		// Only the source view exists, but discovery still prefers the localization target.
		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* (yield* GameTextIndexSteps).prepareTarget({
					projectRoot: test.fixture.projectRoot
				});
			}).pipe(Effect.provide(test.fixture.layer()))
		);
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			expect(yield* host.configuredRefresh(false)).toMatchObject({
				status: "completed",
				cached: true
			});
			expect(test.cacheOpens()).toBe(2);
			expect(yield* host.search(request)).toMatchObject({
				status: "ready",
				page: { total: 1 }
			});
			expect(test.fixture.inventories()).toBe(1);
		}).pipe(Effect.provide(test.layer));
	}).pipe(Effect.scoped)
);

it.live("keeps no-store navigation cold and never starts preparation", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("pipeline");
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			expect(yield* host.configuredRefresh(false)).toEqual({ status: "not_scanned" });
			expect(test.fixture.inventories()).toBe(0);
			expect(test.fixture.packageReads()).toBe(0);
			expect(test.modelOpens()).toBe(0);
		}).pipe(Effect.provide(test.layer));
	}).pipe(Effect.scoped)
);

it.live("publishes a refresh while the cached reader is still finalizing", () =>
	Effect.gen(function* () {
		const test = yield* makeHost("cached-retirement");
		yield* Effect.gen(function* () {
			const host = yield* WorkbenchGameText;
			yield* host.configuredRefresh(false);
			test.fixture.setSource("Replacement");
			const refresh = yield* host.configuredRefresh(true).pipe(Effect.forkChild);
			yield* Deferred.await(test.cachedRetired);
			expect(yield* host.search(request)).toMatchObject({
				status: "ready",
				page: { units: [{ source: { value: "Replacement" } }] }
			});
			expect((yield* Fiber.join(refresh)).status).toBe("completed");
			yield* Deferred.succeed(test.allowRetirement, undefined);
		}).pipe(
			Effect.ensuring(Deferred.succeed(test.allowRetirement, undefined)),
			Effect.provide(test.layer)
		);
	}).pipe(Effect.scoped)
);
