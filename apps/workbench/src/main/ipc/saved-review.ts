import type { SequenceFailureReason } from "@ue-shed/extension-sequencer/contract";
import { AssetReader, isHeaderScanEntry } from "@ue-shed/unreal-assets";
import type { SavedReviewAsset } from "@ue-shed/unreal-assets/saved-review";
import { Effect } from "effect";
import { resolve } from "node:path";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import {
	WorkbenchProject,
	type WorkbenchProjectUnavailable
} from "../services/project-workspace.js";
import type {
	SequenceReadResult,
	SavedReviewInventory
} from "../../shared/saved-review-contract.js";

function sequenceFailureReason(code: string | undefined): SequenceFailureReason {
	switch (code) {
		case "malformed_data":
			return "malformed_package";
		case "unsupported_version":
			return "unsupported_version";
		case "unsupported":
		case "unsupported_format":
		case "unsupported_capability":
			return "unsupported_asset";
		case "executable_missing":
			return "missing_reader";
		default:
			return "reader_failure";
	}
}

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const reader = yield* AssetReader;
	const project = yield* WorkbenchProject;
	const read = Effect.fn("Workbench.SavedReview.readSequence")(
		(assetPath: string): Effect.Effect<SequenceReadResult> =>
			reader.readLevelSequence(assetPath).pipe(
				Effect.map((read): SequenceReadResult => ({ status: "ready", assetPath, ...read })),
				Effect.catchTag("AssetReaderError", (error) =>
					Effect.succeed({
						status: "failed" as const,
						assetPath,
						reason: sequenceFailureReason(error.code),
						message: error.message,
						recovery:
							"Choose an uncooked Level Sequence saved in a supported Unreal version, and verify the configured UAsset reader."
					})
				)
			)
	);
	yield* ipc.register(invokeContracts["saved-review:sequence"], (path) => read(path));
	yield* ipc.register(invokeContracts["saved-review:inventory"], () =>
		Effect.gen(function* (): Effect.fn.Return<
			SavedReviewInventory,
			WorkbenchProjectUnavailable
		> {
			const state = yield* project.current();
			if (state.status !== "ready")
				return {
					status: "not_configured",
					message: "Select an indexed project to follow saved asset references.",
					recovery: "Choose a project and refresh its index."
				};
			const inventory = yield* project.candidates("saved_review");
			return {
				status: "ready",
				generation: inventory.generation,
				projectName: state.project.projectName,
				assets: inventory.assets.filter(isHeaderScanEntry).map(
					(entry): SavedReviewAsset => ({
						packageName: entry.header.package.name,
						assetPath: resolve(state.project.projectRoot, entry.header.path),
						kind: entry.header.exports.some(
							(item) => item.class_name === "LevelSequence"
						)
							? "level_sequence"
							: "blueprint"
					})
				)
			};
		}).pipe(
			Effect.catchTag("WorkbenchProjectUnavailable", (error) =>
				Effect.succeed({
					status: "failed" as const,
					message: error.message,
					recovery: error.recovery
				})
			)
		)
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerSavedReview"));
