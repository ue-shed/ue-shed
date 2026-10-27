import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, type Layer } from "effect";
import type { GameTextIndexRefresh } from "../packages/game-text/dist/entry-index.js";
import {
	compareGameTextCorpus as compareThroughIndex,
	formatCorpusComparisonSummary,
	gameTextCorpusIndexLayer
} from "../packages/game-text-corpus/dist/index.js";
import { ensureUassetExecutable } from "./native-tools.ts";
import { withCorpusUnrealLock } from "./game-text-corpus-lock.ts";

/**
 * The lease covers the complete native scan, including the collapse probe. Without a `layer`,
 * the scan uses UE Shed's own index over a temporary cache and the in-repo reader.
 */
export async function compareGameTextCorpus(
	corpusRoot: string,
	options: {
		readonly layer?: Layer.Layer<GameTextIndexRefresh, unknown>;
		readonly changedFiles?: readonly string[];
	} = {}
) {
	return withCorpusUnrealLock(async () => {
		const cacheRoot = options.layer
			? undefined
			: await mkdtemp(join(tmpdir(), "ue-shed-corpus-compare-"));
		try {
			return await Effect.runPromise(
				compareThroughIndex(
					corpusRoot,
					options.changedFiles ? { changedFiles: options.changedFiles } : {}
				).pipe(
					Effect.provide(
						options.layer ??
							gameTextCorpusIndexLayer({
								executable: ensureUassetExecutable(),
								cacheRoot: cacheRoot!
							})
					)
				)
			);
		} finally {
			if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
		}
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const root = process.argv[2] ?? process.env.UE_SHED_GAME_TEXT_CORPUS;
	if (!root) {
		process.stdout.write(
			"SKIP: generate with pnpm corpus:generate --project <scratch.uproject> --seed 1 --lines 256, then pass its Content corpus folder or set UE_SHED_GAME_TEXT_CORPUS.\n"
		);
	} else {
		const result = await compareGameTextCorpus(root);
		process.stdout.write(`${JSON.stringify(result.triage, null, 2)}\n`);
		process.stdout.write(
			formatCorpusComparisonSummary(
				result.actual.length,
				result.differences.length,
				result.triage.pinned
			)
		);
		process.exitCode = result.triage.unexpected.length || result.triage.stale.length ? 1 : 0;
	}
}
