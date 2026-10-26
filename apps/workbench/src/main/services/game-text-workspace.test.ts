import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import {
	makeGameTextWorkspace,
	type GameTextWorkspaceFileHooks,
	type GameTextWorkspaceProject
} from "@ue-shed/game-text/workspace";
import { GAME_TEXT_RULES_RELATIVE_PATH, STARTER_GAME_TEXT_RULES } from "@ue-shed/game-text/rules";
import { LocalizationTargetName, makeLocalizationEvidenceTestLayer } from "@ue-shed/localization";
import type { TextCorpus } from "@ue-shed/game-text/schema";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { cannedGameTextIndexLayer } from "./game-text-index.test-support.js";

const emptyCorpus: TextCorpus = {
	coverage: {
		discoveredPackages: 0,
		failedPackages: 0,
		inspectedPackages: 0,
		partialPackages: 0,
		resolvedOccurrences: 0,
		textOccurrences: 0,
		textUnits: 0,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1,
	status: "complete",
	units: []
};
const noLocalization = makeLocalizationEvidenceTestLayer({
	discover: () => Effect.succeed({ schemaVersion: 1, targets: [], diagnostics: [] }),
	read: () => Effect.die("No targets"),
	targets: () => Effect.die("Not used")
});
const ready = (projectRoot: string, generation: number) => ({
	status: "ready" as const,
	project: { projectRoot, generation }
});
function selected(projectRoot: string): GameTextWorkspaceProject {
	return {
		current: () => Effect.succeed(ready(projectRoot, 3)),
		refresh: () => Effect.succeed(ready(projectRoot, 3)),
		candidates: () => Effect.succeed({ generation: 3, summary: { projectRoot } }),
		progress: () => Effect.succeed({ completed: 0, total: 0, phase: "idle", stage: "host" })
	};
}
function memoryFiles() {
	const contents = new Map<string, Uint8Array>();
	const writes: string[] = [];
	const read = (path: string) =>
		Effect.suspend(() => {
			const bytes = contents.get(path);
			return bytes === undefined
				? Effect.fail({ message: "Missing file.", recovery: "Create it." })
				: Effect.succeed(bytes);
		});
	const files: GameTextWorkspaceFileHooks = {
		chooseFile: () => Effect.succeed({ status: "cancelled" }),
		chooseSaveFile: () => Effect.succeed({ status: "cancelled" }),
		readFile: read,
		readFileWithin: (root, path) => read(resolve(root, path)),
		writeFile: (path, bytes, options) =>
			Effect.gen(function* () {
				if (options?.exclusive && contents.has(path))
					return yield* Effect.fail({
						code: "already_exists" as const,
						message: "Exists.",
						recovery: "Load it."
					});
				writes.push(path);
				contents.set(path, bytes);
			})
	};
	return { contents, writes, files };
}
const provideWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(cannedGameTextIndexLayer(() => Effect.succeed(emptyCorpus))),
		Effect.provide(noLocalization)
	);

for (const full of [false, true]) {
	for (const disconnectDuringRefresh of [false, true]) {
		it.effect(
			`rejoins ${full ? "full scan" : "refresh"} after disconnect during ${disconnectDuringRefresh ? "host refresh" : "text preparation"}`,
			() =>
				Effect.gen(function* () {
					const started = yield* Deferred.make<void>();
					const finish = yield* Deferred.make<void>();
					const hostStarted = yield* Deferred.make<void>();
					const hostFinish = yield* Deferred.make<void>();
					const rejoining = yield* Deferred.make<void>();
					const scans = yield* Ref.make(0);
					const generation = yield* Ref.make(3);
					let reconnecting = false;
					const root = "C:/Project";
					const scan = Effect.gen(function* () {
						yield* Ref.update(scans, (n) => n + 1);
						yield* Deferred.succeed(started, undefined);
						yield* Deferred.await(finish);
						return emptyCorpus;
					});
					const project: GameTextWorkspaceProject = {
						...selected(root),
						current: () =>
							Effect.gen(function* () {
								const value = yield* Ref.get(generation);
								if (reconnecting) yield* Deferred.succeed(rejoining, undefined);
								return ready(root, value);
							}),
						refresh: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(hostStarted, undefined);
								if (disconnectDuringRefresh) yield* Deferred.await(hostFinish);
								return ready(
									root,
									yield* Ref.updateAndGet(generation, (n) => n + 1)
								);
							}),
						candidates: () =>
							Ref.get(generation).pipe(
								Effect.map((generation) => ({
									generation,
									summary: { projectRoot: root }
								}))
							)
					};
					yield* Effect.gen(function* () {
						const workspace = yield* makeGameTextWorkspace({
							project,
							files: memoryFiles().files
						});
						const run = () =>
							full ? workspace.configuredScan() : workspace.configuredRefresh(true);
						const first = yield* run().pipe(Effect.forkChild);
						yield* Deferred.await(disconnectDuringRefresh ? hostStarted : started);
						yield* Fiber.interrupt(first);
						if (disconnectDuringRefresh) {
							yield* Deferred.succeed(hostFinish, undefined);
							yield* Deferred.await(started);
						}
						expect(yield* Ref.get(generation)).toBe(4);
						reconnecting = true;
						const second = yield* run().pipe(Effect.forkChild);
						yield* Deferred.await(rejoining);
						yield* Effect.yieldNow;
						yield* Deferred.succeed(finish, undefined);
						expect((yield* Fiber.join(second)).status).toBe("completed");
						expect(yield* Ref.get(generation)).toBe(4);
						expect(yield* Ref.get(scans)).toBe(1);
					}).pipe(
						Effect.scoped,
						Effect.provide(cannedGameTextIndexLayer(() => scan)),
						Effect.provide(noLocalization)
					);
				})
		);
	}
}

