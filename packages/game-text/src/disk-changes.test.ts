import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { LocalizationOutputPaths } from "@ue-shed/localization/browser";
import { Effect, Layer, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import {
	DiskWatcher,
	DiskWatcherNodeLive,
	watchDiskChanges,
	watchedFolders,
	watchedLocalizationFiles,
	type DiskChangeItem,
	type DiskChangesState,
	type DiskWatchListener
} from "./disk-changes.js";

const decodeOutputPaths = Schema.decodeUnknownSync(LocalizationOutputPaths);

/** A watcher whose events and failures the test raises, by watched folder. */
const fakeWatcher = () => {
	const listeners = new Map<string, DiskWatchListener>();
	const layer = Layer.succeed(DiskWatcher, {
		watch: (projectRoot, folder, listener) =>
			Effect.acquireRelease(
				Effect.sync(() => void listeners.set(`${projectRoot}/${folder}`, listener)),
				() => Effect.sync(() => void listeners.delete(`${projectRoot}/${folder}`))
			)
	});
	const listener = (folder: string) => {
		const found = listeners.get(`/project/${folder}`);
		if (!found) throw new Error(`${folder} is not watched.`);
		return found;
	};
	return {
		layer,
		watched: () => [...listeners.keys()].sort(),
		change: (folder: string, path: string | undefined) => listener(folder).change(path),
		fail: (folder: string) => listener(folder).error(new Error("watch failed"))
	};
};

const item = (path: string, change: DiskChangeItem["change"] = "changed"): DiskChangeItem => ({
	kind: path.startsWith("Content/") && !path.endsWith(".po") ? "package" : "localization",
	change,
	path
});

describe("watchDiskChanges", () => {
	it.effect(
		"checks everything, then rechecks named paths after a burst and walks on folder events",
		() =>
			Effect.gen(function* () {
				const watcher = fakeWatcher();
				// The paths the index and the disk disagree on, as the engine would answer.
				let differing = [item("Content/A.uasset")];
				const checks: (readonly string[] | "walk")[] = [];
				const published = yield* Queue.unbounded<void>();
				const states = yield* Queue.unbounded<DiskChangesState>();
				yield* watchDiskChanges({
					projectRoot: "/project",
					folders: watchedFolders([
						"Content/Localization/Game/de/Game.po",
						"Config/Review.json"
					]),
					localizationFiles: new Set(["Config/Review.json"]),
					published: Stream.fromQueue(published),
					check: ({ paths, after }) =>
						Effect.sync(() => {
							expect(after).toBeUndefined();
							checks.push(paths ?? "walk");
							const decided = new Set(
								(paths ?? []).flatMap((path) =>
									path.endsWith(".uexp")
										? [
												path.replace(/\.uexp$/u, ".uasset"),
												path.replace(/\.uexp$/u, ".umap")
											]
										: [path]
								)
							);
							const items = differing.filter(
								(entry) => paths === undefined || decided.has(entry.path)
							);
							return {
								status: "ready" as const,
								counts: {
									packages: {
										added: 0,
										changed: items.filter((entry) => entry.kind === "package")
											.length,
										removed: 0
									},
									localization: {
										added: 0,
										changed: items.filter(
											(entry) => entry.kind === "localization"
										).length,
										removed: 0
									}
								},
								items
							};
						})
				}).pipe(
					Stream.runForEach((state) => Queue.offer(states, state)),
					Effect.provide(watcher.layer),
					Effect.forkScoped
				);
				const ready = (changed: number, files: readonly string[], checking = false) => ({
					status: "ready",
					changed,
					files,
					counts: expect.anything(),
					checking
				});
				// The first check is a walk, run at once.
				expect(yield* Queue.take(states)).toEqual(ready(1, ["Content/A.uasset"]));
				expect(checks).toEqual(["walk"]);
				expect(watcher.watched()).toEqual(["/project/Config", "/project/Content"]);

				// A sidecar saved: checking at once, and its package rechecked once the burst settles.
				differing = [item("Content/A.uasset"), item("Content/Text/B.uasset")];
				watcher.change("Content", "Text\\B.uexp");
				watcher.change("Content", "Text/notes.txt");
				expect(yield* Queue.take(states)).toEqual(ready(1, ["Content/A.uasset"], true));
				yield* TestClock.adjust("300 millis");
				expect(yield* Queue.take(states)).toEqual(
					ready(2, ["Content/A.uasset", "Content/Text/B.uasset"])
				);
				expect(checks).toEqual(["walk", ["Content/Text/B.uexp"]]);

				// A package saved back as it was indexed leaves the set; the review file joins it.
				differing = [item("Content/Text/B.uasset"), item("Config/Review.json")];
				watcher.change("Content", "A.uasset");
				watcher.change("Config", "Review.json");
				expect(yield* Queue.take(states)).toMatchObject({ checking: true });
				yield* TestClock.adjust("300 millis");
				expect(yield* Queue.take(states)).toEqual(
					ready(2, ["Config/Review.json", "Content/Text/B.uasset"])
				);
				expect(checks.at(-1)).toEqual(["Content/A.uasset", "Config/Review.json"]);

				// A folder renamed, a watcher failure and a published scan each walk everything.
				differing = [];
				watcher.change("Content", "Text");
				expect(yield* Queue.take(states)).toMatchObject({ checking: true });
				yield* TestClock.adjust("300 millis");
				expect(yield* Queue.take(states)).toEqual(ready(0, []));
				differing = [item("Content/C.uasset", "added")];
				watcher.fail("Content");
				expect(yield* Queue.take(states)).toMatchObject({ checking: true });
				yield* TestClock.adjust("300 millis");
				expect(yield* Queue.take(states)).toEqual(ready(1, ["Content/C.uasset"]));
				differing = [];
				yield* Queue.offer(published, undefined);
				expect(yield* Queue.take(states)).toMatchObject({ checking: true });
				yield* TestClock.adjust("300 millis");
				expect(yield* Queue.take(states)).toEqual(ready(0, []));
				expect(checks.slice(-3)).toEqual(["walk", "walk", "walk"]);
			})
	);

	it.effect("reports a view that was never indexed, and keeps watching", () =>
		Effect.gen(function* () {
			const watcher = fakeWatcher();
			const states = yield* Queue.unbounded<DiskChangesState>();
			yield* watchDiskChanges({
				projectRoot: "/project",
				folders: ["Content"],
				localizationFiles: new Set(),
				published: Stream.never,
				check: () => Effect.succeed({ status: "not_indexed" as const })
			}).pipe(
				Stream.runForEach((state) => Queue.offer(states, state)),
				Effect.provide(watcher.layer),
				Effect.forkScoped
			);
			expect(yield* Queue.take(states)).toEqual({ status: "not_indexed", checking: false });
			watcher.change("Content", "A.uasset");
			expect(yield* Queue.take(states)).toEqual({ status: "not_indexed", checking: true });
		})
	);

	for (const [title, present] of [
		["Config", ["Content", "Config"]],
		["only the project root", ["Content"]]
	] as const)
		it.live(`checks a review file saved in a folder created later, from ${title}`, () =>
			Effect.gen(function* () {
				const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "disk-changes-")));
				yield* Effect.addFinalizer(() =>
					Effect.promise(() => rm(root, { recursive: true, force: true }))
				);
				for (const folder of present)
					yield* Effect.promise(() => mkdir(join(root, folder), { recursive: true }));
				const review = "Config/UEShed/Localization/Game.review.json";
				const checks: (readonly string[] | "walk")[] = [];
				yield* watchDiskChanges({
					projectRoot: root,
					folders: watchedFolders([review]),
					localizationFiles: new Set([review]),
					published: Stream.never,
					settle: "20 millis",
					check: ({ paths }) =>
						Effect.sync(() => {
							checks.push(paths ?? "walk");
							return {
								status: "ready" as const,
								counts: {
									packages: { added: 0, changed: 0, removed: 0 },
									localization: { added: 0, changed: 0, removed: 0 }
								},
								items: []
							};
						})
				}).pipe(Stream.runDrain, Effect.provide(DiskWatcherNodeLive), Effect.forkScoped);
				// Node's recursive watch reports at its own pace: wait for it, within a bound.
				const until = (done: () => boolean) =>
					Effect.gen(function* () {
						const deadline = Date.now() + 5000;
						while (!done() && Date.now() < deadline) yield* Effect.sleep("25 millis");
						expect(done()).toBe(true);
					});
				yield* until(() => checks.length === 1);
				yield* Effect.sleep("100 millis");
				expect(checks).toEqual(["walk"]);
				yield* Effect.promise(() =>
					mkdir(join(root, "Config/UEShed/Localization"), { recursive: true })
				);
				yield* Effect.promise(() => writeFile(join(root, review), "{}"));
				yield* until(() => checks.length > 1);
			}).pipe(Effect.scoped)
		);

	it("names every culture's compiled resource among a target's watched files", () => {
		expect([
			...watchedLocalizationFiles(
				decodeOutputPaths({
					manifest: "Content/Localization/Game/Game.manifest",
					archives: { de: "Content/Localization/Game/de/Game.archive" },
					portableObjects: {},
					resources: {
						de: "Content\\Localization\\Game\\de\\Game.locres",
						id: "Content/Localization/Game/id/Game.locres"
					},
					locmeta: null,
					wordCount: null,
					conflicts: null
				}),
				"Config/UEShed/Localization/Game.review.json"
			)
		]).toEqual([
			"Content/Localization/Game/Game.manifest",
			"Content/Localization/Game/de/Game.archive",
			"Content/Localization/Game/de/Game.locres",
			"Content/Localization/Game/id/Game.locres",
			"Config/UEShed/Localization/Game.review.json"
		]);
	});

	it.effect("rechecks a recompiled or deleted resource by name", () =>
		Effect.gen(function* () {
			const watcher = fakeWatcher();
			const resource = "Content/Localization/Game/id/Game.locres";
			const checks: (readonly string[] | "walk")[] = [];
			const states = yield* Queue.unbounded<DiskChangesState>();
			const files = watchedLocalizationFiles(
				decodeOutputPaths({
					manifest: null,
					archives: {},
					portableObjects: {},
					resources: { id: resource },
					locmeta: null,
					wordCount: null,
					conflicts: null
				}),
				"Config/UEShed/Localization/Game.review.json"
			);
			yield* watchDiskChanges({
				projectRoot: "/project",
				folders: watchedFolders(files),
				localizationFiles: files,
				published: Stream.never,
				check: ({ paths }) =>
					Effect.sync(() => {
						checks.push(paths ?? "walk");
						// Ready, so later events are checked by name rather than walked again.
						return {
							status: "ready" as const,
							counts: {
								packages: { added: 0, changed: 0, removed: 0 },
								localization: { added: 0, changed: 0, removed: 0 }
							},
							items: []
						};
					})
			}).pipe(
				Stream.runForEach((state) => Queue.offer(states, state)),
				Effect.provide(watcher.layer),
				Effect.forkScoped
			);
			yield* Queue.take(states);
			expect(checks).toEqual(["walk"]);
			// A recompile, then a deletion: the same event, so both name the resource.
			for (const round of [1, 2]) {
				watcher.change("Content", "Localization/Game/id/Game.locres");
				yield* Queue.take(states);
				yield* TestClock.adjust("300 millis");
				yield* Queue.take(states);
				expect(checks).toHaveLength(round + 1);
				expect(checks.at(-1)).toEqual([resource]);
			}
		})
	);

	it("watches Content and each target folder outside it once", () => {
		expect(
			watchedFolders([
				"Content/Localization/Game/Game.manifest",
				"Config/UEShed/Localization/Game.review.json",
				"Config/UEShed/Localization/Other.review.json",
				"Plugins/Text/Localization/de/Text.po",
				"Plugins/Text/Localization/Text.manifest"
			])
		).toEqual(["Content", "Plugins/Text/Localization", "Config/UEShed/Localization"]);
	});
});
