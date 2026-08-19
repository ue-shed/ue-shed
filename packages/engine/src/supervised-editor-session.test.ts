import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { makeEngineInstallationDiscoveryTestLayer } from "./engine-installation.js";
import { makeEditorConnectionTestLayer } from "./editor-connection.js";
import {
	OwnedProcessTree,
	OwnedProcessTreeLive,
	SupervisedEditorSession,
	SupervisedEditorSessionLive,
	makeOwnedProcessTreeTestLayer,
	type OwnedProcessExit,
	type OwnedProcessTreeHandle,
	type OwnedProcessTreeLaunchOptions,
	type OwnedProcessTerminationReason
} from "./supervised-editor-session.js";

const manifest = {
	capabilities: ["capture.fixture.v1"],
	producerKind: "unreal_editor" as const,
	projectName: "Fixture",
	schemaVersion: 1 as const
};

interface TestInstallation {
	readonly executable: string;
	readonly pluginDescriptor: string;
	readonly projectDescriptor: string;
	readonly root: string;
}

function installationFixture(): Effect.Effect<TestInstallation> {
	return Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-supervised-")));
		const executable = join(
			root,
			"Engine",
			"Binaries",
			process.platform === "win32"
				? "Win64"
				: process.platform === "darwin"
					? "Mac"
					: "Linux",
			process.platform === "win32" ? "UnrealEditor.exe" : "UnrealEditor"
		);
		const projectDescriptor = join(root, "Fixture.uproject");
		const pluginDescriptor = join(root, "Plugins", "Fixture", "Fixture.uplugin");
		yield* Effect.promise(() => mkdir(dirname(executable), { recursive: true }));
		yield* Effect.promise(() => mkdir(dirname(pluginDescriptor), { recursive: true }));
		yield* Effect.promise(() => writeFile(executable, ""));
		yield* Effect.promise(() => writeFile(projectDescriptor, "{}"));
		yield* Effect.promise(() => writeFile(pluginDescriptor, "{}"));
		return { executable, pluginDescriptor, projectDescriptor, root };
	});
}

function request(fixture: TestInstallation) {
	return {
		explicitEngineRoot: fixture.root,
		expectedProjectName: "Fixture",
		plugins: [{ descriptor: fixture.pluginDescriptor, id: "Fixture" }],
		projectDescriptor: fixture.projectDescriptor,
		readinessPollIntervalMs: 1,
		readinessTimeoutMs: 1_000,
		remoteControlHttpPort: 30_001,
		requiredCapabilities: ["capture.fixture.v1"],
		terminationTimeoutMs: 1_000
	};
}

function testHandle(
	pid: number,
	terminations: Ref.Ref<readonly OwnedProcessTerminationReason[]>,
	awaitExit: Effect.Effect<OwnedProcessExit> = Effect.never
): OwnedProcessTreeHandle {
	return {
		awaitExit,
		pid,
		terminate: (reason) =>
			Ref.update(terminations, (current) => [...current, reason]).pipe(
				Effect.as({
					exitCode: null,
					kind: "terminated" as const,
					reason,
					signal: "SIGKILL"
				})
			)
	};
}

function sessionLayer(options: {
	readonly connection: ReturnType<typeof makeEditorConnectionTestLayer>;
	readonly fixture: TestInstallation;
	readonly process: ReturnType<typeof makeOwnedProcessTreeTestLayer>;
}) {
	const dependencies = Layer.mergeAll(
		makeEngineInstallationDiscoveryTestLayer(() =>
			Effect.succeed({
				root: options.fixture.root,
				version: { major: 5, minor: 7, patch: 0 }
			})
		),
		options.connection,
		options.process
	);
	return SupervisedEditorSessionLive.pipe(Layer.provide(dependencies));
}

