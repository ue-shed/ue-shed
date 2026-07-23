import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { CliRuntime, executeCommand } from "./application.js";
import { CliCommand } from "./command.js";

it.effect("acquires and finalizes the CLI runtime exactly once", () =>
	Effect.gen(function* () {
		const acquired = yield* Ref.make(0);
		const finalized = yield* Ref.make(0);
		const output = yield* Ref.make("");
		const layer = Layer.effect(
			CliRuntime,
			Effect.acquireRelease(
				Ref.update(acquired, (count) => count + 1).pipe(
					Effect.as(
						CliRuntime.of({
							print: (value) => Ref.update(output, (current) => current + value),
							setExitCode: () => Effect.void
						})
					)
				),
				() => Ref.update(finalized, (count) => count + 1)
			)
		);

		yield* Effect.scoped(
			executeCommand(CliCommand.cases.Help.make({})).pipe(Effect.provide(layer))
		);

		expect(yield* Ref.get(acquired)).toBe(1);
		expect(yield* Ref.get(finalized)).toBe(1);
		expect(yield* Ref.get(output)).toContain("UE Shed");
	})
);

it.effect("executes the public plugin list command through the CLI runtime", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-cli-plugin-list-"))
		);
		const manifestPath = join(root, "plugins.manifest.json");
		yield* Effect.promise(() =>
			writeFile(
				manifestPath,
				JSON.stringify({
					artifact: {
						bytes: 1,
						id: "ue-shed-plugin-source",
						kind: "plugin-source",
						path: "plugins.tar.gz",
						sha256: `sha256:${"a".repeat(64)}`
					},
					plugins: [
						{
							dependencies: [],
							descriptorPath: "UEShedCore/UEShedCore.uplugin",
							directory: "UEShedCore",
							id: "UEShedCore",
							version: "0.1.0"
						}
					],
					provenance: {
						candidateManifest: {
							manifestPath: "candidate-manifest.json",
							sha256: `sha256:${"b".repeat(64)}`,
							version: "0.1.0-rc.1"
						},
						source: {
							commit: "a".repeat(40),
							ref: "refs/tags/v0.1.0-rc.1",
							repository: "https://github.com/ue-shed/ue-shed"
						}
					},
					releaseVersion: "0.1.0-rc.1",
					schemaVersion: 1,
					unreal: { maximum: "5.7", minimum: "5.7" }
				}) + "\n",
				"utf8"
			)
		);
		try {
			const output = yield* Ref.make("");
			const layer = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) => Ref.update(output, (current) => current + value),
					setExitCode: () => Effect.void
				})
			);
			yield* Effect.scoped(
				executeCommand(CliCommand.cases.PluginsList.make({ manifestPath })).pipe(
					Effect.provide(layer)
				)
			);
			expect(yield* Ref.get(output)).toContain("UEShedCore");
			expect(yield* Ref.get(output)).toContain("0.1.0-rc.1");
		} finally {
			yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
		}
	})
);
