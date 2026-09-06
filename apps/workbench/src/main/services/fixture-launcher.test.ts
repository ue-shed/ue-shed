import { makeWorkbenchTestConfigurationLayer as makeWorkbenchConfigurationLayer } from "../test-configuration.js";
import { it } from "@effect/vitest";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { expect } from "vitest";
import { FixtureProcess } from "../adapters/fixture-process.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { typescriptLoader } from "../typescript-checkout.js";
import { type WorkbenchConfigurationApi } from "../workbench-config.js";
import {
	FixtureHealth,
	FixtureHealthLive,
	FixtureLauncher,
	FixtureLauncherLive,
	makeFixtureHealthTestLayer,
	type FixtureHealthResult
} from "./fixture-launcher.js";

const unconfigured: WorkbenchConfigurationApi = {
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	rememberProjects: false,
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
};

const repositoryRoot = "C:/repo";
const launchScriptPath = join(repositoryRoot, "scripts", "unreal-fixture.ts");

const configuredCheckout: WorkbenchConfigurationApi = {
	...unconfigured,
	sourceCheckout: { path: repositoryRoot, status: "configured" }
};

const scriptOnDisk = makeLocalFilesTestLayer(new Map([[launchScriptPath, new Uint8Array()]]));

function readyFixtureProcess(launches: Ref.Ref<number>) {
	return FixtureProcess.of({
		launch: () =>
			Ref.update(launches, (count) => count + 1).pipe(Effect.as({ status: "ready" as const }))
	});
}

function neverCalledFixtureProcess() {
	return FixtureProcess.of({
		launch: () => Effect.die("FixtureProcess.launch should not be called")
	});
}

// --- FixtureHealth -----------------------------------------------------------

const manifestOf = (fields: Schema.JsonObject) => ({
	capabilities: [],
	producerKind: "unreal_editor" as const,
	schemaVersion: 1 as const,
	...fields
});

it.effect(
	"FixtureHealth reports ready when no capability is required and the project matches",
	() =>
		Effect.gen(function* () {
			const health = yield* FixtureHealth;
			const result = yield* health.check();
			expect(result).toEqual({ status: "ready" });
		}).pipe(
			Effect.provide(
				FixtureHealthLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeWorkbenchConfigurationLayer({
								...unconfigured,
								expectedProject: { projectName: "Fixture", status: "configured" }
							}),
							makeRemoteControlClientTestLayer(() =>
								Effect.succeed(manifestOf({ projectName: "Fixture" }))
							)
						)
					)
				)
			)
		)
);

it.effect("FixtureHealth reports incompatible when the endpoint belongs to another project", () =>
	Effect.gen(function* () {
		const health = yield* FixtureHealth;
		const result = yield* health.check();
		expect(result).toEqual({
			status: "incompatible",
			message: "The configured endpoint is running OtherProject, not Fixture.",
			recovery:
				"Close the incompatible Unreal instance or configure another endpoint, then retry."
		});
	}).pipe(
		Effect.provide(
			FixtureHealthLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer({
							...unconfigured,
							expectedProject: { projectName: "Fixture", status: "configured" }
						}),
						makeRemoteControlClientTestLayer(() =>
							Effect.succeed(manifestOf({ projectName: "OtherProject" }))
						)
					)
				)
			)
		)
	)
);

it.effect("FixtureHealth reports not_running when Remote Control is unreachable", () =>
	Effect.gen(function* () {
		const health = yield* FixtureHealth;
		const result = yield* health.check();
		expect(result).toEqual({ status: "not_running" });
	}).pipe(
		Effect.provide(
			FixtureHealthLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeRemoteControlClientTestLayer(() =>
							Effect.fail(
								new RemoteControlClientError({
									endpoint: "http://127.0.0.1:30001",
									functionName: "GetCapabilityManifest",
									message: "Editor is not connected",
									operation: "fixture_health",
									retrySafe: true
								})
							)
						)
					)
				)
			)
		)
	)
);

it.effect("FixtureHealth reports ready for map-review when the review probe succeeds", () =>
	Effect.gen(function* () {
		const health = yield* FixtureHealth;
		const result = yield* health.check("map-review");
		expect(result).toEqual({ status: "ready" });
	}).pipe(
		Effect.provide(
			FixtureHealthLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeRemoteControlClientTestLayer(() => Effect.succeed(manifestOf({})))
					)
				)
			)
		)
	)
);

