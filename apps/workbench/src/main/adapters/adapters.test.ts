import { it } from "@effect/vitest";
import { ContentObservatoryState } from "@ue-shed/extension-content-observatory/client";
import { aggregateHealth, defaultHealthInput } from "@ue-shed/observability";
import { Deferred, Effect, Exit, Layer, Schema } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { invokeContracts } from "../ipc-contracts.js";
import { ElectronApp, makeElectronAppTestLayer } from "./electron-app.js";
import { ElectronDialog, makeElectronDialogTestLayer } from "./electron-dialog.js";
import {
	electronIpcLayer,
	ElectronIpc,
	ElectronIpcTest,
	makeElectronIpcTestLayer
} from "./electron-ipc.js";
import {
	makeWorkbenchWindowTestLayer,
	WorkbenchWindow,
	WorkbenchWindowTest
} from "./electron-window.js";
import {
	FixtureProcess,
	FixtureProcessTest,
	makeFixtureProcessTestLayer
} from "./fixture-process.js";
import { LocalFiles, LocalFilesLive, makeLocalFilesTestLayer } from "./local-files.js";
import {
	offlineTexturePreviewHostLayer,
	OfflineTexturePreviewHost
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

it.effect("ElectronApp test layer records readiness and quit", () =>
	Effect.gen(function* () {
		const app = yield* ElectronApp;
		yield* app.whenReady();
		yield* app.quit();
		const metrics = yield* app.getAppMetrics();
		expect(metrics.length).toBeGreaterThan(0);
	}).pipe(Effect.provide(makeElectronAppTestLayer()))
);

it.effect("WorkbenchWindow test layer blocks sends after destroy", () =>
	Effect.gen(function* () {
		const window = yield* WorkbenchWindow;
		const probe = yield* WorkbenchWindowTest;
		yield* window.show();
		yield* window.send("camera:frame", { sequence: "1" });
		yield* window.destroy();
		const failed = yield* window.send("camera:frame", { sequence: "2" }).pipe(Effect.exit);
		expect(Exit.isFailure(failed)).toBe(true);
		expect(yield* probe.shown()).toBe(true);
		expect(yield* probe.sent()).toEqual([
			{ channel: "camera:frame", payload: { sequence: "1" } }
		]);
	}).pipe(Effect.provide(makeWorkbenchWindowTestLayer()))
);

it.effect("ElectronDialog adapts window openDialog results", () =>
	Effect.gen(function* () {
		const dialog = yield* ElectronDialog;
		const cancelled = yield* dialog.chooseDirectory({ title: "Choose project" });
		expect(cancelled).toEqual({ status: "cancelled" });
	}).pipe(
		Effect.provide(
			makeElectronDialogTestLayer.pipe(
				Layer.provide(
					makeWorkbenchWindowTestLayer({
						openDialog: Effect.fn("test.openDialog")(() =>
							Effect.succeed({ status: "cancelled" as const })
						)
					})
				)
			)
		)
	)
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

it.effect("ElectronIpc removes handlers when the scope closes", () =>
	Effect.gen(function* () {
		const probe = yield* Effect.scoped(
			Effect.gen(function* () {
				const ipc = yield* ElectronIpc;
				const test = yield* ElectronIpcTest;
				yield* ipc.register(invokeContracts["showcase:context"], () =>
					Effect.succeed({
						fixtureConfigured: false,
						health: aggregateHealth(defaultHealthInput),
						project: { status: "not_configured" as const },
						reader: "path" as const
					})
				);
				return test;
			}).pipe(Effect.provide(makeElectronIpcTestLayer()))
		);
		expect(yield* probe.handlers()).toEqual([]);
	})
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

it.effect("FixtureProcess test layer records launches", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const process = yield* FixtureProcess;
			const probe = yield* FixtureProcessTest;
			const result = yield* process.launch({
				args: ["launch"],
				cwd: "C:/repo",
				executable: "node"
			});
			expect(result).toEqual({ status: "ready" });
			expect(yield* probe.launches()).toEqual([
				{ args: ["launch"], cwd: "C:/repo", executable: "node" }
			]);
		}).pipe(Effect.provide(makeFixtureProcessTestLayer()))
	)
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

it.effect("LocalFiles test layer serves in-memory fixtures", () =>
	Effect.gen(function* () {
		const files = yield* LocalFiles;
		expect(yield* files.exists("memory://a")).toBe(true);
		expect(Array.from(yield* files.readFile("memory://a"))).toEqual([9]);
	}).pipe(Effect.provide(makeLocalFilesTestLayer(new Map([["memory://a", new Uint8Array([9])]]))))
);

it.effect("LocalFiles rejects artifact paths that escape their owning directory", () =>
	Effect.gen(function* () {
		const files = yield* LocalFiles;
		const exit = yield* files
			.readFileWithin("C:/captures/run-1", "../../secrets.txt")
			.pipe(Effect.exit);
		expect(Exit.isFailure(exit)).toBe(true);
	}).pipe(Effect.provide(makeLocalFilesTestLayer()))
);
