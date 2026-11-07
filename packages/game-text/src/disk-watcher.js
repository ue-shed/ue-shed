import { statSync, watch } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
/**
 * Recursive folder watching. Node's `fs.watch` in production; tests inject their own so they
 * can raise events and errors deterministically.
 */
export class DiskWatcher extends Context.Service()("@ue-shed/game-text/DiskWatcher") {
}
const parts = (folder) => folder
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
/**
 * The wanted folder if it exists, else its nearest existing ancestor below the project root,
 * each watched recursively; else the project root itself, watched for its own entries only.
 */
export const watchPoint = (wanted, isFolder) => {
    const path = parts(wanted);
    for (let length = path.length; length > 0; length--) {
        const folder = path.slice(0, length).join("/");
        if (isFolder(folder))
            return { folder, recursive: true };
    }
    return { folder: "", recursive: false };
};
/** An event named `name` (relative to the watch point, when the OS names it) for `wanted`. */
export const watchEvent = (wanted, point, name) => {
    const target = parts(wanted).join("/");
    if (point.folder === target)
        return { kind: "change", path: name };
    if (name === undefined)
        return point.recursive ? { kind: "change", path: undefined } : { kind: "reattach" };
    const path = [...parts(point.folder), ...parts(name)].join("/");
    if (path.startsWith(`${target}/`))
        return { kind: "change", path: path.slice(target.length + 1) };
    if (path !== target && !target.startsWith(`${path}/`))
        return { kind: "ignore" };
    // The wanted folder, or a folder on the way to it, appeared, moved or changed: whatever it
    // holds is unknown.
    return point.recursive ? { kind: "change", path: undefined } : { kind: "reattach" };
};
const isFolder = (projectRoot) => (folder) => {
    try {
        return statSync(join(projectRoot, folder)).isDirectory();
    }
    catch {
        return false;
    }
};
/**
 * `fs.watch(folder, { recursive: true })`, closed when the watching scope closes. A folder that
 * doesn't exist yet is watched from its nearest existing ancestor (see `watchPoint`), moving one
 * level deeper each time the project root gains the next folder, so a review folder created after
 * the watch starts is still followed. The project root is never watched recursively.
 */
export const DiskWatcherNodeLive = Layer.succeed(DiskWatcher, {
    watch: Effect.fn("GameText.diskWatcher.watch")(function* (projectRoot, folder, listener) {
        yield* Effect.acquireRelease(Effect.sync(() => {
            const state = { watcher: undefined, closed: false };
            const exists = isFolder(projectRoot);
            const attach = () => {
                state.watcher?.close();
                state.watcher = undefined;
                if (state.closed)
                    return;
                const point = watchPoint(folder, exists);
                try {
                    state.watcher = watch(join(projectRoot, point.folder), { recursive: point.recursive }, (_event, name) => {
                        const event = watchEvent(folder, point, name === null ? undefined : String(name));
                        if (event.kind === "change")
                            listener.change(event.path);
                        else if (event.kind === "reattach")
                            reattach();
                    });
                    state.watcher.on("error", listener.error);
                }
                catch (cause) {
                    listener.error(cause);
                    return;
                }
                // A folder created while this one was attaching is not missed.
                if (!point.recursive && watchPoint(folder, exists).folder !== point.folder)
                    reattach();
            };
            // Whatever the new folder already holds was not seen: report an unnamed change.
            const reattach = () => {
                attach();
                if (!state.closed)
                    listener.change(undefined);
            };
            attach();
            return state;
        }), (state) => Effect.sync(() => {
            state.closed = true;
            state.watcher?.close();
        }));
    })
});