it.effect(
	"FixtureHealth reports incompatible for map-review when the running editor lacks review capture",
	() =>
		Effect.gen(function* () {
			const health = yield* FixtureHealth;
			const result = yield* health.check("map-review");
			expect(result).toEqual({
				status: "incompatible",
				message: "The configured endpoint is running Unreal without Map Review capture.",
				recovery:
					"Close the -game fixture or choose another endpoint, then launch the editor fixture."
			});
		}).pipe(
			Effect.provide(
				FixtureHealthLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeWorkbenchConfigurationLayer(unconfigured),
							makeRemoteControlClientTestLayer((request) =>
								request.functionName === "GetCapabilityManifest"
									? Effect.succeed(manifestOf({}))
									: Effect.fail(
											new RemoteControlClientError({
												endpoint: "http://127.0.0.1:30001",
												functionName: request.functionName,
												message: "Map Review capture is not available",
												operation: "fixture_health",
												retrySafe: false
											})
										)
							)
						)
					)
				)
			)
		)
);

// --- FixtureLauncher -----------------------------------------------------------

it.effect("launch returns ready without spawning when already healthy", () =>
	Effect.gen(function* () {
		const launcher = yield* FixtureLauncher;
		const result = yield* launcher.launch("default");
		expect(result).toEqual({ status: "ready" });
	}).pipe(
		Effect.provide(
			FixtureLauncherLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeFixtureHealthTestLayer({
							check: () => Effect.succeed({ status: "ready" })
						}),
						scriptOnDisk,
						Layer.succeed(FixtureProcess, neverCalledFixtureProcess())
					)
				)
			)
		)
	)
);

it.effect("launch preserves the incompatible-capability failure without spawning", () =>
	Effect.gen(function* () {
		const launcher = yield* FixtureLauncher;
		const result = yield* launcher.launch("authoring");
		expect(result).toEqual({
			status: "failed",
			message: "The configured endpoint is running Unreal without Map Review capture.",
			recovery:
				"Close the -game fixture or choose another endpoint, then launch the editor fixture."
		});
	}).pipe(
		Effect.provide(
			FixtureLauncherLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeFixtureHealthTestLayer({
							check: (capability) => {
								const incompatible: FixtureHealthResult = {
									status: "incompatible",
									message:
										"The configured endpoint is running Unreal without Map Review capture.",
									recovery:
										"Close the -game fixture or choose another endpoint, then launch the editor fixture."
								};
								const readyResult: FixtureHealthResult = { status: "ready" };
								return Effect.succeed(
									capability === "map-review" ? incompatible : readyResult
								);
							}
						}),
						scriptOnDisk,
						Layer.succeed(FixtureProcess, neverCalledFixtureProcess())
					)
				)
			)
		)
	)
);

it.effect("launch fails without spawning when no source-checkout is configured", () =>
	Effect.gen(function* () {
		const launcher = yield* FixtureLauncher;
		const result = yield* launcher.launch("default");
		expect(result).toEqual({
			status: "failed",
			message: "This Workbench session has no source-checkout fixture launcher.",
			recovery: "Start Workbench with pnpm showcase from the UE Shed repository."
		});
	}).pipe(
		Effect.provide(
			FixtureLauncherLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeFixtureHealthTestLayer({
							check: () => Effect.succeed({ status: "not_running" })
						}),
						scriptOnDisk,
						Layer.succeed(FixtureProcess, neverCalledFixtureProcess())
					)
				)
			)
		)
	)
);

it.effect("launch fails without spawning when the launcher script is missing on disk", () =>
	Effect.gen(function* () {
		const launcher = yield* FixtureLauncher;
		const result = yield* launcher.launch("default");
		expect(result).toEqual({
			status: "failed",
			message: "This Workbench session has no source-checkout fixture launcher.",
			recovery: "Start Workbench with pnpm showcase from the UE Shed repository."
		});
	}).pipe(
		Effect.provide(
			FixtureLauncherLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(configuredCheckout),
						makeFixtureHealthTestLayer({
							check: () => Effect.succeed({ status: "not_running" })
						}),
						makeLocalFilesTestLayer(),
						Layer.succeed(FixtureProcess, neverCalledFixtureProcess())
					)
				)
			)
		)
	)
);

