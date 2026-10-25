import { nativeEngineLines } from "./native-game-text-engine.test-support.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { GameTextIndexBuilder } from "../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../packages/game-text/src/native-index-builder.ts";
import { compareJoinFuzzInput, joinFuzzInput } from "./columnar-join-fuzz.test-support.ts";
import { withJoinCache } from "./columnar-join.test-support.ts";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const buildNativeJoin =
	(executable: string): NonNullable<Parameters<typeof compareJoinFuzzInput>[3]> =>
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
		);

it.skipIf(!executable)(
	"native persisted joins and line facts match the planted join",
	async () => {
		if (!executable) throw new Error("Native reader is required");
		await withJoinCache(async (cache) => {
			const count =
				process.env.UE_SHED_JOIN_FUZZ_SWEEP === "1"
					? Number(process.env.UE_SHED_NATIVE_JOIN_FUZZ_SEEDS ?? 32)
					: 8;
			if (!Number.isSafeInteger(count) || count < 1)
				throw new Error("Native fuzz seed count must be positive.");
			for (let seed = 0; seed < count; seed++) {
				const directory = join(cache, String(seed));
				await mkdir(directory);
				const differences = await compareJoinFuzzInput(
					joinFuzzInput(seed),
					directory,
					true,
					buildNativeJoin(executable),
					nativeEngineLines(executable)
				);
				expect(differences, `seed ${seed}`).toEqual([]);
			}
		});
	},
	120_000
);

it.skipIf(!executable)(
	"keeps line identities correct when key zero is nonempty",
	async () => {
		if (!executable) throw new Error("Native reader is required");
		await withJoinCache(async (cache) => {
			const differences = await compareJoinFuzzInput(
				{ ...joinFuzzInput(8), excluded: [] },
				cache,
				true,
				buildNativeJoin(executable),
				nativeEngineLines(executable),
				true
			);
			expect(differences).toEqual([]);
		});
	},
	30_000
);
