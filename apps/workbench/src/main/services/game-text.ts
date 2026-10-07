import {
	GameTextInvestigationPreset,
	type GameTextInvestigationQuery,
	type GameTextInvestigationPresetResult,
	exportGameTextInvestigation,
	gameTextCsv,
	gameTextQualityCsv,
	createStarterTextRules,
	GAME_TEXT_RULES_RELATIVE_PATH
} from "@ue-shed/game-text";
import { resolve } from "node:path";
import {
	InvestigationError,
	type InvestigationSource,
	type InvestigationFileResult,
	type InvestigationFormat
} from "@ue-shed/unreal-assets/investigation";
import {
	saveInvestigation,
	openInvestigation,
	investigationFailure
} from "./investigation-files.js";
import {
	decodeTextQualityRuleDocumentJson,
	decodeTextQualityRuleDocument,
	evaluateTextQuality,
	textCorpusQuery,
	textQualityQuery,
	TextCorpusService,
	type TextCorpus,
	type TextCorpusFocusRequest,
	type TextCorpusFocusResult,
	type TextCorpusQuery,
	type TextCorpusQueryRunResult,
	type TextCorpusRunResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult,
	type TextQualityFocusRequest,
	type TextQualityFocusResult,
	type TextQualityQuery,
	type TextQualityQueryRunResult,
	type TextQualityRuleDocument,
	type TextQualityRuleUpdateResult,
	type TextQualitySearchRequest,
	type TextQualitySearchResult
} from "@ue-shed/game-text";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Cache, Context, Data, Duration, Effect, Layer, Ref } from "effect";
import type { WorkbenchTaskProgress } from "../project-workspace-contract.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { LocalFiles } from "../adapters/local-files.js";
import { WorkbenchProject, type WorkbenchProjectCandidates } from "./project-workspace.js";

