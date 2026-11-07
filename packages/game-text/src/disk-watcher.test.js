import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { describe, expect } from "vitest";
import { DiskWatcher, DiskWatcherNodeLive, watchEvent, watchPoint } from "./disk-watcher.js";
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)));
describe("DiskWatcherNodeLive", () => {
    it.live("reports changes while its scope is open and none after it closes", () => Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "disk-watcher-")));
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })));
        const folder = join(root, "Content");
        yield* Effect.promise(() => mkdir(folder));
        const seen = [];
        const errors = [];
        const watcher = yield* DiskWatcher;
        const scope = yield* Scope.make();
        yield* watcher
            .watch(root, "Content", {
            change: (path) => void seen.push(path),
            error: (cause) => void errors.push(cause)
        })
            .pipe(Scope.provide(scope));
        yield* Effect.promise(() => writeFile(join(folder, "open.uasset"), "a"));
        yield* settle;
        expect(seen.length).toBeGreaterThan(0);
        yield* Scope.close(scope, Exit.void);
        const before = seen.length;
        yield* Effect.promise(() => writeFile(join(folder, "closed.uasset"), "b"));
        yield* settle;
        expect(seen.length).toBe(before);
        expect(errors).toEqual([]);
    }).pipe(Effect.provide(DiskWatcherNodeLive), Effect.scoped));
    it.live("reports a project it cannot watch as an error, not a defect", () => Effect.gen(function* () {
        const errors = [];
        const watcher = yield* DiskWatcher;
        yield* watcher.watch(join(tmpdir(), "disk-watcher-missing", "nowhere"), "Content", {
            change: () => undefined,
            error: (cause) => void errors.push(cause)
        });
        expect(errors).toHaveLength(1);
    }).pipe(Effect.provide(DiskWatcherNodeLive), Effect.scoped));
});
describe("watchPoint", () => {
    const wanted = "Config/UEShed/Localization";
    const existing = (...folders) => (folder) => folders.includes(folder);
    it("watches the wanted folder, else its nearest existing ancestor below the root", () => {
        expect(watchPoint(wanted, existing("Config", "Config/UEShed", wanted))).toEqual({
            folder: wanted,
            recursive: true
        });
        expect(watchPoint(wanted, existing("Config", "Config/UEShed"))).toEqual({
            folder: "Config/UEShed",
            recursive: true
        });
        expect(watchPoint(`${wanted}/`, existing("Config"))).toEqual({
            folder: "Config",
            recursive: true
        });
    });
    it("watches the project root for its own entries only when nothing below it exists", () => {
        expect(watchPoint(wanted, existing())).toEqual({ folder: "", recursive: false });
        expect(watchPoint("Content", existing())).toEqual({ folder: "", recursive: false });
    });
});
describe("watchEvent", () => {
    const wanted = "Config/UEShed/Localization";
    it("passes the wanted folder's own events through", () => {
        const point = { folder: wanted, recursive: true };
        expect(watchEvent(wanted, point, "Game.review.json")).toEqual({
            kind: "change",
            path: "Game.review.json"
        });
        expect(watchEvent(wanted, point, undefined)).toEqual({ kind: "change", path: undefined });
    });
    it("reports an ancestor's events under the wanted folder, relative to it", () => {
        const point = { folder: "Config", recursive: true };
        expect(watchEvent(wanted, point, "UEShed\\Localization\\Game.review.json")).toEqual({
            kind: "change",
            path: "Game.review.json"
        });
        // The wanted folder or one on the way to it appeared: what it holds is unknown.
        for (const name of ["UEShed", "UEShed/Localization", undefined])
            expect(watchEvent(wanted, point, name)).toEqual({ kind: "change", path: undefined });
        for (const name of ["DefaultGame.ini", "UEShed/Other.json", "UEShed/Localizations"])
            expect(watchEvent(wanted, point, name)).toEqual({ kind: "ignore" });
    });
    it("moves a project root watch deeper when the next folder appears", () => {
        const point = { folder: "", recursive: false };
        expect(watchEvent(wanted, point, "Config")).toEqual({ kind: "reattach" });
        expect(watchEvent(wanted, point, undefined)).toEqual({ kind: "reattach" });
        for (const name of ["Content", "Saved", "Game.uproject"])
            expect(watchEvent(wanted, point, name)).toEqual({ kind: "ignore" });
    });
});
