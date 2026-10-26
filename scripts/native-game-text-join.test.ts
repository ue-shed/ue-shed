import { nativeEngineFindings, nativeEngineLines } from "./native-game-text-engine.test-support.ts";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { GameTextIndexBuilder } from "../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../packages/game-text/src/native-index-builder.ts";
import {
	compareJoinFuzzInput,
	editJoinFuzzInput,
	joinFuzzInput,
	pairlessJoinFuzzInput
} from "./columnar-join-fuzz.test-support.ts";
import { withJoinCache } from "./columnar-join.test-support.ts";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const seeds =
	process.env.UE_SHED_JOIN_FUZZ_SWEEP === "1"
		? Number(process.env.UE_SHED_NATIVE_JOIN_FUZZ_SEEDS ?? 32)
		: 8;
if (!Number.isSafeInteger(seeds) || seeds < 1)
	throw new Error("Native fuzz seed count must be positive.");
const buildNativeJoin =
	(
		executable: string,
		strategies: string[] = []
	): NonNullable<Parameters<typeof compareJoinFuzzInput>[3]> =>
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
				Effect.map((outcome) => {
					strategies.push(
						outcome.strategy === "full" && outcome.incrementalFallback
							? `full (${outcome.incrementalFallback})`
							: (outcome.strategy ?? "reused")
					);
				}),
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
			for (let seed = 0; seed < seeds; seed++) {
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
	// The timeout scales with the sweep's seed count.
	seeds * 15_000
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

it.skipIf(!executable)(
	"incremental findings after an in-place edit equal a full evaluation",
	async () => {
		if (!executable) throw new Error("Native reader is required");
		const findings = nativeEngineFindings(executable);
		await withJoinCache(async (cache) => {
			const joins: Record<string, number> = {};
			let incremental = 0;
			for (let seed = 0; seed < seeds; seed++) {
				const directory = join(cache, String(seed));
				await mkdir(directory);
				// Half the seeds have nothing to pair, so the join patches the edit.
				const input = seed % 2 ? pairlessJoinFuzzInput(seed) : joinFuzzInput(seed);
				const lines = nativeEngineLines(executable);
				expect(
					await compareJoinFuzzInput(
						input,
						directory,
						true,
						buildNativeJoin(executable),
						lines
					),
					`seed ${seed}`
				).toEqual([]);
				const configuration = {
					projectKey: join(directory, "project"),
					cacheRoot: directory,
					targetKey: "Fuzz"
				};
				// The layer the evaluation after the edit starts from.
				await findings(configuration);
				const strategies: string[] = [];
				expect(
					await compareJoinFuzzInput(
						editJoinFuzzInput(input),
						directory,
						true,
						buildNativeJoin(executable, strategies),
						lines
					),
					`seed ${seed} edited`
				).toEqual([]);
				for (const strategy of strategies) joins[strategy] = (joins[strategy] ?? 0) + 1;
				const full = `${directory}-full`;
				await cp(directory, full, { recursive: true });
				const { incremental: evaluatedIncrementally, ...evaluated } =
					await findings(configuration);
				const { incremental: _full, ...expected } = await findings(
					{ ...configuration, cacheRoot: full },
					true
				);
				expect(evaluated, `seed ${seed}`).toEqual(expected);
				if (evaluatedIncrementally) incremental++;
			}
			console.log(
				`In-place edits: ${incremental} of ${seeds} evaluations incremental; joins ${JSON.stringify(joins)}`
			);
			// Otherwise the round compares two full evaluations.
			expect(joins.incremental ?? 0, "incremental joins").toBeGreaterThan(0);
			expect(incremental, "incremental evaluations").toBeGreaterThan(0);
		});
	},
	// The timeout scales with the sweep's seed count.
	seeds * 75_000
);
