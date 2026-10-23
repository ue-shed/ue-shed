import { indexPublicFailure } from "./index-public-error.js";
import type { IndexFailure } from "./index-contract.js";
import { Schema } from "effect";
import {
	localizationQualityWorkspaceOf,
	indexedLocalizationProgressReport,
	indexedLocalizationBaseline,
	localizationReportPage,
	localizationReportCsv,
	decodeLocalizationBaselineJson,
	LocalizationReportError,
	type LocalizationBaseline,
	type WorkspaceQualityRequest,
	type WorkspaceQualityFocusRequest,
	type WorkspaceQualityResult,
	type WorkspaceQualityFocusResult,
	type WorkspaceChangesResult,
	type WorkspaceReportRequest,
	type WorkspaceReportResult,
	type WorkspaceReportFileRequest,
	type WorkspaceReportFileResult,
	localizationLinesCsv,
	LOCALIZATION_LINES_CSV_FIELDS,
	pickedLocalizationCultures,
	type LocalizationLinesFileResult,
	localizationKeyChangesAcross,
	KEY_CHANGE_FIELDS,
	type LocalizationKeyChangePair,
	localizationEditChangeSet,
	type LocalizationReviewRequest,
	type LocalizationReviewResult,
	localizationEditOutcomes,
	localizationEvidenceFileStatuses,
	localizationTargetFiles,
	type LocalizationEditRequest,
	type LocalizationEditResult,
	type LocalizationFocusRequest,
	type LocalizationFocusResult,
	type LocalizationTargetResult,
	type LocalizationTargetsResult
} from "./entry-corpus.js";
import {
	makeRetainedGameTextIndexWith,
	GameTextIndexSteps,
	type GameTextProjectIndex,
	GameTextIndexError,
	type GameTextIndexRefreshResult,
	type RetainedGameTextIndexResult
} from "./entry-index.js";
import { type GameTextRuleDocument } from "./entry-rules.js";
import {
	MAX_LOCALIZATION_CULTURES,
	type LocalizationJoin,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "./entry-schema.js";
import {
	applyLocalizationChangeSet,
	LocalizationEvidence,
	LocalizationFileAccessLive,
	localizationEvidenceFingerprint,
	updateLocalizationReview,
	type LocalizationReviewSnapshot,
	type LocalizationReviewUpdate,
	reviewLocalizationChangeSet,
	type LocalizationTargetEvidence,
	type LocalizationTarget
} from "@ue-shed/localization";
import { Cause, Effect, Exit, Fiber, Ref, Result, Semaphore, type Scope } from "effect";
import type { Layer } from "effect";
import type { LocalizationFileAccess } from "@ue-shed/localization";
import type { GameTextWorkspaceFileHooks } from "./workspace-host.js";
import type { LocalizationLineView } from "./index-reads.js";

/** Every line of a target's join: the lines reports and key pairing read. */
const indexedLines = (target: LocalizationJoin["target"]) => ({
	query: "",
	capability: "all" as const,
	localization: { target }
});
/** The selection's index reads a report needs. */
const reportIndex = (retained: {
	readonly model: GameTextIndexRefreshResult["query"];
	readonly join: GameTextIndexRefreshResult["localization"];
	readonly evidence: GameTextIndexRefreshResult["evidence"];
}) => ({ query: retained.model, localization: retained.join, evidence: retained.evidence });

function failure(code: string) {
	return {
		status: "failed" as const,
		code,
		message: "Localization files could not be loaded.",
		recovery: "Check the project's localization settings and files, then rescan."
	};
}

/** The published model's revision: readers of a replaced model cannot publish results. */
export const makeGameTextWorkspaceLocalization = Effect.fn("GameText.workspace.localization")(
	function* (
		currentRevision: () => Effect.Effect<string | undefined, never, Scope.Scope>,
		currentProject: () => Effect.Effect<GameTextProjectIndex | undefined, never, Scope.Scope>,
		currentRules?: () => Effect.Effect<GameTextRuleDocument | undefined, never, Scope.Scope>,
		currentIndex?: () => Effect.Effect<
			RetainedGameTextIndexResult | undefined,
			never,
			Scope.Scope
		>,
		options: {
			/** The author change sets carry. */
			readonly author: string;
			/** Writes PO edits and review files. */
			readonly localizationFiles: Layer.Layer<LocalizationFileAccess>;
		} = { author: "game-text", localizationFiles: LocalizationFileAccessLive }
	) {
		const reader = yield* LocalizationEvidence;
		const index = yield* GameTextIndexSteps;
		const currentRoot = () =>
			currentProject().pipe(Effect.map((project) => project?.projectRoot));
		const refreshIndex = yield* makeRetainedGameTextIndexWith(
			Effect.fn("GameText.workspace.prepareTarget")(function* (request) {
				const project = yield* currentProject().pipe(Effect.scoped);
				if (!project)
					return yield* Effect.fail(
						new GameTextIndexError({
							nextStep: "escalate",
							retrySafe: false,
							code: "index_failed",
							operation: "project",
							message: "The project index is no longer selected.",
							recovery: "Scan the selected project again."
						})
					);
				const imported = yield* index.importTarget(project, request);
				const target = yield* index.buildTarget(project, imported, request);
				const prepared = yield* (currentIndex?.() ?? Effect.succeed(undefined)).pipe(
					Effect.scoped
				);
				if (
					prepared?.queryRevision !== undefined &&
					prepared.queryRevision === target.queryRevision
				) {
					// Borrowing the host model pins its reader and worker in this target's scope.
					// Validation above still observes changed files, reviews and carried key changes.
					yield* prepared.borrow;
					return prepared;
				}
				return yield* index.openTarget(target);
			})
		);
		const rules = currentRules ?? (() => Effect.succeed(undefined));
		const baseline = yield* Ref.make<LocalizationBaseline | undefined>(undefined);
		const qualityCache = yield* Ref.make<
			| {
					join: GameTextIndexRefreshResult["localization"];
					document: GameTextRuleDocument | undefined;
					scan: Fiber.Fiber<
						ReturnType<typeof localizationQualityWorkspaceOf>,
						IndexFailure
					>;
			  }
			| undefined
		>(undefined);
		// Quality scans run in the service's scope, so a request that leaves does not stop them.
		const serviceScope = yield* Effect.scope;
		const qualityLock = yield* Semaphore.make(1);
		const clearQuality = Effect.fn("GameText.workspace.localization.clearQuality")(
			function* () {
				const previous = yield* Ref.getAndSet(qualityCache, undefined);
				if (previous)
					yield* Fiber.interrupt(previous.scan).pipe(Effect.forkIn(serviceScope));
			}
		);
		const discovery = yield* Ref.make<
			| {
					readonly revision: string;
					readonly targets: readonly LocalizationTarget[];
					readonly result: LocalizationTargetsResult;
			  }
			| undefined
		>(undefined);
		const selected = yield* Ref.make<
			| {
					readonly projectRoot: string;
					readonly revision: string;
					readonly join: GameTextIndexRefreshResult["localization"];
					readonly quality: GameTextIndexRefreshResult["localizationQuality"];
					readonly sourceQuality: GameTextIndexRefreshResult["sourceQuality"];
					readonly evidence: LocalizationTargetEvidence;
					readonly review: LocalizationReviewSnapshot | undefined;
					readonly model: GameTextIndexRefreshResult["query"];
					readonly search: GameTextIndexRefreshResult["search"];
					readonly borrow: RetainedGameTextIndexResult["borrow"];
					readonly result: LocalizationTargetResult;
			  }
			| undefined
		>(undefined);
		/** Counts selections and resets; a stale attempt does not publish. */
		const version = yield* Ref.make(0);
		// Unreal's gather drops the archive translations of keys that left the manifest. The join from
		// before a gather UE Shed runs is kept until the next selection pairs those keys with the keys
		// that joined. The pairs live for the project, beyond the refresh that follows the gather.
		const gatherBaseline = yield* Ref.make<
			| {
					readonly root: string;
					readonly target: LocalizationJoin["target"];
					readonly nativeCulture: LocalizationJoin["nativeCulture"];
					readonly lines: readonly LocalizationLineView<
						(typeof KEY_CHANGE_FIELDS)[number]
					>[];
			  }
			| undefined
		>(undefined);
		const acrossGather = yield* Ref.make<
			| {
					readonly root: string;
					readonly target: LocalizationJoin["target"];
					readonly pairs: readonly LocalizationKeyChangePair[];
			  }
			| undefined
		>(undefined);
		const preparation = Effect.fn("GameText.workspace.localization.preparation")(function* (
			projectRoot: string
		) {
			const discovered = yield* reader.discover({ projectRoot }).pipe(Effect.result);
			if (
				Result.isFailure(discovered) ||
				discovered.success.targets.length > 50 ||
				discovered.success.targets.some(
					(target) => target.cultures.length > MAX_LOCALIZATION_CULTURES
				)
			)
				return undefined;
			const previous = yield* Ref.get(selected);
			const target =
				(previous?.projectRoot === projectRoot &&
					discovered.success.targets.find(
						(target) => target.name === previous?.join.target
					)) ||
				discovered.success.targets[0];
			if (!target) return undefined;
			const carried = yield* Ref.get(acrossGather);
			return {
				targetName: target.name,
				tolerateReviewErrors: true,
				keyChangePairs:
					carried?.root === projectRoot && carried.target === target.name
						? carried.pairs
						: []
			};
		});
		const beforeGather = Effect.fn("GameText.workspace.localization.before_gather")(function* (
			name: LocalizationJoin["target"]
		) {
			const root = yield* currentRoot();
			const cached = yield* current(name);
			// The keys and translations Unreal's gather may drop, read before it runs.
			yield* Ref.set(
				gatherBaseline,
				root && cached?.join.target === name
					? {
							root,
							target: name,
							nativeCulture: cached.join.nativeCulture,
							lines: yield* cached.model.selectLocalizationLines(
								indexedLines(name),
								KEY_CHANGE_FIELDS
							)
						}
					: undefined
			);
		});

		const reset = Effect.fn("GameText.workspace.localization.reset")(function* (
			preservePrepared = false
		) {
			yield* Ref.update(version, (value) => value + 1);
			yield* Ref.set(discovery, undefined);
			yield* Ref.set(selected, undefined);
			yield* clearQuality();
			yield* Ref.set(baseline, undefined);
			// On an unchanged package revision, retain the old target's pin until its replacement
			// acquires the same immutable worker. It is unavailable through `selected` meanwhile.
			if (!preservePrepared) yield* refreshIndex.release();
		});
		const targets = Effect.fn("GameText.workspace.localization.targets")(function* () {
			const revision = yield* currentRevision();
			const root = yield* currentRoot();
			if (!revision || !root) return { status: "not_ready" as const };
			const cached = yield* Ref.get(discovery);
			if (cached?.revision === revision) return cached.result;
			const attempt = yield* Ref.get(version);
			const discovered = yield* reader.discover({ projectRoot: root }).pipe(Effect.result);
			if ((yield* currentRevision()) !== revision || (yield* Ref.get(version)) !== attempt)
				return { status: "not_ready" as const };
			if (Result.isFailure(discovered)) {
				yield* refreshIndex.release();
				return failure(discovered.failure.code);
			}
			const available = discovered.success.targets;
			if (available.length === 0) yield* refreshIndex.release();
			if (
				available.length > 50 ||
				available.some((target) => target.cultures.length > MAX_LOCALIZATION_CULTURES)
			) {
				yield* refreshIndex.release();
				return failure("bounds_exceeded");
			}
			if (!available.length && discovered.success.diagnostics.length)
				return failure("discovery_incomplete");
			const result: LocalizationTargetsResult = {
				status: "ready",
				targets: available.map(({ name, nativeCulture, cultures }) => ({
					name,
					nativeCulture,
					cultures
				}))
			};
			yield* Ref.set(discovery, { revision, targets: available, result });
			yield* Effect.annotateCurrentSpan({ targetCount: available.length });
			return result;
		});
		const select = Effect.fn("GameText.workspace.localization.select")(function* (
			name: LocalizationJoin["target"],
			refresh = false
		) {
			const revision = yield* currentRevision();
			const root = yield* currentRoot();
			if (!revision || !root) return { status: "not_ready" as const };
			const cached = yield* Ref.get(selected);
			if (!refresh && cached?.revision === revision && cached.join.target === name)
				return cached.result;
			const listed = yield* targets();
			if (listed.status !== "ready") return listed;
			const target = (yield* Ref.get(discovery))?.targets.find((item) => item.name === name);
			if (!target) return failure("target_not_found");
			const attempt = yield* Ref.updateAndGet(version, (value) => value + 1);
			const carried = yield* Ref.get(acrossGather);
			const published =
				!refresh && !(yield* Ref.get(gatherBaseline))
					? yield* currentIndex?.() ?? Effect.succeed(undefined)
					: undefined;
			let indexed =
				published?.localization.target === name
					? Result.succeed(published)
					: yield* refreshIndex
							.refresh({
								projectRoot: root,
								targetName: name,
								tolerateReviewErrors: true,
								keyChangePairs:
									carried?.root === root && carried.target === name
										? carried.pairs
										: []
							})
							.pipe(Effect.result);
			if ((yield* currentRevision()) !== revision || (yield* Ref.get(version)) !== attempt)
				return { status: "not_ready" as const };
			if (Result.isFailure(indexed))
				return failure(
					"operation" in indexed.failure ? indexed.failure.operation : "invalid_project"
				);
			const before = yield* Ref.get(gatherBaseline);
			if (before?.root === root && before.target === name) {
				const loaded = yield* indexed.success.query
					.selectLocalizationLines(indexedLines(name), ["identity", "source", "manifest"])
					.pipe(Effect.result);
				if (Result.isFailure(loaded))
					return {
						status: "failed" as const,
						code: "index_failed",
						message: loaded.failure.message,
						recovery: loaded.failure.recovery
					};
				const across = localizationKeyChangesAcross(before, { lines: loaded.success });
				yield* Ref.set(gatherBaseline, undefined);
				yield* Ref.set(acrossGather, { root, target: name, pairs: across.pairs });
				indexed = yield* refreshIndex
					.refresh({
						projectRoot: root,
						targetName: name,
						tolerateReviewErrors: true,
						keyChangePairs: across.pairs
					})
					.pipe(Effect.result);
				if (Result.isFailure(indexed))
					return failure(
						"operation" in indexed.failure
							? indexed.failure.operation
							: "invalid_project"
					);
			}
			const join = indexed.success.localization,
				model = indexed.success.query,
				review = indexed.success.review;
			const evidence = indexed.success.evidence;
			const textCountsResult = yield* indexed.success
				.search({
					query: "",
					capability: "all",
					lens: "all",
					withoutNotes: false,
					pageSize: 1,
					localization: { target: name }
				})
				.pipe(Effect.result);
			if (Result.isFailure(textCountsResult))
				return {
					status: "failed" as const,
					code: "index_failed",
					message: textCountsResult.failure.message,
					recovery: textCountsResult.failure.recovery
				};
			const textCounts = textCountsResult.success;
			if ((yield* currentRevision()) !== revision || (yield* Ref.get(version)) !== attempt)
				return { status: "not_ready" as const };
			const result: LocalizationTargetResult = {
				status: "ready",
				target: {
					name: target.name,
					nativeCulture: target.nativeCulture,
					cultures: target.cultures
				},
				lines: textCounts.total,
				notSynced: textCounts.localization?.notSynced ?? 0,
				...localizationTargetFiles(localizationEvidenceFileStatuses(evidence))
			};
			return yield* Effect.uninterruptible(
				Effect.gen(function* () {
					if (
						(yield* currentRevision()) !== revision ||
						(yield* Ref.get(version)) !== attempt
					)
						return { status: "not_ready" as const };
					if (cached?.join.target !== name) yield* Ref.set(baseline, undefined);
					yield* Ref.set(selected, {
						projectRoot: root,
						revision,
						join,
						quality: indexed.success.localizationQuality,
						sourceQuality: indexed.success.sourceQuality,
						model,
						search: indexed.success.search,
						borrow: indexed.success.borrow,
						result,
						evidence,
						review
					});
					// A scan nobody waits for would otherwise keep checking, and pinning, the previous
					// selection until another quality request happened to replace it.
					yield* qualityLock.withPermits(1)(clearQuality());
					yield* indexed.success.retain;
					if (indexed.success === published)
						yield* refreshIndex.release({ background: true });
					yield* Effect.annotateCurrentSpan({
						lineCount: textCounts.total,
						notSyncedCount: result.notSynced
					});
					return result;
				})
			);
		});
		const current = Effect.fn("GameText.workspace.localization.current")(function* (
			target: LocalizationJoin["target"]
		) {
			const cached = yield* Ref.get(selected);
			if (
				!cached ||
				cached.revision !== (yield* currentRevision()) ||
				cached.join.target !== target
			)
				return undefined;
			yield* cached.borrow;
			return cached;
		});
		const search = Effect.fn("GameText.workspace.localization.search")(function* (
			request: TextCorpusSearchRequest
		): Effect.fn.Return<TextCorpusSearchResult, never, Scope.Scope> {
			if (!request.localization) return { status: "not_ready" };
			const cached = yield* current(request.localization.target);
			if (
				!cached ||
				(request.localization.culture &&
					!cached.join.cultures.includes(request.localization.culture))
			)
				return { status: "not_ready" };
			const outcome = yield* cached.search(request).pipe(Effect.result);
			if (Result.isFailure(outcome))
				return { status: "failed", error: indexPublicFailure(outcome.failure) };
			const page = outcome.success;
			if ((yield* current(request.localization.target)) !== cached)
				return { status: "not_ready" };
			return { status: "ready", page };
		});
		const focus = Effect.fn("GameText.workspace.localization.focus")(function* (
			request: LocalizationFocusRequest
		): Effect.fn.Return<LocalizationFocusResult, never, Scope.Scope> {
			const cached = yield* current(request.target);
			if (!cached) return { status: "not_ready" };
			const outcome = yield* cached.model.localizationDetail(request).pipe(Effect.result);
			if (Result.isFailure(outcome))
				return {
					status: "failed",
					code: "index_failed",
					message: outcome.failure.message,
					recovery: outcome.failure.recovery
				};
			if ((yield* current(request.target)) !== cached) return { status: "not_ready" };
			return outcome.success
				? { status: "found", focus: outcome.success }
				: { status: "not_found" };
		});

		const quality = Effect.fn("GameText.workspace.localization.quality")(function* (
			request: WorkspaceQualityRequest
		) {
			const retained = yield* current(request.target);
			if (!retained || (request.culture && !retained.join.cultures.includes(request.culture)))
				return undefined;
			const document = yield* rules();
			// One scan per selection and rules document, shared by every request that needs it.
			const scan = yield* qualityLock.withPermits(1)(
				Effect.gen(function* () {
					// A selection published since this request began has already cleared the cache.
					if ((yield* Ref.get(selected)) !== retained) return undefined;
					const cached = yield* Ref.get(qualityCache);
					if (cached?.join === retained.join && cached.document === document)
						return cached.scan;
					yield* clearQuality();
					const options = retained.review ? { review: retained.review.file } : {};
					const scan = yield* Effect.scoped(
						Effect.gen(function* () {
							// The scan pins the index itself while it reads.
							yield* retained.borrow;
							// Indexed source rules read only the units their findings name.
							const source = !document
								? undefined
								: yield* (yield* retained.sourceQuality(document)).export("all");
							// Indexed targets check page by page, yielding between pages.
							return localizationQualityWorkspaceOf(
								source,
								yield* retained.quality(document, options)
							);
						})
					).pipe(Effect.forkIn(serviceScope));
					yield* Ref.set(qualityCache, { join: retained.join, document, scan });
					return scan;
				})
			);
			if (!scan) return undefined;
			const exit = yield* Fiber.await(scan);
			// A newer selection, rescan or rules change interrupted it; the caller asks again.
			if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return undefined;
			return yield* exit;
		});
		const qualitySearch = Effect.fn("GameText.workspace.localization.qualitySearch")(function* (
			request: WorkspaceQualityRequest
		): Effect.fn.Return<WorkspaceQualityResult, never, Scope.Scope> {
			const checked = yield* quality(request).pipe(Effect.result);
			if (Result.isFailure(checked))
				return {
					status: "failed",
					message: checked.failure.message,
					recovery: checked.failure.recovery
				};
			const model = checked.success;
			if (!model) return { status: "not_ready" };
			const result = yield* model.search(request).pipe(Effect.result);
			if (Result.isFailure(result))
				return {
					status: "failed",
					message: result.failure.message,
					recovery: result.failure.recovery
				};
			const page = result.success;
			yield* Effect.annotateCurrentSpan({
				findingCount: page.total,
				pageCount: page.findings.length
			});
			return { status: "ready", page };
		});
		const qualityFocus = Effect.fn("GameText.workspace.localization.qualityFocus")(function* (
			request: WorkspaceQualityFocusRequest
		): Effect.fn.Return<WorkspaceQualityFocusResult, never, Scope.Scope> {
			const checked = yield* quality({ ...request, filter: "all" }).pipe(Effect.result);
			if (Result.isFailure(checked))
				return {
					status: "failed",
					message: checked.failure.message,
					recovery: checked.failure.recovery
				};
			const model = checked.success;
			if (!model) return { status: "not_ready" };
			return yield* model.focus(request).pipe(
				Effect.catch((cause) =>
					Effect.succeed({
						status: "failed" as const,
						message: cause.message,
						recovery: cause.recovery
					})
				)
			);
		});
		const changes = Effect.fn("GameText.workspace.localization.changes")(function* (
			request: WorkspaceQualityRequest
		): Effect.fn.Return<WorkspaceChangesResult, never, Scope.Scope> {
			const checked = yield* quality(request).pipe(Effect.result);
			if (Result.isFailure(checked))
				return {
					status: "failed",
					message: checked.failure.message,
					recovery: checked.failure.recovery
				};
			const model = checked.success;
			if (!model) return { status: "not_ready" };
			const checkedChanges = yield* model.changes(request).pipe(Effect.result);
			if (Result.isFailure(checkedChanges))
				return {
					status: "failed",
					message: checkedChanges.failure.message,
					recovery: checkedChanges.failure.recovery
				};
			const result = checkedChanges.success;
			if (result.status === "ready")
				yield* Effect.annotateCurrentSpan({
					changeCount: result.document.changes.length,
					remainingCount: result.remaining
				});
			return result;
		});
		const reportFailure = (error: { readonly message: string; readonly recovery: string }) => ({
			status: "failed" as const,
			message: error.message,
			recovery: error.recovery
		});
		const report = Effect.fn("GameText.workspace.localization.report")(function* (
			request: WorkspaceReportRequest
		): Effect.fn.Return<WorkspaceReportResult, never, Scope.Scope> {
			const retained = yield* current(request.target);
			if (!retained) return { status: "not_ready" };
			const previous = yield* Ref.get(baseline);
			// Grouped counts and the corpus header, in Rust; the corpus and join are not read.
			return yield* indexedLocalizationProgressReport(reportIndex(retained), previous).pipe(
				Effect.flatMap((progress) =>
					Effect.try({
						try: () => ({
							status: "ready" as const,
							page: localizationReportPage(
								progress,
								retained.join.nativeCulture,
								request,
								previous
							)
						}),
						catch: (cause) =>
							Schema.is(LocalizationReportError)(cause)
								? cause
								: new LocalizationReportError({
										cause: cause,
										retrySafe: false,
										nextStep: "fix_input",
										code: "invalid_report_context",
										message: "Report evidence could not be read.",
										recovery: "Rescan the selected project."
									})
					})
				),
				Effect.catch((error) => Effect.succeed(reportFailure(error)))
			);
		});
		const reportFile = Effect.fn("GameText.workspace.localization.reportFile")(function* (
			request: WorkspaceReportFileRequest,
			dialog: Pick<GameTextWorkspaceFileHooks, "chooseFile" | "chooseSaveFile">,
			files: Pick<GameTextWorkspaceFileHooks, "readFile" | "writeFile">
		): Effect.fn.Return<WorkspaceReportFileResult, never, Scope.Scope> {
			const retained = yield* current(request.target);
			if (!retained) return { status: "not_ready" };
			const previous = yield* Ref.get(baseline);
			const index = reportIndex(retained);
			const result = yield* Effect.gen(function* () {
				const choice =
					request.operation === "compare_baseline"
						? yield* dialog.chooseFile({
								title: "Compare localization baseline",
								filters: [{ name: "Localization baseline", extensions: ["json"] }]
							})
						: yield* dialog.chooseSaveFile({
								title:
									request.operation === "save_baseline"
										? "Save localization baseline"
										: "Export localization report",
								defaultPath:
									request.operation === "save_baseline"
										? "localization.baseline.json"
										: "localization.report.csv",
								filters: [
									{
										name: "Localization report",
										extensions: [
											request.operation === "save_baseline" ? "json" : "csv"
										]
									}
								]
							});
				if (choice.status === "cancelled") return choice;
				if ((yield* current(request.target)) !== retained)
					return { status: "not_ready" as const };
				if (request.operation === "compare_baseline") {
					const bytes = yield* files.readFile(choice.path, {
						maxBytes: 16 * 1024 * 1024
					});
					const decoded = decodeLocalizationBaselineJson(new TextDecoder().decode(bytes));
					if (Result.isFailure(decoded)) return reportFailure(decoded.failure);
					const progress = yield* indexedLocalizationProgressReport(
						index,
						decoded.success
					);
					if ((yield* current(request.target)) !== retained)
						return { status: "not_ready" as const };
					yield* Ref.set(baseline, decoded.success);
					return {
						status: "compared" as const,
						page: localizationReportPage(
							progress,
							retained.join.nativeCulture,
							request,
							decoded.success
						)
					};
				}
				const saved =
					request.operation === "save_baseline"
						? yield* indexedLocalizationBaseline(index, new Date().toISOString())
						: undefined;
				const progress =
					saved === undefined
						? yield* indexedLocalizationProgressReport(index, previous)
						: undefined;
				const contents = yield* Effect.try({
					try: () => {
						if (saved !== undefined) return JSON.stringify(saved, null, 2) + "\n";
						const rows = progress!.cultures.flatMap((_, offset) =>
							offset % 50 === 0
								? localizationReportPage(
										progress!,
										retained.join.nativeCulture,
										{ target: request.target, offset },
										previous
									).rows
								: []
						);
						return localizationReportCsv(rows, previous !== undefined);
					},
					catch: (cause) =>
						Schema.is(LocalizationReportError)(cause)
							? cause
							: new LocalizationReportError({
									cause: cause,
									retrySafe: false,
									nextStep: "fix_input",
									code: "invalid_report_context",
									message: "The report could not be prepared.",
									recovery: "Rescan and try again."
								})
				});
				if ((yield* current(request.target)) !== retained)
					return { status: "not_ready" as const };
				yield* files.writeFile(choice.path, new TextEncoder().encode(contents), {
					maxBytes: 16 * 1024 * 1024,
					exclusive: request.operation === "save_baseline"
				});
				return {
					status: "saved" as const,
					message:
						request.operation === "save_baseline"
							? "Baseline saved."
							: "Report CSV exported."
				};
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({
						status: "failed" as const,
						message: Schema.is(LocalizationReportError)(error)
							? error.message
							: "The file operation failed.",
						recovery: Schema.is(LocalizationReportError)(error)
							? error.recovery
							: "Choose a new destination for a baseline; existing files are never overwritten. Check permissions and try again."
					})
				)
			);
			return result;
		});
		/** Writes every line the request matches, a column per culture, to a CSV the person chose. */
		const linesFile = Effect.fn("GameText.workspace.localization.linesFile")(function* (
			request: TextCorpusSearchRequest,
			dialog: Pick<GameTextWorkspaceFileHooks, "chooseFile" | "chooseSaveFile">,
			files: Pick<GameTextWorkspaceFileHooks, "readFile" | "writeFile">
		): Effect.fn.Return<LocalizationLinesFileResult, never, Scope.Scope> {
			const name = request.localization?.target;
			if (name === undefined) return { status: "not_ready" };
			const retained = yield* current(name);
			if (!retained) return { status: "not_ready" };
			return yield* Effect.gen(function* () {
				const choice = yield* dialog.chooseSaveFile({
					title: "Export all languages",
					defaultPath: `${name}.all-languages.csv`,
					filters: [{ name: "CSV", extensions: ["csv"] }]
				});
				if (choice.status === "cancelled") return choice;
				if ((yield* current(name)) !== retained) return { status: "not_ready" as const };
				// Only the fields the spreadsheet shows, on the bulk lane; the corpus is not read.
				const lines = yield* retained.model.selectLocalizationLines(
					request,
					LOCALIZATION_LINES_CSV_FIELDS
				);
				const { csv, rows } = yield* Effect.try(() =>
					localizationLinesCsv({
						join: retained.join,
						lines,
						cultures: pickedLocalizationCultures(request.localization)
					})
				);
				yield* files.writeFile(choice.path, new TextEncoder().encode(csv), {
					maxBytes: 64 * 1024 * 1024
				});
				yield* Effect.annotateCurrentSpan({ rowCount: rows });
				return { status: "saved" as const, path: choice.path, rowCount: rows };
			}).pipe(
				Effect.catch(() =>
					Effect.succeed({
						status: "failed" as const,
						message: "The all-languages CSV could not be written.",
						recovery: "Choose a writable destination and try again."
					})
				)
			);
		});
		/**
		 * Reviews or writes staged translation edits against the retained evidence. Writing replaces
		 * only PO `msgstr` values; the target is then reloaded so pending edits show as not synced.
		 */
		const edits = Effect.fn("GameText.workspace.localization.edits")(function* (
			request: LocalizationEditRequest
		): Effect.fn.Return<LocalizationEditResult, never, Scope.Scope> {
			const retained = yield* current(request.target);
			const root = yield* currentRoot();
			if (!retained || !root) return { status: "not_ready" as const };
			const changeSet = localizationEditChangeSet(
				retained.evidence,
				request.edits,
				options.author
			);
			if (request.mode === "review") {
				const review = reviewLocalizationChangeSet(retained.evidence, changeSet);
				return {
					status: "reviewed" as const,
					edits: localizationEditOutcomes(review),
					files: review.files.map(({ culture, relativePath, changes }) => ({
						culture,
						relativePath,
						changes,
						written: false
					})),
					notSynced: retained.result.status === "ready" ? retained.result.notSynced : 0
				};
			}
			const receipt = yield* applyLocalizationChangeSet({
				projectRoot: root,
				changeSet
			}).pipe(
				Effect.provideService(LocalizationEvidence, reader),
				Effect.provide(options.localizationFiles),
				Effect.result
			);
			if (Result.isFailure(receipt))
				return {
					status: "failed" as const,
					code: receipt.failure.code,
					message: receipt.failure.message,
					recovery: receipt.failure.recovery
				};
			yield* index
				.invalidate({
					projectRoot: root,
					targetName: request.target,
					changedFiles: receipt.success.files
						.filter((file) => file.error === null)
						.map((file) => file.relativePath)
				})
				.pipe(
					Effect.catch((cause) =>
						Effect.logWarning(
							"Game Text write succeeded but cache invalidation failed",
							{
								message: cause.message,
								recovery: cause.recovery
							}
						)
					)
				);
			// Reload so states, counts and the not-synced indicator describe the written files.
			yield* Ref.set(selected, undefined);
			const reloaded = yield* select(request.target, true);
			yield* Effect.annotateCurrentSpan({
				edits: request.edits.length,
				status: receipt.success.status
			});
			return {
				status:
					receipt.success.status === "nothing_to_write"
						? ("written" as const)
						: receipt.success.status,
				edits: localizationEditOutcomes(receipt.success.review),
				files: receipt.success.files.map(({ culture, relativePath, changes, error }) => ({
					culture,
					relativePath,
					changes,
					written: error === null
				})),
				notSynced: reloaded.status === "ready" ? reloaded.notSynced : 0
			};
		});
		/** Writes review flags or accepted findings, fingerprinted against the retained evidence. */
		const review = Effect.fn("GameText.workspace.localization.review")(function* (
			request: LocalizationReviewRequest,
			by: string
		): Effect.fn.Return<LocalizationReviewResult, never, Scope.Scope> {
			const retained = yield* current(request.target);
			const root = yield* currentRoot();
			if (!retained || !root) return { status: "not_ready" as const };
			const updates: LocalizationReviewUpdate[] = [];
			for (const change of request.changes) {
				const identity = { namespace: change.namespace, key: change.key };
				if (change.kind === "clear") {
					updates.push({ ...change, kind: "clear" });
					continue;
				}
				if (change.kind === "unaccept") {
					updates.push({ ...change, kind: "unaccept" });
					continue;
				}
				const fingerprint = localizationEvidenceFingerprint(
					retained.evidence,
					change.culture,
					identity
				);
				if (fingerprint === undefined)
					return {
						status: "failed" as const,
						code: "not_gathered",
						message: "This line is not in the target's gathered text.",
						recovery: "Gather the target with Unreal, then review the line."
					};
				updates.push({ ...change, fingerprint });
			}
			const written = yield* updateLocalizationReview(
				{ projectRoot: root, target: request.target },
				updates,
				{ by, at: new Date().toISOString() },
				retained.review
			).pipe(Effect.provide(options.localizationFiles), Effect.result);
			if (Result.isFailure(written))
				return {
					status: "failed" as const,
					code: written.failure.code,
					message: "The review file could not be updated.",
					recovery:
						written.failure.code === "file_changed"
							? "The review file changed on disk, for example after a merge. Rescan and try again."
							: "Check the file out in source control or make it writable, then try again."
				};
			yield* index
				.invalidate({
					projectRoot: root,
					targetName: request.target,
					changedFiles: [written.success.relativePath]
				})
				.pipe(
					Effect.catch((cause) =>
						Effect.logWarning(
							"Game Text write succeeded but cache invalidation failed",
							{
								message: cause.message,
								recovery: cause.recovery
							}
						)
					)
				);
			yield* Ref.set(selected, undefined);
			yield* clearQuality();
			yield* select(request.target, true);
			yield* Effect.annotateCurrentSpan({ changes: request.changes.length });
			return { status: "written" as const, relativePath: written.success.relativePath };
		});
		return {
			preparation,
			beforeGather,
			linesFile,
			operationTarget: (name: LocalizationJoin["target"]) =>
				targets().pipe(
					Effect.flatMap((result) =>
						result.status === "ready"
							? Effect.gen(function* () {
									const cached = yield* Ref.get(discovery);
									return cached?.revision === (yield* currentRevision())
										? cached?.targets.find((target) => target.name === name)
										: undefined;
								})
							: Effect.succeed(undefined)
					)
				),
			reset,
			targets,
			select,
			search,
			/** The selected target's query; absent when not loaded. */
			targetQuery: (target: LocalizationJoin["target"]) =>
				current(target).pipe(Effect.map((cached) => cached?.model)),
			focus,
			qualityExport: (request: WorkspaceQualityRequest) =>
				quality(request).pipe(
					Effect.flatMap((model) =>
						model ? model.export(request) : Effect.succeed(undefined)
					)
				),
			qualitySearch,
			qualityFocus,
			changes,
			report,
			reportFile,
			edits,
			review
		};
	}
);
