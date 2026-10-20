import { referenceNativeQuery } from "../../../../../packages/game-text/src/native-query.test-support.js";
import { textCorpusQuery } from "../../../../../packages/game-text/src/query.test-support.js";
import { Effect, Layer, Option, Result, type Scope } from "effect";
import {
	GameTextIndexRefresh,
	GameTextIndexSteps,
	type GameTextProjectIndex,
	type GameTextTargetIndex,
	type GameTextIndexRefreshRequest,
	GameTextIndexError,
	TextCorpusService,
	type GameTextIndexRefreshResult
} from "@ue-shed/game-text/index";
import {
	joinLocalizationTarget,
	applyLocalizationReview,
	applyLocalizationKeyChanges,
	localizationKeyChanges,
	mergeLocalizationKeyChanges,
	localizationQuality,
	textQualityQuery
} from "@ue-shed/game-text/corpus";
import { checkLocalizationTarget } from "@ue-shed/game-text/checks";
import { evaluateGameTextSourceQuality } from "@ue-shed/game-text/rules";
import { type TextCorpus } from "@ue-shed/game-text/schema";
import {
	LocalizationEvidence,
	LocalizationFileAccessLive,
	readLocalizationReview,
	emptyLocalizationReviewFile,
	defaultLocalizationReviewPath
} from "@ue-shed/localization";
import { WorkbenchProject } from "./project-workspace.js";

/** The event-built implementation stays in host tests as the behavioral oracle. */
export function oracleGameTextIndexLayer<E>(
	read: (root: string) => Effect.Effect<TextCorpus, E, Scope.Scope>
) {
	const legacy = Layer.effect(
		GameTextIndexRefresh,
		Effect.gen(function* () {
			const evidence = yield* LocalizationEvidence;
			let retained: TextCorpus | undefined;
			return GameTextIndexRefresh.of({
				invalidate: () =>
					Effect.sync(() => {
						retained = undefined;
					}),
				refresh: Effect.fn("Test.GameTextIndex.refresh")(function* (request) {
					const corpus =
						request.targetName === undefined || !retained
							? yield* read(request.projectRoot).pipe(
									Effect.mapError(
										(cause) =>
											new GameTextIndexError({
												cause: cause,
												nextStep: "escalate",
												code: "index_failed",
												operation: "scan",
												retrySafe:
													cause instanceof Object && "retrySafe" in cause
														? Boolean(cause.retrySafe)
														: true,
												message:
													cause instanceof Error
														? cause.message
														: `The test scan of ${request.projectRoot} failed.`,
												recovery:
													cause instanceof Object && "recovery" in cause
														? String(cause.recovery)
														: "Retry the test scan."
											})
									)
								)
							: retained;
					retained = corpus;
					const target =
						request.targetName === undefined
							? undefined
							: (yield* evidence.discover({ projectRoot: request.projectRoot }).pipe(
									Effect.mapError(
										(cause) =>
											new GameTextIndexError({
												cause: cause,
												nextStep: "escalate",
												retrySafe: false,
												code: "index_failed",
												operation: cause.code,
												message: cause.message,
												recovery: cause.recovery
											})
									)
								)).targets.find((target) => target.name === request.targetName);
					const files = target
						? yield* evidence.read({ projectRoot: request.projectRoot, target }).pipe(
								Effect.mapError(
									(cause) =>
										new GameTextIndexError({
											cause: cause,
											nextStep: "escalate",
											retrySafe: false,
											code: "index_failed",
											operation: cause.code,
											message: cause.message,
											recovery: cause.recovery
										})
								)
							)
						: undefined;
					const review = target
						? Option.getOrUndefined(
								yield* readLocalizationReview({
									projectRoot: request.projectRoot,
									target: target.name
								}).pipe(Effect.provide(LocalizationFileAccessLive), Effect.option)
							)
						: undefined;
					const joined = files
						? applyLocalizationReview(
								joinLocalizationTarget(corpus, files),
								review?.contentHash ? review.file : undefined
							)
						: undefined;
					const join = joined
						? applyLocalizationKeyChanges(
								joined,
								mergeLocalizationKeyChanges(
									localizationKeyChanges(joined, corpus).pairs,
									request.keyChangePairs ?? []
								)
							)
						: undefined;
					const reference = textCorpusQuery(corpus, undefined, join);
					const query = referenceNativeQuery(reference, corpus);
					return {
						project: oracleProjectIndex(request.projectRoot),
						corpus: Effect.succeed(corpus),
						summary: reference.summary(),
						query,
						search: query.search,
						// The in-memory checks are the oracle the indexed scans match.
						localizationQuality: (ruleDocument, options) =>
							Effect.sync(() => {
								if (!join || !files)
									throw new Error("No target in this oracle request");
								return localizationQuality(
									checkLocalizationTarget(
										corpus,
										join,
										files,
										options,
										ruleDocument
									),
									join
								);
							}),
						sourceQuality: (ruleDocument) =>
							Effect.sync(() =>
								textQualityQuery(
									evaluateGameTextSourceQuality(corpus, ruleDocument)
								)
							),
						get localizationJoin(): GameTextIndexRefreshResult["localizationJoin"] {
							if (!join) throw new Error("No target in this oracle request");
							return Effect.succeed(join);
						},
						get localization(): GameTextIndexRefreshResult["localization"] {
							if (!join) throw new Error("No target in this oracle request");
							const { lines: _, ...header } = join;
							return header;
						},
						get evidence(): GameTextIndexRefreshResult["evidence"] {
							if (!files) throw new Error("No target in this oracle request");
							return files;
						},
						get review(): GameTextIndexRefreshResult["review"] {
							if (!target) throw new Error("No target in this oracle request");
							return (
								review ?? {
									file: emptyLocalizationReviewFile(target.name),
									contentHash: null,
									relativePath: defaultLocalizationReviewPath(target.name)
								}
							);
						},
						get joined(): GameTextIndexRefreshResult["joined"] {
							throw new Error("Host must query through the service API");
						},
						get imported(): GameTextIndexRefreshResult["imported"] {
							throw new Error("Unused builder evidence in host oracle");
						},
						get packages(): GameTextIndexRefreshResult["packages"] {
							throw new Error("Unused builder evidence in host oracle");
						},
						get join(): GameTextIndexRefreshResult["join"] {
							throw new Error("Unused builder evidence in host oracle");
						}
					};
				})
			});
		})
	);
	return oracleIndexStepsLayer.pipe(Layer.provideMerge(legacy));
}

