import { resolve } from "node:path";
import { it } from "@effect/vitest";
import {
	EngineInstallationError,
	makeEngineInstallationDiscoveryTestLayer
} from "@ue-shed/engine-discovery";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { expect } from "vitest";
import {
	ConfigFileAccess,
	ConfigFileAccessError,
	ConfigFileAccessLive,
	type ConfigFileAccessShape
} from "./file-access.js";
import { ConfigExplorer, ConfigExplorerLive, ConfigExplorerNodeLive } from "./service.js";
import {
	ConfigCompareRequest,
	ConfigExplanation,
	ConfigFamily,
	ConfigKey,
	ConfigPlatform,
	ConfigSection
} from "./schema.js";

const fixture = resolve("packages/config-explorer/fixtures/config-source");
const fixtureEngine = makeEngineInstallationDiscoveryTestLayer(() =>
	Effect.succeed({ root: fixture, version: { major: 5, minor: 7, patch: 0 } })
);
const unavailableEngine = makeEngineInstallationDiscoveryTestLayer(() =>
	Effect.fail(
		new EngineInstallationError({
			code: "engine_not_found",
			message: "No matching Unreal installation was discovered.",
			recovery: "Pass an explicit engine root.",
			retrySafe: true
		})
	)
);

function fileAccessWith(
	readText: (
		base: ConfigFileAccessShape,
		path: string
	) => ReturnType<ConfigFileAccessShape["readText"]>
) {
	return Layer.effect(
		ConfigFileAccess,
		Effect.gen(function* () {
			const base = yield* ConfigFileAccess;
			return ConfigFileAccess.of({ ...base, readText: (path) => readText(base, path) });
		})
	).pipe(Layer.provide(ConfigFileAccessLive));
}

function explorerWith(fileAccess: Layer.Layer<ConfigFileAccess>) {
	return ConfigExplorerLive.pipe(Layer.provide(fileAccess), Layer.provide(fixtureEngine));
}

function explainRequest(platform: "PlatformA" | "PlatformB", key = "Entries") {
	return {
		project: fixture,
		engineRoot: fixture,
		platform: ConfigPlatform.make(platform),
		family: ConfigFamily.make("Game"),
		section: ConfigSection.make("Fixture.Settings"),
		key: ConfigKey.make(key)
	};
}

it.effect("explains ordered source contributions and preserves missing-layer coverage", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const result = yield* explorer.explain(explainRequest("PlatformA"));
		expect(result.status).toBe("complete");
		expect(result.effectiveValue).toEqual({ kind: "array", values: ["PlatformA"] });
		expect(result.contributions.map(({ operation }) => operation)).toEqual([
			"set",
			"add_unique",
			"add_unique",
			"append",
			"append",
			"add_unique",
			"remove",
			"add_unique",
			"remove",
			"add_unique",
			"clear",
			"add_unique"
		]);
		expect(result.layers.some((layer) => layer.status === "missing")).toBe(true);
		expect(
			result.layers
				.filter((layer) => layer.status === "read")
				.map((layer) => layer.source.path)
		).toContain("Config/PlatformA/PlatformAGame.ini");
		expect(JSON.stringify(result)).not.toContain(fixture);
		yield* Schema.decodeUnknownEffect(ConfigExplanation)(result);
	}).pipe(Effect.provide(ConfigExplorerNodeLive))
);

it.effect("compares platforms by resolving both hierarchies independently", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const comparison = yield* explorer.compare(
			ConfigCompareRequest.make({
				project: fixture,
				engineRoot: fixture,
				leftPlatform: ConfigPlatform.make("PlatformA"),
				rightPlatform: ConfigPlatform.make("PlatformB"),
				family: ConfigFamily.make("Game"),
				section: ConfigSection.make("Fixture.Settings"),
				key: ConfigKey.make("Entries")
			})
		);
		expect(comparison.status).toBe("different");
		expect(comparison.left.effectiveValue).toEqual({ kind: "array", values: ["PlatformA"] });
		expect(comparison.right.effectiveValue).toEqual({
			kind: "array",
			values: ["PlatformB", "PlatformB"]
		});
	}).pipe(Effect.provide(ConfigExplorerNodeLive))
);

