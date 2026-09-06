import { Effect, Schema } from "effect";
import {
	InvestigationError,
	investigationReplayCommand,
	type InvestigationFileResult
} from "@ue-shed/unreal-assets/investigation";
import {
	readInvestigationPresetJson,
	writeInvestigationFile
} from "@ue-shed/unreal-assets/investigation-files";
import type { ElectronDialogApi } from "../adapters/electron-dialog.js";

export const investigationFailure = (error: {
	readonly message: string;
	readonly recovery?: string;
}) => ({
	status: "failed" as const,
	message: error.message,
	recovery: error.recovery ?? "Try the file operation again."
});

export const saveInvestigation = Effect.fn("Workbench.Investigation.save")(function* (
	dialog: ElectronDialogApi,
	options: {
		readonly contents: string;
		readonly extension: "json" | "csv";
		readonly rowCount: number;
		readonly projectRoot?: string;
	}
): Effect.fn.Return<InvestigationFileResult> {
	return yield* Effect.gen(function* () {
		if (options.projectRoot && Buffer.byteLength(options.contents, "utf8") > 4 * 1024 * 1024)
			return yield* Effect.fail(
				new InvestigationError({
					message: "The preset exceeds 4 MiB.",
					recovery: "Reduce the rule document before saving this preset."
				})
			);
		const choice = yield* dialog.chooseSaveFile({
			title: options.projectRoot ? "Save investigation preset" : "Export matching results",
			defaultPath: options.projectRoot
				? "investigation.preset.json"
				: `investigation.${options.extension}`,
			filters: [{ name: options.extension.toUpperCase(), extensions: [options.extension] }]
		});
		if (choice.status === "cancelled") return choice;
		yield* writeInvestigationFile(choice.path, options.contents);
		return {
			status: "saved" as const,
			path: choice.path,
			rowCount: options.rowCount,
			...(options.projectRoot
				? { replayCommand: investigationReplayCommand(options.projectRoot, choice.path) }
				: undefined)
		};
	}).pipe(Effect.catch((error) => Effect.succeed(investigationFailure(error))));
});

export const openInvestigation = Effect.fn("Workbench.Investigation.open")(function* <A, I>(
	dialog: ElectronDialogApi,
	schema: Schema.Codec<A, I>
) {
	const choice = yield* dialog
		.chooseFile({
			title: "Open investigation preset",
			filters: [{ name: "Investigation preset", extensions: ["json"] }]
		})
		.pipe(
			Effect.mapError(
				(error) =>
					new InvestigationError({
						message: error.message,
						recovery: "Try opening the preset again."
					})
			)
		);
	if (choice.status === "cancelled") return choice;
	const input = yield* readInvestigationPresetJson(choice.path);
	const preset = yield* Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(
			(error) =>
				new InvestigationError({
					message: `Invalid investigation preset: ${error.message}`,
					recovery: "Choose a version 1 preset for this workspace."
				})
		)
	);
	return { status: "opened" as const, path: choice.path, preset };
});
