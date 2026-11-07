import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { SharedIndex } from "./shared-index.js";
const joinedNames = new Set(["joined", "joined-base", "joined.invalidated", "imported"]);
/**
 * One view of a shared index: target-specific joined pointers over the same package layers and
 * string IDs. It wraps the `SharedIndex` it is provided with.
 */
export function projectIndexViewLayer(view) {
    const identity = view.kind === "source" ? ["source"] : ["localization", view.target];
    const namespace = `target-join.${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.`;
    const name = (value) => (joinedNames.has(value) ? namespace + value : value);
    const names = (values) => values?.map(name);
    const manifest = (value) => {
        const active = Object.fromEntries(Object.entries(value.active).filter(([key]) => !key.startsWith("target-join.")));
        for (const joined of joinedNames) {
            const key = value.active[name(joined)];
            if (key !== undefined)
                active[joined] = key;
        }
        return { ...value, active };
    };
    const reader = (value) => {
        const layerSync = value.layerSync;
        return {
            ...value,
            manifest: manifest(value.manifest),
            layer: (key) => value.layer(name(key)),
            ...(layerSync ? { layerSync: (key) => layerSync(name(key)) } : undefined)
        };
    };
    const writer = (value) => ({
        ...value,
        manifest: () => manifest(value.manifest()),
        publish: (key, hash, source, previous) => value.publish(name(key), hash, source, previous),
        publishIds: (key, hash, source, generation, retained, removed) => value.publishIds(name(key), hash, source, generation, retained &&
            Object.fromEntries(Object.entries(retained).map(([key, hash]) => [name(key), hash])), names(removed)),
        publishBatch: (entries, removed) => value.publishBatch(entries.map((entry) => ({ ...entry, name: name(entry.name) })), names(removed)),
        publishCold: (entries, removed) => value.publishCold(entries.map((entry) => ({ ...entry, name: name(entry.name) })), names(removed))
    });
    return Layer.effect(SharedIndex, Effect.gen(function* () {
        const backing = yield* SharedIndex;
        return SharedIndex.of({
            cached: backing.cached,
            inspect: Effect.suspend(() => backing.inspect.pipe(Effect.map(manifest))),
            open: Effect.suspend(() => backing.open.pipe(Effect.map(reader))),
            writer: Effect.suspend(() => backing.writer.pipe(Effect.map(writer)))
        });
    }));
}
