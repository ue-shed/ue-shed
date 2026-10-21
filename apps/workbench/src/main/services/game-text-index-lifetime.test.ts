import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { makeHost, request } from "./game-text-index-lifetime.test-support.js";
import { WorkbenchGameText } from "./game-text.js";
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