it.effect("launch runs the checkout fixture script through tsx", () =>
	Effect.gen(function* () {
		const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
		const launched = yield* Ref.make(false);
		const fixtureProcess = FixtureProcess.of({
			launch: (options) =>
				Ref.set(recorded, options.args).pipe(
					Effect.andThen(Ref.set(launched, true)),
					Effect.as({ status: "ready" as const })
				)
		});
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					makeFixtureHealthTestLayer({
						check: () =>
							Ref.get(launched).pipe(
								Effect.map(
									(flag): FixtureHealthResult =>
										flag ? { status: "ready" } : { status: "not_running" }
								)
							)
					}),
					scriptOnDisk,
					Layer.succeed(FixtureProcess, fixtureProcess)
				)
			)
		);
		const result = yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			const fiber = yield* Effect.forkChild(launcher.launch("default"));
			yield* TestClock.adjust("1 second");
			return yield* Fiber.join(fiber);
		}).pipe(Effect.provide(layer));
		expect(result).toEqual({ status: "ready" });
		expect(yield* Ref.get(recorded)).toEqual([
			"--import",
			typescriptLoader,
			launchScriptPath,
			"launch"
		]);
	})
);

it.effect("launch spawns once and waits across poll ticks for readiness", () =>
	Effect.gen(function* () {
		const checks = yield* Ref.make(0);
		const launches = yield* Ref.make(0);
		const healthLayer = makeFixtureHealthTestLayer({
			check: () =>
				Ref.updateAndGet(checks, (count) => count + 1).pipe(
					Effect.map(
						(count): FixtureHealthResult =>
							count >= 3 ? { status: "ready" } : { status: "not_running" }
					)
				)
		});
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					healthLayer,
					scriptOnDisk,
					Layer.succeed(FixtureProcess, readyFixtureProcess(launches))
				)
			)
		);
		const result = yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			const fiber = yield* Effect.forkChild(launcher.launch("default"));
			yield* TestClock.adjust("2 seconds");
			return yield* Fiber.join(fiber);
		}).pipe(Effect.provide(layer));
		expect(result).toEqual({ status: "ready" });
		expect(yield* Ref.get(launches)).toBe(1);
	})
);

it.effect("launch reports a timeout when Remote Control never becomes ready", () =>
	Effect.gen(function* () {
		const launches = yield* Ref.make(0);
		const healthLayer = makeFixtureHealthTestLayer({
			check: () => Effect.succeed({ status: "not_running" })
		});
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					healthLayer,
					scriptOnDisk,
					Layer.succeed(FixtureProcess, readyFixtureProcess(launches))
				)
			)
		);
		const result = yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			const fiber = yield* Effect.forkChild(launcher.launch("default"));
			yield* TestClock.adjust("3 minutes");
			return yield* Fiber.join(fiber);
		}).pipe(Effect.provide(layer));
		expect(result).toEqual({
			status: "failed",
			message:
				"Unreal launched, but Remote Control did not become ready within three minutes.",
			recovery: "Check the Unreal process and Saved/Logs/UEShedFixture.log."
		});
		expect(yield* Ref.get(launches)).toBe(1);
	})
);

it.effect("launch stops polling when the started editor is incompatible", () =>
	Effect.gen(function* () {
		const checks = yield* Ref.make(0);
		const launches = yield* Ref.make(0);
		const incompatible: FixtureHealthResult = {
			status: "incompatible",
			message: "Started editor lacks Map Review.",
			recovery: "Enable UEShedCamerasEditor and retry."
		};
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					makeFixtureHealthTestLayer({
						check: () =>
							Ref.updateAndGet(checks, (count) => count + 1).pipe(
								Effect.map((count) =>
									count === 1
										? ({ status: "not_running" } as const)
										: incompatible
								)
							)
					}),
					scriptOnDisk,
					Layer.succeed(FixtureProcess, readyFixtureProcess(launches))
				)
			)
		);
		const result = yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			return yield* launcher.launch("authoring");
		}).pipe(Effect.provide(layer));
		expect(result).toEqual({
			status: "failed",
			message: incompatible.message,
			recovery: incompatible.recovery
		});
		expect(yield* Ref.get(checks)).toBe(2);
		expect(yield* Ref.get(launches)).toBe(1);
	})
);