export const workbenchGameTextIndexOracleLayer = Layer.unwrap(
	Effect.gen(function* () {
		const scanner = yield* TextCorpusService;
		const project = yield* WorkbenchProject;
		return oracleGameTextIndexLayer((root) =>
			project
				.candidates("game_text")
				.pipe(
					Effect.flatMap((index) =>
						scanner.scanFromProjectIndex(index, { projectRoot: root })
					)
				)
		);
	})
);

import { makeGameTextLocalization as indexedGameTextLocalization } from "./game-text-localization.js";
let revisionCount = 0;
export const makeGameTextLocalizationOracle = (
	currentCorpus: () => Effect.Effect<TextCorpus | undefined>,
	currentProject: Parameters<typeof indexedGameTextLocalization>[1],
	currentRules?: Parameters<typeof indexedGameTextLocalization>[2],
	currentIndex?: Parameters<typeof indexedGameTextLocalization>[3]
) => {
	// Each corpus the test hands over is a new scan, so it gets its own revision.
	const revisions = new WeakMap<TextCorpus, string>();
	const marker = () =>
		currentCorpus().pipe(
			Effect.map((corpus) => {
				if (!corpus) return undefined;
				let revision = revisions.get(corpus);
				if (!revision) {
					revision = `oracle#${++revisionCount}`;
					revisions.set(corpus, revision);
				}
				return revision;
			})
		);
	return indexedGameTextLocalization(marker, currentProject, currentRules, currentIndex).pipe(
		Effect.provide(
			oracleGameTextIndexLayer(() =>
				currentCorpus().pipe(
					Effect.flatMap((corpus) =>
						corpus
							? Effect.succeed(corpus)
							: Effect.die("No corpus in this oracle request")
					)
				)
			)
		)
	);
};

