/** Compare the diagnostic projection control with baseline reads on independent seeded join cases. */
import { deepStrictEqual, equal } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect } from "effect";
import {
	compareJoinFuzzInput,
	joinFuzzInput
} from "../../../scripts/columnar-join-fuzz.test-support.ts";
import { runJoinIn } from "../../../scripts/columnar-join.test-support.ts";
import { SharedIndex } from "../../../packages/game-text/src/shared-index.ts";
import { GameTextIndexBuilder } from "../../../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../../../packages/game-text/src/native-index-builder.ts";
import { openNativeTextQuery } from "../../../packages/game-text/src/native-query.ts";
import { nativeGameTextEngineClientLayer } from "../../../packages/unreal-assets/dist/index.js";
import { withCorpusUnrealLock } from "../../../scripts/game-text-corpus-lock.ts";
import { LocalizationTargetName } from "../../../packages/localization/dist/index.js";

const [output, baseline, control] = process.argv.slice(2);
if (!output || !baseline || !control)
	throw new Error("verify-projection.ts NEW_OUTPUT BASELINE_READER CONTROL_READER");
const root = resolve(output);
const base = resolve(baseline),
	candidate = resolve(control);
process.env.UE_SHED_UASSET_EXECUTABLE = base;
await mkdir(root, { recursive: false });
const results: {
	seed: number;
	rows: number;
	unicodeRows: number;
	loneSurrogateRows: number;
	nullIdentityRows: number;
}[] = [];
await withCorpusUnrealLock(async () => {
	for (const seed of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const cache = join(root, String(seed));
		await mkdir(cache);
		const differences = await compareJoinFuzzInput(
			joinFuzzInput(seed),
			cache,
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
								executable: base,
								timeoutMs: 120000,
								catalogTimeoutMs: 120000
							})
						)
					)
				)
		);
		equal(differences.length, 0, `Independent join oracle, seed ${seed}`);
		const project = join(cache, "project");
		const manifest = await runJoinIn(
			project,
			cache,
			"Fuzz",
			Effect.gen(function* () {
				return yield* (yield* SharedIndex).inspect();
			})
		);
		if (!manifest.active.joined) throw new Error("No joined target.");
		const read = (executable: string) =>
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const query = yield* openNativeTextQuery({
							configuration: {
								projectKey: project,
								cacheRoot: cache,
								targetKey: "Fuzz",
								sharedProject: false
							},
							generation: manifest.generation,
							joinedKey: manifest.active.joined!
						});
						return yield* query.selectLocalizationLines(
							{
								query: "",
								capability: "all",
								localization: { target: LocalizationTargetName.make("Fuzz") }
							},
							["identity", "source"]
						);
					})
				).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
			);
		const expected = await read(base),
			actual = await read(candidate);
		deepStrictEqual(actual, expected, `Projection parity, seed ${seed}`);
		results.push({
			seed,
			rows: actual.length,
			unicodeRows: actual.filter((row) =>
				Array.from(row.source).some((character) => character.codePointAt(0)! > 127)
			).length,
			loneSurrogateRows: actual.filter((row) => /[\ud800-\udfff]/u.test(row.source)).length,
			nullIdentityRows: actual.filter((row) => row.identity === null).length
		});
	}
});
await writeFile(
	join(root, "results.json"),
	JSON.stringify(
		{ seeds: results, parity: "baseline, projected control and independent join oracle agree" },
		null,
		2
	)
);
