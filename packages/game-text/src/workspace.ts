import type { RelatedLinesRequest, RelatedLinesResult } from "./related-lines.js";
import { indexPublicFailure } from "./index-public-error.js";
import { type IndexFailure } from "./index-contract.js";
import {
	GameTextInvestigationPreset,
	type GameTextInvestigationQuery,
	type GameTextInvestigationPresetResult,
	exportGameTextInvestigation,
	workspaceQualityCsv,
	gameTextQualityCsv,
	type LocalizationLinesFileResult
} from "./entry-corpus.js";
import {
	GAME_TEXT_RULES_RELATIVE_PATH,
	STARTER_GAME_TEXT_RULES,
	projectRelativeTextFiles
} from "./entry-rules.js";
import { resolve } from "node:path";
import {
	InvestigationError,
	type InvestigationSource,
	type InvestigationFileResult,
	type InvestigationFormat
} from "@ue-shed/unreal-assets/investigation";
import {
	saveWorkspaceInvestigation as saveInvestigation,
	openWorkspaceInvestigation as openInvestigation,
	investigationFailure
} from "./workspace-investigation.js";
import {
	type WorkspaceQualityRequest,
	type WorkspaceQualityResult,
	type WorkspaceQualityFocusRequest,
	type WorkspaceQualityFocusResult,
	type WorkspaceChangesResult,
	type LocalizationEditRequest,
	type LocalizationEditResult,
	type LocalizationReviewRequest,
	type LocalizationReviewResult,
	type WorkspaceReportRequest,
	type WorkspaceReportResult,
	type WorkspaceReportFileRequest,
	type WorkspaceReportFileResult,
	type LocalizationTargetsResult,
	type LocalizationTargetResult,
	type LocalizationFocusRequest,
	type LocalizationFocusResult,
	type TextQualityFocusRequest,
	type TextQualityFocusResult,
	type AsyncTextQualityQuery,
	type TextQualityQueryRunResult,
	type TextQualityRuleUpdateResult,
	type TextQualitySearchRequest,
	type TextQualitySearchResult
} from "./entry-corpus.js";
import {
	makeRetainedGameTextIndexWith,
	GameTextIndexSteps,
	GameTextIndexError,
	GameTextIndexProgressReporter,
	type GameTextIndexProgress,
	type RetainedGameTextIndexResult
} from "./entry-index.js";
import {
	canonicalGameTextRuleDocumentJson,
	decodeGameTextRuleDocumentJson,
	type GameTextRuleDocument
} from "./entry-rules.js";
import {
	type LocalizationJoin,
	type TextCorpusFocusRequest,
	type TextCorpusFocusResult,
	type TextCorpusQueryRunResult,
	type TextCorpusRowsResult,
	type TextCorpusRunResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "./entry-schema.js";
import {
	corpusInvestigationEnvelope,
	investigationRequest,
	readFindingUnits
} from "./investigation.js";
import { hasBrowseRules, makeGameTextWorkspaceLocalization } from "./workspace-localization.js";
import { checkCompleteRules } from "./native-findings.js";
import type { TextFindingsSelection } from "./text-problem-schema.js";
import { corpusWithoutUnits } from "./index-reads.js";
import type { LocalizationTarget } from "@ue-shed/localization";
import { LocalizationFileAccessLive } from "@ue-shed/localization";
import {
	Cache,
	Result,
	Option,
	Data,
	Deferred,
	Duration,
	Effect,
	PubSub,
	Ref,
	Schema,
	Semaphore,
	Stream,
	type Scope
} from "effect";
import type {
	GameTextWorkspaceHost,
	GameTextWorkspaceProgress,
	GameTextWorkspaceProjectState
} from "./workspace-host.js";

/** A preset of the workspace's query, with the rules its scan used. */
const investigationPreset = (
	query: GameTextInvestigationQuery,
	rules: GameTextInvestigationPreset["rules"]
): GameTextInvestigationPreset => ({
	schemaVersion: query.workspaceFilter === undefined ? 1 : 2,
	kind: "game_text",
	sort: "domain_order",
	query,
	...(rules ? { rules } : undefined)
});

/** The failure of a corpus export whose query isn't open. */
const targetNotLoaded = (query: GameTextInvestigationQuery) =>
	new InvestigationError({
		message: query.localization
			? `The localization target ${query.localization.target} is not loaded.`
			: "This export requires an open native Game Text snapshot.",
		recovery:
			"Refresh the Game Text workspace and select its localization target when filtering translations.",
		retrySafe: true,
		nextStep: "fix_input"
	});

/** An index read's failure as an investigation's, keeping its guidance. */
const investigationIndexFailure = (cause: IndexFailure) =>
	new InvestigationError({
		message: cause.message,
		recovery: cause.recovery,
		retrySafe: cause.retrySafe,
		nextStep: cause.nextStep,
		cause
	});

type ProjectCandidates = {
	readonly generation: number;
	readonly summary: { readonly projectRoot: string };
};

/**
 * The Game Text workspace a host runs over its selected project: scanning, search, quality rules,
 * localization targets, edits, reviews, reports and investigations. Every method answers with a
 * result value; none fails. Hosts register these as their own commands or IPC handlers.
 */
export interface GameTextWorkspaceApi {
	/**
	 * The target as the published scan lists it, for state polls: it never prepares, borrows or
	 * discovers, so it answers while a scan holds the index.
	 */
	readonly operationStateTarget: (
		name: LocalizationJoin["target"]
	) => Effect.Effect<LocalizationTarget | undefined>;
	/** Main-only admission and refresh methods. These are never registered as IPC handlers. */
	readonly operationTarget: (
		name: LocalizationJoin["target"]
	) => Effect.Effect<LocalizationTarget | undefined>;
	readonly operationBusyReason: () => Effect.Effect<string | undefined>;
	readonly beginOperation: () => Effect.Effect<boolean>;
	readonly endOperation: () => Effect.Effect<void>;
	readonly refreshAfterOperation: (
		target: LocalizationJoin["target"],
		gather: boolean
	) => Effect.Effect<boolean>;
	/** Keeps the target's translations before Unreal gathers, to pair keys that change. */
	readonly localizationBeforeGather: (
		target: LocalizationJoin["target"]
	) => Effect.Effect<void, IndexFailure>;
	readonly localizationQualitySearch: (
		request: WorkspaceQualityRequest
	) => Effect.Effect<WorkspaceQualityResult>;
	readonly localizationQualityFocus: (
		request: WorkspaceQualityFocusRequest
	) => Effect.Effect<WorkspaceQualityFocusResult>;
	readonly localizationChanges: (
		request: WorkspaceQualityRequest
	) => Effect.Effect<WorkspaceChangesResult>;
	readonly localizationEdits: (
		request: LocalizationEditRequest
	) => Effect.Effect<LocalizationEditResult>;
	readonly localizationReview: (
		request: LocalizationReviewRequest
	) => Effect.Effect<LocalizationReviewResult>;
	readonly localizationReport: (
		request: WorkspaceReportRequest
	) => Effect.Effect<WorkspaceReportResult>;
	readonly localizationReportFile: (
		request: WorkspaceReportFileRequest
	) => Effect.Effect<WorkspaceReportFileResult>;
	readonly localizationLinesFile: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<LocalizationLinesFileResult>;
	readonly localizationTargets: () => Effect.Effect<LocalizationTargetsResult>;
	readonly localizationTarget: (
		target: LocalizationJoin["target"]
	) => Effect.Effect<LocalizationTargetResult>;
	readonly localizationFocus: (
		request: LocalizationFocusRequest
	) => Effect.Effect<LocalizationFocusResult>;
	/** A selection's related units and lines, with their places and translations. */
	readonly related: (request: RelatedLinesRequest) => Effect.Effect<RelatedLinesResult>;
	readonly investigationExport: (
		query: GameTextInvestigationQuery,
		format: InvestigationFormat
	) => Effect.Effect<InvestigationFileResult>;
	readonly investigationSave: (
		query: GameTextInvestigationQuery
	) => Effect.Effect<InvestigationFileResult>;
	readonly investigationOpen: () => Effect.Effect<GameTextInvestigationPresetResult>;
	readonly configuredRefresh: (refresh?: boolean) => Effect.Effect<TextCorpusQueryRunResult>;
	readonly configuredScan: () => Effect.Effect<TextCorpusRunResult>;
	readonly progress: () => Effect.Effect<GameTextWorkspaceProgress>;
	/**
	 * The workspace's progress, then each change to it: the host's project progress while it
	 * enumerates or scans, then Game Text's own stages. Consecutive equal values are sent once.
	 */
	readonly progressChanges: () => Stream.Stream<GameTextWorkspaceProgress>;
	readonly focus: (request: TextCorpusFocusRequest) => Effect.Effect<TextCorpusFocusResult>;
	readonly search: (request: TextCorpusSearchRequest) => Effect.Effect<TextCorpusSearchResult>;
	/** The request's rows, or its open groups' first rows, without the aggregates `search` adds. */
	readonly searchRows: (request: TextCorpusSearchRequest) => Effect.Effect<TextCorpusRowsResult>;
	readonly chooseQualityRules: () => Effect.Effect<TextQualityQueryRunResult>;
	readonly reloadQualityRules: () => Effect.Effect<TextQualityQueryRunResult>;
	readonly createStarterRules: (
		loadExisting: boolean
	) => Effect.Effect<TextQualityQueryRunResult>;
	readonly previewQualityRules: (
		document: GameTextRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult>;
	readonly saveQualityRules: (
		document: GameTextRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult>;
	readonly qualityFocus: (
		request: TextQualityFocusRequest
	) => Effect.Effect<TextQualityFocusResult>;
	readonly qualitySearch: (
		request: TextQualitySearchRequest
	) => Effect.Effect<TextQualitySearchResult>;
}

/** A scan's phases in the order they start, after the host's project scan (step 1). */
const scanSteps: readonly GameTextIndexProgress["phase"][] = [
	"localization",
	"localization_publish",
	"inventory",
	"packages",
	"package_text",
	"package_publish",
	"joining",
	"opening"
];

function unavailableProject(message: string, recovery: string): TextCorpusRunResult {
	return {
		error: { code: "invalid_project" as const, message, recovery, retrySafe: true },
		status: "failed"
	};
}

function unavailableQueryProject(message: string, recovery: string): TextCorpusQueryRunResult {
	return {
		error: { code: "invalid_project" as const, message, recovery, retrySafe: true },
		status: "failed"
	};
}

/**
 * Builds the workspace in the caller's scope, which owns its scans: a scan keeps running when the
 * request that started it is interrupted (a closed window or a dropped connection), and a later
 * request for the same project generation joins it.
 */
export const makeGameTextWorkspace = Effect.fn("GameText.workspace.make")(function* (
	host: GameTextWorkspaceHost
) {
	const project = host.project;
	const workspaceScope = yield* Effect.scope;
	const rulesRelativePath = host.rulesRelativePath ?? GAME_TEXT_RULES_RELATIVE_PATH;
	let indexProgress: GameTextIndexProgress | undefined;
	// Anything progress reads changed; a subscriber reads progress again. Signals waiting for a
	// slow subscriber collapse into one.
	const progressChanged = yield* PubSub.sliding<void>(1);
	const signalProgress = () => {
		PubSub.publishUnsafe(progressChanged, undefined);
	};
	const reportProgress = (value: GameTextIndexProgress) => {
		indexProgress = value;
		signalProgress();
	};
	if (host.project.progressChanges)
		yield* Stream.runForEach(host.project.progressChanges(), () =>
			Effect.sync(signalProgress)
		).pipe(Effect.forkIn(workspaceScope));
	const steps = yield* GameTextIndexSteps;
	const refreshIndex = yield* makeRetainedGameTextIndexWith(
		Effect.fn("GameText.workspace.prepareWorkspace")(function* (request) {
			const preferred = yield* localization
				.preparation(request.projectRoot)
				.pipe(Effect.scoped);
			// A target index also contains the complete raw source projection. Importing it first
			// lets the cold pipeline prepare one joined index for both views.
			const target = yield* steps.prepareTarget(
				{ ...request, ...preferred },
				{ fallbackToSource: true }
			);
			return yield* steps.openTarget(target);
		})
	).pipe(Effect.provideService(GameTextIndexProgressReporter, reportProgress));
	const cachedIndex = yield* makeRetainedGameTextIndexWith(
		Effect.fn("GameText.workspace.openCached")(function* (request) {
			const preferred = yield* localization
				.preparation(request.projectRoot)
				.pipe(Effect.scoped);
			let opened = yield* steps.openCommitted({ ...request, ...preferred });
			if (Option.isNone(opened) && preferred?.targetName !== undefined)
				opened = yield* steps.openCommitted({ projectRoot: request.projectRoot });
			if (Option.isSome(opened)) return opened.value;
			return yield* Effect.fail(
				new GameTextIndexError({
					code: "index_failed",
					operation: "cache",
					message: "No usable committed Game Text index exists.",
					recovery: "Scan the project.",
					nextStep: "reconcile",
					retrySafe: true
				})
			);
		})
	);
	const dialog = host.files;
	const files = host.files;
	const activity = yield* Ref.make({ scans: 0, operation: false });
	/** Whether a scan or an operation runs is part of progress. */
	const activityChanged = Effect.sync(signalProgress);
	const operationBusyReason = () =>
		Ref.get(activity).pipe(
			Effect.map((value) =>
				value.operation
					? "An Unreal localization step is running. Cancel it or wait before scanning."
					: value.scans > 0
						? "A project scan is running. Wait before running Unreal steps."
						: undefined
			)
		);
	const guardScan = <A, B, R>(scan: Effect.Effect<A, never, R>, unavailable: () => B) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				// Admission shares publication's permit so a cached open cannot publish after this check.
				const admitted = yield* Ref.modify(activity, (value) =>
					value.operation ? [false, value] : [true, { ...value, scans: value.scans + 1 }]
				).pipe(publication.withPermit);
				if (!admitted) return unavailable();
				yield* activityChanged;
				return yield* restore(scan).pipe(
					Effect.ensuring(
						Ref.update(activity, (value) => ({
							...value,
							scans: value.scans - 1
						})).pipe(Effect.andThen(activityChanged))
					)
				);
			})
		);
	/** The published model's revision: a result computed for another one must not publish. */
	const retainedRevision = (index: RetainedGameTextIndexResult) => index.revision;
	/** Source rules over the index, page by page. */
	const sourceQualityModel = (index: RetainedGameTextIndexResult, rules: GameTextRuleDocument) =>
		index.sourceQuality(rules);
	const queryModel = (index: RetainedGameTextIndexResult) => index.query;
	const querySearch = (index: RetainedGameTextIndexResult) => index.search;
	const querySearchRows = (index: RetainedGameTextIndexResult) => index.searchRows;
	const completedQuery = (index: RetainedGameTextIndexResult, cached?: true) =>
		cached
			? { status: "completed" as const, summary: index.summary, cached }
			: { status: "completed" as const, summary: index.summary };
	const qualityModel = yield* Ref.make<AsyncTextQualityQuery | undefined>(undefined);
	const qualityDocument = yield* Ref.make<GameTextRuleDocument | undefined>(undefined);
	const qualityRulePath = yield* Ref.make<
		{ readonly path: string; readonly projectRoot: string } | undefined
	>(undefined);
	const progress = Effect.fn("GameText.workspace.progress")(
		function* (): Effect.fn.Return<GameTextWorkspaceProgress> {
			const projectProgress = yield* project.progress();
			if (projectProgress.phase === "enumerating" || projectProgress.phase === "scanning") {
				return { ...projectProgress, step: 1, steps: scanSteps.length + 1 };
			}
			const current = indexProgress;
			if (current && current.phase !== "ready" && current.phase !== "failed") {
				const labels = {
					inventory: "Reading project asset inventory",
					localization: "Reading localization files",
					localization_publish: "Saving localization text",
					packages: "Checking saved packages for text",
					package_text: "Preparing package text",
					package_publish: "Saving package text",
					joining: "Joining source text and translations",
					opening: "Opening text index",
					corpus: "Reading saved packages",
					localization_quality: "Checking localization quality",
					source_quality: "Checking source text"
				};
				const step = scanSteps.indexOf(current.phase);
				return {
					completed: current.completed,
					total: current.total,
					phase: "scanning" as const,
					stage: "game_text" as const,
					detail: labels[current.phase],
					...(step >= 0 ? { step: step + 2, steps: scanSteps.length + 1 } : undefined)
				};
			}
			const active = yield* Ref.get(activity);
			return {
				completed: 0,
				phase: active.scans ? ("scanning" as const) : ("idle" as const),
				stage: "game_text" as const,
				total: 0
			};
		}
	);
	const scanCorpus = (projectRoot: string) =>
		refreshIndex.refresh({ projectRoot }).pipe(
			Effect.flatMap((result) => result.corpus),
			Effect.scoped
		);

	const runScan = (projectRoot: string) =>
		scanCorpus(projectRoot).pipe(
			Effect.map((corpus) => ({ corpus, status: "completed" as const })),
			Effect.catch((error) =>
				Effect.succeed({
					error: indexPublicFailure(error),
					status: "failed" as const
				})
			)
		);
	const investigationSnapshot = yield* Ref.make<
		| {
				readonly source: InvestigationSource;
				readonly revision: RetainedGameTextIndexResult["revision"];
				readonly rules?: GameTextRuleDocument;
		  }
		| undefined
	>(undefined);

	const scanRevision = yield* Ref.make(0);
	const publication = yield* Semaphore.make(1);
	const modelSelection = yield* Ref.make<
		| {
				readonly projectRoot: string;
				readonly generation: number;
				readonly cached?: true;
				readonly indexed: RetainedGameTextIndexResult;
		  }
		| undefined
	>(undefined);
	const currentIndex = Effect.fn("GameText.workspace.currentIndex")(function* () {
		const selected = yield* project.current();
		const owner = yield* Ref.get(modelSelection);
		if (selected.status !== "ready" || selected.project.projectRoot !== owner?.projectRoot)
			return undefined;
		yield* owner.indexed.borrow;
		return owner.indexed;
	});
	const currentModel = <A>(read: (index: RetainedGameTextIndexResult) => A) =>
		currentIndex().pipe(Effect.map((index) => (index ? read(index) : undefined)));
	const currentValue = <A>(ref: Ref.Ref<A | undefined>) =>
		currentIndex().pipe(
			Effect.flatMap((index) => (index ? Ref.get(ref) : Effect.succeed(undefined)))
		);
	// Review records name who set them; the host's policy decides who that is.
	const reviewer = host.reviewer ?? (() => "game-text");
	const localization = yield* makeGameTextWorkspaceLocalization(
		() => currentModel(retainedRevision),
		() => currentModel((index) => index.project),
		() => currentValue(qualityDocument),
		currentIndex,
		{
			author: host.changeAuthor ?? "game-text",
			localizationFiles: host.localizationFiles ?? LocalizationFileAccessLive,
			...(host.prepareWrites ? { prepareWrites: host.prepareWrites } : undefined)
		}
	).pipe(Effect.provideService(GameTextIndexProgressReporter, reportProgress));
	// The host has no selection event port. Retire on the next workspace call that observes a switch.
	const unselected = Effect.fn("GameText.workspace.unselected")(function* () {
		const selected = yield* project.current();
		const owner = yield* Ref.get(modelSelection);
		return (
			owner !== undefined &&
			!(selected.status === "ready" && selected.project.projectRoot === owner.projectRoot)
		);
	});
	// Every host call, including progress polling, checks for a switch; only a switch observed
	// outside the permit takes it and checks again before retiring.
	const retireUnselected = Effect.fn("GameText.workspace.retireUnselected")(function* () {
		if (yield* unselected()) yield* retireSwitched();
	});
	const retireSwitched = Effect.fn("GameText.workspace.retireSwitched")(
		function* () {
			if (!(yield* unselected())) return;
			yield* Ref.set(modelSelection, undefined);
			yield* Ref.update(scanRevision, (value) => value + 1);
			yield* Ref.set(investigationSnapshot, undefined);
			yield* Ref.set(qualityModel, undefined);
			yield* Ref.set(qualityDocument, undefined);
			yield* Ref.set(qualityRulePath, undefined);
			yield* localization.reset();
			yield* cachedIndex.release({ background: true });
			yield* refreshIndex.release({ background: true });
		},
		publication.withPermit,
		Effect.uninterruptible
	);
	/** Every host read pins its model for the complete operation and observes project switches. */
	const scoped =
		<Args extends unknown[], A, E, R>(operation: (...args: Args) => Effect.Effect<A, E, R>) =>
		(...args: Args) =>
			Effect.scoped(retireUnselected().pipe(Effect.andThen(operation(...args))));
	const consistentIndex = Effect.fn("GameText.workspace.consistentIndex")(function* () {
		const index = yield* currentIndex();
		const selected = yield* project.current();
		const owner = yield* Ref.get(modelSelection);
		// A cached model is searchable but unverified, so it never counts as the current generation.
		return selected.status === "ready" &&
			owner?.cached !== true &&
			(selected.project.generation ?? 0) === owner?.generation
			? index
			: undefined;
	});
	const cachedOpen = Effect.fn("GameText.workspace.cachedOpen")(function* (projectRoot: string) {
		const revision = yield* Ref.get(scanRevision);
		if ((yield* Ref.get(activity)).scans > 0) return { status: "not_scanned" as const };
		return yield* cachedIndex.refresh({ projectRoot }).pipe(
			Effect.flatMap((indexed) =>
				Effect.gen(function* () {
					const selected = yield* project.current();
					if (
						selected.status !== "ready" ||
						selected.project.projectRoot !== projectRoot ||
						(yield* Ref.get(activity)).scans > 0 ||
						(yield* Ref.get(scanRevision)) !== revision
					)
						return { status: "not_scanned" as const };
					// Concurrent reopen requests share the published model, not a second host pin.
					const previous = yield* currentIndex();
					if (previous)
						return completedQuery(previous, (yield* Ref.get(modelSelection))?.cached);
					const generation = selected.project.generation ?? 0;
					yield* indexed.retain;
					yield* Ref.set(modelSelection, {
						projectRoot,
						generation,
						indexed,
						cached: true
					});
					// The cache was never checked against the current Project Index, so it records no
					// investigation source: exports and rules wait for the rescan's verified model.
					yield* Ref.set(investigationSnapshot, undefined);
					return {
						status: "completed" as const,
						summary: indexed.summary,
						cached: true as const
					};
				}).pipe(publication.withPermit, Effect.uninterruptible)
			),
			// oxlint-disable-next-line anti-slop/no-effect-catch-all -- Cache open always falls back to Scan project.
			Effect.catch(() => Effect.succeed({ status: "not_scanned" as const }))
		);
	});
	const runRefresh = (projectRoot: string, index: ProjectCandidates) =>
		Effect.gen(function* () {
			const revision = yield* Ref.updateAndGet(scanRevision, (value) => value + 1);
			const selected = yield* project.current();
			if (
				selected.status !== "ready" ||
				selected.project.projectRoot !== projectRoot ||
				(selected.project.generation ?? 0) !== index.generation ||
				index.summary.projectRoot !== projectRoot
			)
				return unavailableQueryProject(
					"The selected project changed.",
					"Retry in the selected project."
				);
			return yield* refreshIndex.refresh({ projectRoot }).pipe(
				Effect.flatMap((indexed) =>
					Effect.gen(function* () {
						const modelRevision = indexed.revision;
						/** This scan is still the latest for the selected project generation. */
						const owned = Effect.gen(function* () {
							const latest = yield* project.current();
							return (
								(yield* Ref.get(scanRevision)) === revision &&
								latest.status === "ready" &&
								latest.project.projectRoot === projectRoot &&
								(latest.project.generation ?? 0) === index.generation
							);
						});
						const superseded = () =>
							unavailableQueryProject(
								"The project changed during the scan.",
								"Refresh to read the current project generation."
							);
						/** The rules the published model of this project carries over to the new one. */
						const carriedRules = Effect.gen(function* () {
							const owner = yield* Ref.get(modelSelection);
							return owner?.projectRoot === projectRoot
								? yield* Ref.get(qualityDocument)
								: undefined;
						});
						// Ends once the project, its generation or a newer scan supersedes this one.
						const supersession = Effect.gen(function* () {
							while (yield* owned) yield* Effect.sleep("100 millis");
						});
						// A scan that found the published model's inputs unchanged keeps that model, with
						// its source quality, localization selection and quality scans; the new open closes.
						// Only the discovered targets are read again: the scan covers one target's text.
						const kept = yield* Effect.gen(function* () {
							if (!(yield* owned)) return superseded();
							const previous = yield* Ref.get(modelSelection);
							if (
								previous?.projectRoot !== projectRoot ||
								previous.cached ||
								indexed.queryRevision === undefined ||
								previous.indexed.queryRevision !== indexed.queryRevision
							)
								return undefined;
							yield* localization.rediscover();
							yield* Ref.set(modelSelection, {
								...previous,
								generation: index.generation
							});
							yield* Ref.update(
								investigationSnapshot,
								(snapshot) =>
									snapshot && {
										...snapshot,
										source: { ...snapshot.source, generation: index.generation }
									}
							);
							return {
								summary: previous.indexed.summary,
								status: "completed" as const
							};
						}).pipe(publication.withPermit, Effect.uninterruptible);
						if (kept) return kept;
						while (true) {
							if (!(yield* owned)) return superseded();
							// Source rules are evaluated before anything is published, and interruptibly: a scan
							// superseded meanwhile stops evaluating, publishes nothing and retains nothing.
							const rules = yield* carriedRules;
							const evaluated = rules
								? yield* Effect.race(
										sourceQualityModel(indexed, rules).pipe(
											Effect.map((model) => ({ model }))
										),
										supersession.pipe(Effect.as(undefined))
									)
								: { model: undefined };
							if (!evaluated) return superseded();
							const published = yield* Effect.gen(function* () {
								if (!(yield* owned)) return superseded();
								// Rules previewed during the evaluation: evaluate those instead.
								if ((yield* carriedRules) !== rules) return undefined;
								const previous = yield* Ref.get(modelSelection);
								const unchangedPackages =
									previous?.projectRoot === projectRoot &&
									indexed.project !== undefined &&
									previous.indexed.project?.packageKey ===
										indexed.project.packageKey &&
									previous.indexed.project.generation ===
										indexed.project.generation;
								yield* localization.reset(unchangedPackages);
								return yield* Effect.gen(function* () {
									if (!(yield* owned)) return superseded();
									if ((yield* carriedRules) !== rules) return undefined;

									const owner = yield* Ref.get(modelSelection);
									const rulePath =
										owner?.projectRoot === projectRoot
											? yield* Ref.get(qualityRulePath)
											: undefined;
									yield* Ref.set(investigationSnapshot, {
										source: {
											projectRoot,
											generation: index.generation,
											authority: "project_files"
										},
										revision: modelRevision,
										...(rules ? { rules } : undefined)
									});
									yield* Effect.all([
										Ref.set(qualityModel, evaluated.model),
										Ref.set(qualityDocument, rules),
										Ref.set(qualityRulePath, rulePath)
									]);
									yield* Ref.set(modelSelection, {
										projectRoot,
										generation: index.generation,
										indexed
									});
									yield* indexed.retain;
									yield* cachedIndex.release({ background: true });
									return {
										summary: indexed.summary,
										status: "completed" as const
									};
								}).pipe(publication.withPermit);
							}).pipe(Effect.uninterruptible);
							if (published) return published;
						}
					})
				),
				Effect.catch((error) =>
					Effect.succeed({
						error: indexPublicFailure(error),
						status: "failed" as const
					})
				)
			);
		});

	const configuredScan = Effect.fn("GameText.workspace.configuredScan")(function* (
		refreshProject: typeof project.refresh = project.refresh
	) {
		yield* retireUnselected();
		const current = yield* refreshProject();
		if (current.status === "not_configured" || current.status === "cancelled") {
			return { status: "not_configured" as const };
		}
		if (current.status === "failed") {
			return unavailableProject(current.error.message, current.error.recovery);
		}
		return yield* project.candidates().pipe(
			Effect.flatMap(() => runScan(current.project.projectRoot)),
			Effect.catch((error) =>
				Effect.succeed(unavailableProject(error.message, error.recovery))
			)
		);
	});

	class QueryKey extends Data.Class<{
		readonly projectRoot: string;
		readonly generation: number;
		readonly ruleFile: string;
	}> {}
	const refreshes = yield* Cache.makeWith(
		(key: QueryKey) =>
			Effect.gen(function* () {
				const index = yield* project.candidates();
				if (
					index.summary.projectRoot !== key.projectRoot ||
					index.generation !== key.generation
				)
					return unavailableQueryProject(
						"The selected project changed.",
						"Retry in the selected project."
					);
				return yield* runRefresh(key.projectRoot, index);
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed(unavailableQueryProject(error.message, error.recovery))
				)
			),
		{ capacity: 2, timeToLive: () => Duration.zero }
	);
	const configuredRefresh = Effect.fn("GameText.workspace.configuredRefresh")(function* (
		refresh = true,
		refreshProject: typeof project.refresh = project.refresh
	) {
		yield* retireUnselected();
		const current = yield* refresh ? refreshProject() : project.current();
		if (current.status === "not_configured" || current.status === "cancelled") {
			return { status: "not_configured" as const };
		}
		if (current.status === "failed") {
			return unavailableQueryProject(current.error.message, current.error.recovery);
		}
		const key = new QueryKey({
			projectRoot: current.project.projectRoot,
			generation: current.project.generation ?? 0,
			ruleFile: ""
		});
		if (!refresh) {
			const indexed = yield* currentIndex();
			return indexed
				? completedQuery(indexed, (yield* Ref.get(modelSelection))?.cached)
				: yield* cachedOpen(current.project.projectRoot);
		}
		return yield* Cache.get(refreshes, key);
	});

	// A pasted changed-file list may hold absolute paths; those under the project become relative.
	const projectRelativeRequest = (request: TextCorpusSearchRequest) =>
		Ref.get(modelSelection).pipe(
			Effect.map((owner) =>
				owner === undefined || request.where?.files === undefined
					? request
					: {
							...request,
							where: {
								...request.where,
								files: projectRelativeTextFiles(
									request.where.files,
									owner.projectRoot
								)
							}
						}
			)
		);
	/**
	 * Browse's findings layer: with a target, its Quality scan's, with the review acceptance it
	 * applies; without one, the published rules' source findings. `pending` while the rules
	 * evaluate, `none` without a rule that runs there.
	 */
	const browseFindings = Effect.fn("GameText.workspace.browseFindings")(function* (
		target: LocalizationTarget["name"] | undefined
	): Effect.fn.Return<
		| { readonly status: "none" | "pending" }
		| { readonly status: "ready"; readonly selection: TextFindingsSelection },
		never,
		Scope.Scope
	> {
		if (target !== undefined) return yield* localization.browseFindings(target);
		if (!hasBrowseRules(yield* currentValue(qualityDocument), false)) return { status: "none" };
		const key = (yield* currentValue(qualityModel))?.findingsKey;
		return key === undefined
			? { status: "pending" }
			: { status: "ready", selection: { key, sourceOnly: true } };
	});
	/** A read with Browse's findings layer in place of any the host named. */
	const withBrowseFindings = <A extends { readonly findings?: TextFindingsSelection }>(
		read: A,
		findings: Effect.Success<ReturnType<typeof browseFindings>>
	): Omit<A, "findings"> & { readonly findings?: TextFindingsSelection } => {
		const { findings: _host, ...rest } = read;
		return findings.status === "ready" ? { ...rest, findings: findings.selection } : rest;
	};

	const search = Effect.fn("GameText.workspace.search")(function* (
		input: TextCorpusSearchRequest
	): Effect.fn.Return<TextCorpusSearchResult, never, Scope.Scope> {
		const relative = yield* projectRelativeRequest(input);
		const findings = yield* browseFindings(relative.localization?.target);
		const request = withBrowseFindings(relative, findings);
		const status = { status: findings.status };
		if (request.localization) {
			const result = yield* localization.search(request);
			return result.status === "ready"
				? { ...result, page: { ...result.page, findings: status } }
				: result;
		}
		const search = yield* currentModel(querySearch);
		if (!search) return { status: "not_ready" };
		const outcome = yield* search(request).pipe(Effect.result);
		if (Result.isFailure(outcome))
			return { status: "failed", error: indexPublicFailure(outcome.failure) };
		const page = { ...outcome.success, findings: status };
		return (yield* currentModel(querySearch)) === search
			? { status: "ready", page }
			: { status: "not_ready" };
	});

	const searchRows = Effect.fn("GameText.workspace.searchRows")(function* (
		input: TextCorpusSearchRequest
	): Effect.fn.Return<TextCorpusRowsResult, never, Scope.Scope> {
		const relative = yield* projectRelativeRequest(input);
		const request = withBrowseFindings(
			relative,
			yield* browseFindings(relative.localization?.target)
		);
		if (request.localization) return yield* localization.searchRows(request);
		const read = yield* currentModel(querySearchRows);
		if (!read) return { status: "not_ready" };
		const outcome = yield* read(request).pipe(Effect.result);
		if (Result.isFailure(outcome))
			return { status: "failed", error: indexPublicFailure(outcome.failure) };
		const page = outcome.success;
		return (yield* currentModel(querySearchRows)) === read
			? { status: "ready", page }
			: { status: "not_ready" };
	});

	const focus = Effect.fn("GameText.workspace.focus")(function* (input: TextCorpusFocusRequest) {
		const request = withBrowseFindings(
			input,
			yield* browseFindings(input.localization?.target)
		);
		const model = yield* request.localization
			? localization.targetQuery(request.localization.target)
			: currentModel(queryModel);
		if (!model) return { status: "not_ready" as const };
		const result = yield* model.focus(request).pipe(Effect.result);
		if (Result.isFailure(result))
			return { status: "failed" as const, error: indexPublicFailure(result.failure) };
		return result.success === undefined
			? { status: "not_found" as const }
			: { status: "found" as const, focus: result.success };
	});

	const related = Effect.fn("GameText.workspace.related")(function* (
		request: RelatedLinesRequest
	) {
		const model = yield* request.target
			? localization.targetQuery(request.target)
			: currentModel(queryModel);
		if (!model) return { status: "not_ready" as const };
		const result = yield* model.related(request).pipe(Effect.result);
		if (Result.isFailure(result))
			return { status: "failed" as const, error: indexPublicFailure(result.failure) };
		return result.success === undefined
			? { status: "not_found" as const }
			: { status: "found" as const, related: result.success };
	});

	const prepareQualityRules = Effect.fn("GameText.workspace.prepareQualityRules")(function* (
		input: GameTextRuleDocument
	) {
		const index = yield* consistentIndex();
		if (index === undefined) return { status: "not_ready" as const };
		const revision = index.revision;
		const document = yield* decodeGameTextRuleDocumentJson(JSON.stringify(input)).pipe(
			Effect.match({
				onFailure: (error) => ({ error, status: "failed" as const }),
				onSuccess: (value) => ({ status: "ready" as const, value })
			})
		);
		if (document.status === "failed") {
			return {
				error: {
					code: "invalid_rules" as const,
					message: document.error.message,
					recovery: document.error.recovery,
					retrySafe: true
				},
				status: "failed" as const
			};
		}
		// A document equal to the published one (a host's copy, a reloaded file) keeps the published
		// object and model, so the source and localization quality computed for it stay current.
		const snapshot = yield* Ref.get(investigationSnapshot);
		const published = yield* Ref.get(qualityDocument);
		const publishedModel = yield* Ref.get(qualityModel);
		if (
			snapshot?.revision === revision &&
			published !== undefined &&
			publishedModel !== undefined &&
			canonicalGameTextRuleDocumentJson(published) ===
				canonicalGameTextRuleDocumentJson(document.value)
		)
			return {
				revision,
				document: published,
				model: publishedModel,
				status: "ready" as const
			};
		const checked = yield* checkCompleteRules(index.query, document.value).pipe(Effect.result);
		if (Result.isFailure(checked))
			return {
				status: "failed" as const,
				error: {
					code:
						checked.failure._tag === "GameTextRuleDocumentError"
							? ("invalid_rules" as const)
							: ("contract_failure" as const),
					message: checked.failure.message,
					recovery: checked.failure.recovery,
					retrySafe: true
				}
			};
		const prepared = yield* sourceQualityModel(index, document.value).pipe(Effect.result);
		if (Result.isFailure(prepared))
			return {
				status: "failed" as const,
				error: {
					code: "contract_failure" as const,
					message: prepared.failure.message,
					recovery: prepared.failure.recovery,
					retrySafe: prepared.failure.retrySafe
				}
			};
		return {
			revision,
			document: document.value,
			model: prepared.success,
			status: "ready" as const
		};
	});

	const publishQualityRules = Effect.fn("GameText.workspace.publishQualityRules")(
		function* (prepared: {
			readonly document: GameTextRuleDocument;
			readonly model: AsyncTextQualityQuery;
			readonly revision: RetainedGameTextIndexResult["revision"];
		}) {
			const snapshot = yield* Ref.get(investigationSnapshot);
			if (
				snapshot?.revision !== prepared.revision ||
				(yield* consistentIndex())?.revision !== prepared.revision
			)
				return { status: "not_ready" as const };
			yield* Ref.set(investigationSnapshot, { ...snapshot, rules: prepared.document });
			yield* Effect.all([
				Ref.set(qualityDocument, prepared.document),
				Ref.set(qualityModel, prepared.model)
			]);
			// The renderer learns whether Save has a file destination, never the path itself.
			const destination = yield* Ref.get(qualityRulePath);
			const owner = yield* Ref.get(modelSelection);
			return {
				document: prepared.document,
				status: "completed" as const,
				summary: prepared.model.summary(),
				ruleFile:
					destination !== undefined && destination.projectRoot === owner?.projectRoot
						? ("attached" as const)
						: ("none" as const)
			};
		},
		// Atomic with a rescan's publication, which carries the published rules over.
		publication.withPermit
	);

	const createStarterRules = Effect.fn("GameText.workspace.createStarterRules")(function* (
		loadExisting: boolean
	) {
		if ((yield* Ref.get(activity)).operation)
			return {
				status: "failed" as const,
				error: {
					code: "write_failed" as const,
					message: "An Unreal step is running.",
					recovery: "Cancel it or wait before changing rules.",
					retrySafe: true
				}
			};
		const current = yield* project.current();
		if (current.status !== "ready" || !(yield* currentModel(retainedRevision)))
			return { status: "not_ready" as const };
		const root = current.project.projectRoot;
		const path = resolve(root, rulesRelativePath);
		if (!loadExisting) {
			const bytes = new TextEncoder().encode(
				`${JSON.stringify(host.starterRules ?? STARTER_GAME_TEXT_RULES, null, "\t")}\n`
			);
			const created = yield* files
				.writeFile(path, bytes, { maxBytes: 1_048_576, exclusive: true })
				.pipe(
					Effect.match({
						onSuccess: () => ({ status: "ready" as const }),
						onFailure: (error) => ({
							status: "failed" as const,
							error: {
								code:
									error.code === "already_exists"
										? ("already_exists" as const)
										: ("write_failed" as const),
								message: error.message,
								recovery:
									error.code === "already_exists"
										? "Load the existing rules file to use its writing checks."
										: error.recovery,
								retrySafe: true
							}
						})
					})
				);
			if (created.status === "failed") return created;
		}
		return yield* Effect.gen(function* () {
			const bytes = yield* files.readFileWithin(root, rulesRelativePath, {
				maxBytes: 1_048_576
			});
			const document = yield* decodeGameTextRuleDocumentJson(new TextDecoder().decode(bytes));
			const prepared = yield* prepareQualityRules(document);
			const latest = yield* project.current();
			if (
				latest.status !== "ready" ||
				latest.project.projectRoot !== root ||
				(latest.project.generation ?? 0) !== (current.project.generation ?? 0)
			)
				return { status: "not_ready" as const };
			if (prepared.status !== "ready") return prepared;
			yield* Ref.set(qualityRulePath, { path, projectRoot: root });
			return yield* publishQualityRules(prepared);
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed({
					status: "failed" as const,
					error: {
						code:
							"_tag" in error && error._tag === "GameTextRuleDocumentError"
								? ("invalid_rules" as const)
								: ("read_failed" as const),
						message: error.message,
						recovery: error.recovery,
						retrySafe: true
					}
				})
			)
		);
	});

	const chooseQualityRules = Effect.fn("GameText.workspace.chooseQualityRules")(function* () {
		const revision = yield* currentModel(retainedRevision);
		if (revision === undefined) return { status: "not_ready" as const };
		const choice = yield* dialog
			.chooseFile({
				filters: [{ extensions: ["json"], name: "Game Text quality rules" }],
				title: "Choose Game Text quality rules"
			})
			.pipe(Effect.catch(() => Effect.succeed({ status: "cancelled" as const })));
		if (choice.status === "cancelled") return choice;
		const bytes = yield* files.readFile(choice.path, { maxBytes: 1_048_576 }).pipe(
			Effect.match({
				onFailure: (error) => ({
					error: {
						code: "read_failed" as const,
						message: error.message,
						recovery: error.recovery,
						retrySafe: true
					},
					status: "failed" as const
				}),
				onSuccess: (value) => ({ status: "ready" as const, value })
			})
		);
		if (bytes.status === "failed") {
			return bytes;
		}
		const document = yield* decodeGameTextRuleDocumentJson(
			new TextDecoder().decode(bytes.value)
		).pipe(
			Effect.match({
				onFailure: (error) => ({ error, status: "failed" as const }),
				onSuccess: (value) => ({ status: "ready" as const, value })
			})
		);
		if (document.status === "failed") {
			return {
				error: {
					code: "invalid_rules" as const,
					message: document.error.message,
					recovery: document.error.recovery,
					retrySafe: true
				},
				status: "failed" as const
			};
		}
		if ((yield* currentModel(retainedRevision)) !== revision)
			return { status: "not_ready" as const };
		const prepared = yield* prepareQualityRules(document.value);
		if (prepared.status !== "ready") return prepared;
		const snapshot = yield* Ref.get(investigationSnapshot);
		if (snapshot?.revision !== prepared.revision) return { status: "not_ready" as const };
		yield* Ref.set(qualityRulePath, {
			path: choice.path,
			projectRoot: snapshot.source.projectRoot
		});
		return yield* publishQualityRules(prepared);
	});

	const previewQualityRules = Effect.fn("GameText.workspace.previewQualityRules")(function* (
		document: GameTextRuleDocument
	) {
		const prepared = yield* prepareQualityRules(document);
		return prepared.status === "ready" ? yield* publishQualityRules(prepared) : prepared;
	});

	const reloadQualityRules = Effect.fn("GameText.workspace.reloadQualityRules")(function* () {
		const revision = yield* currentModel(retainedRevision);
		if (!revision) return { status: "not_ready" as const };
		const destination = yield* Ref.get(qualityRulePath);
		const owner = yield* Ref.get(modelSelection);
		const path =
			destination?.projectRoot === owner?.projectRoot ? destination?.path : undefined;
		if (!path) {
			return yield* chooseQualityRules();
		}
		return yield* Effect.gen(function* () {
			const bytes = yield* files.readFile(path, { maxBytes: 1_048_576 });
			const document = yield* decodeGameTextRuleDocumentJson(new TextDecoder().decode(bytes));
			if ((yield* currentModel(retainedRevision)) !== revision)
				return { status: "not_ready" as const };
			return yield* previewQualityRules(document);
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed({
					status: "failed" as const,
					error: {
						code:
							"_tag" in error && error._tag === "GameTextRuleDocumentError"
								? ("invalid_rules" as const)
								: ("read_failed" as const),
						message: error.message,
						recovery: error.recovery,
						retrySafe: true
					}
				})
			)
		);
	});

	const saveQualityRules = Effect.fn("GameText.workspace.saveQualityRules")(function* (
		document: GameTextRuleDocument
	) {
		if ((yield* Ref.get(activity)).operation)
			return {
				status: "failed" as const,
				error: {
					code: "write_failed" as const,
					message: "An Unreal step is running.",
					recovery: "Cancel it or wait before saving rules.",
					retrySafe: true
				}
			};
		const destination = yield* Ref.get(qualityRulePath);
		const owner = yield* Ref.get(modelSelection);
		const path =
			destination?.projectRoot === owner?.projectRoot ? destination?.path : undefined;
		if (path === undefined) {
			if ((yield* Ref.get(qualityDocument)) === undefined)
				return { status: "not_ready" as const };
			return {
				status: "failed" as const,
				error: {
					code: "write_failed" as const,
					message: "These rules have no standalone file destination.",
					recovery:
						"Preview changes, then use Save preset to preserve the embedded rules. Load a standalone rule file to update that file instead.",
					retrySafe: true
				}
			};
		}
		const prepared = yield* prepareQualityRules(document);
		if (prepared.status !== "ready") return prepared;
		const snapshot = yield* Ref.get(investigationSnapshot);
		if (
			snapshot?.revision !== prepared.revision ||
			snapshot.source.projectRoot !== destination?.projectRoot
		)
			return { status: "not_ready" as const };
		const bytes = new TextEncoder().encode(
			`${JSON.stringify(prepared.document, null, "\t")}\n`
		);
		const recovery = host.recoveryCopy;
		const write = yield* Effect.gen(function* () {
			if (recovery) {
				const previous = yield* files.readFile(path, { maxBytes: 1_048_576 });
				yield* recovery(path, previous);
			}
			yield* files.writeFile(path, bytes, { maxBytes: 1_048_576 });
		}).pipe(
			Effect.match({
				onFailure: (error) => ({
					error: {
						code: "write_failed" as const,
						message: error.message,
						recovery: error.recovery,
						retrySafe: true
					},
					status: "failed" as const
				}),
				onSuccess: () => ({ status: "ready" as const })
			})
		);
		return write.status === "ready" ? yield* publishQualityRules(prepared) : write;
	});

	// Reads hydrate asynchronously; a model replaced meanwhile (project switch, rescan, new rules)
	// answers not ready rather than publishing the retired model's result.
	const qualityRead = <A>(read: (model: AsyncTextQualityQuery) => Effect.Effect<A, unknown>) =>
		Effect.gen(function* () {
			const model = yield* currentValue(qualityModel);
			if (!model) return undefined;
			const outcome = yield* read(model).pipe(Effect.result);
			if (Result.isFailure(outcome)) {
				yield* Effect.logWarning("Source quality read failed", { cause: outcome.failure });
				return undefined;
			}
			return (yield* currentValue(qualityModel)) === model
				? { value: outcome.success }
				: undefined;
		});
	const qualitySearch = Effect.fn("GameText.workspace.qualitySearch")(function* (
		request: TextQualitySearchRequest
	) {
		const read = yield* qualityRead((model) => model.search(request));
		return read
			? { page: read.value, status: "ready" as const }
			: { status: "not_ready" as const };
	});
	const qualityFocus = Effect.fn("GameText.workspace.qualityFocus")(function* (
		request: TextQualityFocusRequest
	) {
		const read = yield* qualityRead((model) => model.focus(request));
		if (!read) return { status: "not_ready" as const };
		return read.value
			? { focus: read.value, status: "found" as const }
			: { status: "not_found" as const };
	});

	/** The investigation snapshot, while it is still the current scan's. */
	const currentInvestigationSnapshot = Effect.fn("GameText.workspace.investigationSnapshot")(
		function* () {
			const snapshot = yield* Ref.get(investigationSnapshot);
			const current = yield* project.current();
			if (
				!snapshot ||
				(yield* currentModel(retainedRevision)) !== snapshot.revision ||
				current.status !== "ready" ||
				current.project.projectRoot !== snapshot.source.projectRoot ||
				(current.project.generation ?? 0) !== snapshot.source.generation
			)
				return yield* Effect.fail(
					new InvestigationError({
						retrySafe: true,
						nextStep: "fix_input",
						message: "No current scan is available.",
						recovery: "Refresh this workspace before saving or exporting."
					})
				);
			return snapshot;
		}
	);
	/**
	 * The query a corpus export reads, and its request. Problem and translation pills select
	 * lines through the target's join, as the list does, and the export lists Browse's findings:
	 * the same layer the list showed.
	 */
	const investigationCorpus = Effect.fn("GameText.workspace.investigationCorpus")(function* (
		query: GameTextInvestigationQuery
	) {
		const localized =
			query.localization === undefined
				? yield* currentModel(queryModel)
				: yield* localization.targetQuery(query.localization.target);
		const findings = yield* browseFindings(query.localization?.target);
		const request = investigationRequest(query);
		return {
			localized,
			request,
			withFindings:
				findings.status === "ready" ? { ...request, findings: findings.selection } : request
		};
	});
	/** A quality query's investigation document, and the units its source findings name. */
	const captureQualityInvestigation = Effect.fn("GameText.workspace.captureQualityInvestigation")(
		function* (query: GameTextInvestigationQuery) {
			const snapshot = yield* currentInvestigationSnapshot();
			const workspace =
				query.localization && query.workspaceFilter !== undefined
					? yield* localization.qualityExport({
							target: query.localization.target,
							filter: query.workspaceFilter,
							...(query.localization.culture
								? { culture: query.localization.culture }
								: undefined)
						})
					: undefined;
			const index = yield* currentIndex();
			// Source rules come from the index, page by page; the published model when it has them.
			const published = yield* currentValue(qualityModel);
			const publishedRules = yield* currentValue(qualityDocument);
			const document = yield* exportGameTextInvestigation(
				{
					sourceQuality: (rules) =>
						published && rules === publishedRules
							? Effect.succeed(published)
							: index
								? index.sourceQuality(rules)
								: Effect.die(new Error("No current scan is available."))
				},
				investigationPreset(query, snapshot.rules),
				snapshot.source,
				undefined,
				workspace
			);
			// A quality CSV names each finding's key: read only the units findings name.
			const units =
				document.result.mode === "quality" && index
					? yield* readFindingUnits(
							index.query,
							document.result.report.findings.map((finding) => finding.textUnitId)
						).pipe(Effect.mapError(investigationIndexFailure))
					: [];
			return { document, units };
		}
	);
	/** Browse's CSV of a corpus query, written by the engine to the file the user chooses. */
	const corpusInvestigationCsv = Effect.fn("GameText.workspace.corpusInvestigationCsv")(
		function* (query: GameTextInvestigationQuery) {
			yield* currentInvestigationSnapshot();
			const { localized, withFindings } = yield* investigationCorpus(query);
			if (localized === undefined) return yield* Effect.fail(targetNotLoaded(query));
			return yield* saveInvestigation(dialog, {
				extension: "csv",
				write: (path) =>
					localized.writeCorpusCsv(withFindings, { path }).pipe(
						Effect.map((written) => ("rows" in written ? written.rows : 0)),
						Effect.mapError(investigationIndexFailure)
					)
			});
		},
		Effect.catch((error) => Effect.succeed(investigationFailure(error)))
	);
	/**
	 * A corpus query's investigation JSON. The host writes the document around its units, made
	 * as before from the corpus header, and the engine writes the units into the chosen file.
	 */
	const corpusInvestigationJson = Effect.fn("GameText.workspace.corpusInvestigationJson")(
		function* (query: GameTextInvestigationQuery) {
			const snapshot = yield* currentInvestigationSnapshot();
			const { localized, request } = yield* investigationCorpus(query);
			if (localized === undefined) return yield* Effect.fail(targetNotLoaded(query));
			const header = yield* localized
				.readCorpusHeader()
				.pipe(Effect.mapError(investigationIndexFailure));
			const document = yield* exportGameTextInvestigation(
				{
					sourceQuality: () =>
						Effect.die(new Error("A corpus export reads no source rules."))
				},
				investigationPreset(query, snapshot.rules),
				snapshot.source,
				{ export: () => Effect.succeed(corpusWithoutUnits(header)) }
			);
			const envelope = corpusInvestigationEnvelope(document);
			return yield* saveInvestigation(dialog, {
				extension: "json",
				write: (path) =>
					localized.writeCorpusJson(request, { path }, envelope).pipe(
						Effect.map((written) => ("rows" in written ? written.rows : 0)),
						Effect.mapError(investigationIndexFailure)
					)
			});
		},
		Effect.catch((error) => Effect.succeed(investigationFailure(error)))
	);
	const investigationExport = Effect.fn("GameText.workspace.investigationExport")(
		(query: GameTextInvestigationQuery, format: InvestigationFormat) =>
			query.mode === "corpus"
				? format === "csv"
					? corpusInvestigationCsv(query)
					: corpusInvestigationJson(query)
				: captureQualityInvestigation(query).pipe(
						Effect.flatMap(({ document, units }) => {
							const { result } = document;
							if (result.mode === "corpus")
								return Effect.die(new Error("A quality query exported a corpus."));
							return saveInvestigation(dialog, {
								contents:
									format === "json"
										? JSON.stringify(document, null, "\t") + "\n"
										: result.mode === "localization_quality"
											? workspaceQualityCsv(result.report)
											: gameTextQualityCsv(result.report, { units }),
								extension: format,
								// A source quality CSV has a row per finding and place.
								rowCount:
									format === "csv" && result.mode === "quality"
										? result.report.findings.reduce(
												(count, finding) =>
													count + finding.affectedOccurrences.length,
												0
											)
										: result.report.findings.length
							});
						}),
						Effect.catch((error) => Effect.succeed(investigationFailure(error)))
					)
	);
	/** Saves a query and the scan's rules as a preset; checking it reads nothing of the scan. */
	const investigationSave = Effect.fn("GameText.workspace.investigationSave")(
		function* (query: GameTextInvestigationQuery) {
			const snapshot = yield* currentInvestigationSnapshot();
			const preset = investigationPreset(query, snapshot.rules);
			yield* Schema.decodeUnknownEffect(GameTextInvestigationPreset)(preset).pipe(
				Effect.mapError(
					(cause) =>
						new InvestigationError({
							cause,
							retrySafe: true,
							nextStep: "fix_input",
							message: "This query cannot be saved as a preset.",
							recovery:
								"Load quality rules for a source quality query, or choose a localization target for a localization quality filter."
						})
				)
			);
			return yield* saveInvestigation(dialog, {
				contents: JSON.stringify(preset, null, "\t") + "\n",
				extension: "json",
				rowCount: 0,
				projectRoot: snapshot.source.projectRoot
			});
		},
		Effect.catch((error) => Effect.succeed(investigationFailure(error)))
	);
	const investigationOpen = Effect.fn("GameText.workspace.investigationOpen")(() =>
		Effect.gen(function* () {
			const opened = yield* openInvestigation(dialog, GameTextInvestigationPreset);
			if (opened.status !== "opened") return opened;
			if (opened.preset.rules) {
				const applied = yield* previewQualityRules(opened.preset.rules);
				if (applied.status !== "completed")
					return investigationFailure({
						message: "Cannot apply quality rules to this workspace.",
						recovery: "Refresh Game Text and open the preset again."
					});
			} else {
				yield* Ref.set(qualityDocument, undefined);
				yield* Ref.set(qualityModel, undefined);
				yield* Ref.update(investigationSnapshot, (snapshot) =>
					snapshot ? { source: snapshot.source, revision: snapshot.revision } : undefined
				);
			}
			yield* Ref.set(qualityRulePath, undefined);
			return opened;
		}).pipe(Effect.catch((error) => Effect.succeed(investigationFailure(error))))
	);

	// A scan owns both host refresh and text preparation. Admission and the generation handoff
	// share a lock: reconnects observe the refreshed generation and join its existing producer.
	// The key changes during refresh, so a fixed-key Cache cannot represent this handoff.
	const scanKey = (state: GameTextWorkspaceProjectState) =>
		state.status === "ready"
			? JSON.stringify([state.project.projectRoot, state.project.generation ?? 0])
			: state.status;
	const sharedScans = <A>() =>
		Effect.gen(function* () {
			const running = yield* Ref.make<
				{ readonly key: string; readonly done: Deferred.Deferred<A> } | undefined
			>(undefined);
			const start = yield* Semaphore.make(1);
			return (scan: (refreshProject: typeof project.refresh) => Effect.Effect<A>) =>
				Effect.gen(function* () {
					const done = yield* start.withPermit(
						Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								// Host reads can suspend before a producer exists; cancellation must release admission.
								const key = scanKey(yield* restore(project.current()));
								const current = yield* Ref.get(running);
								if (current?.key === key) return current.done;
								const next = yield* Deferred.make<A>();
								yield* Ref.set(running, { key, done: next });
								const refreshProject = () =>
									Effect.gen(function* () {
										const state = yield* project.refresh();
										yield* Ref.update(running, (value) =>
											value?.done === next
												? { key: scanKey(state), done: next }
												: value
										);
										return state;
									}).pipe(start.withPermit);
								yield* scan(refreshProject).pipe(
									Effect.exit,
									Effect.flatMap((exit) =>
										Ref.update(running, (value) =>
											value?.done === next ? undefined : value
										).pipe(Effect.andThen(Deferred.done(next, exit)))
									),
									Effect.forkIn(workspaceScope)
								);
								return next;
							})
						)
					);
					return yield* Deferred.await(done);
				});
		});
	const refreshScan = (refreshProject: typeof project.refresh) =>
		Effect.scoped(
			guardScan(configuredRefresh(true, refreshProject), () =>
				unavailableQueryProject(
					"An Unreal localization step is running.",
					"Cancel it or wait before scanning."
				)
			)
		);
	const fullScan = (refreshProject: typeof project.refresh) =>
		guardScan(configuredScan(refreshProject), () =>
			unavailableProject(
				"An Unreal localization step is running.",
				"Cancel it or wait before scanning."
			)
		);
	const sharedRefresh = yield* sharedScans<Effect.Success<ReturnType<typeof refreshScan>>>();
	const sharedScan = yield* sharedScans<Effect.Success<ReturnType<typeof fullScan>>>();

	return {
		operationStateTarget: (name) =>
			Effect.gen(function* () {
				const current = yield* project.current();
				const owner = yield* Ref.get(modelSelection);
				if (
					current.status !== "ready" ||
					current.project.projectRoot !== owner?.projectRoot ||
					(current.project.generation ?? 0) !== owner.generation
				)
					return undefined;
				return yield* localization.operationStateTarget(name, owner.indexed.revision);
			}),
		operationTarget: scoped((name) =>
			consistentIndex().pipe(
				Effect.flatMap((index) =>
					index ? localization.operationTarget(name) : Effect.succeed(undefined)
				)
			)
		),
		operationBusyReason,
		beginOperation: () =>
			Ref.modify(activity, (value) =>
				value.operation || value.scans > 0
					? [false, value]
					: [true, { ...value, operation: true }]
			).pipe(Effect.tap(() => activityChanged)),
		endOperation: () =>
			Ref.update(activity, (value) => ({ ...value, operation: false })).pipe(
				Effect.andThen(activityChanged)
			),
		refreshAfterOperation: (target, gather) =>
			Effect.scoped(
				Effect.gen(function* () {
					if (gather && (yield* configuredRefresh(true)).status !== "completed")
						return false;
					if (!gather) yield* localization.reset();
					return (yield* localization.select(target, true)).status === "ready";
				})
			),
		localizationBeforeGather: scoped(localization.beforeGather),
		localizationQualitySearch: scoped(localization.qualitySearch),
		localizationQualityFocus: scoped(localization.qualityFocus),
		localizationChanges: scoped(localization.changes),
		localizationEdits: scoped(localization.edits),
		localizationReview: scoped((request) => localization.review(request, reviewer())),
		localizationReport: scoped(localization.report),
		localizationReportFile: scoped((request) =>
			localization.reportFile(request, dialog, files)
		),
		localizationLinesFile: scoped((input) =>
			projectRelativeRequest(input).pipe(
				Effect.flatMap((request) => localization.linesFile(request, dialog))
			)
		),
		localizationTargets: scoped(localization.targets),
		localizationTarget: scoped(localization.select),
		localizationFocus: scoped((request: LocalizationFocusRequest) =>
			localization
				.browseFindings(request.target)
				.pipe(
					Effect.flatMap((findings) =>
						localization.focus(withBrowseFindings(request, findings))
					)
				)
		),
		related: scoped(related),
		investigationExport: scoped(investigationExport),
		investigationSave: scoped(investigationSave),
		investigationOpen: scoped(investigationOpen),
		configuredRefresh: (refresh = true) =>
			refresh ? sharedRefresh(refreshScan) : Effect.scoped(configuredRefresh(false)),
		configuredScan: () => sharedScan(fullScan),
		focus: scoped(focus),
		progress: scoped(progress),
		progressChanges: () =>
			Stream.unwrap(
				Effect.gen(function* () {
					// Subscribed before the first read, so no change between them is missed.
					const changes = yield* PubSub.subscribe(progressChanged);
					return Stream.concat(
						Stream.make(undefined),
						Stream.fromSubscription(changes)
					).pipe(
						Stream.mapEffect(() => progress()),
						Stream.changesWith(
							(left, right) =>
								left.phase === right.phase &&
								left.stage === right.stage &&
								left.completed === right.completed &&
								left.total === right.total &&
								left.detail === right.detail &&
								left.step === right.step
						)
					);
				})
			),
		search: scoped(search),
		searchRows: scoped(searchRows),
		chooseQualityRules: scoped(chooseQualityRules),
		reloadQualityRules: scoped(reloadQualityRules),
		createStarterRules: scoped(createStarterRules),
		qualityFocus: scoped(qualityFocus),
		qualitySearch: scoped(qualitySearch),
		previewQualityRules: scoped(previewQualityRules),
		saveQualityRules: scoped(saveQualityRules)
	} satisfies GameTextWorkspaceApi;
});