/** Object-oracle handles model host ownership without exercising the compact store. */
export function oracleProjectIndex(projectRoot: string): GameTextProjectIndex {
	return {
		projectRoot,
		cacheRoot: "oracle",
		generation: "oracle",
		packageKey: "oracle",
		get packages(): GameTextProjectIndex["packages"] {
			throw new Error("Unused compact-store evidence in object oracle");
		}
	};
}
const oracleIndexStepsLayer = Layer.effect(
	GameTextIndexSteps,
	Effect.gen(function* () {
		const legacy = yield* GameTextIndexRefresh;
		const evidence = yield* LocalizationEvidence;
		const requests = new WeakMap<GameTextTargetIndex, GameTextIndexRefreshRequest>();
		const steps: Effect.Success<typeof GameTextIndexSteps> = GameTextIndexSteps.of({
			prepareTarget: (request, options) =>
				Effect.gen(function* () {
					const project = yield* steps.openProject(request);
					const imported = yield* steps
						.importTarget(project, request)
						.pipe(Effect.result);
					if (Result.isFailure(imported) && !options?.fallbackToSource)
						return yield* Effect.fail(imported.failure);
					const input = Result.isFailure(imported)
						? yield* steps.importTarget(project)
						: imported.success;
					const refreshed = yield* steps.refreshProject(request);
					return yield* steps.buildTarget(refreshed, input, request);
				}),
			openProject: (request) => Effect.succeed(oracleProjectIndex(request.projectRoot)),
			refreshProject: (request) =>
				legacy.invalidate(request).pipe(Effect.as(oracleProjectIndex(request.projectRoot))),
			importTarget: (project, request = {}) =>
				Effect.gen(function* () {
					const target =
						request.targetName === undefined
							? undefined
							: (yield* evidence.discover({
									projectRoot: project.projectRoot
								})).targets.find((target) => target.name === request.targetName);
					if (!target && request.targetName !== undefined)
						return yield* Effect.fail(
							new GameTextIndexError({
								nextStep: "escalate",
								retrySafe: false,
								code: "index_failed",
								operation: "target_not_found",
								message: "Target not found",
								recovery: "Select an available target."
							})
						);
					return {
						project,
						view:
							request.targetName === undefined
								? { kind: "source" as const }
								: { kind: "localization" as const, target: request.targetName },
						imported: {
							get target() {
								if (!target)
									throw new Error("Source oracle has no localization target");
								return target;
							},
							files: [],
							diagnostics: [],
							profile: null
						},
						fileKeys: {},
						fileErrors: {},
						fileProvenances: {},
						fileDiagnostics: {},
						targetName: request.targetName
					};
				}).pipe(
					Effect.mapError((cause) =>
						cause instanceof GameTextIndexError
							? cause
							: new GameTextIndexError({
									cause: cause,
									nextStep: "escalate",
									retrySafe: false,
									code: "index_failed",
									operation: cause.code,
									message: cause.message,
									recovery: cause.recovery
								})
					)
				),
			buildTarget: (project, imported, request = {}) =>
				Effect.sync(() => {
					const target: GameTextTargetIndex = {
						project,
						view: imported.view,
						imported: imported.imported,
						generation: "oracle",
						fileKeys: {},
						get join(): GameTextTargetIndex["join"] {
							throw new Error("Unused compact join in object oracle");
						},
						get review(): GameTextTargetIndex["review"] {
							throw new Error("Unused compact review in object oracle");
						}
					};
					const preparation: GameTextIndexRefreshRequest = {
						projectRoot: imported.project.projectRoot,
						...request
					};
					if (imported.view.kind === "localization")
						Object.assign(preparation, { targetName: imported.view.target });
					requests.set(target, preparation);
					return target;
				}),
			openTarget: (target) => {
				const request = requests.get(target);
				return request
					? legacy
							.refresh(request)
							.pipe(
								Effect.map((result) =>
									Object.assign(result, { project: target.project })
								)
							)
					: Effect.die("Missing oracle request");
			},
			invalidate: legacy.invalidate
		});
		return steps;
	})
);
