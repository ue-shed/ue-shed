import { Effect, Metric, Schema, Stream } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationOperations,
	LocalizationOperationsNodeLive,
	LocalizationOperationError,
	LocalizationRunRequest,
	LocalizationTargetName,
	localizationOperationError,
	type LocalizationError
} from "@ue-shed/localization";
import { CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type LocalizationRunCommand = Extract<CliCommand, { readonly _tag: "LocalizationRun" }>;
class LocalizationRunConfigurationError extends Schema.TaggedErrorClass<LocalizationRunConfigurationError>()(
	"LocalizationRunConfigurationError",
	{
		code: Schema.Literal("invalid_configuration"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}
const LocalizationRunFailure = Schema.Union([
	LocalizationOperationError,
	LocalizationRunConfigurationError
]);
function discoveryFailure(error: LocalizationError): LocalizationOperationError {
	switch (error.code) {
		case "file_missing":
			return localizationOperationError("missing_config");
		case "file_unreadable":
		case "directory_unreadable":
			return localizationOperationError("io_failed");
		case "unsafe_path":
		case "limit_exceeded":
			return localizationOperationError(error.code);
		case "file_changed":
			return localizationOperationError("config_changed");
		default:
			return localizationOperationError("unsupported_config");
	}
}
export const runLocalizationOperation = Effect.fn("Cli.workflow.localization_run")(
	(command: LocalizationRunCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const work = Effect.gen(function* () {
					const name = yield* Schema.decodeUnknownEffect(LocalizationTargetName)(
						command.target
					).pipe(Effect.mapError(() => localizationOperationError("invalid_request")));
					const reader = yield* LocalizationEvidence;
					const discovery = yield* reader
						.discover({ projectRoot: command.projectRoot })
						.pipe(Effect.mapError(discoveryFailure));
					const target = discovery.targets.find((item) => item.name === name);
					if (!target)
						return yield* Effect.fail(localizationOperationError("target_not_found"));
					const input: LocalizationRunRequest = {
						target,
						projectRoot: command.projectRoot,
						operation: command.operation,
						timeoutSeconds: command.timeout
					};
					if (command.engineRoot !== undefined)
						Object.assign(input, { explicitEngineRoot: command.engineRoot });
					const request = yield* Schema.decodeUnknownEffect(LocalizationRunRequest)(
						input
					).pipe(Effect.mapError(() => localizationOperationError("invalid_request")));
					const operations = yield* LocalizationOperations;
					if (command.plan) return yield* printJson(yield* operations.plan(request));
					yield* operations.run(request).pipe(
						Stream.runForEach((event) => {
							if (event.type === "receipt")
								return (
									command.json
										? runtime.print(`${JSON.stringify(event)}\n`)
										: printJson(event)
								).pipe(
									Effect.andThen(
										runtime.setExitCode(event.status === "completed" ? 0 : 2)
									)
								);
							if (command.json) return runtime.print(`${JSON.stringify(event)}\n`);
							if (event.type === "process_started")
								return runtime.printError("Unreal localization process started.\n");
							return runtime.printError(
								`${event.phase}: ${event.kind} (${event.stepIndex + 1}/${event.stepTotal})\n`
							);
						})
					);
				});
				yield* work.pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.provide(LocalizationOperationsNodeLive),
					Effect.catchTag("ConfigError", () =>
						Effect.fail(
							new LocalizationRunConfigurationError({
								code: "invalid_configuration",
								message: "Localization operation configuration could not be read.",
								recovery:
									"Check CLI flags and the ProgramFiles / ProgramData environment configuration; correct malformed values and run --plan again.",
								retrySafe: true
							})
						)
					),
					Effect.catch((error) =>
						Effect.gen(function* () {
							yield* Metric.update(
								Metric.counter("cli.localization.operations.failures"),
								1
							);
							yield* Effect.annotateCurrentSpan({ code: error.code });
							const output = {
								schemaVersion: 1,
								type: "failure",
								error: Schema.encodeSync(LocalizationRunFailure)(error)
							};
							if (command.json) yield* runtime.print(`${JSON.stringify(output)}\n`);
							else yield* printJson(output);
							yield* runtime.setExitCode(2);
						})
					)
				);
			})
		)
);
