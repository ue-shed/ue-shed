import {
	MAX_LOCALIZATION_CULTURES,
	joinLocalizationTarget,
	localizationQualityWorkspace,
	checkLocalizationTarget,
	evaluateGameTextSourceQuality,
	localizationProgressReport,
	localizationReportPage,
	localizationReportCsv,
	createLocalizationBaseline,
	decodeLocalizationBaselineJson,
	LocalizationReportError,
	type LocalizationBaseline,
	type GameTextRuleDocument,
	type WorkspaceQualityRequest,
	type WorkspaceQualityFocusRequest,
	type WorkspaceQualityResult,
	type WorkspaceQualityFocusResult,
	type WorkspaceChangesResult,
	type WorkspaceReportRequest,
	type WorkspaceReportResult,
	type WorkspaceReportFileRequest,
	type WorkspaceReportFileResult,
	localizationFocusPage,
	textCorpusQuery,
	applyLocalizationKeyChanges,
	localizationLinesCsv,
	pickedLocalizationCultures,
	type LocalizationLinesFileResult,
	localizationKeyChangesAcross,
	mergeLocalizationKeyChanges,
	type LocalizationKeyChangePair,
	applyLocalizationReview,
	localizationKeyChanges,
	localizationEditChangeSet,
	type LocalizationReviewRequest,
	type LocalizationReviewResult,
	localizationEditOutcomes,
	type LocalizationEditRequest,
	type LocalizationEditResult,
	type LocalizationFocusRequest,
	type LocalizationFocusResult,
	type LocalizationJoin,
	type LocalizationTargetResult,
	type LocalizationTargetsResult,
	type TextCorpus,
	type TextCorpusQuery,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "@ue-shed/game-text";
import {
	applyLocalizationChangeSet,
	LocalizationEvidence,
	LocalizationFileAccessLive,
	localizationEvidenceFingerprint,
	readLocalizationReview,
	updateLocalizationReview,
	type LocalizationReviewSnapshot,
	type LocalizationReviewUpdate,
	reviewLocalizationChangeSet,
	type LocalizationTargetEvidence,
	type LocalizationTarget
} from "@ue-shed/localization";
import { Effect, Option, Ref, Result } from "effect";
import type { ElectronDialogApi } from "../adapters/electron-dialog.js";
import type { LocalFilesApi } from "../adapters/local-files.js";

function failure(code: string) {
	return {
		status: "failed" as const,
		code,
		message: "Localization files could not be loaded.",
		recovery: "Check the project's localization settings and files, then rescan."
	};
}

/** The retained corpus reference is also the scan revision: stale readers cannot publish results. */
export const makeGameTextLocalization = Effect.fn("Workbench.GameText.localization")(function* (
	currentCorpus: () => Effect.Effect<TextCorpus | undefined>,
	currentRoot: () => Effect.Effect<string | undefined>,
	currentRules?: () => Effect.Effect<GameTextRuleDocument | undefined>
) {
	const reader = yield* LocalizationEvidence;
	const rules = currentRules ?? (() => Effect.succeed(undefined));
	const baseline = yield* Ref.make<LocalizationBaseline | undefined>(undefined);
	const qualityCache = yield* Ref.make<
		| {
				join: LocalizationJoin;
				document: GameTextRuleDocument | undefined;
				model: ReturnType<typeof localizationQualityWorkspace>;
		  }
		| undefined
	>(undefined);
	const discovery = yield* Ref.make<
		| {
				readonly corpus: TextCorpus;
				readonly targets: readonly LocalizationTarget[];
				readonly result: LocalizationTargetsResult;
		  }
		| undefined
	>(undefined);
	const selected = yield* Ref.make<
		| {
				readonly corpus: TextCorpus;
				readonly join: LocalizationJoin;
				readonly evidence: LocalizationTargetEvidence;
				readonly review: LocalizationReviewSnapshot | undefined;
				readonly model: TextCorpusQuery;
				readonly result: LocalizationTargetResult;
		  }
		| undefined
	>(undefined);
	const revision = yield* Ref.make(0);
	// Unreal's gather drops the archive translations of keys that left the manifest. The join from
	// before a gather UE Shed runs is kept until the next selection pairs those keys with the keys
	// that joined. The pairs live for the project, beyond the refresh that follows the gather.
	const gatherBaseline = yield* Ref.make<
		{ readonly root: string; readonly join: LocalizationJoin } | undefined
	>(undefined);
	const acrossGather = yield* Ref.make<
		| {
				readonly root: string;
				readonly target: LocalizationJoin["target"];
				readonly pairs: readonly LocalizationKeyChangePair[];
		  }
		| undefined
	>(undefined);
	const beforeGather = Effect.fn("Workbench.GameText.localization.before_gather")(function* (
		name: LocalizationJoin["target"]
	) {
		const root = yield* currentRoot();
		const cached = yield* Ref.get(selected);
		yield* Ref.set(
			gatherBaseline,
			root && cached?.join.target === name ? { root, join: cached.join } : undefined
		);
	});

	const reset = Effect.fn("Workbench.GameText.localization.reset")(function* () {
		yield* Ref.update(revision, (value) => value + 1);
		yield* Ref.set(discovery, undefined);
		yield* Ref.set(selected, undefined);
		yield* Ref.set(qualityCache, undefined);
		yield* Ref.set(baseline, undefined);
	});
	const targets = Effect.fn("Workbench.GameText.localization.targets")(function* () {
		const corpus = yield* currentCorpus();
		const root = yield* currentRoot();
		if (!corpus || !root) return { status: "not_ready" as const };
		const cached = yield* Ref.get(discovery);
		if (cached?.corpus === corpus) return cached.result;
		const version = yield* Ref.get(revision);
		const discovered = yield* reader.discover({ projectRoot: root }).pipe(Effect.result);
		if ((yield* currentCorpus()) !== corpus || (yield* Ref.get(revision)) !== version)
			return { status: "not_ready" as const };
		if (Result.isFailure(discovered)) return failure(discovered.failure.code);
		const available = discovered.success.targets;
		if (
			available.length > 50 ||
			available.some((target) => target.cultures.length > MAX_LOCALIZATION_CULTURES)
		)
			return failure("bounds_exceeded");
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
		yield* Ref.set(discovery, { corpus, targets: available, result });
		yield* Effect.annotateCurrentSpan({ targetCount: available.length });
		return result;
	});
	const select = Effect.fn("Workbench.GameText.localization.select")(function* (
		name: LocalizationJoin["target"]
	) {
		const corpus = yield* currentCorpus();
		const root = yield* currentRoot();
		if (!corpus || !root) return { status: "not_ready" as const };
		const cached = yield* Ref.get(selected);
		if (cached?.corpus === corpus && cached.join.target === name) return cached.result;
		const listed = yield* targets();
		if (listed.status !== "ready") return listed;
		const target = (yield* Ref.get(discovery))?.targets.find((item) => item.name === name);
		if (!target) return failure("target_not_found");
		const version = yield* Ref.updateAndGet(revision, (value) => value + 1);
		yield* Ref.set(selected, undefined);
		const evidence = yield* reader.read({ projectRoot: root, target }).pipe(Effect.result);
		if ((yield* currentCorpus()) !== corpus || (yield* Ref.get(revision)) !== version)
			return { status: "not_ready" as const };
		if (Result.isFailure(evidence)) return failure(evidence.failure.code);
		// A malformed review file must not hide translations: show them without review state.
		const review = Option.getOrUndefined(
			yield* readLocalizationReview({ projectRoot: root, target: target.name }).pipe(
				Effect.provide(LocalizationFileAccessLive),
				Effect.option
			)
		);
		if ((yield* currentCorpus()) !== corpus || (yield* Ref.get(revision)) !== version)
			return { status: "not_ready" as const };
		// Review is tracked once the target has a review file; until then nothing is "not reviewed".
		const reviewed = applyLocalizationReview(
			joinLocalizationTarget(corpus, evidence.success),
			review?.contentHash ? review.file : undefined
		);
		const before = yield* Ref.get(gatherBaseline);
		if (before?.root === root && before.join.target === name) {
			yield* Ref.set(gatherBaseline, undefined);
			const across = localizationKeyChangesAcross(before.join, reviewed);
			yield* Ref.set(acrossGather, { root, target: name, pairs: across.pairs });
			yield* Effect.annotateCurrentSpan({ keyChangesAcrossGather: across.pairs.length });
		}
		const carried = yield* Ref.get(acrossGather);
		// Saved text whose key changed since the last gather pairs with the key Unreal still lists;
		// keys that changed in a gather UE Shed ran keep their pairs from before that gather.
		const join = applyLocalizationKeyChanges(
			reviewed,
			mergeLocalizationKeyChanges(
				localizationKeyChanges(reviewed, corpus).pairs,
				carried?.root === root && carried.target === name ? carried.pairs : []
			)
		);
		const model = textCorpusQuery(corpus, undefined, join);
		const textCounts = model.search({
			query: "",
			capability: "all",
			lens: "all",
			withoutNotes: false,
			pageSize: 1,
			localization: { target: name }
		});
		const result: LocalizationTargetResult = {
			status: "ready",
			target: {
				name: target.name,
				nativeCulture: target.nativeCulture,
				cultures: target.cultures
			},
			lines: textCounts.total,
			notSynced: textCounts.localization?.notSynced ?? 0
		};
		if (cached?.join.target !== name) yield* Ref.set(baseline, undefined);
		yield* Ref.set(selected, {
			corpus,
			join,
			model,
			result,
			evidence: evidence.success,
			review
		});
		yield* Effect.annotateCurrentSpan({
			lineCount: textCounts.total,
			notSyncedCount: result.notSynced
		});
		return result;
	});
	const current = Effect.fn("Workbench.GameText.localization.current")(function* (
		target: LocalizationJoin["target"]
	) {
		const cached = yield* Ref.get(selected);
		return cached && cached.corpus === (yield* currentCorpus()) && cached.join.target === target
			? cached
			: undefined;
	});
	const search = Effect.fn("Workbench.GameText.localization.search")(function* (
		request: TextCorpusSearchRequest
	): Effect.fn.Return<TextCorpusSearchResult> {
		if (!request.localization) return { status: "not_ready" };
		const cached = yield* current(request.localization.target);
		if (
			!cached ||
			(request.localization.culture &&
				!cached.join.cultures.includes(request.localization.culture))
		)
			return { status: "not_ready" };
		return { status: "ready", page: cached.model.search(request) };
	});
	const focus = Effect.fn("Workbench.GameText.localization.focus")(function* (
		request: LocalizationFocusRequest
	): Effect.fn.Return<LocalizationFocusResult> {
		const cached = yield* current(request.target);
		if (!cached) return { status: "not_ready" };
		const id =
			request.selection.kind === "line"
				? request.selection.id
				: cached.model.focus({ id: request.selection.id, pageSize: 1 })?.localization?.id;
		const line = id ? cached.model.localizationFocus(id) : undefined;
		return line
			? { status: "found", focus: localizationFocusPage(cached.join, line, request) }
			: { status: "not_found" };
	});

	const quality = Effect.fn("Workbench.GameText.localization.quality")(function* (
		request: WorkspaceQualityRequest
	) {
		const retained = yield* current(request.target);
		if (!retained || (request.culture && !retained.join.cultures.includes(request.culture)))
			return undefined;
		const document = yield* rules();
		const cached = yield* Ref.get(qualityCache);
		if (cached?.join === retained.join && cached.document === document) return cached.model;
		const model = localizationQualityWorkspace(
			document ? evaluateGameTextSourceQuality(retained.corpus, document) : undefined,
			checkLocalizationTarget(
				retained.corpus,
				retained.join,
				retained.evidence,
				retained.review ? { review: retained.review.file } : {},
				document
			),
			retained.join
		);
		yield* Ref.set(qualityCache, { join: retained.join, document, model });
		return model;
	});
	const qualitySearch = Effect.fn("Workbench.GameText.localization.qualitySearch")(function* (
		request: WorkspaceQualityRequest
	): Effect.fn.Return<WorkspaceQualityResult> {
		const model = yield* quality(request);
		if (!model) return { status: "not_ready" };
		const page = model.search(request);
		yield* Effect.annotateCurrentSpan({
			findingCount: page.total,
			pageCount: page.findings.length
		});
		return { status: "ready", page };
	});
	const qualityFocus = Effect.fn("Workbench.GameText.localization.qualityFocus")(function* (
		request: WorkspaceQualityFocusRequest
	): Effect.fn.Return<WorkspaceQualityFocusResult> {
		const model = yield* quality({ ...request, filter: "all" });
		return model ? model.focus(request) : { status: "not_ready" };
	});
	const changes = Effect.fn("Workbench.GameText.localization.changes")(function* (
		request: WorkspaceQualityRequest
	): Effect.fn.Return<WorkspaceChangesResult> {
		const model = yield* quality(request);
		if (!model) return { status: "not_ready" };
		const result = model.changes(request);
		if (result.status === "ready")
			yield* Effect.annotateCurrentSpan({
				changeCount: result.document.changes.length,
				remainingCount: result.remaining
			});
		return result;
	});
	const reportFailure = (error: LocalizationReportError) => ({
		status: "failed" as const,
		message: error.message,
		recovery: error.recovery
	});
	const report = Effect.fn("Workbench.GameText.localization.report")(function* (
		request: WorkspaceReportRequest
	): Effect.fn.Return<WorkspaceReportResult> {
		const retained = yield* current(request.target);
		if (!retained) return { status: "not_ready" };
		const previous = yield* Ref.get(baseline);
		return yield* Effect.try({
			try: () => ({
				status: "ready" as const,
				page: localizationReportPage(
					localizationProgressReport(
						retained.corpus,
						retained.join,
						retained.evidence,
						previous
					),
					retained.join.nativeCulture,
					request,
					previous
				)
			}),
			catch: (cause) =>
				cause instanceof LocalizationReportError
					? cause
					: new LocalizationReportError({
							code: "invalid_report_context",
							message: "Report evidence could not be read.",
							recovery: "Rescan the selected project."
						})
		}).pipe(Effect.catch((error) => Effect.succeed(reportFailure(error))));
	});
	const reportFile = Effect.fn("Workbench.GameText.localization.reportFile")(function* (
		request: WorkspaceReportFileRequest,
		dialog: ElectronDialogApi,
		files: LocalFilesApi
	): Effect.fn.Return<WorkspaceReportFileResult> {
		const retained = yield* current(request.target);
		if (!retained) return { status: "not_ready" };
		const previous = yield* Ref.get(baseline);
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
				const bytes = yield* files.readFile(choice.path, { maxBytes: 16 * 1024 * 1024 });
				const decoded = decodeLocalizationBaselineJson(new TextDecoder().decode(bytes));
				if (Result.isFailure(decoded)) return reportFailure(decoded.failure);
				const progress = yield* Effect.try({
					try: () =>
						localizationProgressReport(
							retained.corpus,
							retained.join,
							retained.evidence,
							decoded.success
						),
					catch: (cause) =>
						cause instanceof LocalizationReportError
							? cause
							: new LocalizationReportError({
									code: "invalid_baseline",
									message: "The baseline could not be compared.",
									recovery: "Choose a baseline for this target."
								})
				});
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
			const contents = yield* Effect.try({
				try: () => {
					if (request.operation === "save_baseline")
						return (
							JSON.stringify(
								createLocalizationBaseline(
									retained.corpus,
									retained.evidence,
									new Date().toISOString()
								),
								null,
								2
							) + "\n"
						);
					const progress = localizationProgressReport(
						retained.corpus,
						retained.join,
						retained.evidence,
						previous
					);
					const rows = progress.cultures.flatMap((_, index) =>
						index % 50 === 0
							? localizationReportPage(
									progress,
									retained.join.nativeCulture,
									{ target: request.target, offset: index },
									previous
								).rows
							: []
					);
					return localizationReportCsv(rows, previous !== undefined);
				},
				catch: (cause) =>
					cause instanceof LocalizationReportError
						? cause
						: new LocalizationReportError({
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
					message:
						error instanceof LocalizationReportError
							? error.message
							: "The file operation failed.",
					recovery:
						error instanceof LocalizationReportError
							? error.recovery
							: "Choose a new destination for a baseline; existing files are never overwritten. Check permissions and try again."
				})
			)
		);
		return result;
	});
	/** Writes every line the request matches, a column per culture, to a CSV the person chose. */
	const linesFile = Effect.fn("Workbench.GameText.localization.linesFile")(function* (
		request: TextCorpusSearchRequest,
		dialog: ElectronDialogApi,
		files: LocalFilesApi
	): Effect.fn.Return<LocalizationLinesFileResult> {
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
			const { csv, rows } = yield* Effect.try(() =>
				localizationLinesCsv({
					join: retained.join,
					lines: retained.model.localizationLines(request),
					corpus: retained.corpus,
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
	const edits = Effect.fn("Workbench.GameText.localization.edits")(function* (
		request: LocalizationEditRequest
	): Effect.fn.Return<LocalizationEditResult> {
		const retained = yield* current(request.target);
		const root = yield* currentRoot();
		if (!retained || !root) return { status: "not_ready" as const };
		const changeSet = localizationEditChangeSet(retained.evidence, request.edits, "workbench");
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
		const receipt = yield* applyLocalizationChangeSet({ projectRoot: root, changeSet }).pipe(
			Effect.provideService(LocalizationEvidence, reader),
			Effect.provide(LocalizationFileAccessLive),
			Effect.result
		);
		if (Result.isFailure(receipt))
			return {
				status: "failed" as const,
				code: receipt.failure.code,
				message: receipt.failure.message,
				recovery: receipt.failure.recovery
			};
		// Reload so states, counts and the not-synced indicator describe the written files.
		yield* Ref.set(selected, undefined);
		const reloaded = yield* select(request.target);
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
	const review = Effect.fn("Workbench.GameText.localization.review")(function* (
		request: LocalizationReviewRequest,
		by: string
	): Effect.fn.Return<LocalizationReviewResult> {
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
		).pipe(Effect.provide(LocalizationFileAccessLive), Effect.result);
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
		yield* Ref.set(selected, undefined);
		yield* Ref.set(qualityCache, undefined);
		yield* select(request.target);
		yield* Effect.annotateCurrentSpan({ changes: request.changes.length });
		return { status: "written" as const, relativePath: written.success.relativePath };
	});
	return {
		beforeGather,
		linesFile,
		operationTarget: (name: LocalizationJoin["target"]) =>
			targets().pipe(
				Effect.flatMap((result) =>
					result.status === "ready"
						? Effect.gen(function* () {
								const cached = yield* Ref.get(discovery);
								return cached?.corpus === (yield* currentCorpus())
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
		focus,
		qualitySearch,
		qualityFocus,
		changes,
		report,
		reportFile,
		edits,
		review
	};
});
