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

function engineAt(root: string, minor: number) {
	return Effect.promise(async () => {
		await mkdir(join(root, "Engine", "Build"), { recursive: true });
		await writeFile(
			join(root, "Engine", "Build", "Build.version"),
			JSON.stringify({ MajorVersion: 5, MinorVersion: minor, PatchVersion: 4 })
		);
	});
}

function launcherList(programData: string, engines: readonly string[]) {
	return Effect.promise(async () => {
		const launcher = join(programData, "Epic", "UnrealEngineLauncher");
		await mkdir(launcher, { recursive: true });
		await writeFile(
			join(launcher, "LauncherInstalled.dat"),
			JSON.stringify({
				InstallationList: [
					{ AppName: "Fortnite", InstallLocation: "Z:\\Games\\Fortnite" },
					...engines.map((root, index) => ({
						AppName: `UE_5.${7 + index}`,
						InstallLocation: root
					}))
				]
			})
		);
	});
}

it.effect.skipIf(process.platform !== "win32")(
	"finds a Launcher engine installed outside Program Files",
	() => {
		const fixture = Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-launcher-")));
		return Effect.gen(function* () {
			const root = yield* fixture;
			const engine = join(root, "Drive", "UE_5.7");
			yield* engineAt(engine, 7);
			yield* launcherList(join(root, "ProgramData"), [engine]);
			const descriptor = join(root, "Game.uproject");
			yield* Effect.promise(() =>
				writeFile(descriptor, JSON.stringify({ EngineAssociation: "5.7" }))
			);
			const installation = yield* Effect.flatMap(EngineInstallationDiscovery, (discovery) =>
				discovery.resolve({ projectDescriptor: descriptor })
			).pipe(
				Effect.provide(EngineInstallationDiscoveryLive),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							ProgramData: join(root, "ProgramData"),
							ProgramFiles: join(root, "NoEngines")
						})
					)
				)
			);
			expect(installation).toEqual({
				root: engine,
				version: { major: 5, minor: 7, patch: 4 }
			});
		});
	}
);

it.effect.skipIf(process.platform !== "win32")(
	"counts an engine the Launcher put in Program Files once",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-launcher-")));
			const programFiles = join(root, "Program Files");
			const engine = join(programFiles, "Epic Games", "UE_5.7");
			yield* engineAt(engine, 7);
			yield* launcherList(join(root, "ProgramData"), [engine]);
			const descriptor = join(root, "Game.uproject");
			yield* Effect.promise(() =>
				writeFile(descriptor, JSON.stringify({ EngineAssociation: "5.7" }))
			);
			const installation = yield* Effect.flatMap(EngineInstallationDiscovery, (discovery) =>
				discovery.resolve({ projectDescriptor: descriptor })
			).pipe(
				Effect.provide(EngineInstallationDiscoveryLive),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							ProgramData: join(root, "ProgramData"),
							ProgramFiles: programFiles
						})
					)
				)
			);
			expect(installation.root).toBe(engine);
		})
);
