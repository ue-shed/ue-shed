import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { Effect, Result } from "effect";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

export const runLocalizationTargets = Effect.fn("Cli.workflow.localization_targets")(
	(command: Extract<CliCommand, { readonly _tag: "LocalizationTargets" }>) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const service = yield* LocalizationEvidence;
				const result = yield* service
					.targets({ projectRoot: command.projectRoot })
					.pipe(Effect.result);
				if (Result.isFailure(result)) {
					yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(2);
					return;
				}
				yield* printJson(result.success);
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		)
);
