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
	LocalizationEvidence,
	type LocalizationTargetEvidence,
	type LocalizationTarget
} from "@ue-shed/localization";
import { Effect, Ref, Result } from "effect";
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
				readonly model: TextCorpusQuery;
				readonly result: LocalizationTargetResult;
		  }
		| undefined
	>(undefined);
	const revision = yield* Ref.make(0);

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
		const join = joinLocalizationTarget(corpus, evidence.success);
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
		yield* Ref.set(selected, { corpus, join, model, result, evidence: evidence.success });
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
				{},
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
	return {
		reset,
		targets,
		select,
		search,
		focus,
		qualitySearch,
		qualityFocus,
		changes,
		report,
		reportFile
	};
});