export interface WorkbenchGameTextApi {
	readonly investigationExport: (
		query: GameTextInvestigationQuery,
		format: InvestigationFormat
	) => Effect.Effect<InvestigationFileResult>;
	readonly investigationSave: (
		query: GameTextInvestigationQuery
	) => Effect.Effect<InvestigationFileResult>;
	readonly investigationOpen: () => Effect.Effect<GameTextInvestigationPresetResult>;
	readonly chooseAndRefresh: () => Effect.Effect<TextCorpusQueryRunResult>;
	readonly chooseAndScan: () => Effect.Effect<TextCorpusRunResult>;
	readonly configuredRefresh: (refresh?: boolean) => Effect.Effect<TextCorpusQueryRunResult>;
	readonly configuredScan: () => Effect.Effect<TextCorpusRunResult>;
	readonly progress: () => Effect.Effect<WorkbenchTaskProgress>;
	readonly focus: (request: TextCorpusFocusRequest) => Effect.Effect<TextCorpusFocusResult>;
	readonly search: (request: TextCorpusSearchRequest) => Effect.Effect<TextCorpusSearchResult>;
	readonly chooseQualityRules: () => Effect.Effect<TextQualityQueryRunResult>;
	readonly reloadQualityRules: () => Effect.Effect<TextQualityQueryRunResult>;
	readonly createStarterRules: (
		loadExisting: boolean
	) => Effect.Effect<TextQualityQueryRunResult>;
	readonly previewQualityRules: (
		document: TextQualityRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult>;
	readonly saveQualityRules: (
		document: TextQualityRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult>;
	readonly qualityFocus: (
		request: TextQualityFocusRequest
	) => Effect.Effect<TextQualityFocusResult>;
	readonly qualitySearch: (
		request: TextQualitySearchRequest
	) => Effect.Effect<TextQualitySearchResult>;
}

export class WorkbenchGameText extends Context.Service<WorkbenchGameText, WorkbenchGameTextApi>()(
	"@ue-shed/workbench/WorkbenchGameText"
) {}

function unavailableProject(message: string, recovery: string): TextCorpusRunResult {
	return {
		error: { code: "invalid_project", message, recovery, retrySafe: true },
		status: "failed"
	};
}

function unavailableQueryProject(message: string, recovery: string): TextCorpusQueryRunResult {
	return {
		error: { code: "invalid_project", message, recovery, retrySafe: true },
		status: "failed"
	};
}

export const WorkbenchGameTextLive = Layer.effect(
	WorkbenchGameText,
	Effect.gen(function* () {
		const project = yield* WorkbenchProject;
		const textCorpus = yield* TextCorpusService;
		const dialog = yield* ElectronDialog;
		const files = yield* LocalFiles;
		const retainedCorpus = yield* Ref.make<TextCorpus | undefined>(undefined);
		const queryModel = yield* Ref.make<TextCorpusQuery | undefined>(undefined);
		const qualityModel = yield* Ref.make<TextQualityQuery | undefined>(undefined);
		const qualityDocument = yield* Ref.make<TextQualityRuleDocument | undefined>(undefined);
		const qualityRulePath = yield* Ref.make<
			{ readonly path: string; readonly projectRoot: string } | undefined
		>(undefined);
		const progress = Effect.fn("Workbench.WorkbenchGameText.progress")(function* () {
			const projectProgress = yield* project.progress();
			if (projectProgress.phase === "enumerating" || projectProgress.phase === "scanning") {
				return projectProgress;
			}
			const corpusProgress = yield* textCorpus.progress();
			return {
				completed: corpusProgress.processedAssets,
				phase: corpusProgress.phase,
				stage: "game_text" as const,
				total: corpusProgress.totalAssets
			};
		});
		const scanCorpus = (projectRoot: string, index: SavedAssetScan) =>
			textCorpus.scanFromProjectIndex(index, { projectRoot });

		const runScan = (projectRoot: string, index: SavedAssetScan) =>
			scanCorpus(projectRoot, index).pipe(
				Effect.map((corpus) => ({ corpus, status: "completed" as const })),
				Effect.catch((error) =>
					Effect.succeed({
						error: {
							code: error.code,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						},
						status: "failed" as const
					})
				)
			);
		const investigationSnapshot = yield* Ref.make<
			| {
					readonly source: InvestigationSource;
					readonly corpus: TextCorpus;
					readonly rules?: TextQualityRuleDocument;
			  }
			| undefined
		>(undefined);

		const scanRevision = yield* Ref.make(0);
		const modelSelection = yield* Ref.make<
			{ readonly projectRoot: string; readonly generation: number } | undefined
		>(undefined);
		const currentModel = <A>(ref: Ref.Ref<A | undefined>) =>
			Effect.gen(function* () {
				const selected = yield* project.current();
				const owner = yield* Ref.get(modelSelection);
				if (
					selected.status !== "ready" ||
					selected.project.projectRoot !== owner?.projectRoot ||
					(selected.project.generation ?? 0) !== owner.generation
				)
					return undefined;
				return yield* Ref.get(ref);
			});
		const runRefresh = (projectRoot: string, index: WorkbenchProjectCandidates) =>
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
				return yield* scanCorpus(projectRoot, index).pipe(
					Effect.flatMap((report) =>
						Effect.gen(function* () {
							const latest = yield* project.current();
							if (
								(yield* Ref.get(scanRevision)) !== revision ||
								latest.status !== "ready" ||
								latest.project.projectRoot !== projectRoot ||
								(latest.project.generation ?? 0) !== index.generation
							)
								return unavailableQueryProject(
									"The project changed during the scan.",
									"Refresh to read the current project generation."
								);
							const next = textCorpusQuery(report, new Date().toISOString());
							const owner = yield* Ref.get(modelSelection);
							const rules =
								owner?.projectRoot === projectRoot
									? yield* Ref.get(qualityDocument)
									: undefined;
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
								corpus: report,
								...(rules ? { rules } : undefined)
							});
							yield* Effect.all([
								Ref.set(retainedCorpus, report),
								Ref.set(queryModel, next),
								Ref.set(
									qualityModel,
									rules
										? textQualityQuery(evaluateTextQuality(report, rules))
										: undefined
								),
								Ref.set(qualityDocument, rules),
								Ref.set(qualityRulePath, rulePath)
							]);
							yield* Ref.set(modelSelection, {
								projectRoot,
								generation: index.generation
							});
							return { summary: next.summary(), status: "completed" as const };
						})
					),
					Effect.catch((error) =>
						Effect.succeed({
							error: {
								code: error.code,
								message: error.message,
								recovery: error.recovery,
								retrySafe: error.retrySafe
							},
							status: "failed" as const
						})
					)
				);
			});

