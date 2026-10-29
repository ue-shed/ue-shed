import { Effect } from "effect";
import {
	localizationFileFormat,
	type LocalizationFileComparisonRequest,
	type LocalizationFileComparisonResult,
	type LocalizationFilePair
} from "./file-comparison.js";
import { GameTextIndexSteps } from "./index-steps.js";
import type { GameTextWorkspaceHost } from "./workspace-host.js";

const failed = (code: string, message: string, recovery: string) =>
	({ status: "failed", code, message, recovery }) as const;

const FILTERS = [{ name: "Unreal localization files", extensions: ["po", "archive", "manifest"] }];

/**
 * `compareLocalizationFiles`: two localization files the person chose, compared in the engine a
 * page at a time. A later page may name only files chosen in this workspace, so a caller cannot
 * have the engine read any other file.
 */
export const makeWorkspaceFileComparison = Effect.fn("GameText.workspace.fileComparison")(
	function* (host: Pick<GameTextWorkspaceHost, "files">) {
		const steps = yield* GameTextIndexSteps;
		return workspaceFileComparison(host, steps.compareTextFiles);
	}
);

/** `compareLocalizationFiles` over a way to compare two files. */
export function workspaceFileComparison(
	host: Pick<GameTextWorkspaceHost, "files">,
	compareTextFiles: GameTextIndexSteps["Service"]["compareTextFiles"]
) {
	const chosen = new Set<string>();
	const choose = (title: string) =>
		host.files.chooseFile({ title, filters: FILTERS }).pipe(
			Effect.map((choice) => {
				if (choice.status === "selected") chosen.add(choice.path);
				return choice.status === "selected" ? choice.path : undefined;
			})
		);
	return Effect.fn("GameText.workspace.compareLocalizationFiles")(
		function* (request: LocalizationFileComparisonRequest) {
			let files: LocalizationFilePair;
			if (request.files === undefined) {
				const before = yield* choose("Choose the older localization file");
				if (before === undefined) return { status: "cancelled" } as const;
				const after = yield* choose("Choose the newer localization file");
				if (after === undefined) return { status: "cancelled" } as const;
				files = { before, after };
			} else files = request.files;
			const named = [files.before, files.after].filter((path) => path !== undefined);
			if (named.length === 0 || named.some((path) => !chosen.has(path)))
				return failed(
					"file_not_chosen",
					"Only files chosen for a comparison can be compared.",
					"Choose the two files again."
				);
			const formats = new Set(named.map(localizationFileFormat));
			const [format] = formats;
			if (format === undefined || formats.size > 1)
				return failed(
					"unsupported_file",
					"Both files must be the same kind of localization file: .po, .archive or .manifest.",
					"Choose two .po, two .archive or two .manifest files."
				);
			const side = (path: string | undefined) =>
				path === undefined ? undefined : { file: path, path };
			const before = side(files.before);
			const after = side(files.after);
			const comparison = yield* compareTextFiles({
				options: { format },
				...(before === undefined ? undefined : { before }),
				...(after === undefined ? undefined : { after }),
				changes: request.changes
			});
			return {
				status: "ready",
				files,
				format,
				counts: comparison.counts,
				total: comparison.total,
				changes: comparison.changes
			} satisfies LocalizationFileComparisonResult;
		},
		// oxlint-disable-next-line anti-slop/no-effect-catch-all -- The contract answers every failure as `failed`, with its code and recovery.
		Effect.catch((error) =>
			Effect.succeed(
				failed(
					("code" in error ? error.code : undefined) ?? "compare_failed",
					error.message,
					error.recovery
				)
			)
		)
	);
}
