import {
	GameTextIndexError,
	SnapshotStoreError,
	SnapshotFormatError
} from "@ue-shed/game-text/index";
import { refreshCliGameTextIndex, invalidateCliGameTextIndex } from "./game-text-index.js";
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
import { localizationKeyChangesAcross } from "@ue-shed/game-text/corpus";
import { type LocalizationJoin } from "@ue-shed/game-text/schema";
import { LocalizationChangeSet } from "@ue-shed/localization";
import { CliRuntime, printJson } from "../cli-runtime.js";
import {
	LocalizationCheckOutputError,
	writeLocalizationCheckChanges
} from "./localization-check.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type LocalizationRunCommand = Extract<CliCommand, { readonly _tag: "LocalizationRun" }>;
class LocalizationRunConfigurationError extends Schema.TaggedError<LocalizationRunConfigurationError>()(
	"LocalizationRunConfigurationError",
	{
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		cause: Schema.optionalKey(Schema.Defect()),
		code: Schema.Literal("invalid_configuration"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}
const LocalizationRunFailure = Schema.Union([
	GameTextIndexError,
	SnapshotStoreError,
	SnapshotFormatError,
	LocalizationOperationError,
	LocalizationRunConfigurationError,
	LocalizationCheckOutputError
]);
/**
 * The translations of keys that changed in the gather, as a change set for the new keys. Pairs
 * whose text changed too are left out: those translations were written for the earlier text.
 */
function carriedChanges(before: LocalizationJoin, after: LocalizationJoin) {
	const { pairs, ambiguous } = localizationKeyChangesAcross(before, after);
	const sources = new Map(
		after.lines.flatMap((line) =>
			line.identity === null
				? []
				: [
						[
							JSON.stringify([line.identity.namespace, line.identity.key]),
							line.manifest[0]?.source.Text
						]
					]
		)
	);
	const carried = pairs.filter((item) => !item.sourceChanged);
	const changes = carried.flatMap((item) => {
		const source = sources.get(JSON.stringify([item.to.namespace, item.to.key]));
		return source === undefined
			? []
			: item.translations.map((translation) => ({
					target: after.target,
					culture: translation.culture,
					namespace: item.to.namespace,
					key: item.to.key,
					source,
					previousTranslation: null,
					translation: translation.translation
				}));
	});
	return {
		changes,
		keys: carried.length,
		textChanged: pairs.length - carried.length,
		ambiguous
	};
}

function discoveryFailure(error: LocalizationError): LocalizationOperationError {
	switch (error.code) {
		case "file_missing":
			return localizationOperationError("missing_config", error);
		case "file_unreadable":
		case "directory_unreadable":
			return localizationOperationError("io_failed", error);
		case "unsafe_path":
		case "limit_exceeded":
			return localizationOperationError(error.code, error);
		case "file_changed":
			return localizationOperationError("config_changed", error);
		default:
			return localizationOperationError("unsupported_config", error);
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
					).pipe(
						Effect.mapError((cause) =>
							localizationOperationError("invalid_request", cause)
						)
					);
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
					).pipe(
						Effect.mapError((cause) =>
							localizationOperationError("invalid_request", cause)
						)
					);
					const operations = yield* LocalizationOperations;
					if (command.plan) return yield* printJson(yield* operations.plan(request));
					// Unreal trims the archive translations of keys that leave the manifest, so a
					// carry reads the target's files before the gather and again after it.
					const before =
						command.carry === undefined
							? undefined
							: yield* (yield* refreshCliGameTextIndex(
									{
										projectRoot: command.projectRoot,
										targetName: target.name,
										savedPackages: false
									},
									undefined
								).pipe(
									Effect.mapError(
										(cause) =>
											new LocalizationOperationError({
												cause: cause,
												...localizationOperationError("io_failed"),
												message: cause.message,
												recovery: cause.recovery,
												// No Unreal process has started yet.
												retrySafe: true
											})
									)
								)).localizationJoin;
					let completed = false;
					yield* operations.run(request).pipe(
						Stream.runForEach((event) => {
							if (event.type === "receipt") {
								completed = event.status === "completed";
								return (
									command.json
										? runtime.print(`${JSON.stringify(event)}\n`)
										: printJson(event)
								).pipe(
									Effect.andThen(
										runtime.setExitCode(event.status === "completed" ? 0 : 2)
									)
								);
							}
							if (command.json) return runtime.print(`${JSON.stringify(event)}\n`);
							if (event.type === "process_started")
								return runtime.printError("Unreal localization process started.\n");
							return runtime.printError(
								`${event.phase}: ${event.kind} (${event.stepIndex + 1}/${event.stepTotal})\n`
							);
						})
					);
					if (completed)
						yield* invalidateCliGameTextIndex({
							projectRoot: command.projectRoot,
							targetName: target.name,
							changedFiles: [
								...Object.values(target.outputPaths.archives),
								...Object.values(target.outputPaths.portableObjects),
								...(target.outputPaths.manifest
									? [target.outputPaths.manifest]
									: [])
							]
						}).pipe(
							Effect.catch((cause) =>
								Effect.logWarning(
									"Game Text write succeeded but cache invalidation failed",
									{ message: cause.message, recovery: cause.recovery }
								)
							)
						);
					if (before === undefined || command.carry === undefined || !completed) return;
					const after = yield* (yield* refreshCliGameTextIndex(
						{
							projectRoot: command.projectRoot,
							targetName: target.name,
							savedPackages: false
						},
						undefined
					).pipe(
						Effect.mapError(
							(cause) =>
								new LocalizationOperationError({
									cause: cause,
									...localizationOperationError("io_failed"),
									message: cause.message,
									recovery: cause.recovery
								})
						)
					)).localizationJoin;
					const carry = carriedChanges(before, after);
					if (carry.changes.length > 0)
						yield* writeLocalizationCheckChanges(
							command.carry,
							LocalizationChangeSet.make({
								schemaVersion: 1,
								provenance: { producer: "ue-shed loc run --carry", files: [] },
								changes: carry.changes
							})
						);
					yield* Metric.update(
						Metric.counter("cli.localization.carried"),
						carry.changes.length
					);
					const summary = {
						schemaVersion: 1,
						type: "carry",
						path: carry.changes.length > 0 ? command.carry : null,
						keys: carry.keys,
						changes: carry.changes.length,
						textChanged: carry.textChanged,
						ambiguous: carry.ambiguous
					};
					if (command.json) yield* runtime.print(`${JSON.stringify(summary)}\n`);
					else yield* printJson(summary);
				});
				yield* work.pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.provide(LocalizationOperationsNodeLive),
					Effect.catchTag("ConfigError", () =>
						Effect.fail(
							new LocalizationRunConfigurationError({
								nextStep: "fix_input",
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
