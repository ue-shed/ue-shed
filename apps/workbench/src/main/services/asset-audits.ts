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
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import type { WorkbenchWindowError } from "../adapters/electron-window.js";
import type { WorkbenchTaskProgress } from "../project-workspace-contract.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { OfflineTexturePreview } from "./offline-texture-preview.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchAssetAuditsShape {
	readonly chooseAndRefresh: () => Effect.Effect<
		TextureAuditQueryRunResult,
		WorkbenchWindowError
	>;
	readonly chooseAndScan: () => Effect.Effect<TextureAuditRunResult, WorkbenchWindowError>;
	readonly configuredRefresh: () => Effect.Effect<TextureAuditQueryRunResult>;
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
	WorkbenchAssetAuditsShape
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
		const scanAudit = (projectRoot: string, ruleFile: string, index: SavedAssetScan) =>
			textureAudit.scanFromProjectIndex(index, { projectRoot, ruleFile });

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
		const runRefresh = (projectRoot: string, ruleFile: string, index: SavedAssetScan) =>
			scanAudit(projectRoot, ruleFile, index).pipe(
				Effect.flatMap((report) => {
					const next = textureAuditQuery(report);
					return Ref.set(queryModel, next).pipe(
						Effect.as({ summary: next.summary(), status: "completed" as const })
					);
				}),
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

		const configuredScan = Effect.fn("Workbench.WorkbenchAssetAudits.configuredScan")(
			function* () {
				if (configuration.textureAuditRules.status !== "configured") {
					return { status: "not_configured" as const };
				}
				const ruleFile = configuration.textureAuditRules.path;
				const current = yield* project.current();
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

		const configuredRefresh = Effect.fn("Workbench.WorkbenchAssetAudits.configuredRefresh")(
			function* () {
				if (configuration.textureAuditRules.status !== "configured") {
					return { status: "not_configured" as const };
				}
				const ruleFile = configuration.textureAuditRules.path;
				const current = yield* project.current();
				if (current.status === "not_configured" || current.status === "cancelled") {
					return { status: "not_configured" as const };
				}
				if (current.status === "failed") {
					return unavailableQueryProject(current.error.message, current.error.recovery);
				}
				return yield* project.candidates("texture").pipe(
					Effect.flatMap((index) =>
						runRefresh(current.project.projectRoot, ruleFile, index)
					),
					Effect.catch((error) =>
						Effect.succeed(unavailableQueryProject(error.message, error.recovery))
					)
				);
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
				Ref.get(queryModel).pipe(
					Effect.map((model) =>
						model === undefined
							? { status: "not_ready" as const }
							: { page: model.search(request), status: "ready" as const }
					)
				)
		);

		const record = Effect.fn("Workbench.WorkbenchAssetAudits.record")((objectPath: string) =>
			Ref.get(queryModel).pipe(
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
			return yield* readLiveTexturePreview({
				endpoint: configuration.remoteControlEndpoint,
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
				const model = yield* Ref.get(queryModel);
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

		return WorkbenchAssetAudits.of({
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
	service: Pick<WorkbenchAssetAuditsShape, "chooseAndScan" | "configuredScan" | "preview"> &
		Partial<Omit<WorkbenchAssetAuditsShape, "chooseAndScan" | "configuredScan" | "preview">>
): Layer.Layer<WorkbenchAssetAudits> {
	return Layer.succeed(
		WorkbenchAssetAudits,
		WorkbenchAssetAudits.of({
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