for (const full of [false, true]) {
	it.effect(
		`cancels ${full ? "full scan" : "refresh"} during admission and releases the permit`,
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const interrupted = yield* Deferred.make<void>();
				let reads = 0;
				let refreshes = 0;
				const root = "C:/Project";
				yield* Effect.gen(function* () {
					const workspace = yield* makeGameTextWorkspace({
						files: memoryFiles().files,
						project: {
							...selected(root),
							current: () =>
								Effect.gen(function* () {
									reads += 1;
									if (reads === 1) {
										yield* Deferred.succeed(entered, undefined);
										yield* Deferred.await(release);
									}
									return ready(root, 3);
								}),
							refresh: () =>
								Effect.sync(() => {
									refreshes += 1;
									return ready(root, 3);
								})
						}
					});
					const run = () =>
						full ? workspace.configuredScan() : workspace.configuredRefresh();
					const request = yield* run().pipe(Effect.forkChild);
					yield* Deferred.await(entered);
					yield* Fiber.interrupt(request).pipe(
						Effect.andThen(Deferred.succeed(interrupted, undefined)),
						Effect.forkChild
					);
					// Drain runnable fibers without allowing the blocked host hook to return.
					yield* TestClock.adjust(0);
					expect(yield* Deferred.isDone(interrupted)).toBe(true);
					expect(yield* Deferred.isDone(release)).toBe(false);
					expect(refreshes).toBe(0);
					const next = yield* run().pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					expect(refreshes).toBe(1);
					expect((yield* Fiber.join(next)).status).toBe("completed");
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}).pipe(provideWorkspace)
	);
}

it.effect("creates starter rules exclusively in a non-disk host store", () =>
	Effect.gen(function* () {
		const store = memoryFiles();
		const root = resolve("in-memory-project");
		const path = resolve(root, "Config/Custom/text-rules.json");
		const workspace = yield* makeGameTextWorkspace({
			project: selected(root),
			files: store.files,
			rulesRelativePath: "Config/Custom/text-rules.json"
		});
		expect((yield* workspace.configuredRefresh()).status).toBe("completed");
		expect((yield* workspace.createStarterRules(false)).status).toBe("completed");
		const previous = store.contents.get(path);
		expect(previous).toBeDefined();
		expect(store.writes).toEqual([path]);
		expect(yield* workspace.createStarterRules(false)).toMatchObject({
			status: "failed",
			error: { code: "already_exists" }
		});
		expect(store.contents.get(path)).toBe(previous);
		expect(store.writes).toEqual([path]);
		expect((yield* workspace.createStarterRules(true)).status).toBe("completed");
	}).pipe(provideWorkspace)
);

it.effect("creates the host's starter rules", () =>
	Effect.gen(function* () {
		const store = memoryFiles();
		const root = resolve("in-memory-project");
		const starterRules = {
			schemaVersion: 1 as const,
			roles: [],
			rules: [{ kind: "long" as const, enabled: false }]
		};
		const workspace = yield* makeGameTextWorkspace({
			project: selected(root),
			files: store.files,
			starterRules
		});
		expect((yield* workspace.configuredRefresh()).status).toBe("completed");
		expect((yield* workspace.createStarterRules(false)).status).toBe("completed");
		const written = store.contents.get(resolve(root, GAME_TEXT_RULES_RELATIVE_PATH));
		expect(JSON.parse(new TextDecoder().decode(written))).toEqual(starterRules);
	}).pipe(provideWorkspace)
);

it.effect("answers an operation state poll from the published scan, without discovering", () =>
	Effect.gen(function* () {
		let discoveries = 0;
		const root = "C:/Project";
		yield* Effect.gen(function* () {
			const workspace = yield* makeGameTextWorkspace({
				project: selected(root),
				files: memoryFiles().files
			});
			const name = LocalizationTargetName.make("FixtureGame");
			// Before any scan there is nothing published, and the poll discovers nothing itself.
			expect(yield* workspace.operationStateTarget(name)).toBeUndefined();
			expect(discoveries).toBe(0);
			expect((yield* workspace.configuredRefresh()).status).toBe("completed");
			const scanned = discoveries;
			expect(yield* workspace.operationStateTarget(name)).toBeUndefined();
			expect(discoveries).toBe(scanned);
		}).pipe(
			Effect.scoped,
			Effect.provide(cannedGameTextIndexLayer(() => Effect.succeed(emptyCorpus))),
			Effect.provide(
				makeLocalizationEvidenceTestLayer({
					discover: () =>
						Effect.sync(() => {
							discoveries += 1;
							return { schemaVersion: 1, targets: [], diagnostics: [] };
						}),
					read: () => Effect.die("No targets"),
					targets: () => Effect.die("Not used")
				})
			)
		);
	})
);

