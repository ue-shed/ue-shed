import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { LocalizationTargetName } from "@ue-shed/localization";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { GameTextIndexBuilder } from "./index-builder.js";
import { typeScriptIndexBuilderLayer } from "./index-builder-reference.test-support.js";
import { GameTextIndexQuery, nativeIndexQueryLayer } from "./index-query-native.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { GameTextIndexSteps, gameTextIndexStepsLayer } from "./index-steps.js";
import { LocalizationImportSource } from "./localization-import.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import { makeGameTextWorkspace } from "./workspace.js";
import type { GameTextWorkspaceFileHooks, GameTextWorkspaceProject } from "./workspace-host.js";

function memoryFiles() {
	const contents = new Map<string, Uint8Array>();
	const read = (path: string) =>
		Effect.suspend(() => {
			const bytes = contents.get(path);
			return bytes === undefined
				? Effect.fail({ message: "Missing file.", recovery: "Create it." })
				: Effect.succeed(bytes);
		});
	const files: GameTextWorkspaceFileHooks = {
		chooseFile: () => Effect.succeed({ status: "cancelled" }),
		chooseSaveFile: () => Effect.succeed({ status: "cancelled" }),
		readFile: read,
		readFileWithin: (root, path) => read(resolve(root, path)),
		writeFile: (path, bytes, options) =>
			Effect.gen(function* () {
				if (options?.exclusive && contents.has(path))
					return yield* Effect.fail({
						code: "already_exists" as const,
						message: "Exists.",
						recovery: "Load it."
					});
				contents.set(path, bytes);
			})
	};
	return files;
}

type Counts = { source: number; localization: number };

function countingLayer(
	fixture: Effect.Success<ReturnType<typeof makeIndexRegressionFixture>>,
	counts: Counts
) {
	const nativeQuery = Layer.unwrap(
		Effect.flatMap(AssetReader, (reader) => reader.configuration()).pipe(
			Effect.map(nativeIndexQueryLayer),
			Effect.provide(AssetReaderLive),
			Effect.orDie
		)
	);
	const files = { ...LocalizationImportSource.defaultValue() };
	const builder = Layer.effect(
		GameTextIndexBuilder,
		Effect.map(GameTextIndexBuilder, (reference) =>
			GameTextIndexBuilder.of({
				...reference,
				importLocalizationTarget: (input) =>
					reference
						.importLocalizationTarget(input)
						.pipe(Effect.provideService(LocalizationImportSource, files))
			})
		)
	).pipe(Layer.provide(typeScriptIndexBuilderLayer));
	const inner = gameTextIndexStepsLayer(join(fixture.projectRoot, "cache")).pipe(
		Layer.provide(fixture.source),
		Layer.provide(fixture.evidence),
		Layer.provide(builder),
		Layer.provide(nativeQuery)
	);
	const counting = Layer.effect(
		GameTextIndexSteps,
		Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			return GameTextIndexSteps.of({
				...steps,
				openTarget: (target) =>
					steps.openTarget(target).pipe(
						Effect.map((model) => ({
							...model,
							sourceQuality: (document: GameTextRuleDocument) => {
								counts.source++;
								return model.sourceQuality(document);
							},
							localizationQuality: (
								document: GameTextRuleDocument | undefined,
								options?: Parameters<typeof model.localizationQuality>[1]
							) => {
								counts.localization++;
								return model.localizationQuality(document, options);
							}
						}))
					)
			});
		})
	).pipe(Layer.provide(inner));
	return Layer.mergeAll(counting, fixture.evidence);
}

function projectFor(root: string): GameTextWorkspaceProject {
	const ready = {
		status: "ready" as const,
		project: { projectRoot: root, generation: 3 }
	};
	return {
		current: () => Effect.succeed(ready),
		refresh: () => Effect.succeed(ready),
		candidates: () => Effect.succeed({ generation: 3, summary: { projectRoot: root } }),
		progress: () => Effect.succeed({ completed: 0, total: 0, phase: "idle", stage: "host" })
	};
}

