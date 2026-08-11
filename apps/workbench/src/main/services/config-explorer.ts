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
import type { ConfigExplorerShowcaseResult } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchConfigExplorerShape {
	readonly showcase: () => Effect.Effect<ConfigExplorerShowcaseResult>;
}

export class WorkbenchConfigExplorer extends Context.Service<
	WorkbenchConfigExplorer,
	WorkbenchConfigExplorerShape
>()("@ue-shed/workbench/WorkbenchConfigExplorer") {}

function publicFailure(error: ConfigExplorerError): ConfigExplorerShowcaseResult {
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

		const showcase = Effect.fn("Workbench.WorkbenchConfigExplorer.showcase")(function* () {
			if (configuration.sourceCheckout.status === "not_configured") {
				return {
					error: {
						code: "showcase_unavailable" as const,
						message: "The committed Config Explorer fixture is unavailable.",
						recovery: "Launch Workbench through pnpm showcase from a source checkout.",
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
			const common = {
				engineRoot: fixtureRoot,
				family: ConfigFamily.make("Game"),
				project: join(fixtureRoot, "FixtureProject.uproject"),
				section: ConfigSection.make("Fixture.Settings")
			};

			return yield* Effect.all(
				{
					comparison: explorer.compare({
						...common,
						key: ConfigKey.make("Entries"),
						leftPlatform: ConfigPlatform.make("PlatformA"),
						rightPlatform: ConfigPlatform.make("PlatformB")
					}),
					explicitEmpty: explorer.explain({
						...common,
						key: ConfigKey.make("ExplicitEmpty"),
						platform: ConfigPlatform.make("PlatformA")
					}),
					redirectInvolvement: explorer.explain({
						...common,
						key: ConfigKey.make("LegacyRedirected"),
						platform: ConfigPlatform.make("PlatformA")
					}),
					scalarReplacement: explorer.explain({
						...common,
						key: ConfigKey.make("Mode"),
						platform: ConfigPlatform.make("PlatformA")
					}),
					unsupportedSyntax: explorer.explain({
						...common,
						key: ConfigKey.make("Unsupported"),
						platform: ConfigPlatform.make("PlatformA")
					})
				},
				{ concurrency: 5 }
			).pipe(
				Effect.map((evidence) => ({ ...evidence, status: "ready" as const })),
				Effect.catch((error) => Effect.succeed(publicFailure(error)))
			);
		});

		return WorkbenchConfigExplorer.of({ showcase });
	})
);

export function makeWorkbenchConfigExplorerTestLayer(
	service: WorkbenchConfigExplorerShape
): Layer.Layer<WorkbenchConfigExplorer> {
	return Layer.succeed(WorkbenchConfigExplorer, WorkbenchConfigExplorer.of(service));
}
