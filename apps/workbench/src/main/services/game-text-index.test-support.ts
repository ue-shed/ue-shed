import { writeFileSync } from "node:fs";
import { indexedTestReports } from "../../../../../packages/game-text/src/indexed-reports.test-support.js";
import { Effect, Layer, Option, Result, type Scope } from "effect";
import {
	GameTextIndexRefresh,
	GameTextIndexSteps,
	type GameTextProjectIndex,
	type GameTextTargetIndex,
	type GameTextIndexRefreshRequest,
	GameTextIndexError,
	type NativeTextQuery,
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
import {
	type LocalizationQueryPage,
	type TextCorpus,
	type TextCorpusQuerySummary,
	type TextCorpusSearchPage,
	type TextProblemCounts
} from "@ue-shed/game-text/schema";
import {
	LocalizationEvidence,
	LocalizationFileAccessLive,
	readLocalizationReview,
	emptyLocalizationReviewFile,
	defaultLocalizationReviewPath,
	type LocalizationReviewFile,
	type LocalizationTargetEvidence
} from "@ue-shed/localization";
import { WorkbenchProject } from "./project-workspace.js";

/** What a test's planted answers may depend on: the refresh, and the files it read. */
export interface CannedQueryInputs {
	readonly request: GameTextIndexRefreshRequest;
	readonly corpus: TextCorpus;
	/** The target's files, when the request names a target. */
	readonly evidence: LocalizationTargetEvidence | undefined;
	/** The target's review file, when the project has one. */
	readonly review: LocalizationReviewFile | undefined;
}
/** A test's answers to the query members it reads, for each refresh. */
export type CannedQuery = (inputs: CannedQueryInputs) => Partial<NativeTextQuery>;

/**
 * The query a host test reads: its planted answers, and every other member dies naming itself.
 * Hosts read a refresh's summary at once, so an unplanted summary is `emptySummary`.
 */
function cannedTextQuery(corpus: TextCorpus, answers: Partial<NativeTextQuery>): NativeTextQuery {
	const unplanted = (member: string) => () =>
		Effect.die(`This test planted no answer for ${member}.`);
	return {
		findingsEvaluate: unplanted("findingsEvaluate"),
		findingsAccept: unplanted("findingsAccept"),
		findingsQuery: unplanted("findingsQuery"),
		findingsWrite: unplanted("findingsWrite"),
		rulesCheck: unplanted("rulesCheck"),
		readCorpus: unplanted("readCorpus"),
		readLocalizationLines: unplanted("readLocalizationLines"),
		summary: () => Effect.succeed(emptySummary(corpus)),
		search: unplanted("search"),
		searchRows: unplanted("searchRows"),
		focus: unplanted("focus"),
		localizationFocus: unplanted("localizationFocus"),
		localizationDetail: unplanted("localizationDetail"),
		related: unplanted("related"),
		localizationLines: unplanted("localizationLines"),
		exportWithSignals: unplanted("exportWithSignals"),
		aggregate: unplanted("aggregate"),
		selectLocalizationLines: unplanted("selectLocalizationLines"),
		writeLocalizationLinesCsv: unplanted("writeLocalizationLinesCsv"),
		writeCorpusCsv: unplanted("writeCorpusCsv"),
		writeCorpusJson: unplanted("writeCorpusJson"),
		readUnits: unplanted("readUnits"),
		readCorpusHeader: unplanted("readCorpusHeader"),
		readFileCoverage: unplanted("readFileCoverage"),
		readCorpusReportHeader: unplanted("readCorpusReportHeader"),
		corpusFingerprint: unplanted("corpusFingerprint"),
		export: unplanted("export"),
		...answers
	};
}

const noCounts: TextCorpusSearchPage["counts"] = {
	all: 0,
	unresolved: 0,
	conflicting: 0,
	editable: 0,
	readOnly: 0,
	withoutNotes: 0,
	origins: { string_table: 0, data_table: 0, asset: 0, cpp: 0, other_source: 0 }
};
const noProblems: TextProblemCounts = {
	key_changed: 0,
	conflicting_source: 0,
	not_gathered: 0,
	changed_since_gather: 0,
	translation: 0,
	finding: 0,
	unchecked: 0,
	up_to_date: 0
};
/** A search page with nothing counted and no rows, but the fields given. */
export const searchPage = (page: Partial<TextCorpusSearchPage> = {}): TextCorpusSearchPage => ({
	counts: noCounts,
	problems: noProblems,
	total: 0,
	units: [],
	...page
});
/** A target's page of lines with nothing counted and no lines, but the fields given. */
export const linesPage = (
	target: LocalizationQueryPage["target"],
	page: Partial<LocalizationQueryPage> = {}
): LocalizationQueryPage => ({
	target,
	counts: [],
	stateCounts: {
		translated: 0,
		not_translated: 0,
		needs_update: 0,
		not_synced: 0,
		not_gathered: 0,
		changed_since_gather: 0,
		not_found: 0,
		gathered_only: 0,
		outside_target: 0,
		unknown: 0
	},
	notSynced: 0,
	lines: [],
	...page
});
/** Every translation the target's PO files hold, for answers that follow a test's PO edits. */
export const poTranslations = (evidence: LocalizationTargetEvidence | undefined) =>
	(evidence?.cultures ?? []).flatMap(({ po }) =>
		po.status === "read" ? po.value.entries.flatMap((entry) => Object.values(entry.msgstr)) : []
	);
/** A corpus's summary with every count 0: its scan status and coverage only. */
const emptySummary = (corpus: TextCorpus): TextCorpusQuerySummary => ({
	counts: noCounts,
	searchable: { textUnits: 0, textOccurrences: 0 },
	schemaVersion: 1,
	status: corpus.status,
	coverage: corpus.coverage,
	diagnosticCount: corpus.diagnostics.length,
	review: { all: 0, unresolved: 0, conflicting: 0 },
	sources: { assetProperty: 0, dataTable: 0, mixed: 0, stringTable: 0 }
});
/** Answers over a corpus with no text: an empty page for every search, and no unit to focus. */
const emptyCorpusAnswers: CannedQuery = ({ corpus: { units: _units, ...header } }) => ({
	search: () => Effect.succeed(searchPage()),
	focus: () => Effect.succeed(undefined),
	readCorpusHeader: () => Effect.succeed(header),
	// The corpus export the engine writes when no unit matches.
	writeCorpusJson: (_request, file, envelope) =>
		Effect.sync(() => {
			const bytes = new TextEncoder().encode(`${envelope.before}[]${envelope.after}`);
			writeFileSync(file.path, bytes);
			return { status: "written" as const, rows: 0, bytes: bytes.byteLength };
		})
});

/** The index's refresh and steps over a test's corpus, its query answering what the test planted. */
export function cannedGameTextIndexLayer<E>(
	read: (root: string) => Effect.Effect<TextCorpus, E, Scope.Scope>,
	answers: CannedQuery = emptyCorpusAnswers
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
					const query = cannedTextQuery(
						corpus,
						answers({
							request,
							corpus,
							evidence: files,
							review: review?.contentHash ? review.file : undefined
						})
					);
					return {
						project: testProjectIndex(request.projectRoot),
						corpus: Effect.succeed(corpus),
						summary: yield* query.summary(),
						query,
						search: query.search,
						searchRows: query.searchRows,
						prepareLocalizationCheck: () =>
							Effect.die("Workbench writes no CLI check reports."),
						// Explicit test facts are evaluated by the same native rule engine.
						localizationCheck: (document, options) =>
							Effect.sync(() => {
								if (!join || !files)
									throw new Error("No target in this test request");
								return indexedTestReports(corpus, files).localization(
									document,
									options
								);
							}),
						localizationQuality: (ruleDocument, options) =>
							Effect.sync(() => {
								if (!join || !files)
									throw new Error("No target in this test request");
								return localizationQuality(
									indexedTestReports(corpus, files).localization(
										ruleDocument,
										options
									),
									join
								);
							}),
						sourceQuality: (ruleDocument) =>
							Effect.sync(() =>
								asyncQuery(indexedTestReports(corpus, files).source(ruleDocument))
							),
						get localizationJoin(): GameTextIndexRefreshResult["localizationJoin"] {
							if (!join) throw new Error("No target in this test request");
							return Effect.succeed(join);
						},
						get localization(): GameTextIndexRefreshResult["localization"] {
							if (!join) throw new Error("No target in this test request");
							const { lines: _, ...header } = join;
							return header;
						},
						get evidence(): GameTextIndexRefreshResult["evidence"] {
							if (!files) throw new Error("No target in this test request");
							return files;
						},
						get review(): GameTextIndexRefreshResult["review"] {
							if (!target) throw new Error("No target in this test request");
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
							throw new Error("Unused builder evidence in host test");
						},
						get packages(): GameTextIndexRefreshResult["packages"] {
							throw new Error("Unused builder evidence in host test");
						},
						get join(): GameTextIndexRefreshResult["join"] {
							throw new Error("Unused builder evidence in host test");
						}
					};
				})
			});
		})
	);
	return testIndexStepsLayer.pipe(Layer.provideMerge(legacy));
}
/** The canned index over the selected Workbench project's scan. */
export const workbenchGameTextIndexLayer = (answers?: CannedQuery) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const scanner = yield* TextCorpusService;
			const project = yield* WorkbenchProject;
			return cannedGameTextIndexLayer(
				(root) =>
					project
						.candidates("game_text")
						.pipe(
							Effect.flatMap((index) =>
								scanner.scanFromProjectIndex(index, { projectRoot: root })
							)
						),
				answers
			);
		})
	);
