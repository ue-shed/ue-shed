import { cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigProvider, Effect, Layer, Ref, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
	LocalizationOperationPlan,
	LocalizationOperationError
} from "@ue-shed/localization/browser";
import { runCli } from "./command.js";
import { CliRuntime } from "./cli-runtime.js";

it.effect("loc run --plan returns validated recipe writes without a commandlet or reader", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-loc-run-cli-")));
		try {
			const project = join(root, "project");
			const engine = join(root, "engine");
			yield* Effect.promise(async () => {
				await cp(resolve("fixtures/unreal-427-localization"), project, { recursive: true });
				await mkdir(join(engine, "Engine/Build"), { recursive: true });
				await writeFile(
					join(engine, "Engine/Build/Build.version"),
					JSON.stringify({ MajorVersion: 4, MinorVersion: 27, PatchVersion: 2 })
				);
			});
			const output = yield* Ref.make("");
			const errors = yield* Ref.make("");
			const exit = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) => Ref.update(output, (text) => text + value),
					printError: (value) => Ref.update(errors, (text) => text + value),
					setExitCode: (value) => Ref.set(exit, value)
				})
			);
			yield* runCli([
				"loc",
				"run",
				"gather",
				project,
				"--target",
				"Fixture427",
				"--engine-root",
				engine,
				"--plan"
			]).pipe(Effect.provide(runtime));
			const plan = Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationOperationPlan))(
				yield* Ref.get(output)
			);
			expect(plan.engine).toBe("4.27");
			expect(plan.wholeRecipe).toBe(true);
			expect(plan.files).toHaveLength(13);
			expect(yield* Ref.get(errors)).toBe("");
			expect(yield* Ref.get(exit)).toBe(0);
		} finally {
			yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
		}
	})
);

it.effect("loc run reports configuration provider failures without echoing private values", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const exit = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) => Ref.update(output, (text) => text + value),
				printError: () => Effect.void,
				setExitCode: (value) => Ref.set(exit, value)
			})
		);
		yield* runCli([
			"loc",
			"run",
			"gather",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"Fixture427",
			"--plan",
			"--json"
		]).pipe(
			Effect.provide(runtime),
			Effect.provide(
				ConfigProvider.layer(
					ConfigProvider.make((path) =>
						path.length === 1 && path[0] === "ProgramFiles"
							? Effect.fail(
									new ConfigProvider.SourceError({
										message: "private-environment-value"
									})
								)
							: Effect.succeed(undefined)
					)
				)
			)
		);
		const failure = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					schemaVersion: Schema.Literal(1),
					type: Schema.Literal("failure"),
					error: Schema.Struct({
						_tag: Schema.Literal("LocalizationRunConfigurationError"),
						code: Schema.Literal("invalid_configuration"),
						message: Schema.NonEmptyString,
						recovery: Schema.NonEmptyString,
						retrySafe: Schema.Literal(true)
					})
				})
			)
		)(yield* Ref.get(output));
		expect(failure.error.recovery).toContain("ProgramFiles / ProgramData");
		expect(failure.error.recovery).toContain("--plan");
		expect(yield* Ref.get(output)).not.toContain("private-environment-value");
		expect(yield* Ref.get(exit)).toBe(2);
	})
);

it.effect("loc run returns a typed unknown-target failure before engine discovery or launch", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const exit = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) => Ref.update(output, (text) => text + value),
				printError: () => Effect.void,
				setExitCode: (value) => Ref.set(exit, value)
			})
		);
		yield* runCli([
			"loc",
			"run",
			"sync",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"UnknownTargetSelection",
			"--json"
		]).pipe(Effect.provide(runtime));
		const failure = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					schemaVersion: Schema.Literal(1),
					type: Schema.Literal("failure"),
					error: LocalizationOperationError
				})
			)
		)(yield* Ref.get(output));
		expect(failure.error.code).toBe("target_not_found");
		expect(failure.error.recovery).toContain("loc targets");
		expect(yield* Ref.get(output)).not.toContain("UnknownTargetSelection");
		expect(yield* Ref.get(exit)).toBe(2);
	})
);

it.effect("loc run refuses --carry for a run that does not gather", () =>
	Effect.gen(function* () {
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: () => Effect.void,
				printError: () => Effect.void,
				setExitCode: () => Effect.void
			})
		);
		const failure = yield* runCli([
			"loc",
			"run",
			"sync",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"FixtureGame",
			"--carry",
			"carry.json"
		]).pipe(Effect.provide(runtime), Effect.flip);
		expect(failure.message).toContain("--carry needs a run that gathers");
	})
);
