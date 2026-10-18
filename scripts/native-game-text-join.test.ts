import { nativeEngineResponses } from "./native-game-text-engine.test-support.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { GameTextIndexBuilder } from "../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../packages/game-text/src/native-index-builder.ts";
import { compareJoinFuzzInput, joinFuzzInput } from "./columnar-join-fuzz.test-support.ts";
import { withJoinCache } from "./columnar-join.test-support.ts";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
it.skipIf(!executable)(
	"native persisted joins and queries match the original event oracle",
	async () => {
		if (!executable) throw new Error("Native reader is required");
		await withJoinCache(async (cache) => {
			for (let seed = 0; seed < 32; seed++) {
				const directory = join(cache, String(seed));
				await mkdir(directory);
				const differences = await compareJoinFuzzInput(
					joinFuzzInput(seed),
					directory,
					true,
					(configuration, input) =>
						Effect.runPromise(
							Effect.scoped(
								Effect.gen(function* () {
									const builder = yield* GameTextIndexBuilder;
									return yield* builder.withSession(
										{ configuration },
										builder.refreshJoinedTarget(input)
									);
								})
							).pipe(
								Effect.asVoid,
								Effect.provide(
									nativeIndexBuilderLayer({
										executable,
										timeoutMs: 30_000,
										catalogTimeoutMs: 120_000
									})
								)
							)
						),
					nativeEngineResponses(executable)
				);
				expect(differences, `seed ${seed}`).toEqual([]);
			}
		});
	},
	120_000
);
