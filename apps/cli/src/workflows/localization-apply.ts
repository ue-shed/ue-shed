import { Effect, FileSystem, Metric, Result, Schema, Stream } from "effect";
import {
	applyLocalizationChangeSet,
	decodeLocalizationChangeSet,
	LocalizationChangeSetError,
	LocalizationChangeSetReceipt,
	LocalizationError,
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationFileAccessLive,
	LocalizationOperationError,
	LocalizationOperations,
	LocalizationOperationsNodeLive,
	LocalizationRunRequest,
	localizationOperationError,
	reviewLocalizationChangeSet
} from "@ue-shed/localization";
import { CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type LocalizationApplyCommand = Extract<CliCommand, { readonly _tag: "LocalizationApply" }>;

const maxChangeSetBytes = 8 * 1024 * 1024;

class LocalizationApplyInputError extends Schema.TaggedErrorClass<LocalizationApplyInputError>()(
	"LocalizationApplyInputError",
	{
		code: Schema.Literals(["change_set_unreadable", "change_set_too_large"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

const LocalizationApplyFailure = Schema.Union([
	LocalizationApplyInputError,
	LocalizationChangeSetError,
	LocalizationError,
	LocalizationOperationError
]);

const readChangeSet = Effect.fn("Cli.localization.read_change_set")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	const unreadable = () =>
		new LocalizationApplyInputError({
			code: "change_set_unreadable",
			message: "The change-set file could not be read as UTF-8.",
			recovery: "Pass an existing UTF-8 JSON change set produced by UE Shed."
		});
	const stat = yield* fs.stat(path).pipe(Effect.mapError(unreadable));
	if (stat.size > maxChangeSetBytes)
		return yield* Effect.fail(
			new LocalizationApplyInputError({
				code: "change_set_too_large",
				message: "The change-set file is larger than 8 MB.",
				recovery: "Split the change set into smaller files."
			})
		);
	const text = yield* fs.readFileString(path).pipe(Effect.mapError(unreadable));
	const decoded = decodeLocalizationChangeSet(text);
	return Result.isFailure(decoded) ? yield* Effect.fail(decoded.failure) : decoded.success;
});

/** Reviews or writes a change set, then optionally asks Unreal to import and compile it. */
export const applyLocalizationChanges = Effect.fn("Cli.workflow.localization_apply")(
	(command: LocalizationApplyCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const work = Effect.gen(function* () {
					const changeSet = yield* readChangeSet(command.changes);
					const reader = yield* LocalizationEvidence;
					const targetName = changeSet.changes[0]?.target;
					const discovery = yield* reader.discover({ projectRoot: command.projectRoot });
					const target = discovery.targets.find((item) => item.name === targetName);
					if (command.review) {
						if (target === undefined)
							return yield* Effect.fail(
								localizationOperationError("target_not_found")
							);
						const evidence = yield* reader.read({
							projectRoot: command.projectRoot,
							target
						});
						const output = {
							schemaVersion: 1,
							type: "review",
							review: reviewLocalizationChangeSet(evidence, changeSet)
						};
						return yield* command.json
							? runtime.print(`${JSON.stringify(output)}\n`)
							: printJson(output);
					}
					const receipt = yield* applyLocalizationChangeSet({
						projectRoot: command.projectRoot,
						changeSet,
						skipStale: command.skipStale
					});
					const output = {
						schemaVersion: 1,
						type: "receipt",
						receipt: Schema.encodeSync(LocalizationChangeSetReceipt)(receipt)
					};
					if (command.json) yield* runtime.print(`${JSON.stringify(output)}\n`);
					else yield* printJson(output);
					if (receipt.status !== "written") {
						yield* runtime.setExitCode(receipt.status === "nothing_to_write" ? 0 : 2);
						return;
					}
					if (!command.sync || target === undefined) return;
					yield* syncAfterWrite(command, target);
				});
				yield* work.pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.provide(LocalizationFileAccessLive),
					Effect.provide(LocalizationOperationsNodeLive),
					Effect.catchTag("ConfigError", () =>
						Effect.fail(localizationOperationError("invalid_request"))
					),
					Effect.catch((error) =>
						Effect.gen(function* () {
							yield* Metric.update(
								Metric.counter("cli.localization.apply.failures"),
								1
							);
							yield* Effect.annotateCurrentSpan({ code: error.code });
							const output = {
								schemaVersion: 1,
								type: "failure",
								error: Schema.encodeSync(LocalizationApplyFailure)(error)
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

const syncAfterWrite = Effect.fn("Cli.localization.sync_after_write")(function* (
	command: LocalizationApplyCommand,
	target: LocalizationRunRequest["target"]
) {
	const runtime = yield* CliRuntime;
	const input: LocalizationRunRequest = {
		target,
		projectRoot: command.projectRoot,
		operation: "sync",
		timeoutSeconds: command.timeout
	};
	if (command.engineRoot !== undefined)
		Object.assign(input, { explicitEngineRoot: command.engineRoot });
	const request = yield* Schema.decodeUnknownEffect(LocalizationRunRequest)(input).pipe(
		Effect.mapError(() => localizationOperationError("invalid_request"))
	);
	const operations = yield* LocalizationOperations;
	yield* operations.run(request).pipe(
		Stream.runForEach((event) => {
			if (event.type === "receipt")
				return (
					command.json ? runtime.print(`${JSON.stringify(event)}\n`) : printJson(event)
				).pipe(Effect.andThen(runtime.setExitCode(event.status === "completed" ? 0 : 2)));
			if (command.json) return runtime.print(`${JSON.stringify(event)}\n`);
			if (event.type === "process_started")
				return runtime.printError("Unreal localization process started.\n");
			return runtime.printError(
				`${event.phase}: ${event.kind} (${event.stepIndex + 1}/${event.stepTotal})\n`
			);
		})
	);
});
