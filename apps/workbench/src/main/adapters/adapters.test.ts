import { it } from "@effect/vitest";
import { ContentObservatoryState } from "@ue-shed/extension-content-observatory/client";
import { Deferred, Effect, Exit, Schema } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { invokeContracts } from "../ipc-contracts.js";
import {
	ElectronApp,
	type ElectronAppEvent,
	type ElectronAppHost,
	electronAppLayer
} from "./electron-app.js";
import {
	ElectronIpc,
	electronIpcLayer,
	ElectronIpcTest,
	makeElectronIpcTestLayer
} from "./electron-ipc.js";
import { LocalFiles, LocalFilesLive } from "./local-files.js";
import {
	OfflineTexturePreviewHost,
	offlineTexturePreviewHostLayer
} from "./offline-texture-preview-host.js";

it.effect("OfflineTexturePreviewHost returns nonzero commandlet exits for output validation", () =>
	Effect.gen(function* () {
		const host = yield* OfflineTexturePreviewHost;
		const result = yield* host.runCommandlet({
			args: ["-e", "process.stderr.write('project plugin error'); process.exit(7)"],
			cwd: process.cwd(),
			executable: process.execPath
		});
		expect(result).toEqual({ exitCode: 7, stderr: "project plugin error" });
	}).pipe(Effect.provide(offlineTexturePreviewHostLayer(process.env)))
);

it.effect("ElectronApp forwards host event arguments and removes the same listener", () =>
	Effect.gen(function* () {
		const registered = new Map<ElectronAppEvent, (...args: Array<unknown>) => void>();
		const removed: Array<ElectronAppEvent> = [];
		const host: ElectronAppHost = {
			getAppMetrics: () => [],
			getPath: () => "C:/Workbench-Test-UserData",
			on: (event, listener) => {
				registered.set(event, listener);
			},
			quit: () => undefined,
			removeListener: (event, listener) => {
				if (registered.get(event) === listener) removed.push(event);
			},
			whenReady: () => Promise.resolve()
		};
		let prevented = 0;
		yield* Effect.gen(function* () {
			const app = yield* ElectronApp;
			yield* app.on("before-quit", (event) => event.preventDefault());
			// Electron calls listeners with its event object first and extra arguments after it.
			registered.get("before-quit")?.({ preventDefault: () => (prevented += 1) }, "extra");
		}).pipe(Effect.provide(electronAppLayer(host)));
		expect(prevented).toBe(1);
		expect(removed).toEqual(["before-quit"]);
	})
);

it.effect("ElectronIpc registers handlers, rejects duplicates, and cleans up", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const ipc = yield* ElectronIpc;
			const probe = yield* ElectronIpcTest;
			yield* ipc.register(invokeContracts["fixture:launch"], () =>
				Effect.succeed({ status: "ready" as const })
			);
			const duplicate = yield* ipc
				.register(invokeContracts["fixture:launch"], () =>
					Effect.succeed({ status: "ready" as const })
				)
				.pipe(Effect.exit);
			expect(Exit.isFailure(duplicate)).toBe(true);

			const ready = yield* probe.invoke("fixture:launch");
			expect(ready).toEqual({ status: "ready" });

			const handlers = yield* probe.handlers();
			const handler = handlers[0];
			expect(handler).toBeDefined();
			const malformed = yield* Effect.tryPromise({
				try: () => handler!.invoke("unexpected"),
				catch: (cause) => cause
			}).pipe(Effect.exit);
			expect(Exit.isFailure(malformed)).toBe(true);

			expect((yield* probe.handlers()).map((entry) => entry.channel)).toEqual([
				"fixture:launch"
			]);
		}).pipe(Effect.provide(makeElectronIpcTestLayer()))
	)
);

