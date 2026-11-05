import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { describe, expect } from "vitest";
import { DiskWatcher, DiskWatcherNodeLive } from "./disk-watcher.js";

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)));

describe("DiskWatcherNodeLive", () => {
	it.live("reports changes while its scope is open and none after it closes", () =>
		Effect.gen(function* () {
			const folder = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "disk-watcher-")));
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => rm(folder, { recursive: true, force: true }))
			);
			const seen: (string | undefined)[] = [];
			const errors: unknown[] = [];
			const watcher = yield* DiskWatcher;
			const scope = yield* Scope.make();
			yield* watcher
				.watch(folder, {
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
		}).pipe(Effect.provide(DiskWatcherNodeLive), Effect.scoped)
	);

	it.live("reports a folder it cannot watch as an error, not a defect", () =>
		Effect.gen(function* () {
			const errors: unknown[] = [];
			const watcher = yield* DiskWatcher;
			yield* watcher.watch(join(tmpdir(), "disk-watcher-missing", "nowhere"), {
				change: () => undefined,
				error: (cause) => void errors.push(cause)
			});
			expect(errors).toHaveLength(1);
		}).pipe(Effect.provide(DiskWatcherNodeLive), Effect.scoped)
	);
});
