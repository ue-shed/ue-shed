import { Effect, Schema } from "effect";
import {
	InvestigationError,
	investigationReplayCommand
} from "@ue-shed/unreal-assets/investigation";
import type { GameTextWorkspaceFileHooks } from "./workspace-host.js";

const PRESET_LIMIT = 4 * 1024 * 1024;
const EXPORT_LIMIT = 512 * 1024 * 1024;

export const investigationFailure = (error: {
	readonly message: string;
	readonly recovery?: string;
}) => ({
	status: "failed" as const,
	message: error.message,
	recovery: error.recovery ?? "Try the file operation again."
});

/** Asks the host for a destination and writes an investigation export or preset through it. */
export const saveWorkspaceInvestigation = Effect.fn("GameText.workspace.investigation.save")(
	function* (
		files: GameTextWorkspaceFileHooks,
		options: {
			readonly contents: string;
			readonly extension: "json" | "csv";
			readonly rowCount: number;
			readonly projectRoot?: string;
		}
	) {
		const bytes = new TextEncoder().encode(options.contents);
		if (options.projectRoot && bytes.byteLength > PRESET_LIMIT)
			return yield* Effect.fail(
				new InvestigationError({
					retrySafe: true,
					nextStep: "fix_input",
					message: "The preset exceeds 4 MiB.",
					recovery: "Reduce the rule document before saving this preset."
				})
			);
		const choice = yield* files.chooseSaveFile({
			title: options.projectRoot ? "Save investigation preset" : "Export matching results",
			defaultPath: options.projectRoot
				? "investigation.preset.json"
				: `investigation.${options.extension}`,
			filters: [{ name: options.extension.toUpperCase(), extensions: [options.extension] }]
		});
		if (choice.status === "cancelled") return choice;
		yield* files.writeFile(choice.path, bytes, { maxBytes: EXPORT_LIMIT });
		return {
			status: "saved" as const,
			path: choice.path,
			rowCount: options.rowCount,
			...(options.projectRoot
				? {
						replayCommand: investigationReplayCommand(options.projectRoot, choice.path)
					}
				: undefined)
		};
	},
	Effect.catch((error) => Effect.succeed(investigationFailure(error)))
);

/** Asks the host for a preset file, then reads and decodes it. */
export const openWorkspaceInvestigation = Effect.fn("GameText.workspace.investigation.open")(
	function* <A, I>(files: GameTextWorkspaceFileHooks, schema: Schema.Codec<A, I>) {
		const choice = yield* files
			.chooseFile({
				title: "Open investigation preset",
				filters: [{ name: "Investigation preset", extensions: ["json"] }]
			})
			.pipe(
				Effect.mapError(
					(error) =>
						new InvestigationError({
							cause: error,
							retrySafe: true,
							nextStep: "fix_input",
							message: error.message,
							recovery: "Try opening the preset again."
						})
				)
			);
		if (choice.status === "cancelled") return choice;
		const bytes = yield* files.readFile(choice.path, { maxBytes: PRESET_LIMIT }).pipe(
			Effect.mapError(
				(error) =>
					new InvestigationError({
						cause: error,
						retrySafe: true,
						nextStep: "fix_input",
						message: error.message,
						recovery: "Choose a preset of at most 4 MiB that can be read."
					})
			)
		);
		const preset = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
			new TextDecoder().decode(bytes)
		).pipe(
			Effect.mapError(
				(error) =>
					new InvestigationError({
						cause: error,
						retrySafe: true,
						nextStep: "fix_input",
						message: `Invalid investigation preset: ${error.message}`,
						recovery: "Choose a version 1 preset for this workspace."
					})
			)
		);
		return { status: "opened" as const, path: choice.path, preset };
	}
);