		const configuredScan = Effect.fn("Workbench.WorkbenchGameText.configuredScan")(
			function* () {
				const current = yield* project.refresh();
				if (current.status === "not_configured" || current.status === "cancelled") {
					return { status: "not_configured" as const };
				}
				if (current.status === "failed") {
					return unavailableProject(current.error.message, current.error.recovery);
				}
				return yield* project.candidates("game_text").pipe(
					Effect.flatMap((index) => runScan(current.project.projectRoot, index)),
					Effect.catch((error) =>
						Effect.succeed(unavailableProject(error.message, error.recovery))
					)
				);
			}
		);

		const chooseAndScan = Effect.fn("Workbench.WorkbenchGameText.chooseAndScan")(function* () {
			const choice = yield* project.choose();
			if (choice.status === "cancelled") return { status: "cancelled" as const };
			if (choice.status === "not_configured") return { status: "not_configured" as const };
			if (choice.status === "failed") {
				return unavailableProject(choice.error.message, choice.error.recovery);
			}
			return yield* project.candidates("game_text").pipe(
				Effect.flatMap((index) => runScan(choice.project.projectRoot, index)),
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
					const index = yield* project.candidates("game_text");
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
		const configuredRefresh = Effect.fn("Workbench.WorkbenchGameText.configuredRefresh")(
			function* (refresh = true) {
				const current = yield* refresh ? project.refresh() : project.current();
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
				const model = yield* currentModel(queryModel);
				if (!refresh) {
					return model
						? { status: "completed" as const, summary: model.summary() }
						: { status: "not_scanned" as const };
				}
				return yield* Cache.get(refreshes, key);
			}
		);

		const chooseAndRefresh = Effect.fn("Workbench.WorkbenchGameText.chooseAndRefresh")(
			function* () {
				const choice = yield* project.choose();
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				if (choice.status === "not_configured")
					return { status: "not_configured" as const };
				if (choice.status === "failed") {
					return unavailableQueryProject(choice.error.message, choice.error.recovery);
				}
				return yield* project.candidates("game_text").pipe(
					Effect.flatMap((index) => runRefresh(choice.project.projectRoot, index)),
					Effect.catch((error) =>
						Effect.succeed(unavailableQueryProject(error.message, error.recovery))
					)
				);
			}
		);

		const search = Effect.fn("Workbench.WorkbenchGameText.search")(
			(request: TextCorpusSearchRequest) =>
				currentModel(queryModel).pipe(
					Effect.map((model) =>
						model === undefined
							? { status: "not_ready" as const }
							: { page: model.search(request), status: "ready" as const }
					)
				)
		);

		const focus = Effect.fn("Workbench.WorkbenchGameText.focus")(
			(request: TextCorpusFocusRequest) =>
				currentModel(queryModel).pipe(
					Effect.map((model) => {
						if (model === undefined) return { status: "not_ready" as const };
						const result = model.focus(request);
						return result === undefined
							? { status: "not_found" as const }
							: { focus: result, status: "found" as const };
					})
				)
		);

		const prepareQualityRules = Effect.fn("Workbench.WorkbenchGameText.prepareQualityRules")(
			function* (input: TextQualityRuleDocument) {
				const corpus = yield* currentModel(retainedCorpus);
				if (corpus === undefined) return { status: "not_ready" as const };
				const document = yield* decodeTextQualityRuleDocument(input).pipe(
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
				const model = textQualityQuery(evaluateTextQuality(corpus, document.value));
				return { corpus, document: document.value, model, status: "ready" as const };
			}
		);

		const publishQualityRules = Effect.fn("Workbench.WorkbenchGameText.publishQualityRules")(
			function* (prepared: {
				readonly document: TextQualityRuleDocument;
				readonly model: TextQualityQuery;
				readonly corpus: TextCorpus;
			}) {
				const snapshot = yield* Ref.get(investigationSnapshot);
				if (
					snapshot?.corpus !== prepared.corpus ||
					(yield* currentModel(retainedCorpus)) !== prepared.corpus
				)
					return { status: "not_ready" as const };
				yield* Ref.set(investigationSnapshot, { ...snapshot, rules: prepared.document });
				yield* Effect.all([
					Ref.set(qualityDocument, prepared.document),
					Ref.set(qualityModel, prepared.model)
				]);
				return {
					document: prepared.document,
					status: "completed" as const,
					summary: prepared.model.summary()
				};
			}
		);

		const createStarterRules = Effect.fn("Workbench.WorkbenchGameText.createStarterRules")(
			function* (loadExisting: boolean) {
				const current = yield* project.current();
				if (current.status !== "ready" || !(yield* currentModel(retainedCorpus)))
					return { status: "not_ready" as const };
				const root = current.project.projectRoot;
				const path = resolve(root, GAME_TEXT_RULES_RELATIVE_PATH);
				if (!loadExisting) {
					const created = yield* createStarterTextRules(root).pipe(
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
											: error.code === "invalid_project"
												? "Select an existing project folder and scan it before creating rules."
												: "Check the project folder's write permissions and try again.",
									retrySafe: true
								}
							})
						})
					);
					if (created.status === "failed") return created;
				}
				return yield* files
					.readFileWithin(root, GAME_TEXT_RULES_RELATIVE_PATH, { maxBytes: 1_048_576 })
					.pipe(
						Effect.flatMap((bytes) =>
							decodeTextQualityRuleDocumentJson(new TextDecoder().decode(bytes))
						),
						Effect.flatMap((document) => prepareQualityRules(document)),
						Effect.flatMap((prepared) =>
							Effect.gen(function* () {
								const latest = yield* project.current();
								if (
									latest.status !== "ready" ||
									latest.project.projectRoot !== root ||
									(latest.project.generation ?? 0) !==
										(current.project.generation ?? 0)
								)
									return { status: "not_ready" as const };
								if (prepared.status !== "ready") return prepared;
								yield* Ref.set(qualityRulePath, { path, projectRoot: root });
								return yield* publishQualityRules(prepared);
							})
						),
						Effect.catch((error) =>
							Effect.succeed({
								status: "failed" as const,
								error: {
									code:
										error._tag === "TextQualityRuleDocumentError"
											? ("invalid_rules" as const)
											: ("read_failed" as const),
									message: error.message,
									recovery: error.recovery,
									retrySafe: true
								}
							})
						)
					);
			}
		);

		const chooseQualityRules = Effect.fn("Workbench.WorkbenchGameText.chooseQualityRules")(
			function* () {
				const corpus = yield* currentModel(retainedCorpus);
				if (corpus === undefined) return { status: "not_ready" as const };
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
								retrySafe: error.retrySafe
							},
							status: "failed" as const
						}),
						onSuccess: (value) => ({ status: "ready" as const, value })
					})
				);
				if (bytes.status === "failed") {
					return bytes;
				}
				const document = yield* decodeTextQualityRuleDocumentJson(
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
				if ((yield* currentModel(retainedCorpus)) !== corpus)
					return { status: "not_ready" as const };
				const prepared = yield* prepareQualityRules(document.value);
				if (prepared.status !== "ready") return prepared;
				const snapshot = yield* Ref.get(investigationSnapshot);
				if (snapshot?.corpus !== prepared.corpus) return { status: "not_ready" as const };
				yield* Ref.set(qualityRulePath, {
					path: choice.path,
					projectRoot: snapshot.source.projectRoot
				});
				return yield* publishQualityRules(prepared);
			}
		);

		const previewQualityRules = Effect.fn("Workbench.WorkbenchGameText.previewQualityRules")(
			function* (document: TextQualityRuleDocument) {
				const prepared = yield* prepareQualityRules(document);
				return prepared.status === "ready"
					? yield* publishQualityRules(prepared)
					: prepared;
			}
		);

		const reloadQualityRules = Effect.fn("Workbench.WorkbenchGameText.reloadQualityRules")(
			function* () {
				const corpus = yield* currentModel(retainedCorpus);
				if (!corpus) return { status: "not_ready" as const };
				const destination = yield* Ref.get(qualityRulePath);
				const owner = yield* Ref.get(modelSelection);
				const path =
					destination?.projectRoot === owner?.projectRoot ? destination?.path : undefined;
				if (!path) {
					return yield* chooseQualityRules();
				}
				return yield* files.readFile(path, { maxBytes: 1_048_576 }).pipe(
					Effect.flatMap((bytes) =>
						decodeTextQualityRuleDocumentJson(new TextDecoder().decode(bytes))
					),
					Effect.flatMap((document) =>
						Effect.gen(function* () {
							if ((yield* currentModel(retainedCorpus)) !== corpus)
								return { status: "not_ready" as const };
							return yield* previewQualityRules(document);
						})
					),
					Effect.catch((error) =>
						Effect.succeed({
							status: "failed" as const,
							error: {
								code:
									error._tag === "TextQualityRuleDocumentError"
										? ("invalid_rules" as const)
										: ("read_failed" as const),
								message: error.message,
								recovery: error.recovery,
								retrySafe: true
							}
						})
					)
				);
			}
		);

		const saveQualityRules = Effect.fn("Workbench.WorkbenchGameText.saveQualityRules")(
			function* (document: TextQualityRuleDocument) {
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
					snapshot?.corpus !== prepared.corpus ||
					snapshot.source.projectRoot !== destination?.projectRoot
				)
					return { status: "not_ready" as const };
				const bytes = new TextEncoder().encode(
					`${JSON.stringify(prepared.document, null, "\t")}\n`
				);
				const write = yield* files.writeFile(path, bytes, { maxBytes: 1_048_576 }).pipe(
					Effect.match({
						onFailure: (error) => ({
							error: {
								code: "write_failed" as const,
								message: error.message,
								recovery: error.recovery,
								retrySafe: error.retrySafe
							},
							status: "failed" as const
						}),
						onSuccess: () => ({ status: "ready" as const })
					})
				);
				return write.status === "ready" ? yield* publishQualityRules(prepared) : write;
			}
		);

		const qualitySearch = Effect.fn("Workbench.WorkbenchGameText.qualitySearch")(
			(request: TextQualitySearchRequest) =>
				currentModel(qualityModel).pipe(
					Effect.map((model) =>
						model === undefined
							? { status: "not_ready" as const }
							: { page: model.search(request), status: "ready" as const }
					)
				)
		);

		const qualityFocus = Effect.fn("Workbench.WorkbenchGameText.qualityFocus")(
			(request: TextQualityFocusRequest) =>
				currentModel(qualityModel).pipe(
					Effect.map((model) => {
						if (model === undefined) return { status: "not_ready" as const };
						const result = model.focus(request);
						return result === undefined
							? { status: "not_found" as const }
							: { focus: result, status: "found" as const };
					})
				)
		);

		const captureInvestigation = Effect.fn("Workbench.GameText.captureInvestigation")(
			function* (query: GameTextInvestigationQuery) {
				const snapshot = yield* Ref.get(investigationSnapshot);
				const current = yield* project.current();
				if (
					!snapshot ||
					current.status !== "ready" ||
					current.project.projectRoot !== snapshot.source.projectRoot ||
					(current.project.generation ?? 0) !== snapshot.source.generation
				)
					return yield* Effect.fail(
						new InvestigationError({
							message: "No current scan is available.",
							recovery: "Refresh this workspace before saving or exporting."
						})
					);
				const preset: GameTextInvestigationPreset = {
					schemaVersion: 1,
					kind: "game_text",
					sort: "domain_order",
					query,
					...(snapshot.rules ? { rules: snapshot.rules } : undefined)
				};
				const document = yield* exportGameTextInvestigation(
					snapshot.corpus,
					preset,
					snapshot.source
				);
				return { document, corpus: snapshot.corpus };
			}
		);
		const investigationExport = Effect.fn("Workbench.GameText.investigationExport")(
			(query: GameTextInvestigationQuery, format: InvestigationFormat) =>
				captureInvestigation(query).pipe(
					Effect.flatMap(({ document, corpus }) =>
						saveInvestigation(dialog, {
							contents:
								format === "json"
									? JSON.stringify(document, null, "\t") + "\n"
									: document.result.mode === "corpus"
										? gameTextCsv(document.result.corpus, corpus)
										: gameTextQualityCsv(document.result.report, corpus),
							extension: format,
							rowCount:
								format === "json"
									? document.result.mode === "corpus"
										? document.result.corpus.units.length
										: document.result.report.findings.length
									: document.result.mode === "corpus"
										? document.result.corpus.units.reduce(
												(count, unit) => count + unit.occurrences.length,
												0
											)
										: document.result.report.findings.reduce(
												(count, finding) =>
													count + finding.affectedOccurrences.length,
												0
											)
						})
					),
					Effect.catch((error) => Effect.succeed(investigationFailure(error)))
				)
		);
		const investigationSave = Effect.fn("Workbench.GameText.investigationSave")(
			(query: GameTextInvestigationQuery) =>
				captureInvestigation(query).pipe(
					Effect.flatMap(({ document }) =>
						saveInvestigation(dialog, {
							contents: JSON.stringify(document.preset, null, "\t") + "\n",
							extension: "json",
							rowCount: 0,
							projectRoot: document.source.projectRoot
						})
					),
					Effect.catch((error) => Effect.succeed(investigationFailure(error)))
				)
		);
		const investigationOpen = Effect.fn("Workbench.GameText.investigationOpen")(() =>
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
						snapshot ? { source: snapshot.source, corpus: snapshot.corpus } : undefined
					);
				}
				yield* Ref.set(qualityRulePath, undefined);
				return opened;
			}).pipe(Effect.catch((error) => Effect.succeed(investigationFailure(error))))
		);

		return WorkbenchGameText.of({
			investigationExport,
			investigationSave,
			investigationOpen,
			chooseAndRefresh,
			chooseAndScan,
			configuredRefresh,
			configuredScan,
			focus,
			progress,
			search,
			chooseQualityRules,
			reloadQualityRules,
			createStarterRules,
			qualityFocus,
			qualitySearch,
			previewQualityRules,
			saveQualityRules
		});
	})
);

