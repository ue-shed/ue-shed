import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { LocalizationTargetName } from "@ue-shed/localization";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";
import { GameTextIndexBuilder } from "./index-builder.js";
import { typeScriptIndexBuilderLayer } from "./index-builder-reference.test-support.js";
import { GameTextIndexQuery, nativeIndexQueryLayer } from "./index-query-native.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { gameTextIndexStepsLayer } from "./index-steps.js";
import { LocalizationImportSource } from "./localization-import.js";
import { effectiveRuleDocument, enabledRuleDocument } from "./rules/effective.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
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

it.live(
	"reports source and localization quality progress on the opened workspace",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			// Holds every gated evaluation inside the engine call, after the scan has
			// reported that no rule has finished yet.
			let armed = false;
			let entered: Deferred.Deferred<void> | undefined;
			let hold: Deferred.Deferred<void> | undefined;
			const nativeQuery = Layer.unwrap(
				Effect.flatMap(AssetReader, (reader) => reader.configuration()).pipe(
					Effect.map(nativeIndexQueryLayer),
					Effect.provide(AssetReaderLive),
					Effect.orDie
				)
			);
			const gatedQuery = Layer.effect(
				GameTextIndexQuery,
				Effect.gen(function* () {
					const native = yield* GameTextIndexQuery;
					return GameTextIndexQuery.of({
						open: (input) =>
							native.open(input).pipe(
								Effect.map((model) => ({
									...model,
									findingsEvaluate: (document, progress) =>
										Effect.gen(function* () {
											const gate = entered;
											const release = hold;
											if (armed && gate && release) {
												yield* Deferred.succeed(gate, undefined);
												yield* Deferred.await(release);
											}
											return yield* model.findingsEvaluate(
												document,
												progress
											);
										})
								}))
							)
					});
				})
			).pipe(Layer.provide(nativeQuery));
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
			const layer = Layer.mergeAll(
				gameTextIndexStepsLayer(join(fixture.projectRoot, "cache")).pipe(
					Layer.provide(fixture.source),
					Layer.provide(fixture.evidence),
					Layer.provide(builder),
					Layer.provide(gatedQuery)
				),
				fixture.evidence
			);
			const root = fixture.projectRoot;
			const ready = {
				status: "ready" as const,
				project: { projectRoot: root, generation: 3 }
			};
			const project: GameTextWorkspaceProject = {
				current: () => Effect.succeed(ready),
				refresh: () => Effect.succeed(ready),
				candidates: () => Effect.succeed({ generation: 3, summary: { projectRoot: root } }),
				progress: () => Effect.succeed({ completed: 0, total: 0, phase: "idle" })
			};
			yield* Effect.gen(function* () {
				const workspace = yield* makeGameTextWorkspace({
					project,
					files: memoryFiles()
				});
				expect((yield* workspace.configuredRefresh({})).status).toBe("completed");
				const rules = enabledRuleDocument(effectiveRuleDocument(STARTER_CHECK_RULES)).rules
					.length;
				expect(rules).toBeGreaterThan(0);

				entered = yield* Deferred.make<void>();
				hold = yield* Deferred.make<void>();
				armed = true;
				const preview = yield* workspace
					.previewQualityRules(STARTER_CHECK_RULES)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: rules,
					phase: "source_quality",
					findings: 0
				});
				yield* Deferred.succeed(hold, undefined);
				expect((yield* Fiber.join(preview)).status).toBe("completed");
				armed = false;
				// A finished evaluation no longer shows as running.
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});

				const target = LocalizationTargetName.make("Review");
				expect((yield* workspace.localizationTarget(target)).status).toBe("ready");
				entered = yield* Deferred.make<void>();
				hold = yield* Deferred.make<void>();
				armed = true;
				const search = yield* workspace
					.localizationQualitySearch({ target, filter: "all", offset: 0 })
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: rules,
					phase: "localization_quality",
					findings: 0
				});
				yield* Deferred.succeed(hold, undefined);
				expect((yield* Fiber.join(search)).status).toBe("ready");
				armed = false;
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});

				// Nor does an interrupted one.
				entered = yield* Deferred.make<void>();
				hold = yield* Deferred.make<void>();
				armed = true;
				const interrupted = yield* workspace
					.previewQualityRules({
						...STARTER_CHECK_RULES,
						rules: STARTER_CHECK_RULES.rules.slice(1)
					})
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				expect((yield* workspace.progress()).phase).toBe("source_quality");
				yield* Fiber.interrupt(interrupted);
				armed = false;
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});

				// Overlapping evaluations: the one still running stays shown when the other ends.
				const fewer = (skipped: number) => ({
					...STARTER_CHECK_RULES,
					rules: STARTER_CHECK_RULES.rules.slice(skipped)
				});
				const firstHold = yield* Deferred.make<void>();
				entered = yield* Deferred.make<void>();
				hold = firstHold;
				armed = true;
				const first = yield* workspace.previewQualityRules(fewer(2)).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				const secondHold = yield* Deferred.make<void>();
				entered = yield* Deferred.make<void>();
				hold = secondHold;
				const second = yield* workspace
					.previewQualityRules(fewer(3))
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				armed = false;
				yield* Deferred.succeed(firstHold, undefined);
				expect((yield* Fiber.join(first)).status).toBe("completed");
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: enabledRuleDocument(effectiveRuleDocument(fewer(3))).rules.length,
					phase: "source_quality",
					findings: 0
				});
				yield* Deferred.succeed(secondHold, undefined);
				expect((yield* Fiber.join(second)).status).toBe("completed");
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});

				// And across models: another target's localization check ends while a source preview
				// on the project's model still runs.
				fixture.addTarget("Other");
				expect((yield* workspace.configuredRefresh({})).status).toBe("completed");
				const other = LocalizationTargetName.make("Other");
				expect((yield* workspace.localizationTarget(other)).status).toBe("ready");
				const previewHold = yield* Deferred.make<void>();
				entered = yield* Deferred.make<void>();
				hold = previewHold;
				armed = true;
				const previewing = yield* workspace
					.previewQualityRules(fewer(4))
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				const checkHold = yield* Deferred.make<void>();
				entered = yield* Deferred.make<void>();
				hold = checkHold;
				const checking = yield* workspace
					.localizationQualitySearch({ target: other, filter: "all", offset: 0 })
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				armed = false;
				yield* Deferred.succeed(checkHold, undefined);
				expect((yield* Fiber.join(checking)).status).toBe("ready");
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: enabledRuleDocument(effectiveRuleDocument(fewer(4))).rules.length,
					phase: "source_quality",
					findings: 0
				});
				yield* Deferred.succeed(previewHold, undefined);
				expect((yield* Fiber.join(previewing)).status).toBe("completed");
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});

				// And across a replaced model: an evaluation still running on the model a Scan
				// replaced is not shown again, so progress ends idle once everything has finished.
				const staleHold = yield* Deferred.make<void>();
				entered = yield* Deferred.make<void>();
				hold = staleHold;
				armed = true;
				const stale = yield* workspace.previewQualityRules(fewer(5)).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				armed = false;
				fixture.setSource("Updated source");
				expect((yield* workspace.configuredRefresh({})).status).toBe("completed");
				expect((yield* workspace.previewQualityRules(fewer(6))).status).toBe("completed");
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});
				yield* Deferred.succeed(staleHold, undefined);
				yield* Fiber.await(stale);
				expect(yield* workspace.progress()).toEqual({
					completed: 0,
					total: 0,
					phase: "idle"
				});
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.scoped),
	60_000
);
