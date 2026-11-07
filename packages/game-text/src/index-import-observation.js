import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SharedIndex } from "./shared-index.js";
import { encodeWtf8 } from "./wtf8.js";
import { GameTextIndexError } from "./index-contract.js";
const hash = (value) => createHash("sha256")
    .update(encodeWtf8(JSON.stringify(value)))
    .digest("hex");
const fileObservationName = (path) => `localization.observation.${hash(path)}`;
const ordered = (values) => Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
/** Partial imports may reuse historical evidence only while its shared observations still match. */
export const checkRetainedImportObservations = Effect.fn("GameTextIndex.checkRetainedImport")(function* (previous, changedFiles) {
    const writer = yield* (yield* SharedIndex).writer;
    const active = writer.manifest().active;
    const changed = new Set(changedFiles);
    const stale = () => Effect.fail(new GameTextIndexError({
        nextStep: "escalate",
        code: "index_failed",
        operation: "localization",
        retrySafe: true,
        message: "A retained localization input was superseded by another import.",
        recovery: "Import the complete localization target again before rebuilding it."
    }));
    for (const [path, provenance] of Object.entries(previous.input.fileProvenances ?? {})) {
        if (changed.has(path))
            continue;
        const key = previous.dependencies[path];
        const observation = active[fileObservationName(path)];
        if (active[path] !== key ||
            (observation !== undefined && observation !== hash([path, "read", key, provenance])))
            return yield* stale();
    }
    for (const path of Object.keys(previous.input.fileErrors ?? {})) {
        if (changed.has(path))
            continue;
        const error = previous.input.fileDiagnostics?.[path];
        const observation = active[fileObservationName(path)];
        if (observation !== undefined &&
            (!error ||
                observation !==
                    hash([path, "failed", error.code, error.message, error.recovery])))
            return yield* stale();
    }
});
/** Completed observations include failures even when a historical successful layer remains active. */
export const observeGameTextImport = Effect.fn("GameTextIndex.observeImport")(function* (input) {
    const index = yield* SharedIndex;
    const writer = yield* index.writer;
    const active = writer.manifest().active;
    const observations = {};
    for (const file of input.imported.files) {
        observations[fileObservationName(file.relativePath)] = hash([
            file.relativePath,
            "read",
            file.key,
            file.provenance
        ]);
    }
    for (const diagnostic of input.imported.diagnostics) {
        if (diagnostic.relativePath !== null) {
            observations[fileObservationName(diagnostic.relativePath)] = hash([
                diagnostic.relativePath,
                "failed",
                diagnostic.error.code,
                diagnostic.error.message,
                diagnostic.error.recovery
            ]);
        }
    }
    // This pointer belongs to the target view; file observations above are shared across targets.
    observations.imported = hash([
        input.imported.target,
        ordered(input.fileErrors),
        ordered(input.fileDiagnostics).map(([path, error]) => [
            path,
            error.code,
            error.message,
            error.recovery
        ]),
        ordered(input.fileProvenances),
        input.imported.diagnostics.filter((diagnostic) => diagnostic.relativePath === null)
    ]);
    const entries = Object.entries(observations)
        .filter(([name, key]) => active[name] !== key)
        .map(([name, key]) => ({
        name,
        key,
        source: {
            columns: [
                { name: "observation", kind: "bytes", load: async () => Uint8Array.of(1) }
            ]
        }
    }));
    if (entries.length)
        yield* writer.publishBatch(entries);
    const current = writer.manifest().active;
    const paths = new Set([
        ...Object.keys(input.fileProvenances),
        ...Object.keys(input.fileErrors)
    ]);
    const dependencies = { imported: current.imported };
    for (const path of paths) {
        dependencies[path] = current[path];
        const name = fileObservationName(path);
        dependencies[name] = current[name];
    }
    return dependencies;
});