export function makeWorkbenchGameTextTestLayer(
	service: Pick<WorkbenchGameTextApi, "chooseAndScan" | "configuredScan"> &
		Partial<Omit<WorkbenchGameTextApi, "chooseAndScan" | "configuredScan">>
): Layer.Layer<WorkbenchGameText> {
	return Layer.succeed(
		WorkbenchGameText,
		WorkbenchGameText.of({
			investigationExport: () => Effect.succeed({ status: "cancelled" }),
			investigationSave: () => Effect.succeed({ status: "cancelled" }),
			investigationOpen: () => Effect.succeed({ status: "cancelled" }),
			chooseAndRefresh: () => Effect.succeed({ status: "not_configured" }),
			configuredRefresh: () => Effect.succeed({ status: "not_configured" }),
			focus: () => Effect.succeed({ status: "not_ready" }),
			chooseQualityRules: () => Effect.succeed({ status: "not_ready" }),
			reloadQualityRules: () => Effect.succeed({ status: "not_ready" }),
			createStarterRules: () => Effect.succeed({ status: "not_ready" }),
			progress: () =>
				Effect.succeed({
					completed: 0,
					phase: "idle",
					stage: "game_text",
					total: 0
				}),
			search: () => Effect.succeed({ status: "not_ready" }),
			qualityFocus: () => Effect.succeed({ status: "not_ready" }),
			qualitySearch: () => Effect.succeed({ status: "not_ready" }),
			previewQualityRules: () => Effect.succeed({ status: "not_ready" }),
			saveQualityRules: () => Effect.succeed({ status: "not_ready" }),
			...service
		})
	);
}
