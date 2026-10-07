import { resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { LocalizationTargetsReport } from "@ue-shed/localization/browser";
import { expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

it.effect("loc targets prints schema-versioned config-only evidence through the command tree", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (text) => Ref.update(output, (value) => value + text),
				printError: (text) => Ref.update(errors, (value) => value + text),
				setExitCode: (code) => Ref.set(exitCode, code)
			})
		);
		yield* runCli(["loc", "targets", resolve("fixtures/unreal-427-localization")]).pipe(
			Effect.provide(runtime)
		);
		const report = yield* Schema.decodeUnknownEffect(LocalizationTargetsReport)(
			JSON.parse(yield* Ref.get(output))
		);
		expect(report.targets[0]?.name).toBe("Fixture427");
		expect(report.targets[0]?.source).toBe("config_only");
		expect(report.targets[0]?.configs).toHaveLength(1);
		expect(
			report.presence[0]?.cultures.every(
				(culture) => culture.archive && culture.po && culture.resource
			)
		).toBe(true);
		expect(yield* Ref.get(errors)).toBe("");
		expect(yield* Ref.get(exitCode)).toBe(0);
	})
);
