import { Effect, Result } from "effect";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type Command = Extract<CliCommand, { readonly _tag: "NiagaraPreview" }>;

export const runNiagaraPreview = Effect.fn("Cli.workflow.niagara_preview")((command: Command) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const { runNiagaraPreview } = yield* Effect.promise(() => import("@ue-shed/niagara"));
			const result = yield* Effect.result(
				runNiagaraPreview({
					...(command.engineRoot === undefined
						? undefined
						: { explicitEngineRoot: command.engineRoot }),
					...(command.outputRoot === undefined
						? undefined
						: { outputRoot: command.outputRoot }),
					...(command.pluginDescriptor === undefined
						? undefined
						: { pluginDescriptor: command.pluginDescriptor }),
					projectDescriptor: command.projectDescriptor,
					...(command.runId === undefined ? undefined : { runId: command.runId }),
					settings: {
						...(command.captureMode === undefined
							? undefined
							: { captureMode: command.captureMode }),
						...(command.durationSeconds === undefined
							? undefined
							: { durationSeconds: command.durationSeconds }),
						...(command.frameCount === undefined
							? undefined
							: { frameCount: command.frameCount }),
						...(command.height === undefined ? undefined : { height: command.height }),
						...(command.simulationFramesPerSecond === undefined
							? undefined
							: {
									simulationFramesPerSecond: command.simulationFramesPerSecond
								}),
						...(command.startSeconds === undefined
							? undefined
							: { startSeconds: command.startSeconds }),
						...(command.width === undefined ? undefined : { width: command.width })
					},
					systemObjectPath: command.systemObjectPath
				})
			);
			const runtime = yield* CliRuntime;
			if (Result.isFailure(result)) {
				yield* printJson({ status: "failed", error: result.failure });
				yield* runtime.setExitCode(2);
				return;
			}
			yield* printJson({ status: "completed", ...result.success });
		})
	)
);
