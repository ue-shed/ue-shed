import { join } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { GameTextIndexBuilderLive } from "./index-builder.js";
import { GameTextIndexRefresh, gameTextIndexRefreshLayer } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

it.skipIf(!executable)(
	"production reuses native input layers with the complete TypeScript builder and query",
	async () => {
		if (!executable) throw new Error("Native setup requires a reader executable");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					const layer = (builder: typeof GameTextIndexBuilderLive) =>
						gameTextIndexRefreshLayer(join(fixture.projectRoot, "cache")).pipe(
							Layer.provide(builder),
							Layer.provide(fixture.source),
							Layer.provide(fixture.evidence)
						);
					const request = { query: "Source", capability: "all" as const, pageSize: 10 };
					const previous = yield* Effect.scoped(
						Effect.gen(function* () {
							const model = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							expect(model.join.key).toMatch(/^joined-native-v1:/u);
							return yield* model.search(request);
						})
					).pipe(
						Effect.provide(
							layer(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 120_000
								})
							)
						)
					);
					yield* Effect.gen(function* () {
						const refresh = yield* GameTextIndexRefresh;
						const model = yield* refresh.refresh({
							...fixture.request,
							changedFiles: []
						});
						expect(model.join.key).toMatch(/^joined-v18:/u);
						expect(model.join.rebuilt).toBe(true);
						expect(model.packages.readPackages).toBe(0);
						expect(yield* model.search(request)).toEqual(previous);
						expect(
							model.query.focus({ id: previous.units[0]!.id, pageSize: 10 })
						).toBeDefined();
						const unchanged = yield* refresh.refresh({
							...fixture.request,
							changedFiles: []
						});
						expect(unchanged.join.rebuilt).toBe(false);
						expect(yield* unchanged.search(request)).toEqual(previous);
					}).pipe(Effect.provide(layer(GameTextIndexBuilderLive)));
				})
			)
		);
	}
);
