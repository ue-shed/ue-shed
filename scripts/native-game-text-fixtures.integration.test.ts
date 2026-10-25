import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
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
import { LocalizationState } from "../packages/game-text/src/localization-schema.ts";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const ExpectedStates = Schema.Struct({
	target: Schema.String,
	entries: Schema.Array(
		Schema.Struct({
			culture: Schema.String,
			namespace: Schema.String,
			key: Schema.String,
			state: LocalizationState
		})
	)
});

/** These are disposable fixtures generated and verified by each actual engine, never studio data. */
describe.skipIf(!executable)("native Game Text over Unreal-generated saved fixtures", () => {
	for (const version of ["57", "58"]) {
		const fixture = process.env[`UE_SHED_GAME_TEXT_FIXTURE_${version}`];
		it.skipIf(!fixture)(
			`runs the production CLI composition against the UE 5.${version[1]} fixture`,
			async () => {
				if (!fixture || !executable)
					throw new Error("Explicit fixture and native executable required");
				const expected = Schema.decodeUnknownSync(Schema.fromJsonString(ExpectedStates))(
					await readFile(
						new URL(
							"../fixtures/unreal-project/FixtureSource/Localization/expected-states.json",
							import.meta.url
						),
						"utf8"
					)
				);
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
								// Every committed intent entry is a stored line's culture state.
								const states = (yield* model.query.readLocalizationLines()).flatMap(
									({ identity, cultures }) =>
										identity === null
											? []
											: cultures.map((culture) => ({
													culture: culture.culture,
													namespace: identity.namespace,
													key: identity.key,
													state: culture.state
												}))
								);
								expect(expected.target).toBe(target.name);
								for (const entry of expected.entries)
									expect(states).toContainEqual(entry);
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
