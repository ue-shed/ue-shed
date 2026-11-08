import { GameTextWorkspaceHostFailure } from "./workspace-host.js";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { LocalizationTargetName } from "@ue-shed/localization";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { expect, vi } from "vitest";
import * as localizationModule from "./workspace-localization.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { typeScriptIndexBuilderLayer } from "./index-builder-reference.test-support.js";
import { nativeIndexQueryLayer } from "./index-query-native.js";
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
				? new GameTextWorkspaceHostFailure({
						message: "Missing file.",
						recovery: "Create it.",
						retrySafe: false,
						nextStep: "fix_input"
					})
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
					return yield* new GameTextWorkspaceHostFailure({
						code: "already_exists" as const,
						message: "Exists.",
						recovery: "Load it.",
						retrySafe: false,
						nextStep: "fix_input"
					});
				contents.set(path, bytes);
			})
	};
	return files;
}

type Counts = { source: number; localization: number };

function countingLayer(
	fixture: Effect.Success<ReturnType<typeof makeIndexRegressionFixture>>,
	counts: Counts,
	afterSource: Effect.Effect<void> = Effect.void
) {
	const nativeQuery = Layer.unwrap(
		Effect.flatMap(AssetReader, (reader) => reader.configuration).pipe(
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
								return model
									.sourceQuality(document)
									.pipe(Effect.tap(() => afterSource));
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
		current: Effect.succeed(ready),
		refresh: Effect.succeed(ready),
		candidates: Effect.sync(() => ({ generation: 3, summary: { projectRoot: root } })),
		progress: Effect.sync(() => ({ completed: 0, total: 0, phase: "idle" }))
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
				const firstScan = yield* workspace.configuredRefresh({});
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
				const listed = yield* workspace.localizationTargets;
				expect(listed.status === "ready" && listed.targets.map(({ name }) => name)).toEqual(
					["Review"]
				);
				// A target added beside unchanged text: the scan keeps the model, not the listing.
				fixture.addTarget("Added");

				const secondScan = yield* workspace.configuredRefresh({});
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
				const relisted = yield* workspace.localizationTargets;
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
				expect((yield* workspace.configuredRefresh({})).status).toBe("completed");
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
				expect((yield* workspace.configuredRefresh({})).status).toBe("completed");
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

				expect((yield* workspace.createStarterRules({ loadExisting: false })).status).toBe(
					"completed"
				);
				expect(counts.source).toBe(afterFirstQuality.source);
				expect((yield* workspace.reloadQualityRules).status).toBe("completed");
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

it.live("G3.c rejected rules publication preserves the original save destination", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		let arm = false;
		let switched = false;
		const files = memoryFiles();
		const writes: string[] = [];
		const path = join(fixture.projectRoot, "chosen.json");
		const bytes = new TextEncoder().encode(
			JSON.stringify({ ...STARTER_CHECK_RULES, rules: [] })
		);
		const project = projectFor(fixture.projectRoot);
		const layer = countingLayer(
			fixture,
			{ source: 0, localization: 0 },
			Effect.sync(() => {
				if (arm) {
					arm = false;
					switched = true;
				}
			})
		);
		yield* Effect.gen(function* () {
			const workspace = yield* makeGameTextWorkspace({
				project: {
					...project,
					current: Effect.suspend(() => {
						if (switched) {
							switched = false;
							return Effect.succeed({
								status: "ready" as const,
								project: { projectRoot: "C:/Other", generation: 3 }
							});
						}
						return project.current;
					})
				},
				files: {
					...files,
					chooseFile: () => Effect.succeed({ status: "selected", path }),
					readFile: () => Effect.succeed(bytes),
					writeFile: (path, bytes, options) => {
						writes.push(path);
						return files.writeFile(path, bytes, options);
					}
				}
			});
			expect((yield* workspace.configuredRefresh({})).status).toBe("completed");
			expect((yield* workspace.createStarterRules({ loadExisting: false })).status).toBe(
				"completed"
			);
			arm = true;
			expect((yield* workspace.chooseQualityRules).status).toBe("not_ready");
			expect((yield* workspace.saveQualityRules(STARTER_CHECK_RULES)).status).toBe(
				"completed"
			);
			expect(writes).not.toContain(path);
		}).pipe(Effect.provide(layer));
	})
);

it.live("G3.b serializes localization reset with publication", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const resetting = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const newerSelected = yield* Deferred.make<void>();
		let arm = false;
		let generation = 3;
		const original = localizationModule.makeGameTextWorkspaceLocalization;
		const spy = vi
			.spyOn(localizationModule, "makeGameTextWorkspaceLocalization")
			.mockImplementation((...args) =>
				original(...args).pipe(
					Effect.map((service) => ({
						...service,
						reset: (...args: Parameters<typeof service.reset>) =>
							Effect.gen(function* () {
								if (arm) {
									arm = false;
									yield* Deferred.succeed(resetting, undefined);
									yield* Deferred.await(release);
								}
								return yield* service.reset(...args);
							})
					}))
				)
			);
		const layer = countingLayer(fixture, { source: 0, localization: 0 });
		const project = projectFor(fixture.projectRoot);
		yield* Effect.gen(function* () {
			const workspace = yield* makeGameTextWorkspace({
				project: {
					...project,
					candidates: Effect.sync(() => ({
						generation,
						summary: { projectRoot: fixture.projectRoot }
					})),
					current: Effect.sync(() => ({
						status: "ready" as const,
						project: { projectRoot: fixture.projectRoot, generation }
					})),
					refresh: Effect.sync(() => ({
						status: "ready" as const,
						project: { projectRoot: fixture.projectRoot, generation }
					}))
				},
				files: memoryFiles()
			});
			yield* workspace.configuredRefresh({});
			yield* workspace.previewQualityRules(STARTER_CHECK_RULES);
			generation = 4;
			fixture.setSource("Old scan");
			arm = true;
			const older = yield* workspace.configuredRefresh({}).pipe(Effect.forkChild);
			yield* Deferred.await(resetting);
			generation = 5;
			fixture.setSource("New scan");
			const newer = yield* workspace.configuredRefresh({}).pipe(
				Effect.andThen(workspace.localizationTarget(fixture.target.name)),
				Effect.tap(() => Deferred.succeed(newerSelected, undefined)),
				Effect.forkChild
			);
			const publication = yield* Deferred.await(newerSelected).pipe(
				Effect.timeout("1 second"),
				Effect.exit
			);
			const publishedDuringReset = Exit.isSuccess(publication);
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(older);
			yield* Fiber.join(newer);
			expect(publishedDuringReset).toBe(false);
		}).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => spy.mockRestore())));
	})
);