it.effect("validates files before starting the owned process", () =>
	Effect.gen(function* () {
		const launches = yield* Ref.make<readonly OwnedProcessTreeLaunchOptions[]>([]);
		const terminations = yield* Ref.make<readonly OwnedProcessTerminationReason[]>([]);
		const fixture = yield* installationFixture();
		const layer = sessionLayer({
			connection: makeEditorConnectionTestLayer({
				connect: () => Effect.succeed(manifest),
				waitUntilReady: () => Effect.succeed(manifest)
			}),
			fixture,
			process: makeOwnedProcessTreeTestLayer((options) =>
				Ref.update(launches, (current) => [...current, options]).pipe(
					Effect.as(testHandle(41, terminations))
				)
			)
		});
		const error = yield* Effect.flip(
			Effect.scoped(
				Effect.flatMap(SupervisedEditorSession, (sessions) =>
					sessions.acquire({
						...request(fixture),
						projectDescriptor: "relative.uproject"
					})
				)
			).pipe(Effect.provide(layer))
		);
		expect(error.code).toBe("invalid_request");
		expect(yield* Ref.get(launches)).toEqual([]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

it.effect("acquires readiness and releases only its owned process", () =>
	Effect.gen(function* () {
		const launches = yield* Ref.make<readonly OwnedProcessTreeLaunchOptions[]>([]);
		const terminations = yield* Ref.make<readonly OwnedProcessTerminationReason[]>([]);
		const fixture = yield* installationFixture();
		const layer = sessionLayer({
			connection: makeEditorConnectionTestLayer({
				connect: () => Effect.succeed(manifest),
				waitUntilReady: () => Effect.succeed(manifest)
			}),
			fixture,
			process: makeOwnedProcessTreeTestLayer((options) =>
				Ref.update(launches, (current) => [...current, options]).pipe(
					Effect.as(testHandle(42, terminations))
				)
			)
		});
		const acquired = yield* Effect.scoped(
			Effect.flatMap(SupervisedEditorSession, (sessions) =>
				sessions.acquire(request(fixture))
			)
		).pipe(Effect.provide(layer));
		expect(acquired).toMatchObject({
			manifest,
			pid: 42,
			projectDescriptor: fixture.projectDescriptor,
			remoteControlEndpoint: "http://127.0.0.1:30001"
		});
		const launch = (yield* Ref.get(launches))[0];
		expect(launch?.executable).toBe(fixture.executable);
		expect(launch?.args).toContain(`-PLUGIN=${fixture.pluginDescriptor}`);
		expect(launch?.args).toContain("-EnablePlugins=Fixture,RemoteControl");
		expect(yield* Ref.get(terminations)).toEqual(["released"]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

it.effect("cancellation during readiness tears down the acquired process", () =>
	Effect.gen(function* () {
		const readinessStarted = yield* Deferred.make<void>();
		const readiness = yield* Deferred.make<void>();
		const terminations = yield* Ref.make<readonly OwnedProcessTerminationReason[]>([]);
		const fixture = yield* installationFixture();
		const layer = sessionLayer({
			connection: makeEditorConnectionTestLayer({
				connect: () => Effect.succeed(manifest),
				waitUntilReady: () =>
					Deferred.succeed(readinessStarted, undefined).pipe(
						Effect.andThen(Deferred.await(readiness)),
						Effect.as(manifest)
					)
			}),
			fixture,
			process: makeOwnedProcessTreeTestLayer(() =>
				Effect.succeed(testHandle(43, terminations))
			)
		});
		const fiber = yield* Effect.forkChild(
			Effect.scoped(
				Effect.flatMap(SupervisedEditorSession, (sessions) =>
					sessions.acquire(request(fixture))
				)
			).pipe(Effect.provide(layer))
		);
		yield* Deferred.await(readinessStarted);
		yield* Fiber.interrupt(fiber);
		expect(yield* Ref.get(terminations)).toEqual(["cancelled"]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

test("cancellation during launch cancels the process acquisition", async () => {
	const launchStarted = await Effect.runPromise(Deferred.make<void>());
	const launchCancelled = await Effect.runPromise(Deferred.make<void>());
	const fixture = await Effect.runPromise(installationFixture());
	const neverLaunch: Effect.Effect<OwnedProcessTreeHandle> = Effect.never;
	const layer = sessionLayer({
		connection: makeEditorConnectionTestLayer({
			connect: () => Effect.succeed(manifest),
			waitUntilReady: () => Effect.succeed(manifest)
		}),
		fixture,
		process: makeOwnedProcessTreeTestLayer(() =>
			Deferred.succeed(launchStarted, undefined).pipe(
				Effect.flatMap(() => neverLaunch),
				Effect.ensuring(Deferred.succeed(launchCancelled, undefined))
			)
		)
	});
	const fiber = Effect.runFork(
		Effect.scoped(
			Effect.flatMap(SupervisedEditorSession, (sessions) =>
				sessions.acquire(request(fixture))
			)
		).pipe(Effect.provide(layer))
	);
	await Effect.runPromise(Deferred.await(launchStarted));
	Effect.runFork(Fiber.interrupt(fiber));
	await Effect.runPromise(Deferred.await(launchCancelled));
	await rm(fixture.root, { force: true, recursive: true });
});

it.effect("cancellation during operation tears down the acquired process", () =>
	Effect.gen(function* () {
		const operationStarted = yield* Deferred.make<void>();
		const operation = yield* Deferred.make<void>();
		const terminations = yield* Ref.make<readonly OwnedProcessTerminationReason[]>([]);
		const fixture = yield* installationFixture();
		const layer = sessionLayer({
			connection: makeEditorConnectionTestLayer({
				connect: () => Effect.succeed(manifest),
				waitUntilReady: () => Effect.succeed(manifest)
			}),
			fixture,
			process: makeOwnedProcessTreeTestLayer(() =>
				Effect.succeed(testHandle(46, terminations))
			)
		});
		const fiber = yield* Effect.forkChild(
			Effect.scoped(
				Effect.gen(function* () {
					const sessions = yield* SupervisedEditorSession;
					yield* sessions.acquire(request(fixture));
					yield* Deferred.succeed(operationStarted, undefined);
					yield* Deferred.await(operation);
				})
			).pipe(Effect.provide(layer))
		);
		yield* Deferred.await(operationStarted);
		yield* Fiber.interrupt(fiber);
		expect(yield* Ref.get(terminations)).toEqual(["cancelled"]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

it.effect("reports a deterministic early process exit", () =>
	Effect.gen(function* () {
		const terminations = yield* Ref.make<readonly OwnedProcessTerminationReason[]>([]);
		const fixture = yield* installationFixture();
		const layer = sessionLayer({
			connection: makeEditorConnectionTestLayer({
				connect: () => Effect.succeed(manifest),
				waitUntilReady: () => Effect.never
			}),
			fixture,
			process: makeOwnedProcessTreeTestLayer(() =>
				Effect.succeed(
					testHandle(
						44,
						terminations,
						Effect.succeed({ exitCode: 7, kind: "exited", signal: null })
					)
				)
			)
		});
		const error = yield* Effect.flip(
			Effect.scoped(
				Effect.flatMap(SupervisedEditorSession, (sessions) =>
					sessions.acquire(request(fixture))
				)
			).pipe(Effect.provide(layer))
		);
		expect(error).toMatchObject({ code: "process_exited", stage: "readiness" });
		expect(yield* Ref.get(terminations)).toEqual(["failed"]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

it.effect("rejects a missing required capability after real readiness", () =>
	Effect.gen(function* () {
		const terminations = yield* Ref.make<readonly OwnedProcessTerminationReason[]>([]);
		const fixture = yield* installationFixture();
		const layer = sessionLayer({
			connection: makeEditorConnectionTestLayer({
				connect: () => Effect.succeed(manifest),
				waitUntilReady: () => Effect.succeed(manifest)
			}),
			fixture,
			process: makeOwnedProcessTreeTestLayer(() =>
				Effect.succeed(testHandle(45, terminations))
			)
		});
		const error = yield* Effect.flip(
			Effect.scoped(
				Effect.flatMap(SupervisedEditorSession, (sessions) =>
					sessions.acquire({
						...request(fixture),
						requiredCapabilities: ["missing.fixture.v1"]
					})
				)
			).pipe(Effect.provide(layer))
		);
		expect(error).toMatchObject({ code: "capability_unavailable", stage: "readiness" });
		expect(yield* Ref.get(terminations)).toEqual(["failed"]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

const ErrorWithCode = Schema.Struct({ code: Schema.String });
const ProcessTreeEvidence = Schema.Struct({
	childPid: Schema.Int.check(Schema.isGreaterThan(0)),
	parentPid: Schema.Int.check(Schema.isGreaterThan(0))
});

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return !Schema.is(ErrorWithCode)(cause) || cause.code !== "ESRCH";
	}
}

async function processIsRunning(pid: number): Promise<boolean> {
	if (process.platform !== "linux") return processExists(pid);
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		return commandEnd !== -1 && stat.slice(commandEnd + 2).trimStart()[0] !== "Z";
	} catch (cause) {
		if (Schema.is(ErrorWithCode)(cause) && cause.code === "ENOENT") return false;
		throw cause;
	}
}

describe("owned process trees", () => {
	it("reports a real natural exit deterministically", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const processes = yield* OwnedProcessTree;
				const handle = yield* processes.launch({
					args: ["-e", "process.exit(7)"],
					cwd: process.cwd(),
					executable: process.execPath,
					terminationTimeout: Duration.seconds(5)
				});
				return yield* handle.awaitExit;
			}).pipe(Effect.provide(OwnedProcessTreeLive))
		);
		expect(outcome).toEqual({ exitCode: 7, kind: "exited", signal: null });
	});

	it("completes a natural root exit only after its descendant is terminated", async () => {
		const base = await mkdtemp(join(tmpdir(), "ue-shed-process-tree-natural-"));
		const evidencePath = join(base, "pids.json");
		const fixturePath = fileURLToPath(
			new URL("./test-fixtures/owned-process-tree.mjs", import.meta.url)
		);
		const evidenceChanged = new Promise<void>((complete) => {
			const watcher = watch(base, (_event, filename) => {
				if (filename !== "pids.json") return;
				watcher.close();
				complete();
			});
		});
		const handle = await Effect.runPromise(
			Effect.flatMap(OwnedProcessTree, (processes) =>
				processes.launch({
					args: [fixturePath, "parent-exits", evidencePath],
					cwd: base,
					executable: process.execPath,
					terminationTimeout: Duration.seconds(5)
				})
			).pipe(Effect.provide(OwnedProcessTreeLive))
		);
		await evidenceChanged;
		const evidence = Schema.decodeUnknownSync(ProcessTreeEvidence)(
			JSON.parse(await readFile(evidencePath, "utf8"))
		);
		const outcome = await Effect.runPromise(handle.awaitExit);

		expect(outcome).toEqual({ exitCode: 0, kind: "exited", signal: null });
		expect(await processIsRunning(evidence.parentPid)).toBe(false);
		expect(await processIsRunning(evidence.childPid)).toBe(false);
		await rm(base, { force: true, recursive: true });
	});

	it("terminates a real parent and descendant fixture on scope release", async () => {
		const base = await mkdtemp(join(tmpdir(), "ue-shed-process-tree-"));
		const root = join(base, "path with spaces");
		await mkdir(root);
		const evidencePath = join(root, "pids.json");
		const fixturePath = fileURLToPath(
			new URL("./test-fixtures/owned-process-tree.mjs", import.meta.url)
		);
		const evidenceChanged = new Promise<void>((complete) => {
			const watcher = watch(root, (_event, filename) => {
				if (filename !== "pids.json") return;
				watcher.close();
				complete();
			});
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const processes = yield* OwnedProcessTree;
					yield* Effect.acquireRelease(
						processes.launch({
							args: [fixturePath, "parent", evidencePath],
							cwd: root,
							executable: process.execPath,
							terminationTimeout: Duration.seconds(5)
						}),
						(handle) => handle.terminate("released").pipe(Effect.orDie)
					);
					yield* Effect.promise(() => evidenceChanged);
				})
			).pipe(Effect.provide(OwnedProcessTreeLive))
		);
		await access(evidencePath);
		const evidence = Schema.decodeUnknownSync(ProcessTreeEvidence)(
			JSON.parse(await readFile(evidencePath, "utf8"))
		);
		expect(await processIsRunning(evidence.parentPid)).toBe(false);
		expect(await processIsRunning(evidence.childPid)).toBe(false);
		await rm(base, { force: true, recursive: true });
	});
});
