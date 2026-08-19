import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { CliRuntime, type CliRuntimeApi } from "./cli-runtime.js";
import { runCli } from "./command.js";

function runtimeLayer(output: Ref.Ref<string>, errors: Ref.Ref<string>, exitCode: Ref.Ref<number>) {
	const runtime: CliRuntimeApi = {
		print: (value) => Ref.update(output, (current) => current + value),
		printError: (value) => Ref.update(errors, (current) => current + value),
		setExitCode: (value) => Ref.set(exitCode, value)
	};
	return Layer.succeed(CliRuntime, CliRuntime.of(runtime));
}

it.effect("renders generated help through the Effect CLI command tree", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		yield* runCli(["--help"]).pipe(Effect.provide(runtimeLayer(output, errors, exitCode)));

		expect(yield* Ref.get(output)).toContain(
			"UE Shed — External tools for Unreal Engine development."
		);
		expect(yield* Ref.get(output)).toContain("authoring");
		expect(yield* Ref.get(output)).toContain("project-index");
		expect(yield* Ref.get(output)).toContain("custodian");
		expect(yield* Ref.get(output)).toContain("scenarios");
		expect(yield* Ref.get(output)).toContain("niagara");
		expect(yield* Ref.get(errors)).toBe("");
		expect(yield* Ref.get(exitCode)).toBe(0);
	})
);

it.effect("validates Niagara render bounds before launching Unreal", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);

		yield* runCli([
			"niagara",
			"preview",
			"Fixture.uproject",
			"/Game/Fixture/Niagara/NS_Preview.NS_Preview",
			"--frames",
			"0"
		]).pipe(Effect.provide(runtimeLayer(output, errors, exitCode)));

		expect(yield* Ref.get(output)).toBe("");
		expect(yield* Ref.get(errors)).toContain("--frames requires a positive integer");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("validates the public scenarios command before contacting Unreal", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);

		yield* runCli(["scenarios", "run", "http://editor", "--evidence-limit", "0"]).pipe(
			Effect.provide(runtimeLayer(output, errors, exitCode))
		);

		expect(yield* Ref.get(output)).toBe("");
		expect(yield* Ref.get(errors)).toContain("--evidence-limit requires a positive integer");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("keeps help, version, and the help command on the public boundary", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const layer = runtimeLayer(output, errors, exitCode);

		yield* runCli([]).pipe(Effect.provide(layer));
		expect(yield* Ref.get(output)).toContain("USAGE");

		yield* Ref.set(output, "");
		yield* runCli(["help"]).pipe(Effect.provide(layer));
		expect(yield* Ref.get(output)).toContain("SUBCOMMANDS");

		yield* Ref.set(output, "");
		yield* runCli(["--version"]).pipe(Effect.provide(layer));
		expect(yield* Ref.get(output)).toMatch(/^ue-shed 0\.0\.0 \(protocol \d+\.\d+\)\r?\n$/);
	})
);

it.effect("reports parser failures as usage errors without leaking generated help to stdout", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);

		yield* runCli(["not-a-command"]).pipe(
			Effect.provide(runtimeLayer(output, errors, exitCode))
		);

		expect(yield* Ref.get(output)).toBe("");
		expect(yield* Ref.get(errors)).toContain("ue-shed: Unknown subcommand");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("parses declarative cross-option validation before running product services", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const layer = runtimeLayer(output, errors, exitCode);

		const mapError = yield* runCli([
			"map",
			"history",
			"project",
			"Content/Maps/L_Example.umap",
			"--since",
			"7 days",
			"--mode",
			"fast"
		]).pipe(Effect.provide(layer), Effect.flip);
		expect(mapError.message).toContain("--mode fast requires exactly one target");

		const captureError = yield* runCli([
			"review",
			"capture",
			"project",
			"set.json",
			"http://editor",
			"--correlation",
			"daily-fixture"
		]).pipe(Effect.provide(layer), Effect.flip);
		expect(captureError.message).toContain("--cause external_automation");
	})
);

it.effect("validates repeated filter inputs through the declarative parser", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);

		const result = yield* runCli([
			"assets",
			"scan",
			"project",
			"--maximum-assets",
			"0",
			"--class",
			"InputAction",
			"--class",
			"InputMappingContext",
			"--"
		]).pipe(Effect.provide(runtimeLayer(output, errors, exitCode)), Effect.exit);

		expect(result._tag).toBe("Success");
		expect(yield* Ref.get(output)).toBe("");
		expect(yield* Ref.get(errors)).toContain("--maximum-assets");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("requires an explicit rule file for Game Text review", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);

		yield* runCli(["text", "review", "project"]).pipe(
			Effect.provide(runtimeLayer(output, errors, exitCode))
		);

		expect(yield* Ref.get(output)).toBe("");
		expect(yield* Ref.get(errors)).toContain("--rules");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);
