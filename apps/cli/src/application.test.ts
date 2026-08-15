import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runTextReview } from "./asset-workflows.js";
import { runVersion } from "./core-workflows.js";
import { runMapHistory } from "./workflows/map.js";
import { runPluginsList } from "./workflows/plugins.js";
import { executeScenarioCommand } from "./workflows/scenario.js";
import { movementGymRuns } from "@ue-shed/scenarios";

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
							printError: () => Effect.void,
							setExitCode: () => Effect.void
						})
					)
				),
				() => Ref.update(finalized, (count) => count + 1)
			)
		);

		yield* Effect.scoped(runVersion().pipe(Effect.provide(layer)));

		expect(yield* Ref.get(acquired)).toBe(1);
		expect(yield* Ref.get(finalized)).toBe(1);
		expect(yield* Ref.get(output)).toContain("ue-shed");
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
					printError: () => Effect.void,
					setExitCode: () => Effect.void
				})
			);
			yield* Effect.scoped(
				runPluginsList({ _tag: "PluginsList", manifestPath }).pipe(Effect.provide(layer))
			);
			expect(yield* Ref.get(output)).toContain("UEShedCore");
			expect(yield* Ref.get(output)).toContain("0.1.0-rc.1");
		} finally {
			yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
		}
	})
);

it.effect("prints the public scenario runner result as structured JSON", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const layer = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) => Ref.update(output, (current) => current + value),
				printError: () => Effect.void,
				setExitCode: () => Effect.void
			})
		);
		const runner = {
			cancel: () => Effect.die("unexpected cancellation"),
			run: () => Effect.succeed(movementGymRuns[1]!)
		};
		yield* executeScenarioCommand(
			{ _tag: "ScenarioRun", endpoint: "http://editor", evidenceLimit: 2 },
			runner
		).pipe(Effect.provide(layer));

		const printed = JSON.parse(yield* Ref.get(output)) as { status: string };
		expect(printed.status).toBe("completed");
	})
);

it.effect("keeps a failed scenario structured while setting a non-zero outcome", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const layer = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) => Ref.update(output, (current) => current + value),
				printError: () => Effect.void,
				setExitCode: (code) => Ref.set(exitCode, code)
			})
		);
		const failedRun = {
			...movementGymRuns[1]!,
			status: "failed" as const,
			failure: {
				atState: "running",
				code: "probe_missing",
				message: "The required cache state was unavailable.",
				recovery: "Verify the Movement Gym fixture and retry."
			}
		};
		const runner = {
			cancel: () => Effect.die("unexpected cancellation"),
			run: () => Effect.succeed(failedRun)
		};

		yield* executeScenarioCommand(
			{ _tag: "ScenarioRun", endpoint: "http://editor" },
			runner
		).pipe(Effect.provide(layer));

		expect((JSON.parse(yield* Ref.get(output)) as { status: string }).status).toBe("failed");
		expect(yield* Ref.get(exitCode)).toBe(1);
	})
);

it.effect(
	"rejects invalid Map History time input before contacting Perforce",
	() =>
		Effect.gen(function* () {
			const output = yield* Ref.make("");
			const layer = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) => Ref.update(output, (current) => current + value),
					printError: () => Effect.void,
					setExitCode: () => Effect.void
				})
			);
			const error = yield* runMapHistory({
				_tag: "MapHistory",
				mapPath: "Content/Maps/L_Example.umap",
				projectRoot: "project",
				since: "not-a-timestamp-or-duration"
			}).pipe(Effect.provide(layer), Effect.flip);

			expect(error.message).toContain("--since");
			expect(yield* Ref.get(output)).toBe("");
		}),
	{ timeout: 15_000 }
);

it.effect("rejects Fast History path identity without both package and path", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const layer = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) => Ref.update(output, (current) => current + value),
				printError: () => Effect.void,
				setExitCode: () => Effect.void
			})
		);
		const error = yield* runMapHistory({
			_tag: "MapHistory",
			actorPackage: "/Game/__ExternalActors__/Maps/L_Example/A/Actor",
			mapPath: "Content/Maps/L_Example.umap",
			mode: "fast",
			projectRoot: "project",
			since: "2026-07-21T00:00:00.000Z"
		}).pipe(Effect.provide(layer), Effect.flip);

		expect(error.message).toContain("Fast History");
		expect(yield* Ref.get(output)).toBe("");
	})
);

it.effect(
	"reports malformed Game Text rules before scanning and does not echo their contents",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.promise(() =>
				mkdtemp(join(tmpdir(), "ue-shed-text-rules-"))
			);
			const ruleFile = join(root, "rules.json");
			yield* Effect.promise(() => writeFile(ruleFile, "{secret-project-term", "utf8"));
			try {
				const output = yield* Ref.make("");
				const layer = Layer.succeed(
					CliRuntime,
					CliRuntime.of({
						print: (value) => Ref.update(output, (current) => current + value),
						printError: () => Effect.void,
						setExitCode: () => Effect.void
					})
				);
				const error = yield* runTextReview({
					_tag: "TextReview",
					projectRoot: "project-is-never-scanned",
					ruleFile
				}).pipe(Effect.provide(layer), Effect.flip);

				expect(error.message).toContain("not valid JSON");
				expect(error.message).toContain("Correct the JSON syntax");
				expect(error.message).not.toContain("secret-project-term");
				expect(error.message).not.toContain(ruleFile);
				expect(yield* Ref.get(output)).toBe("");
			} finally {
				yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
			}
		})
);
