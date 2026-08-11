import {
	ConfigExplorer,
	ConfigFamily,
	ConfigKey,
	ConfigPlatform,
	ConfigSection,
	type ConfigExplorerError
} from "@ue-shed/config-explorer";
import { Context, Effect, Layer } from "effect";
import { join } from "node:path";
import type { ConfigExplorerQuery, ConfigExplorerQueryResult } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchConfigExplorerShape {
	readonly query: (request: ConfigExplorerQuery) => Effect.Effect<ConfigExplorerQueryResult>;
}

export class WorkbenchConfigExplorer extends Context.Service<
	WorkbenchConfigExplorer,
	WorkbenchConfigExplorerShape
>()("@ue-shed/workbench/WorkbenchConfigExplorer") {}

function publicFailure(error: ConfigExplorerError): ConfigExplorerQueryResult {
	return {
		error: {
			code: error.code,
			message: error.message,
			recovery: error.recovery,
			retrySafe: error.retrySafe,
			...(error.candidates === undefined ? {} : { candidates: error.candidates })
		},
		status: "failed"
	};
}

export const WorkbenchConfigExplorerLive = Layer.effect(
	WorkbenchConfigExplorer,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const explorer = yield* ConfigExplorer;
		const project = yield* WorkbenchProject;

		const query: WorkbenchConfigExplorerShape["query"] = Effect.fn(
			"Workbench.WorkbenchConfigExplorer.query"
		)(function* (request: ConfigExplorerQuery) {
			let target: {
				readonly engineRoot?: string;
				readonly projectName: string;
				readonly projectRoot: string;
			};
			if (request.source === "sample_fixture") {
				if (configuration.sourceCheckout.status !== "configured") {
					return {
						error: {
							code: "sample_unavailable" as const,
							message: "The committed Config Explorer sample is unavailable.",
							recovery:
								"Launch Workbench through pnpm showcase from a source checkout.",
							retrySafe: false
						},
						status: "failed" as const
					};
				}
				const fixtureRoot = join(
					configuration.sourceCheckout.path,
					"packages",
					"config-explorer",
					"fixtures",
					"config-source"
				);
				target = {
					engineRoot: fixtureRoot,
					projectName: "UE Shed config fixture",
					projectRoot: fixtureRoot
				};
			} else {
				const selected = yield* project.selectedProject().pipe(
					Effect.map((value) => ({ status: "ready" as const, value })),
					Effect.catch((error) =>
						Effect.succeed({
							error: {
								code: "project_unavailable" as const,
								message: error.message,
								recovery: error.recovery,
								retrySafe: true
							},
							status: "failed" as const
						})
					)
				);
				if (selected.status === "failed") return selected;
				target = {
					...selected.value,
					...(configuration.unrealEngineRoot?.status === "configured"
						? { engineRoot: configuration.unrealEngineRoot.path }
						: {})
				};
			}

			const common = {
				project: target.projectRoot,
				section: ConfigSection.make(request.section),
				key: ConfigKey.make(request.key),
				...(request.family === undefined
					? {}
					: { family: ConfigFamily.make(request.family) }),
				...(target.engineRoot === undefined ? {} : { engineRoot: target.engineRoot })
			};

			if (request.mode === "explain") {
				return yield* explorer
					.explain({
						...common,
						platform: ConfigPlatform.make(request.platform)
					})
					.pipe(
						Effect.map((evidence) => ({
							evidence,
							mode: "explain" as const,
							projectName: target.projectName,
							source: request.source,
							status: "ready" as const
						})),
						Effect.catch((error) => Effect.succeed(publicFailure(error)))
					);
			}
			return yield* explorer
				.compare({
					...common,
					leftPlatform: ConfigPlatform.make(request.leftPlatform),
					rightPlatform: ConfigPlatform.make(request.rightPlatform)
				})
				.pipe(
					Effect.map((evidence) => ({
						evidence,
						mode: "compare" as const,
						projectName: target.projectName,
						source: request.source,
						status: "ready" as const
					})),
					Effect.catch((error) => Effect.succeed(publicFailure(error)))
				);
		});

		return WorkbenchConfigExplorer.of({ query });
	})
);

export function makeWorkbenchConfigExplorerTestLayer(
	service: WorkbenchConfigExplorerShape
): Layer.Layer<WorkbenchConfigExplorer> {
	return Layer.succeed(WorkbenchConfigExplorer, WorkbenchConfigExplorer.of(service));
}
