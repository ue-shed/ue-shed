import { Effect, Schema } from "effect";
import { InvestigationError, investigationReplayCommand } from "@ue-shed/unreal-assets/investigation";
const PRESET_LIMIT = 4 * 1024 * 1024;
const EXPORT_LIMIT = 512 * 1024 * 1024;
export const investigationFailure = (error) => ({
    status: "failed",
    message: error.message,
    recovery: error.recovery ?? "Try the file operation again."
});
/** Asks the host for a destination and writes an investigation export or preset through it. */
export const saveWorkspaceInvestigation = Effect.fn("GameText.workspace.investigation.save")(function* (files, options) {
    const output = "write" in options
        ? { write: options.write }
        : {
            bytes: new TextEncoder().encode(options.contents),
            rowCount: options.rowCount
        };
    if (options.projectRoot && "bytes" in output && output.bytes.byteLength > PRESET_LIMIT)
        return yield* new InvestigationError({
            retrySafe: true,
            nextStep: "fix_input",
            message: "The preset exceeds 4 MiB.",
            recovery: "Reduce the rule document before saving this preset."
        });
    const choice = yield* files.chooseSaveFile({
        title: options.projectRoot ? "Save investigation preset" : "Export matching results",
        defaultPath: options.projectRoot
            ? "investigation.preset.json"
            : `investigation.${options.extension}`,
        filters: [{ name: options.extension.toUpperCase(), extensions: [options.extension] }]
    });
    if (choice.status === "cancelled")
        return choice;
    let rowCount;
    if ("write" in output)
        rowCount = yield* output.write(choice.path);
    else {
        yield* files.writeFile(choice.path, output.bytes, { maxBytes: EXPORT_LIMIT });
        rowCount = output.rowCount;
    }
    return {
        status: "saved",
        path: choice.path,
        rowCount,
        ...(options.projectRoot
            ? {
                replayCommand: investigationReplayCommand(options.projectRoot, choice.path)
            }
            : undefined)
    };
}, Effect.catchTag(["GameTextWorkspaceHostFailure", "InvestigationError"], (error) => Effect.succeed(investigationFailure(error))));
/** Asks the host for a preset file, then reads and decodes it. */
export const openWorkspaceInvestigation = Effect.fn("GameText.workspace.investigation.open")(function* (files, schema) {
    const choice = yield* files
        .chooseFile({
        title: "Open investigation preset",
        filters: [{ name: "Investigation preset", extensions: ["json"] }]
    })
        .pipe(Effect.mapError((error) => new InvestigationError({
        cause: error,
        retrySafe: true,
        nextStep: "fix_input",
        message: error.message,
        recovery: "Try opening the preset again."
    })));
    if (choice.status === "cancelled")
        return choice;
    const bytes = yield* files.readFile(choice.path, { maxBytes: PRESET_LIMIT }).pipe(Effect.mapError((error) => new InvestigationError({
        cause: error,
        retrySafe: true,
        nextStep: "fix_input",
        message: error.message,
        recovery: "Choose a preset of at most 4 MiB that can be read."
    })));
    const preset = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(Effect.mapError((error) => new InvestigationError({
        cause: error,
        retrySafe: true,
        nextStep: "fix_input",
        message: `Invalid investigation preset: ${error.message}`,
        recovery: "Choose a version 1 preset for this workspace."
    })));
    return { status: "opened", path: choice.path, preset };
});
