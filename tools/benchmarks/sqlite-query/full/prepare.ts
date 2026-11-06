import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect } from "effect";
import {
	tinyJoinInput,
	semanticJoinInput,
	runJoinIn,
	joinStoreOptions
} from "../../../../scripts/columnar-join.test-support.ts";
import { SharedIndex } from "../../../../packages/game-text/src/shared-index.ts";
import { readJoinedTarget } from "../../../../packages/game-text/src/joined-target-reader.ts";
import { GameTextIndexBuilder } from "../../../../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../../../../packages/game-text/src/native-index-builder.ts";
import { withCorpusUnrealLock } from "../../../../scripts/game-text-corpus-lock.ts";

const [rootPath, scaleText = "1", mode] = process.argv.slice(2);
if (!rootPath) throw new Error("prepare.ts ROOT SCALE [--reuse]");
const targetKey = mode === "--semantic" ? "Cases" : "Generated";
const root = resolve(rootPath),
	scale = Number(scaleText),
	executable = resolve("target/release/uasset.exe");
if (!(scale > 0 && scale <= 1)) throw new Error("Scale must be in (0,1]");
await withCorpusUnrealLock(async () => {
	process.env.UE_SHED_UASSET_EXECUTABLE = executable;
	if (mode !== "--reuse") {
		await mkdir(root);
		const input =
			mode == "--semantic" ? await semanticJoinInput(root) : await tinyJoinInput(root, scale);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const builder = yield* GameTextIndexBuilder;
					return yield* builder.withSession(
						{ configuration: joinStoreOptions(input.projectRoot, root, targetKey) },
						builder.refreshJoinedTarget({
							projectRoot: input.projectRoot,
							target: input.evidence.target
						})
					);
				})
			).pipe(
				Effect.provide(
					nativeIndexBuilderLayer({
						executable,
						timeoutMs: 600000,
						catalogTimeoutMs: 600000
					})
				)
			)
		);
	}
	const projectRoot = join(root, mode === "--semantic" ? "cases" : "tiny");
	const retained = await runJoinIn(
		projectRoot,
		root,
		targetKey,
		Effect.gen(function* () {
			const store = yield* SharedIndex;
			const manifest = yield* store.inspect();
			const reader = yield* store.open();
			const joined = yield* readJoinedTarget(reader);
			return { manifest, meta: joined.meta };
		})
	);
	if (!retained.manifest.active.joined) throw new Error("No native joined generation");
	const input = {
		settings: {
			configuration: {
				...joinStoreOptions(projectRoot, root, targetKey),
				sharedProject: false
			},
			generation: retained.manifest.generation,
			joinedKey: retained.manifest.active.joined
		},
		scale,
		seed: 57,
		rawLineCount: retained.meta.count,
		target: retained.meta.input.target.name,
		nativeCulture: retained.meta.input.target.nativeCulture,
		cultures: retained.meta.input.target.cultures
	};
	await writeFile(resolve(root, "input.json"), JSON.stringify(input));
	console.log(
		JSON.stringify({
			phase: "prepared",
			scale,
			rawLineCount: input.rawLineCount,
			reused: mode === "--reuse"
		})
	);
});