it.effect("counts the host's project scan as the first of a scan's steps", () =>
	Effect.gen(function* () {
		const root = "C:/Project";
		const workspace = yield* makeGameTextWorkspace({
			project: {
				...selected(root),
				progress: () =>
					Effect.succeed({
						completed: 2,
						total: 5,
						phase: "scanning" as const,
						stage: "project_index"
					})
			},
			files: memoryFiles().files
		});
		expect(yield* workspace.progress()).toEqual({
			completed: 2,
			total: 5,
			phase: "scanning",
			stage: "project_index",
			step: 1,
			steps: 9
		});
	}).pipe(provideWorkspace)
);

it.effect("never falls back to disk when the host refuses starter creation", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-workspace-refusal-"))),
			(root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		const store = memoryFiles();
		const workspace = yield* makeGameTextWorkspace({
			project: selected(root),
			files: {
				...store.files,
				writeFile: () =>
					Effect.fail({
						message: "Host denied write.",
						recovery: "Request writable access."
					})
			}
		});
		expect((yield* workspace.configuredRefresh()).status).toBe("completed");
		expect(yield* workspace.createStarterRules(false)).toMatchObject({
			status: "failed",
			error: { code: "write_failed", message: "Host denied write." }
		});
		expect(store.writes).toEqual([]);
		const disk = yield* Effect.tryPromise(() =>
			readFile(resolve(root, GAME_TEXT_RULES_RELATIVE_PATH))
		).pipe(Effect.result);
		expect(disk._tag).toBe("Failure");
	}).pipe(provideWorkspace)
);

for (const failedHook of ["read", "recovery"] as const) {
	it.effect(`preserves attached rules when the ${failedHook} hook fails`, () =>
		Effect.gen(function* () {
			const store = memoryFiles();
			const root = resolve("in-memory-project");
			const path = resolve(root, "Config/Custom/text-rules.json");
			const original = new TextEncoder().encode(JSON.stringify(STARTER_GAME_TEXT_RULES));
			store.contents.set(path, original);
			let copies = 0;
			const workspace = yield* makeGameTextWorkspace({
				project: selected(root),
				rulesRelativePath: "Config/Custom/text-rules.json",
				files: {
					...store.files,
					readFile: () =>
						failedHook === "read"
							? Effect.fail({
									message: "Read refused.",
									recovery: "Restore readable access."
								})
							: store.files.readFile(path)
				},
				recoveryCopy: () =>
					Effect.gen(function* () {
						copies += 1;
						return yield* Effect.fail({
							message: "Recovery refused.",
							recovery: "Restore backup access."
						});
					})
			});
			expect((yield* workspace.configuredRefresh()).status).toBe("completed");
			expect((yield* workspace.createStarterRules(true)).status).toBe("completed");
			expect(yield* workspace.saveQualityRules(STARTER_GAME_TEXT_RULES)).toMatchObject({
				status: "failed",
				error: { code: "write_failed" }
			});
			expect(store.writes).toEqual([]);
			expect(store.contents.get(path)).toBe(original);
			expect(copies).toBe(failedHook === "read" ? 0 : 1);
		}).pipe(provideWorkspace)
	);
}

it.effect("copies previous rule bytes before the host replaces them", () =>
	Effect.gen(function* () {
		const store = memoryFiles();
		const root = resolve("in-memory-project");
		const path = resolve(root, "Config/Custom/text-rules.json");
		const original = new TextEncoder().encode(JSON.stringify(STARTER_GAME_TEXT_RULES));
		store.contents.set(path, original);
		const events: string[] = [];
		const workspace = yield* makeGameTextWorkspace({
			project: selected(root),
			rulesRelativePath: "Config/Custom/text-rules.json",
			files: {
				...store.files,
				writeFile: (path, bytes, options) =>
					Effect.gen(function* () {
						events.push("write");
						yield* store.files.writeFile(path, bytes, options);
					})
			},
			recoveryCopy: (copiedPath, bytes) =>
				Effect.sync(() => {
					expect(copiedPath).toBe(path);
					expect(bytes).toBe(original);
					expect(store.contents.get(path)).toBe(original);
					events.push("copy");
				})
		});
		expect((yield* workspace.configuredRefresh()).status).toBe("completed");
		expect((yield* workspace.createStarterRules(true)).status).toBe("completed");
		expect((yield* workspace.saveQualityRules(STARTER_GAME_TEXT_RULES)).status).toBe(
			"completed"
		);
		expect(events).toEqual(["copy", "write"]);
		expect(store.writes).toEqual([path]);
	}).pipe(provideWorkspace)
);
