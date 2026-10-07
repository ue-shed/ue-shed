import { join } from "node:path";
import { Effect, FileSystem, Metric, Result, Schema } from "effect";
import { LocalizationChangeSet, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import {
	checkLocalizationTarget,
	decodeGameTextRuleDocumentJson,
	GameTextRuleDocumentError,
	GAME_TEXT_RULES_RELATIVE_PATH
} from "@ue-shed/game-text";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import { loadLocalizationContext } from "./localization.js";

export class LocalizationCheckOutputError extends Schema.TaggedErrorClass<LocalizationCheckOutputError>()(
	"LocalizationCheckOutputError",
	{
		code: Schema.Literals([
			"changes_exists",
			"changes_unwritable",
			"invalid_changes_destination",
			"rules_unreadable"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

/** Exclusive JSON proposal creation. This boundary has no localization-file write capability. */
export const writeLocalizationCheckChanges = Effect.fn("Cli.localization.write_changes")(function* (
	destination: string,
	document: LocalizationChangeSet
) {
	if (!destination.toLowerCase().endsWith(".json"))
		return yield* Effect.fail(
			new LocalizationCheckOutputError({
				code: "invalid_changes_destination",
				message: "The change-set destination must be a JSON file.",
				recovery: "Choose a new .json file for the proposal."
			})
		);
	const fs = yield* FileSystem.FileSystem;
	const json = yield* Schema.encodeEffect(Schema.fromJsonString(LocalizationChangeSet))(
		document
	).pipe(
		Effect.mapError(
			() =>
				new LocalizationCheckOutputError({
					code: "changes_unwritable",
					message: "The suggested changes could not be encoded.",
					recovery: "Regenerate the check report and retry."
				})
		)
	);
	yield* fs.writeFileString(destination, `${json}\n`, { flag: "wx" }).pipe(
		Effect.mapError(
			(error) =>
				new LocalizationCheckOutputError(
					error.reason._tag === "AlreadyExists"
						? {
								code: "changes_exists",
								message: "The change-set destination already exists.",
								recovery:
									"Choose a new JSON destination or retain the existing proposal."
							}
						: {
								code: "changes_unwritable",
								message: "The change-set file could not be created.",
								recovery: "Choose a writable directory and a new JSON filename."
							}
				)
		)
	);
});

export const runLocalizationCheck = Effect.fn("Cli.workflow.localization_check")(
	(command: Extract<CliCommand, { readonly _tag: "LocalizationCheck" }>) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const result = yield* Effect.gen(function* () {
					const {
						corpus,
						join: joined,
						evidence,
						selection
					} = yield* loadLocalizationContext(command);
					const fs = yield* FileSystem.FileSystem;
					const rulesPath = join(command.projectRoot, GAME_TEXT_RULES_RELATIVE_PATH);
					const rules = yield* Effect.gen(function* () {
						if (!(yield* fs.exists(rulesPath))) return undefined;
						return yield* fs
							.readFileString(rulesPath)
							.pipe(Effect.flatMap(decodeGameTextRuleDocumentJson));
					}).pipe(
						Effect.mapError((error) =>
							error instanceof GameTextRuleDocumentError
								? error
								: new LocalizationCheckOutputError({
										code: "rules_unreadable",
										message: "The project quality rules could not be read.",
										recovery:
											"Repair the Game Text rules file or remove it to use all built-ins."
									})
						)
					);
					const options = {
						...(selection.culture === undefined
							? undefined
							: { culture: selection.culture }),
						...(command.checks.length ? { checks: command.checks } : undefined)
					};
					const report = checkLocalizationTarget(
						corpus,
						joined,
						evidence,
						options,
						rules
					);
					if (command.changes !== undefined)
						yield* writeLocalizationCheckChanges(command.changes, report.changes);
					yield* Metric.update(
						Metric.counter("cli.localization.check.findings"),
						report.findings.length
					);
					return report;
				}).pipe(Effect.provide(LocalizationEvidenceNodeLive), Effect.result);
				if (Result.isFailure(result)) {
					yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(2);
					return;
				}
				yield* printJson(result.success);
			})
		)
);
