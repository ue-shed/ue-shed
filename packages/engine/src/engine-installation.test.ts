import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { expect } from "vitest";
import {
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryLive
} from "./engine-installation.js";

it.effect("resolves an explicitly selected engine without a machine default", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-engine-")));
		const build = join(root, "Engine", "Build");
		yield* Effect.promise(() => mkdir(build, { recursive: true }));
		yield* Effect.promise(() =>
			writeFile(
				join(build, "Build.version"),
				JSON.stringify({ MajorVersion: 5, MinorVersion: 7, PatchVersion: 1 })
			)
		);
		const descriptor = join(root, "Fixture.uproject");
		yield* Effect.promise(() =>
			writeFile(descriptor, JSON.stringify({ EngineAssociation: "5.7" }))
		);
		const discovery = yield* EngineInstallationDiscovery;
		const installation = yield* discovery.resolve({
			projectDescriptor: descriptor,
			explicitRoot: root
		});
		expect(installation.version).toEqual({ major: 5, minor: 7, patch: 1 });
	}).pipe(
		Effect.provide(EngineInstallationDiscoveryLive),
		Effect.provide(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ ProgramFiles: "Z:\\NoEngines" }))
		)
	)
);
