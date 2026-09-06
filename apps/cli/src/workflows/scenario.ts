import { Effect, Layer } from "effect";
import type { ScenarioRunnerApi } from "@ue-shed/scenarios";
import { readScenarioDocumentFile } from "@ue-shed/scenarios/files";
import { CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type ScenarioRunCommand = Extract<CliCommand, { readonly _tag: "ScenarioRun" }>;

export function executeScenarioCommand(
	command: ScenarioRunCommand,
	runner: Pick<ScenarioRunnerApi, "run">
) {
	return Effect.gen(function* () {
		const document =
			command.document === undefined
				? undefined
				: yield* readScenarioDocumentFile(command.document);
		const result = yield* runner.run({
			...(document === undefined ? undefined : { document }),
			endpoint: command.endpoint,
			...(command.evidenceLimit === undefined
				? undefined
				: { evidenceLimit: command.evidenceLimit })
		});
		yield* printJson(result);
		if (result.status === "failed" || result.status === "cancelled") {
			const runtime = yield* CliRuntime;
			yield* runtime.setExitCode(1);
		}
	});
}

export const runScenario = Effect.fn("Cli.workflow.scenario_run")((command: ScenarioRunCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const { ScenarioRunner, ScenarioRunnerLive } = yield* Effect.promise(
				() => import("@ue-shed/scenarios")
			);
			const { EditorPlaySessionLive } = yield* Effect.promise(
				() => import("@ue-shed/engine")
			);
			const { RemoteControlClientLive } = yield* Effect.promise(
				() => import("@ue-shed/unreal-connection")
			);
			const dependencies = Layer.merge(
				RemoteControlClientLive,
				EditorPlaySessionLive.pipe(Layer.provide(RemoteControlClientLive))
			);
			const program = Effect.gen(function* () {
				const runner = yield* ScenarioRunner;
				yield* executeScenarioCommand(command, runner);
			});
			return yield* program.pipe(
				Effect.provide(ScenarioRunnerLive.pipe(Layer.provide(dependencies)))
			);
		})
	)
);