it.effect("reports unsupported selected-key syntax as partial coverage", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const result = yield* explorer.explain(explainRequest("PlatformA", "Unsupported"));
		expect(result.status).toBe("partial");
		expect(result.diagnostics.map(({ code }) => code)).toContain("unsupported_operator");
		expect(result.layers.some((layer) => layer.status === "unsupported")).toBe(true);
	}).pipe(Effect.provide(ConfigExplorerNodeLive))
);

it.effect("reports a relevant config redirect rather than claiming complete identity", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const result = yield* explorer.explain(explainRequest("PlatformA", "Redirected"));
		expect(result.status).toBe("partial");
		expect(result.diagnostics.map(({ code }) => code)).toContain("unsupported_config_redirect");
		expect(
			result.layers.some(
				(layer) => layer.layer === "ConfigRedirects" && layer.status === "unsupported"
			)
		).toBe(true);
	}).pipe(Effect.provide(ConfigExplorerNodeLive))
);

it.effect("discovers a unique family and distinguishes explicit empty from missing", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const result = yield* explorer.explain({
			project: fixture,
			engineRoot: fixture,
			platform: ConfigPlatform.make("PlatformA"),
			section: ConfigSection.make("Fixture.Settings"),
			key: ConfigKey.make("ExplicitEmpty")
		});
		expect(result.family).toBe("Game");
		expect(result.effectiveValue).toEqual({ kind: "empty_array" });
	}).pipe(Effect.provide(ConfigExplorerNodeLive))
);

it.effect("returns typed ambiguity instead of guessing a config family", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const ambiguous = yield* Effect.flip(
			explorer.explain({
				project: fixture,
				engineRoot: fixture,
				platform: ConfigPlatform.make("PlatformA"),
				section: ConfigSection.make("Fixture.Settings"),
				key: ConfigKey.make("Ambiguous")
			})
		);
		expect(ambiguous.code).toBe("ambiguous_config_family");
		expect(ambiguous.candidates).toEqual(["Engine", "Game"]);
	}).pipe(Effect.provide(ConfigExplorerNodeLive))
);

it.effect("surfaces an existing unreadable layer as partial coverage", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const result = yield* explorer.explain(explainRequest("PlatformA"));
		expect(result.status).toBe("partial");
		expect(
			result.layers.some(
				(layer) =>
					layer.source.path === "Config/DefaultGame.ini" && layer.status === "unreadable"
			)
		).toBe(true);
	}).pipe(
		Effect.provide(
			explorerWith(
				fileAccessWith((base, path) =>
					path.endsWith("DefaultGame.ini")
						? Effect.fail(
								new ConfigFileAccessError({
									operation: "read",
									message: "Fixture read denied.",
									retrySafe: true
								})
							)
						: base.readText(path)
				)
			)
		)
	)
);

it.effect("interrupts an in-flight hierarchy read", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const interrupted = yield* Deferred.make<void>();
		const layer = explorerWith(
			fileAccessWith((base, path) =>
				/[\\/]Engine[\\/]Config[\\/]Base\.ini$/u.test(path)
					? Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
						)
					: base.readText(path)
			)
		);
		const fiber = yield* Effect.forkChild(
			Effect.gen(function* () {
				const explorer = yield* ConfigExplorer;
				return yield* explorer.explain(explainRequest("PlatformA"));
			}).pipe(Effect.provide(layer))
		);
		yield* Deferred.await(started);
		yield* Fiber.interrupt(fiber);
		yield* Deferred.await(interrupted);
		expect(true).toBe(true);
	})
);

it.effect("maps incomplete engine discovery to a safe public recovery", () =>
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const { engineRoot: _engineRoot, ...request } = explainRequest("PlatformA");
		const failure = yield* Effect.flip(explorer.explain(request));
		expect(failure.code).toBe("engine_discovery_incomplete");
		expect(failure.recovery).toBe("Pass an explicit engine root.");
		expect(JSON.stringify(failure)).not.toContain(fixture);
	}).pipe(
		Effect.provide(
			ConfigExplorerLive.pipe(
				Layer.provide(ConfigFileAccessLive),
				Layer.provide(unavailableEngine)
			)
		)
	)
);