it.effect("ElectronIpc encodes transformed result fields before crossing the boundary", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const ipc = yield* ElectronIpc;
			const probe = yield* ElectronIpcTest;
			const state = Schema.decodeUnknownSync(ContentObservatoryState)({
				jobId: "map-history-1",
				maps: [],
				progress: {
					phase: "idle",
					processedChangelists: 0,
					totalChangelists: 0
				},
				projectRoot: "C:/Project",
				request: {
					mode: "deep",
					limits: {
						maxChangelists: 250,
						maxConcurrency: 4,
						maxDurationMs: 120000,
						maxMaterializedFiles: 4000,
						maxPackages: 4000
					},
					mapPath: "Content/Maps/L_Example.umap",
					range: {
						since: "2026-07-20T00:00:00.000Z",
						until: "2026-07-27T00:00:00.000Z"
					}
				},
				status: "running"
			});
			yield* ipc.register(invokeContracts["content-observatory:start"], () =>
				Effect.succeed(state)
			);
			const result = yield* probe.invoke("content-observatory:start", {
				mode: "deep",
				limits: {
					maxChangelists: 250,
					maxConcurrency: 4,
					maxDurationMs: 120000,
					maxMaterializedFiles: 4000,
					maxPackages: 4000
				},
				mapPath: "Content/Maps/L_Example.umap",
				range: {
					since: "2026-07-20T00:00:00.000Z",
					until: "2026-07-27T00:00:00.000Z"
				}
			});
			expect(result).toMatchObject({
				request: {
					range: {
						since: "2026-07-20T00:00:00.000Z",
						until: "2026-07-27T00:00:00.000Z"
					}
				}
			});
		}).pipe(Effect.provide(makeElectronIpcTestLayer()))
	)
);

it.effect("ElectronIpc removes each real host handler exactly once", () =>
	Effect.gen(function* () {
		const removed: Array<string> = [];
		yield* Effect.scoped(
			Effect.gen(function* () {
				const ipc = yield* ElectronIpc;
				yield* ipc.register(invokeContracts["fixture:launch"], () =>
					Effect.succeed({ status: "ready" as const })
				);
			}).pipe(
				Effect.provide(
					electronIpcLayer({
						handle: () => undefined,
						removeHandler: (channel) => removed.push(channel)
					})
				)
			)
		);
		expect(removed).toEqual(["fixture:launch"]);
	})
);

it.effect("ElectronIpc interrupts an in-flight handler when its owning scope closes", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const interrupted = yield* Deferred.make<void>();
		const invocation = yield* Effect.scoped(
			Effect.gen(function* () {
				const ipc = yield* ElectronIpc;
				const probe = yield* ElectronIpcTest;
				yield* ipc.register(invokeContracts["fixture:launch"], () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
					)
				);
				const handler = (yield* probe.handlers())[0];
				if (!handler) return yield* Effect.die("fixture handler was not registered");
				const promise = handler.invoke();
				yield* Deferred.await(started);
				return promise;
			}).pipe(Effect.provide(makeElectronIpcTestLayer()))
		);

		yield* Deferred.await(interrupted);
		const exit = yield* Effect.tryPromise({
			try: () => invocation,
			catch: (cause) => cause
		}).pipe(Effect.exit);
		expect(Exit.isFailure(exit)).toBe(true);
	})
);

it.effect("LocalFiles reads bounded host files and reports absence", () =>
	Effect.gen(function* () {
		const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-files-")));
		const path = join(directory, "artifact.bin");
		yield* Effect.promise(() => writeFile(path, Buffer.from([1, 2, 3, 4])));
		const files = yield* LocalFiles;
		expect(yield* files.exists(path)).toBe(true);
		expect(yield* files.exists(join(directory, "missing.bin"))).toBe(false);
		expect(Array.from(yield* files.readFile(path))).toEqual([1, 2, 3, 4]);
		const tooLarge = yield* files.readFile(path, { maxBytes: 2 }).pipe(Effect.exit);
		expect(Exit.isFailure(tooLarge)).toBe(true);
		const writtenPath = join(directory, "written.bin");
		yield* files.writeFile(writtenPath, new Uint8Array([5, 6, 7]), { maxBytes: 3 });
		expect(Array.from(yield* files.readFile(writtenPath))).toEqual([5, 6, 7]);
		yield* files.writeFile(writtenPath, new Uint8Array([8, 9]), { maxBytes: 3 });
		expect(Array.from(yield* files.readFile(writtenPath))).toEqual([8, 9]);
	}).pipe(Effect.provide(LocalFilesLive))
);

it.effect("LocalFiles rejects artifact paths that escape their owning directory", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-path-guard-"))),
			(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
		);
		const directory = join(root, "capture");
		yield* Effect.promise(async () => {
			await mkdir(directory);
			await writeFile(join(root, "secret.txt"), "private");
			await writeFile(join(directory, "frame.bin"), Buffer.from([1, 2]));
		});
		const files = yield* LocalFiles;
		expect(Array.from(yield* files.readFileWithin(directory, "frame.bin"))).toEqual([1, 2]);
		const failure = yield* files.readFileWithin(directory, "../secret.txt").pipe(Effect.flip);
		expect(failure.causeText).toBe("Artifact path escapes its capture-run directory.");
		expect(failure.retrySafe).toBe(false);
	}).pipe(Effect.scoped, Effect.provide(LocalFilesLive))
);
