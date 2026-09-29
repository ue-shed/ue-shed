import { Effect } from "effect";
import {
	readSavedBlueprint,
	readSavedLevelSequence,
	compareSavedBlueprints,
	compareSavedSequences,
	blueprintReferences,
	sequenceReferences,
	type SavedReviewOutput
} from "@ue-shed/unreal-assets";
import { printJson } from "./cli-runtime.js";
import { observeCliOperation, readerLayer } from "./cli-operation.js";
import type { CliCommand } from "./command-model.js";

const printReview = (output: SavedReviewOutput) => printJson(output);

export const runSavedReview = Effect.fn("Cli.workflow.saved_review")(
	(command: Extract<CliCommand, { _tag: "SavedReview" }>) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				if (command.domain === "blueprint") {
					const current = yield* readSavedBlueprint({ assetPath: command.path });
					if (command.baseline !== undefined) {
						const baseline = yield* readSavedBlueprint({ assetPath: command.baseline });
						return yield* printReview({
							...compareSavedBlueprints(baseline, current),
							beforePath: command.baseline,
							afterPath: command.path
						});
					}
					return yield* printReview({
						schemaVersion: 1,
						path: command.path,
						...current,
						references: blueprintReferences(current)
					});
				}
				const current = yield* readSavedLevelSequence({ assetPath: command.path });
				if (command.baseline !== undefined) {
					const baseline = yield* readSavedLevelSequence({ assetPath: command.baseline });
					return yield* printReview({
						...compareSavedSequences(baseline, current),
						beforePath: command.baseline,
						afterPath: command.path
					});
				}
				return yield* printReview({
					schemaVersion: 1,
					path: command.path,
					...current,
					references: sequenceReferences(current)
				});
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);
