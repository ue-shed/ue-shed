import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { assetReaderLayer } from "../packages/unreal-assets/dist/index.js";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive
} from "../packages/localization/dist/index.js";
import { refreshCliGameTextIndex } from "../apps/cli/src/workflows/game-text-index.ts";
import { gameTextIndexRefreshLayer } from "../packages/game-text/src/index-refresh.ts";
import { gameTextIndexSourceNodeLayer } from "../packages/game-text/src/index-source-node.ts";
import { GameTextIndexBuilderLive } from "../packages/game-text/src/native-index-builder.ts";
import { textCorpusQuery } from "../packages/game-text/src/query.test-support.ts";
import { joinLocalizationTarget } from "../packages/game-text/src/localization.ts";
import {
	TextCorpusSearchRequest,
	type TextCorpusSearchPage,
	type TextCorpusFocus
} from "../packages/game-text/src/schema.ts";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

/** These are disposable fixtures generated and verified by each actual engine, never studio data. */
describe.skipIf(!executable)("native Game Text over Unreal-generated saved fixtures", () => {
	for (const version of ["57", "58"]) {
		const fixture = process.env[`UE_SHED_GAME_TEXT_FIXTURE_${version}`];
		it.skipIf(!fixture)(
			`runs the production CLI composition against the UE 5.${version[1]} fixture`,
			async () => {
				if (!fixture || !executable)
					throw new Error("Explicit fixture and native executable required");
				const cache = await mkdtemp(join(tmpdir(), "ue-shed-native-saved-"));
				try {
					const projectRoot = await realpath(fixture);
					await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const evidence = yield* LocalizationEvidence;
								const discovery = yield* evidence.discover({ projectRoot });
								const target = discovery.targets.find(
									(target) => target.name === "FixtureGame"
								);
								if (!target)
									throw new Error(
										"The generated fixture's localization target is missing"
									);
								const model = yield* refreshCliGameTextIndex(
									{ projectRoot, targetName: target.name },
									executable
								);
								const corpus = yield* model.corpus;
								expect(corpus.coverage.textUnits).toBeGreaterThan(100);
								expect(model.summary.coverage).toEqual(corpus.coverage);
								const oracle = textCorpusQuery(
									corpus,
									undefined,
									joinLocalizationTarget(corpus, model.evidence)
								);
								for (const value of [
									{},
									{ query: "Confirm" },
									{ localization: { target: target.name } },
									{
										localization: {
											target: target.name,
											culture: target.cultures[0]
										},
										group: "problem",
										facets: {
											assets: true,
											origins: true,
											audiences: true,
											cultures: true,
											folder: ""
										}
									}
								]) {
									const request = Schema.decodeUnknownSync(
										TextCorpusSearchRequest
									)({ query: "", capability: "all", pageSize: 50, ...value });
									const actual = yield* model.query.search(request);
									expect(comparable(actual)).toEqual(
										comparable(oracle.search(request))
									);
									for (const [index, unit] of actual.units.entries()) {
										const line = actual.localization?.lines[index];
										const focus = {
											id: unit.id,
											pageSize: 2,
											...(line
												? {
														localization: {
															target: target.name,
															id: line.id
														}
													}
												: undefined)
										};
										expect(
											comparable((yield* model.query.focus(focus)) ?? null)
										).toEqual(comparable(oracle.focus(focus) ?? null));
									}
								}
								const reopened = yield* refreshCliGameTextIndex(
									{ projectRoot, targetName: target.name },
									executable
								);
								expect(reopened.packages.readPackages).toBe(0);
								expect(reopened.imported.files.every((file) => !file.parsed)).toBe(
									true
								);
								expect(reopened.join.rebuilt).toBe(false);
							})
						).pipe(
							Effect.provide(
								gameTextIndexRefreshLayer(cache).pipe(
									Layer.provide(gameTextIndexSourceNodeLayer(cache)),
									Layer.provide(GameTextIndexBuilderLive),
									Layer.provide(
										assetReaderLayer({
											executable,
											timeoutMs: 30000,
											catalogTimeoutMs: 120000
										})
									),
									Layer.provide(LocalizationEvidenceNodeLive)
								)
							),
							Effect.provide(LocalizationEvidenceNodeLive)
						)
					);
				} finally {
					await rm(cache, { recursive: true, force: true });
				}
			},
			120000
		);
	}
});

function comparable(value: TextCorpusSearchPage | TextCorpusFocus | null): string {
	return JSON.stringify(value, (key, field: typeof Schema.Json.Type | undefined) => {
		if (Array.isArray(field))
			return ["facts", "unknownReasons", "flags"].includes(key) ? [...field].sort() : field;
		if (Predicate.isRecord(field))
			return Object.fromEntries(
				Object.entries(field).sort(([left], [right]) => left.localeCompare(right))
			);
		return field;
	});
}