import { makeGameTextLocalization as indexedGameTextLocalization } from "./game-text-localization.js";
let revisionCount = 0;
export const makeCannedGameTextLocalization = (
	answers: CannedQuery,
	currentCorpus: () => Effect.Effect<TextCorpus | undefined>,
	currentProject: Parameters<typeof indexedGameTextLocalization>[1],
	currentRules?: Parameters<typeof indexedGameTextLocalization>[2],
	currentIndex?: Parameters<typeof indexedGameTextLocalization>[3],
	prepareWrites?: Parameters<typeof indexedGameTextLocalization>[4]
) => {
	// Each corpus the test hands over is a new scan, so it gets its own revision.
	const revisions = new WeakMap<TextCorpus, string>();
	const marker = () =>
		currentCorpus().pipe(
			Effect.map((corpus) => {
				if (!corpus) return undefined;
				let revision = revisions.get(corpus);
				if (!revision) {
					revision = `test#${++revisionCount}`;
					revisions.set(corpus, revision);
				}
				return revision;
			})
		);
	return indexedGameTextLocalization(
		marker,
		currentProject,
		currentRules,
		currentIndex,
		prepareWrites
	).pipe(
		Effect.provide(
			cannedGameTextIndexLayer(
				() =>
					currentCorpus().pipe(
						Effect.flatMap((corpus) =>
							corpus
								? Effect.succeed(corpus)
								: Effect.die("No corpus in this test request")
						)
					),
				answers
			)
		)
	);
};
/** Test handles model host ownership without exercising the compact store. */
export function testProjectIndex(projectRoot: string): GameTextProjectIndex {
	return {
		projectRoot,
		cacheRoot: "test",
		generation: "test",
		packageKey: "test",
		get packages(): GameTextProjectIndex["packages"] {
			throw new Error("Unused compact-store evidence in test index");
		}
	};
}
const testIndexStepsLayer = Layer.effect(
	GameTextIndexSteps,
	Effect.gen(function* () {
		const legacy = yield* GameTextIndexRefresh;
		const evidence = yield* LocalizationEvidence;
		const requests = new WeakMap<GameTextTargetIndex, GameTextIndexRefreshRequest>();
		const steps: Effect.Success<typeof GameTextIndexSteps> = GameTextIndexSteps.of({
			openCommitted: () => Effect.succeed(Option.none()),
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
			openProject: (request) => Effect.succeed(testProjectIndex(request.projectRoot)),
			refreshProject: (request) =>
				legacy.invalidate(request).pipe(Effect.as(testProjectIndex(request.projectRoot))),
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
									throw new Error("Source test index has no localization target");
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
						generation: "test",
						fileKeys: {},
						get join(): GameTextTargetIndex["join"] {
							throw new Error("Unused compact join in test index");
						},
						get review(): GameTextTargetIndex["review"] {
							throw new Error("Unused compact review in test index");
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
					: Effect.die("Missing test request");
			},
			readPoint: () => Effect.die("This test reads no points."),
			invalidate: legacy.invalidate
		});
		return steps;
	})
);
function asyncQuery(report: Parameters<typeof textQualityQuery>[0]) {
	const query = textQualityQuery(report);
	return {
		summary: query.summary,
		search: (request: Parameters<typeof query.search>[0]) =>
			Effect.sync(() => query.search(request)),
		focus: (request: Parameters<typeof query.focus>[0]) =>
			Effect.sync(() => query.focus(request)),
		export: (filter: Parameters<typeof query.export>[0]) =>
			Effect.sync(() => query.export(filter))
	};
}
