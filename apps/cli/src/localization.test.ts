import { resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { LocalizationTargetsReport } from "@ue-shed/localization/browser";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	defaultLocalizationLimits,
	makeLocalizationEvidenceTestLayer
} from "@ue-shed/localization";
import { expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { loadLocalizationContext } from "./workflows/localization.js";

const Failure = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literal("failed"),
	error: Schema.Struct({ code: Schema.String, message: Schema.String, recovery: Schema.String })
});

it.effect("loc status provides safe recovery for missing manifests and reader failures", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (text) => Ref.update(output, (value) => value + text),
				printError: () => Effect.void,
				setExitCode: (code) => Ref.set(exitCode, code)
			})
		);
		yield* runCli([
			"loc",
			"status",
			resolve("fixtures/unreal-project"),
			"--target",
			"Game"
		]).pipe(Effect.provide(runtime));
		const missing = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(
			yield* Ref.get(output)
		);
		expect(missing.error.code).toBe("missing_manifest");
		yield* Ref.set(output, "");
		yield* runCli([
			"loc",
			"status",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"Fixture427",
			"--reader",
			"missing-private-reader"
		]).pipe(Effect.provide(runtime));
		const failed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(
			yield* Ref.get(output)
		);
		expect(failed.error.code).toBe("reader_failure");
		expect(failed.error.message).toContain("ENOENT");
		expect(failed.error.recovery).toBe(
			"Choose an Unreal project directory containing a Content folder."
		);
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("a manifest over the byte limit keeps its cause and recovery before scanning", () =>
	Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const limited = makeLocalizationEvidenceTestLayer({
			...reader,
			read: (request) =>
				reader.read({
					...request,
					limits: { ...defaultLocalizationLimits, maxFileBytes: 1 }
				})
		});
		const error = yield* loadLocalizationContext({
			_tag: "LocalizationStatus",
			projectRoot: resolve("fixtures/unreal-427-localization"),
			target: "Fixture427",
			reader: "must-not-start",
			limit: 5
		}).pipe(Effect.provide(limited), Effect.flip);
		expect(error).toMatchObject({
			code: "unreadable_manifest",
			message: expect.stringContaining("limit_exceeded"),
			recovery: "Reduce the input or explicitly increase the localization reader limits."
		});
		expect(error.recovery).not.toContain("gather");
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
);

it.effect("loc status rejects an unknown target before opening the saved reader", () =>
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
		yield* runCli([
			"loc",
			"status",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"PrivateTargetName"
		]).pipe(Effect.provide(runtime));
		const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(
			yield* Ref.get(output)
		);
		expect(report.error.code).toBe("target_not_found");
		expect(report.error.message).not.toContain("PrivateTargetName");
		expect(report.error.recovery).toContain("loc targets");
		expect(yield* Ref.get(errors)).toBe("");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("loc status rejects an unsupported culture before scanning", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (text) => Ref.update(output, (value) => value + text),
				printError: () => Effect.void,
				setExitCode: (code) => Ref.set(exitCode, code)
			})
		);
		yield* runCli([
			"loc",
			"status",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"Fixture427",
			"--culture",
			"es"
		]).pipe(Effect.provide(runtime));
		const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Failure))(
			yield* Ref.get(output)
		);
		expect(report.error.code).toBe("invalid_selection");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

it.effect("loc status enforces bounded pages at the CLI boundary", () =>
	Effect.gen(function* () {
		const errors = yield* Ref.make("");
		const exitCode = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: () => Effect.void,
				printError: (text) => Ref.update(errors, (value) => value + text),
				setExitCode: (code) => Ref.set(exitCode, code)
			})
		);
		yield* runCli(["loc", "status", "project", "--target", "Target", "--limit", "51"]).pipe(
			Effect.provide(runtime)
		);
		expect(yield* Ref.get(errors)).toContain("--limit must be between 1 and 50");
		expect(yield* Ref.get(exitCode)).toBe(2);
	})
);

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
