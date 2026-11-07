import { Effect } from "effect";
import { localizationFileFormat } from "./file-comparison.js";
import { GameTextIndexSteps } from "./index-steps.js";
const failed = (code, message, recovery) => ({ status: "failed", code, message, recovery });
const FILTERS = [{ name: "Unreal localization files", extensions: ["po", "archive", "manifest"] }];
/**
 * `chooseLocalizationFile` and `compareLocalizationFiles`: localization files the person chose,
 * compared in the engine a page at a time. A comparison may name only files chosen in this
 * workspace, so a caller cannot have the engine read any other file.
 */
export const makeWorkspaceFileComparison = Effect.fn("GameText.workspace.fileComparison")(function* (host) {
    const steps = yield* GameTextIndexSteps;
    return workspaceFileComparison(host, steps.compareTextFiles);
});
/** The file comparison methods over a way to compare two files. */
export function workspaceFileComparison(host, compareTextFiles) {
    const chosen = new Set();
    const chooseLocalizationFile = Effect.fn("GameText.workspace.chooseLocalizationFile")(function* (request) {
        const choice = yield* host.files.chooseFile({
            title: request.side === "before"
                ? "Choose the older localization file"
                : "Choose the newer localization file",
            filters: FILTERS
        });
        if (choice.status === "cancelled")
            return choice;
        const format = localizationFileFormat(choice.path);
        if (format === undefined)
            return failed("unsupported_file", "This is not a .po, .archive or .manifest file.", "Choose an Unreal localization file.");
        chosen.add(choice.path);
        return { status: "selected", path: choice.path, format };
    }, 
    // oxlint-disable-next-line anti-slop/no-effect-catch-all -- The contract answers every failure as `failed`, with its code and recovery.
    Effect.catchTag(["GameTextWorkspaceHostFailure"], (error) => Effect.succeed(failed(error.code ?? "choose_failed", error.message, error.recovery))));
    const compareLocalizationFiles = Effect.fn("GameText.workspace.compareLocalizationFiles")(function* (request) {
        const { files } = request;
        const named = [files.before, files.after].filter((path) => path !== undefined);
        if (named.length === 0 || named.some((path) => !chosen.has(path)))
            return failed("file_not_chosen", "Only files chosen for a comparison can be compared.", "Choose the two files again.");
        const formats = new Set(named.map(localizationFileFormat));
        const [format] = formats;
        if (format === undefined || formats.size > 1)
            return failed("unsupported_file", "Both files must be the same kind of localization file: .po, .archive or .manifest.", "Choose two .po, two .archive or two .manifest files.");
        const side = (path) => path === undefined ? undefined : { file: path, path };
        const before = side(files.before);
        const after = side(files.after);
        const comparison = yield* compareTextFiles({
            options: { format },
            ...(before === undefined ? undefined : { before }),
            ...(after === undefined ? undefined : { after }),
            filter: {
                groups: [...(request.filter?.groups ?? [])],
                query: request.filter?.query ?? "",
                preview: request.filter?.preview ?? 0,
                asset: request.filter?.asset ?? ""
            },
            changes: request.changes
        });
        return {
            status: "ready",
            files,
            format,
            counts: comparison.counts,
            listed: comparison.listed,
            total: comparison.total,
            assets: comparison.assets,
            changes: comparison.changes
        };
    }, 
    // oxlint-disable-next-line anti-slop/no-effect-catch-all -- The contract answers every failure as `failed`, with its code and recovery.
    Effect.catchTag(["GameTextIndexError"], (error) => Effect.succeed(failed(("code" in error ? error.code : undefined) ?? "compare_failed", error.message, error.recovery))));
    return { chooseLocalizationFile, compareLocalizationFiles };
}
