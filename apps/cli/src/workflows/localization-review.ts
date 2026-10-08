import { Effect, Metric, Result, Schema } from "effect";
import {
	CultureCode,
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationFileAccessLive,
	LocalizationIdentity,
	localizationEvidenceFingerprint,
	readLocalizationReview,
	updateLocalizationReview,
	type LocalizationReviewUpdate
} from "@ue-shed/localization";
import { CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type LocalizationReviewCommand = Extract<CliCommand, { readonly _tag: "LocalizationReview" }>;

class LocalizationReviewCommandError extends Schema.TaggedErrorClass<LocalizationReviewCommandError>()(
	"LocalizationReviewCommandError",
	{
		code: Schema.Literals([
			"invalid_line",
			"invalid_selection",
			"target_not_found",
			"not_gathered"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

const commandError = (
	code: LocalizationReviewCommandError["code"],
	message: string,
	recovery: string
) => new LocalizationReviewCommandError({ code, message, recovery });

/** `Namespace,Key`, splitting on the last unescaped comma so namespaces may contain dots. */
function parseLine(value: string) {
	const comma = value.lastIndexOf(",");
	return Schema.decodeUnknownEffect(LocalizationIdentity)({
		namespace: comma < 0 ? "" : value.slice(0, comma),
		key: comma < 0 ? value : value.slice(comma + 1)
	}).pipe(
		Effect.mapError(() =>
			commandError(
				"invalid_line",
				"A --line value is not a namespace and key.",
				"Pass lines as Namespace,Key (an empty namespace is ,Key)."
			)
		)
	);
}

/** Sets, clears or accepts review state in the target's review file. Never touches Unreal files. */
export const runLocalizationReview = Effect.fn("Cli.workflow.localization_review")(
	(command: LocalizationReviewCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const work = Effect.gen(function* () {
					const reader = yield* LocalizationEvidence;
					const discovery = yield* reader.discover({ projectRoot: command.projectRoot });
					const target = discovery.targets.find((item) => item.name === command.target);
					if (target === undefined)
						return yield* Effect.fail(
							commandError(
								"target_not_found",
								"The selected localization target was not found.",
								"Run loc targets and choose a listed target."
							)
						);
					// Every review flag and finding belongs to one culture's translation.
					const culture = yield* Schema.decodeUnknownEffect(CultureCode)(
						command.culture
					).pipe(
						Effect.mapError(() =>
							commandError(
								"invalid_selection",
								"The culture is invalid.",
								"Choose a culture listed by loc targets."
							)
						)
					);
					if (!target.cultures.includes(culture))
						return yield* Effect.fail(
							commandError(
								"invalid_selection",
								"The target does not include that culture.",
								"Choose a culture listed by loc targets."
							)
						);
					const lines = yield* Effect.forEach(command.lines, parseLine);
					const evidence = yield* reader.read({
						projectRoot: command.projectRoot,
						target
					});
					const fingerprint = (identity: LocalizationIdentity) => {
						const value = localizationEvidenceFingerprint(evidence, culture, identity);
						return value === undefined
							? Effect.fail(
									commandError(
										"not_gathered",
										"A line is not in the target's gathered text.",
										"Gather the target, then review the line."
									)
								)
							: Effect.succeed(value);
					};
					const updates: LocalizationReviewUpdate[] = [];
					for (const identity of lines) {
						switch (command.action) {
							case "set":
								updates.push({
									kind: "set",
									culture,
									...identity,
									flags: command.flags,
									fingerprint: yield* fingerprint(identity)
								});
								break;
							case "clear":
								updates.push({
									kind: "clear",
									culture,
									...identity,
									flags: command.flags
								});
								break;
							case "accept":
								updates.push({
									kind: "accept",
									check: command.check ?? "",
									culture,
									...identity,
									fingerprint: yield* fingerprint(identity)
								});
								break;
							case "unaccept":
								updates.push({
									kind: "unaccept",
									check: command.check ?? "",
									culture,
									...identity
								});
								break;
						}
					}
					const location = {
						projectRoot: command.projectRoot,
						target: target.name,
						path: command.reviewFile
					};
					const snapshot = yield* readLocalizationReview(location);
					const written = yield* updateLocalizationReview(
						location,
						updates,
						{ by: command.by, at: new Date().toISOString() },
						snapshot
					);
					yield* Metric.update(
						Metric.counter("cli.localization.review.updates"),
						updates.length
					);
					yield* printJson({
						schemaVersion: 1,
						status: "written",
						relativePath: written.relativePath,
						records: written.file.records.length,
						acceptedFindings: written.file.acceptedFindings.length
					});
				});
				const result = yield* work.pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.provide(LocalizationFileAccessLive),
					Effect.result
				);
				if (Result.isFailure(result)) {
					const error = result.failure;
					yield* printJson({
						schemaVersion: 1,
						status: "failed",
						error: {
							code: error.code,
							message: error.message,
							recovery: error.recovery
						}
					});
					yield* runtime.setExitCode(2);
				}
			})
		)
);