it.live(
	"keeps localization quality across an unchanged scan and reruns it after a PO change",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const counts: Counts = { source: 0, localization: 0 };
			const layer = countingLayer(fixture, counts);
			const root = fixture.projectRoot;
			yield* Effect.gen(function* () {
				const workspace = yield* makeGameTextWorkspace({
					project: projectFor(root),
					files: memoryFiles()
				});
				const firstScan = yield* workspace.configuredRefresh(true);
				expect(firstScan.status).toBe("completed");
				expect((yield* workspace.previewQualityRules(STARTER_CHECK_RULES)).status).toBe(
					"completed"
				);
				const target = LocalizationTargetName.make("Review");
				expect((yield* workspace.localizationTarget(target)).status).toBe("ready");
				const first = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(first.status).toBe("ready");
				const afterFirst = counts.localization;
				expect(afterFirst).toBeGreaterThan(0);
				const listed = yield* workspace.localizationTargets();
				expect(listed.status === "ready" && listed.targets.map(({ name }) => name)).toEqual(
					["Review"]
				);
				// A target added beside unchanged text: the scan keeps the model, not the listing.
				fixture.addTarget("Added");

				const secondScan = yield* workspace.configuredRefresh(true);
				expect(secondScan.status).toBe("completed");
				if (firstScan.status === "completed" && secondScan.status === "completed")
					expect(secondScan.summary).toEqual(firstScan.summary);
				expect((yield* workspace.localizationTarget(target)).status).toBe("ready");
				const second = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(second).toEqual(first);
				expect(counts.localization).toBe(afterFirst);
				const relisted = yield* workspace.localizationTargets();
				expect(
					relisted.status === "ready" && relisted.targets.map(({ name }) => name)
				).toEqual(["Review", "Added"]);
				expect(counts.localization).toBe(afterFirst);

				yield* Effect.promise(() =>
					writeFile(
						join(root, "de.po"),
						'msgctxt "UI,K"\nmsgid "Source"\nmsgstr "A changed shipped translation"\n'
					)
				);
				expect((yield* workspace.configuredRefresh(true)).status).toBe("completed");
				expect((yield* workspace.localizationTarget(target)).status).toBe("ready");
				const third = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(third.status).toBe("ready");
				expect(counts.localization).toBeGreaterThan(afterFirst);
				expect(
					(yield* workspace.localizationTarget(LocalizationTargetName.make("Added")))
						.status
				).toBe("ready");
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.scoped),
	60_000
);

it.live(
	"reuses source and localization quality for an equal rules document",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const counts: Counts = { source: 0, localization: 0 };
			const layer = countingLayer(fixture, counts);
			const root = fixture.projectRoot;
			yield* Effect.gen(function* () {
				const workspace = yield* makeGameTextWorkspace({
					project: projectFor(root),
					files: memoryFiles(),
					starterRules: STARTER_CHECK_RULES
				});
				expect((yield* workspace.configuredRefresh(true)).status).toBe("completed");
				expect((yield* workspace.previewQualityRules(STARTER_CHECK_RULES)).status).toBe(
					"completed"
				);
				const afterFirstPreview = counts.source;
				expect(afterFirstPreview).toBeGreaterThan(0);
				expect(
					(yield* workspace.previewQualityRules(structuredClone(STARTER_CHECK_RULES)))
						.status
				).toBe("completed");
				expect(counts.source).toBe(afterFirstPreview);

				const target = LocalizationTargetName.make("Review");
				expect((yield* workspace.localizationTarget(target)).status).toBe("ready");
				const first = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(first.status).toBe("ready");
				const afterFirstQuality = { ...counts };
				expect(afterFirstQuality.localization).toBeGreaterThan(0);

				expect(
					(yield* workspace.previewQualityRules(structuredClone(STARTER_CHECK_RULES)))
						.status
				).toBe("completed");
				expect(counts.source).toBe(afterFirstQuality.source);
				const second = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(second).toEqual(first);
				expect(counts.localization).toBe(afterFirstQuality.localization);
				expect(counts.source).toBe(afterFirstQuality.source);

				expect((yield* workspace.createStarterRules(false)).status).toBe("completed");
				expect(counts.source).toBe(afterFirstQuality.source);
				expect((yield* workspace.reloadQualityRules()).status).toBe("completed");
				expect(counts.source).toBe(afterFirstQuality.source);
				const third = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(third).toEqual(first);
				expect(counts.localization).toBe(afterFirstQuality.localization);

				const changed: GameTextRuleDocument = {
					...STARTER_CHECK_RULES,
					rules: STARTER_CHECK_RULES.rules.slice(1)
				};
				expect((yield* workspace.previewQualityRules(changed)).status).toBe("completed");
				expect(counts.source).toBeGreaterThan(afterFirstQuality.source);
				const afterChangedPreview = counts.localization;
				const fourth = yield* workspace.localizationQualitySearch({
					target,
					filter: "all",
					offset: 0
				});
				expect(fourth.status).toBe("ready");
				expect(counts.localization).toBeGreaterThan(afterChangedPreview);
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.scoped),
	60_000
);
