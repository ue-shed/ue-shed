/** Prepare retained generated evidence with the production native join; no Unreal content writes. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import {
	tinyJoinInput,
	runJoinIn,
	joinStoreOptions
} from "../../../scripts/columnar-join.test-support.ts";
import { GameTextIndexBuilder } from "../../../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../../../packages/game-text/src/native-index-builder.ts";
import { SharedIndex } from "../../../packages/game-text/src/shared-index.ts";
import { openNativeTextQuery } from "../../../packages/game-text/src/native-query.ts";
import { nativeGameTextEngineClientLayer } from "../../../packages/unreal-assets/dist/index.js";
import { withCorpusUnrealLock } from "../../../scripts/game-text-corpus-lock.ts";

const root = resolve(process.argv[2]!);
const scale = Number(process.argv[3] ?? "0.01");
const executable = resolve(process.argv[4] ?? "target/release/uasset.exe");
if (!process.argv[2] || !Number.isFinite(scale) || scale <= 0 || scale > 1)
	throw new Error("Usage: prepare.ts NEW_OUTPUT SCALE<=1 [READER]");
await mkdir(root, { recursive: false });
await withCorpusUnrealLock(async () => {
	process.env.UE_SHED_UASSET_EXECUTABLE = executable;
	const started = performance.now();
	const input = await tinyJoinInput(root, scale);
	const preparedMs = performance.now() - started;
	const configuration = joinStoreOptions(input.projectRoot, root, "Generated");
	const joinedAt = performance.now();
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const builder = yield* GameTextIndexBuilder;
				return yield* builder.withSession(
					{ configuration },
					builder.refreshJoinedTarget({
						projectRoot: input.projectRoot,
						target: input.evidence.target
					})
				);
			})
		).pipe(
			Effect.provide(
				nativeIndexBuilderLayer({ executable, timeoutMs: 120000, catalogTimeoutMs: 120000 })
			)
		)
	);
	const nativeJoinMs = performance.now() - joinedAt;
	const manifest = await runJoinIn(
		input.projectRoot,
		root,
		"Generated",
		Effect.gen(function* () {
			return yield* (yield* SharedIndex).inspect();
		})
	);
	if (!manifest.active.joined) throw new Error("Native join did not publish.");
	const settings = {
		configuration: { ...configuration, sharedProject: false },
		generation: manifest.generation,
		joinedKey: manifest.active.joined
	};
	const exportedAt = performance.now();
	const facts = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const query = yield* openNativeTextQuery(settings);
				return yield* query.selectLocalizationLines(
					{
						query: "",
						capability: "all",
						localization: { target: input.evidence.target.name }
					},
					["identity", "source", "marks", "audience", "places"]
				);
			})
		).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
	);
	const exportMs = performance.now() - exportedAt;
	await writeFile(resolve(root, "facts.json"), JSON.stringify(facts));
	await writeFile(
		resolve(root, "input.json"),
		JSON.stringify({
			settings,
			scale,
			seed: 57,
			rows: facts.length,
			preparedMs,
			nativeJoinMs,
			exportMs
		})
	);
	console.log(JSON.stringify(JSON.parse(await readFile(resolve(root, "input.json"), "utf8"))));
});