it.effect("concurrent launches for the same mode share one spawn", () =>
	Effect.gen(function* () {
		const launches = yield* Ref.make(0);
		const launchedFlag = yield* Ref.make(false);
		const gate = yield* Deferred.make<void>();
		const healthLayer = makeFixtureHealthTestLayer({
			check: () =>
				Ref.get(launchedFlag).pipe(
					Effect.map(
						(flag): FixtureHealthResult =>
							flag ? { status: "ready" } : { status: "not_running" }
					)
				)
		});
		const fixtureProcess = FixtureProcess.of({
			launch: () =>
				Ref.update(launches, (count) => count + 1).pipe(
					Effect.andThen(Deferred.await(gate)),
					Effect.andThen(Ref.set(launchedFlag, true)),
					Effect.as({ status: "ready" as const })
				)
		});
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					healthLayer,
					scriptOnDisk,
					Layer.succeed(FixtureProcess, fixtureProcess)
				)
			)
		);
		const [resultA, resultB] = yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			const fiber = yield* Effect.forkChild(
				Effect.all([launcher.launch("default"), launcher.launch("default")], {
					concurrency: "unbounded"
				})
			);
			yield* Deferred.succeed(gate, undefined);
			return yield* Fiber.join(fiber);
		}).pipe(Effect.provide(layer));
		expect(resultA).toEqual({ status: "ready" });
		expect(resultB).toEqual({ status: "ready" });
		expect(yield* Ref.get(launches)).toBe(1);
	})
);

it.effect("a failed launch does not stay cached and a later call retries", () =>
	Effect.gen(function* () {
		const launches = yield* Ref.make(0);
		const healthLayer = makeFixtureHealthTestLayer({
			check: () =>
				Ref.get(launches).pipe(
					Effect.map(
						(count): FixtureHealthResult =>
							count >= 2 ? { status: "ready" } : { status: "not_running" }
					)
				)
		});
		const fixtureProcess = FixtureProcess.of({
			launch: () =>
				Ref.updateAndGet(launches, (count) => count + 1).pipe(
					Effect.map((count) =>
						count === 1
							? {
									status: "failed" as const,
									message: "boom",
									recovery: "retry the launch"
								}
							: { status: "ready" as const }
					)
				)
		});
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					healthLayer,
					scriptOnDisk,
					Layer.succeed(FixtureProcess, fixtureProcess)
				)
			)
		);
		const { first, second } = yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			const firstResult = yield* launcher.launch("default");
			const secondResult = yield* launcher.launch("default");
			return { first: firstResult, second: secondResult };
		}).pipe(Effect.provide(layer));
		expect(first).toEqual({ status: "failed", message: "boom", recovery: "retry the launch" });
		expect(second).toEqual({ status: "ready" });
		expect(yield* Ref.get(launches)).toBe(2);
	})
);

it.effect("interrupting an in-flight launch closes the launcher child", () =>
	Effect.gen(function* () {
		const terminated = yield* Ref.make(false);
		const started = yield* Deferred.make<void>();
		const fixtureProcess = FixtureProcess.of({
			launch: () =>
				Effect.acquireRelease(
					Deferred.succeed(started, undefined).pipe(Effect.as("child")),
					() => Ref.set(terminated, true)
				).pipe(Effect.andThen(Effect.never))
		});
		const layer = FixtureLauncherLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer(configuredCheckout),
					makeFixtureHealthTestLayer({
						check: () => Effect.succeed({ status: "not_running" })
					}),
					scriptOnDisk,
					Layer.succeed(FixtureProcess, fixtureProcess)
				)
			)
		);
		yield* Effect.gen(function* () {
			const launcher = yield* FixtureLauncher;
			const fiber = yield* Effect.forkChild(launcher.launch("default"));
			yield* Deferred.await(started);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.provide(layer));
		expect(yield* Ref.get(terminated)).toBe(true);
	})
);

it.effect("building the layer never calls health or the fixture process", () =>
	Effect.gen(function* () {
		const healthCalls = yield* Ref.make(0);
		const processCalls = yield* Ref.make(0);
		const healthLayer = makeFixtureHealthTestLayer({
			check: () =>
				Ref.update(healthCalls, (count) => count + 1).pipe(
					Effect.as({ status: "ready" } satisfies FixtureHealthResult)
				)
		});
		const fixtureProcess = FixtureProcess.of({
			launch: () =>
				Ref.update(processCalls, (count) => count + 1).pipe(
					Effect.as({ status: "ready" as const })
				)
		});
		const deps = Layer.mergeAll(
			makeWorkbenchConfigurationLayer(configuredCheckout),
			healthLayer,
			scriptOnDisk,
			Layer.succeed(FixtureProcess, fixtureProcess)
		);
		yield* Effect.scoped(Layer.build(FixtureLauncherLive.pipe(Layer.provide(deps))));
		expect(yield* Ref.get(healthCalls)).toBe(0);
		expect(yield* Ref.get(processCalls)).toBe(0);
	})
);
