import {
	TextureInvestigationPreset,
	type TextureInvestigationQuery,
	type TextureInvestigationPresetResult,
	textureInvestigationPreset,
	exportTextureInvestigation,
	textureInvestigationCsv,
	type TextureAuditRuleSet
} from "@ue-shed/asset-audits";
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
import { WorkbenchUnrealConnection } from "./unreal-connection.js";
import {
	MAX_TEXTURE_PREVIEW_BATCH_SIZE,
	readLiveTexturePreview,
	textureAuditQuery,
	TextureAudit,
	TextureObjectPath,
	type TextureAuditQuery,
	type TextureAuditQueryRunResult,
	type TextureAuditRecordResult,
	type TextureAuditSearchRequest,
	type TextureAuditSearchResult,
	type TextureAuditRunResult,
	type TexturePreviewBatchRequest,
	type TexturePreviewBatchResult,
	type TexturePreviewResult
} from "@ue-shed/asset-audits";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Cache, Context, Data, Duration, Effect, Layer, Ref, Schema } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import type { WorkbenchWindowError } from "../adapters/electron-window.js";
import type { WorkbenchTaskProgress } from "../project-workspace-contract.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { OfflineTexturePreview } from "./offline-texture-preview.js";
import { WorkbenchProject, type WorkbenchProjectCandidates } from "./project-workspace.js";

export interface WorkbenchAssetAuditsApi {
	readonly investigationExport: (
		query: TextureInvestigationQuery,
		format: InvestigationFormat
	) => Effect.Effect<InvestigationFileResult>;
	readonly investigationSave: (
		query: TextureInvestigationQuery
	) => Effect.Effect<InvestigationFileResult>;
	readonly investigationOpen: () => Effect.Effect<TextureInvestigationPresetResult>;
	readonly chooseAndRefresh: () => Effect.Effect<
		TextureAuditQueryRunResult,
		WorkbenchWindowError
	>;
	readonly chooseAndScan: () => Effect.Effect<TextureAuditRunResult, WorkbenchWindowError>;
	readonly configuredRefresh: (refresh?: boolean) => Effect.Effect<TextureAuditQueryRunResult>;
	readonly configuredScan: () => Effect.Effect<TextureAuditRunResult>;
	readonly progress: () => Effect.Effect<WorkbenchTaskProgress>;
	readonly preview: (objectPath: string) => Effect.Effect<TexturePreviewResult>;
	readonly previewOffline: (objectPath: string) => Effect.Effect<TexturePreviewResult>;
	readonly previewOfflineBatch: (
		request: TexturePreviewBatchRequest
	) => Effect.Effect<TexturePreviewBatchResult>;
	readonly record: (objectPath: string) => Effect.Effect<TextureAuditRecordResult>;
	readonly search: (
		request: TextureAuditSearchRequest
	) => Effect.Effect<TextureAuditSearchResult>;
}

export class WorkbenchAssetAudits extends Context.Service<
	WorkbenchAssetAudits,
	WorkbenchAssetAuditsApi
>()("@ue-shed/workbench/WorkbenchAssetAudits") {}

function unavailablePreview(
	objectPath: string,
	reason: Extract<TexturePreviewResult, { status: "unavailable" }>["reason"],
	message: string,
	retrySafe = true
): TexturePreviewResult {
	return {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		message,
		objectPath,
		reason,
		retrySafe,
		status: "unavailable"
	};
}

function unavailableProject(message: string, recovery: string): TextureAuditRunResult {
	return {
		error: { code: "invalid_project", message, recovery, retrySafe: true },
		status: "failed"
	};
}

function unavailableQueryProject(message: string, recovery: string): TextureAuditQueryRunResult {
	return {
		error: { code: "invalid_project", message, recovery, retrySafe: true },
		status: "failed"
	};
}

