import {
	readLiveTexturePreview,
	TextureAudit,
	type TextureAuditRunResult,
	type TexturePreviewResult
} from "@ue-shed/asset-audits";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import type { WorkbenchWindowError } from "../adapters/electron-window.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchAssetAuditsShape {
	readonly chooseAndScan: () => Effect.Effect<TextureAuditRunResult, WorkbenchWindowError>;
	readonly configuredScan: () => Effect.Effect<TextureAuditRunResult>;
	readonly preview: (objectPath: string) => Effect.Effect<TexturePreviewResult>;
}

export class WorkbenchAssetAudits extends Context.Service<
	WorkbenchAssetAudits,
	WorkbenchAssetAuditsShape
>()("@ue-shed/workbench/WorkbenchAssetAudits") {}

function unavailablePreview(objectPath: string, message: string): TexturePreviewResult {
	return {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		message,
		objectPath,
		reason: "not_connected",
		retrySafe: true,
		status: "unavailable"
	};
}

function unavailableProject(message: string, recovery: string): TextureAuditRunResult {
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
		const textureAudit = yield* TextureAudit;
		const remoteControl = yield* RemoteControlClient;

		const runScan = (projectRoot: string, ruleFile: string, index: SavedAssetScan) =>
			textureAudit.scanFromProjectIndex(index, { projectRoot, ruleFile }).pipe(
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
				return yield* project.index().pipe(
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
				return yield* project.index().pipe(
					Effect.flatMap((index) =>
						runScan(projectChoice.project.projectRoot, ruleFile, index)
					),
					Effect.catch((error) =>
						Effect.succeed(unavailableProject(error.message, error.recovery))
					)
				);
			}
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
							`Live Unreal preview unavailable: ${error.message}`
						)
					)
				)
			);
		});

		return WorkbenchAssetAudits.of({ chooseAndScan, configuredScan, preview });
	})
);

export function makeWorkbenchAssetAuditsTestLayer(
	service: WorkbenchAssetAuditsShape
): Layer.Layer<WorkbenchAssetAudits> {
	return Layer.succeed(WorkbenchAssetAudits, WorkbenchAssetAudits.of(service));
}