export const WorkbenchAssetAuditsLive = Layer.effect(
	WorkbenchAssetAudits,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const connection = yield* WorkbenchUnrealConnection;
		const dialog = yield* ElectronDialog;
		const project = yield* WorkbenchProject;
		const offlinePreview = yield* OfflineTexturePreview;
		const textureAudit = yield* TextureAudit;
		const remoteControl = yield* RemoteControlClient;
		const queryModel = yield* Ref.make<TextureAuditQuery | undefined>(undefined);
		const progress = Effect.fn("Workbench.WorkbenchAssetAudits.progress")(function* () {
			const projectProgress = yield* project.progress();
			if (projectProgress.phase === "enumerating" || projectProgress.phase === "scanning") {
				return projectProgress;
			}
			const auditProgress = yield* textureAudit.progress();
			return {
				completed: auditProgress.processedAssets,
				phase: auditProgress.phase,
				stage: "texture_audit" as const,
				total: auditProgress.totalAssets
			};
		});
		const scanAudit = (
			projectRoot: string,
			rules: string | TextureAuditRuleSet,
			index: SavedAssetScan
		) =>
			textureAudit.scanFromProjectIndex(index, {
				projectRoot,
				...(Schema.is(Schema.String)(rules) ? { ruleFile: rules } : { rules })
			});

		const runScan = (projectRoot: string, ruleFile: string, index: SavedAssetScan) =>
			scanAudit(projectRoot, ruleFile, index).pipe(
				Effect.map((report) => ({ report, status: "completed" as const })),
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
			{ readonly source: InvestigationSource; readonly model: TextureAuditQuery } | undefined
		>(undefined);
		const importedRules = yield* Ref.make<
			{ readonly projectRoot: string; readonly rules: TextureAuditRuleSet } | undefined
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
		const runRefresh = (
			projectRoot: string,
			ruleFile: string | TextureAuditRuleSet,
			index: WorkbenchProjectCandidates
		) =>
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
				return yield* scanAudit(projectRoot, ruleFile, index).pipe(
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
							const next = textureAuditQuery(report);
							yield* Ref.set(
								importedRules,
								Schema.is(Schema.String)(ruleFile)
									? undefined
									: { projectRoot, rules: ruleFile }
							);
							yield* Ref.set(investigationSnapshot, {
								source: {
									projectRoot,
									generation: index.generation,
									authority: "project_files"
								},
								model: next
							});
							yield* Ref.set(queryModel, next);
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

		const configuredScan = Effect.fn("Workbench.WorkbenchAssetAudits.configuredScan")(
			function* () {
				if (configuration.textureAuditRules.status !== "configured") {
					return { status: "not_configured" as const };
				}
				const ruleFile = configuration.textureAuditRules.path;
				const current = yield* project.refresh();
				if (current.status === "not_configured" || current.status === "cancelled") {
					return { status: "not_configured" as const };
				}
				if (current.status === "failed") {
					return unavailableProject(current.error.message, current.error.recovery);
				}
				return yield* project.candidates("texture").pipe(
					Effect.flatMap((index) =>
						runScan(current.project.projectRoot, ruleFile, index)
					),
					Effect.catch((error) =>
						Effect.succeed(unavailableProject(error.message, error.recovery))
					)
				);
			}
		);

		const chooseAndScan = Effect.fn("Workbench.WorkbenchAssetAudits.chooseAndScan")(
			function* () {
				const projectChoice = yield* project.choose();
				if (projectChoice.status === "cancelled") return { status: "cancelled" as const };
				if (projectChoice.status === "not_configured") {
					return { status: "not_configured" as const };
				}
				if (projectChoice.status === "failed") {
					return unavailableProject(
						projectChoice.error.message,
						projectChoice.error.recovery
					);
				}
				let ruleFile =
					configuration.textureAuditRules.status === "configured"
						? configuration.textureAuditRules.path
						: undefined;
				if (!ruleFile) {
					const ruleChoice = yield* dialog.chooseFile({
						filters: [{ extensions: ["json"], name: "JSON rule set" }],
						title: "Choose texture audit rules"
					});
					if (ruleChoice.status === "cancelled") return { status: "cancelled" as const };
					ruleFile = ruleChoice.path;
				}
				return yield* project.candidates("texture").pipe(
					Effect.flatMap((index) =>
						runScan(projectChoice.project.projectRoot, ruleFile, index)
					),
					Effect.catch((error) =>
						Effect.succeed(unavailableProject(error.message, error.recovery))
					)
				);
			}
		);

		class QueryKey extends Data.Class<{
			readonly projectRoot: string;
			readonly generation: number;
			readonly ruleFile: string;
		}> {}
		const activeKey = yield* Ref.make<QueryKey | undefined>(undefined);
		const refreshes = yield* Cache.makeWith(
			(key: QueryKey) =>
				Effect.gen(function* () {
					const index = yield* project.candidates("texture");
					if (
						index.summary.projectRoot !== key.projectRoot ||
						index.generation !== key.generation
					)
						return unavailableQueryProject(
							"The selected project changed.",
							"Retry in the selected project."
						);
					const result = yield* runRefresh(key.projectRoot, key.ruleFile, index);
					if (result.status === "completed") yield* Ref.set(activeKey, key);
					return result;
				}).pipe(
					Effect.catch((error) =>
						Effect.succeed(unavailableQueryProject(error.message, error.recovery))
					)
				),
			{ capacity: 2, timeToLive: () => Duration.zero }
		);
		const configuredRefresh = Effect.fn("Workbench.WorkbenchAssetAudits.configuredRefresh")(
			function* (refresh = true) {
				const current = yield* refresh ? project.refresh() : project.current();
				if (current.status === "not_configured" || current.status === "cancelled") {
					return { status: "not_configured" as const };
				}
				if (current.status === "failed") {
					return unavailableQueryProject(current.error.message, current.error.recovery);
				}
				const imported = yield* Ref.get(importedRules);
				if (imported?.projectRoot === current.project.projectRoot) {
					const model = yield* currentModel(queryModel);
					if (!refresh && model)
						return { status: "completed" as const, summary: model.summary() };
					return yield* project.candidates("texture").pipe(
						Effect.flatMap((index) =>
							runRefresh(current.project.projectRoot, imported.rules, index)
						),
						Effect.catch((error) =>
							Effect.succeed(unavailableQueryProject(error.message, error.recovery))
						)
					);
				}
				if (configuration.textureAuditRules.status !== "configured")
					return { status: "not_configured" as const };
				const ruleFile = configuration.textureAuditRules.path;
				const key = new QueryKey({
					projectRoot: current.project.projectRoot,
					generation: current.project.generation ?? 0,
					ruleFile: ruleFile
				});
				const previous = yield* Ref.get(activeKey);
				const model = yield* currentModel(queryModel);
				if (
					!refresh &&
					previous?.projectRoot === key.projectRoot &&
					previous.generation === key.generation &&
					previous.ruleFile === key.ruleFile &&
					model
				) {
					return { status: "completed" as const, summary: model.summary() };
				}
				return yield* Cache.get(refreshes, key);
			}
		);

		const chooseAndRefresh = Effect.fn("Workbench.WorkbenchAssetAudits.chooseAndRefresh")(
			function* () {
				const projectChoice = yield* project.choose();
				if (projectChoice.status === "cancelled") return { status: "cancelled" as const };
				if (projectChoice.status === "not_configured") {
					return { status: "not_configured" as const };
				}
				if (projectChoice.status === "failed") {
					return unavailableQueryProject(
						projectChoice.error.message,
						projectChoice.error.recovery
					);
				}
				let ruleFile =
					configuration.textureAuditRules.status === "configured"
						? configuration.textureAuditRules.path
						: undefined;
				if (!ruleFile) {
					const ruleChoice = yield* dialog.chooseFile({
						filters: [{ extensions: ["json"], name: "JSON rule set" }],
						title: "Choose texture audit rules"
					});
					if (ruleChoice.status === "cancelled") return { status: "cancelled" as const };
					ruleFile = ruleChoice.path;
				}
				return yield* project.candidates("texture").pipe(
					Effect.flatMap((index) =>
						runRefresh(projectChoice.project.projectRoot, ruleFile, index)
					),
					Effect.catch((error) =>
						Effect.succeed(unavailableQueryProject(error.message, error.recovery))
					)
				);
			}
		);

		const search = Effect.fn("Workbench.WorkbenchAssetAudits.search")(
			(request: TextureAuditSearchRequest) =>
				currentModel(queryModel).pipe(
					Effect.map((model) =>
						model === undefined
							? { status: "not_ready" as const }
							: { page: model.search(request), status: "ready" as const }
					)
				)
		);

		const record = Effect.fn("Workbench.WorkbenchAssetAudits.record")((objectPath: string) =>
			currentModel(queryModel).pipe(
				Effect.map((model) => {
					if (model === undefined) return { status: "not_ready" as const };
					const result = model.record(objectPath);
					return result === undefined
						? { status: "not_found" as const }
						: { record: result, status: "found" as const };
				})
			)
		);

		const preview = Effect.fn("Workbench.WorkbenchAssetAudits.preview")(function* (
			objectPath: string
		) {
			const endpoint = yield* connection.endpoint();

			return yield* readLiveTexturePreview({
				endpoint: endpoint,
				objectPath
			}).pipe(
				Effect.provideService(RemoteControlClient, remoteControl),
				Effect.catch((error) =>
					Effect.succeed(
						unavailablePreview(
							objectPath,
							"not_connected",
							`Live Unreal preview unavailable: ${error.message}`
						)
					)
				)
			);
		});

		const previewOfflineBatch = Effect.fn("Workbench.WorkbenchAssetAudits.previewOfflineBatch")(
			function* (request: TexturePreviewBatchRequest) {
				const currentProject = yield* project.current();
				if (currentProject.status !== "ready") {
					return {
						cached: 0,
						generated: 0,
						previews: request.objectPaths.map((objectPath) =>
							unavailablePreview(
								objectPath,
								"offline_unavailable",
								"Choose an Unreal project before generating saved previews.",
								false
							)
						)
					};
				}
				const model = yield* currentModel(queryModel);
				const findingPaths =
					model
						?.search({
							findingsOnly: true,
							pageSize: MAX_TEXTURE_PREVIEW_BATCH_SIZE,
							query: ""
						})
						.records.map((record) => record.objectPath) ?? [];
				const seenPaths = new Set<string>();
				const selectedPath = request.objectPaths[0];
				const prioritizedPaths = [
					...(selectedPath === undefined ? [] : [selectedPath]),
					...findingPaths,
					...request.objectPaths
				]
					.filter((objectPath) => {
						if (seenPaths.has(objectPath)) return false;
						seenPaths.add(objectPath);
						return true;
					})
					.slice(0, MAX_TEXTURE_PREVIEW_BATCH_SIZE);
				const inputs = prioritizedPaths.flatMap((objectPath) => {
					const texture = model?.record(objectPath)?.record;
					return texture
						? [
								{
									objectPath,
									packageFile: texture.filePath,
									projectRoot: currentProject.project.projectRoot
								}
							]
						: [];
				});
				if (inputs.length === 0) {
					return {
						cached: 0,
						generated: 0,
						previews: prioritizedPaths.map((objectPath) =>
							unavailablePreview(
								objectPath,
								"offline_unavailable",
								"Rescan the texture audit before generating saved previews.",
								true
							)
						)
					};
				}
				const batch = yield* offlinePreview.previewBatch(inputs).pipe(
					Effect.catch((error) =>
						Effect.succeed({
							cached: 0,
							generated: 0,
							previews: inputs.map((input) =>
								unavailablePreview(
									input.objectPath,
									"offline_unavailable",
									error.message,
									error.retrySafe
								)
							)
						})
					)
				);
				const byPath = new Map(batch.previews.map((result) => [result.objectPath, result]));
				return {
					cached: batch.cached,
					generated: batch.generated,
					previews: prioritizedPaths.map(
						(objectPath) =>
							byPath.get(objectPath) ??
							unavailablePreview(
								objectPath,
								"offline_unavailable",
								"Rescan the texture audit before generating this saved preview.",
								true
							)
					)
				};
			}
		);

		const previewOffline = Effect.fn("Workbench.WorkbenchAssetAudits.previewOffline")(
			function* (objectPath: string) {
				const decodedPath = yield* Schema.decodeUnknownEffect(TextureObjectPath)(
					objectPath
				).pipe(Effect.orDie);
				const batch = yield* previewOfflineBatch({ objectPaths: [decodedPath] });
				return (
					batch.previews[0] ??
					unavailablePreview(
						objectPath,
						"offline_unavailable",
						"Saved preview generation returned no result.",
						true
					)
				);
			}
		);

		const captureInvestigation = Effect.fn("Workbench.AssetAudits.captureInvestigation")(
			function* (query: TextureInvestigationQuery) {
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
				const preset = yield* textureInvestigationPreset(snapshot.model, query);
				return exportTextureInvestigation(snapshot.model, preset, snapshot.source);
			}
		);
		const investigationExport = Effect.fn("Workbench.AssetAudits.investigationExport")(
			(query: TextureInvestigationQuery, format: InvestigationFormat) =>
				captureInvestigation(query).pipe(
					Effect.flatMap((document) =>
						saveInvestigation(dialog, {
							contents:
								format === "json"
									? JSON.stringify(document, null, "\t") + "\n"
									: textureInvestigationCsv(document),
							extension: format,
							rowCount: document.result.records.length
						})
					),
					Effect.catch((error) => Effect.succeed(investigationFailure(error)))
				)
		);
		const investigationSave = Effect.fn("Workbench.AssetAudits.investigationSave")(
			(query: TextureInvestigationQuery) =>
				captureInvestigation(query).pipe(
					Effect.flatMap((document) =>
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
		const investigationOpen = Effect.fn("Workbench.AssetAudits.investigationOpen")(() =>
			Effect.gen(function* () {
				const opened = yield* openInvestigation(dialog, TextureInvestigationPreset);
				if (opened.status !== "opened") return opened;
				const current = yield* project.current();
				if (current.status !== "ready")
					return investigationFailure({
						message: "Select a project first.",
						recovery: "Open a project, then open this preset."
					});
				const index = yield* project.candidates("texture");
				const applied = yield* runRefresh(
					current.project.projectRoot,
					opened.preset.rules,
					index
				);
				if (applied.status !== "completed")
					return investigationFailure(
						applied.status === "failed"
							? applied.error
							: {
									message: "The project changed.",
									recovery: "Open the preset again in the selected project."
								}
					);
				return opened;
			}).pipe(Effect.catch((error) => Effect.succeed(investigationFailure(error))))
		);

		return WorkbenchAssetAudits.of({
			investigationExport,
			investigationSave,
			investigationOpen,
			chooseAndRefresh,
			chooseAndScan,
			configuredRefresh,
			configuredScan,
			progress,
			preview,
			previewOffline,
			previewOfflineBatch,
			record,
			search
		});
	})
);

export function makeWorkbenchAssetAuditsTestLayer(
	service: Pick<WorkbenchAssetAuditsApi, "chooseAndScan" | "configuredScan" | "preview"> &
		Partial<Omit<WorkbenchAssetAuditsApi, "chooseAndScan" | "configuredScan" | "preview">>
): Layer.Layer<WorkbenchAssetAudits> {
	return Layer.succeed(
		WorkbenchAssetAudits,
		WorkbenchAssetAudits.of({
			investigationExport: () => Effect.succeed({ status: "cancelled" }),
			investigationSave: () => Effect.succeed({ status: "cancelled" }),
			investigationOpen: () => Effect.succeed({ status: "cancelled" }),
			chooseAndRefresh: () => Effect.succeed({ status: "not_configured" }),
			configuredRefresh: () => Effect.succeed({ status: "not_configured" }),
			progress: () =>
				Effect.succeed({
					completed: 0,
					phase: "idle",
					stage: "texture_audit",
					total: 0
				}),
			record: () => Effect.succeed({ status: "not_ready" }),
			previewOffline: (objectPath) =>
				Effect.succeed(
					unavailablePreview(
						objectPath,
						"offline_unavailable",
						"Saved preview is not configured in this test.",
						false
					)
				),
			previewOfflineBatch: (request) =>
				Effect.succeed({
					cached: 0,
					generated: 0,
					previews: request.objectPaths.map((objectPath) =>
						unavailablePreview(
							objectPath,
							"offline_unavailable",
							"Saved preview is not configured in this test.",
							false
						)
					)
				}),
			search: () => Effect.succeed({ status: "not_ready" }),
			...service
		})
	);
}
