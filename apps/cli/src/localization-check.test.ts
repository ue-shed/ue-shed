import { resolve, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref, Result, Schema } from "effect";
import { expect } from "vitest";
import { LocalizationChangeSet } from "@ue-shed/localization/browser";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { writeLocalizationCheckChanges } from "./workflows/localization-check.js";

const document = Schema.decodeUnknownSync(LocalizationChangeSet)({
	schemaVersion: 1,
	provenance: { producer: "fixture", files: [] },
	changes: [
		{
			target: "Fixture",
			culture: "de",
			namespace: "NS",
			key: "Key",
			source: "{Name}",
			previousTranslation: "{Wrong}",
			translation: "{Name}"
		}
	]
});
const Failure = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literal("failed"),
	error: Schema.Struct({ code: Schema.String, message: Schema.String, recovery: Schema.String })
});

it.effect("exclusively creates a change-set JSON and preserves an existing proposal", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const destination = join(directory, "changes.json");
		yield* writeLocalizationCheckChanges(destination, document);
		const initial = yield* fs.readFileString(destination);
		expect(
			Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationChangeSet))(initial)
		).toEqual(document);
		const existing = yield* writeLocalizationCheckChanges(destination, {
			...document,
			changes: []
		}).pipe(Effect.result);
		if (Result.isSuccess(existing)) throw new Error("An existing proposal was overwritten.");
		expect(existing.failure.code).toBe("changes_exists");
		expect(existing.failure.message).not.toContain(destination);
		expect(yield* fs.readFileString(destination)).toBe(initial);
		for (const filename of [
			"Fixture.po",
			"Fixture.archive",
			"Fixture.locres",
			"Fixture.locmeta"
		]) {
			const rejected = yield* writeLocalizationCheckChanges(
				join(directory, filename),
				document
			).pipe(Effect.result);
			if (Result.isSuccess(rejected))
				throw new Error("A localization destination was accepted.");
			expect(rejected.failure.code).toBe("invalid_changes_destination");
			expect(yield* fs.exists(join(directory, filename))).toBe(false);
		}
		const unwritable = yield* writeLocalizationCheckChanges(
			join(directory, "missing-parent", "changes.json"),
			document
		).pipe(Effect.result);
		if (Result.isSuccess(unwritable)) throw new Error("A missing parent was silently created.");
		expect(unwritable.failure.code).toBe("changes_unwritable");
	}).pipe(Effect.provide(NodeServices.layer))
);

it.effect("loc check rejects unknown targets and cultures with safe actionable failures", () =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const exit = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (text) => Ref.update(output, (value) => value + text),
				printError: () => Effect.void,
				setExitCode: (code) => Ref.set(exit, code)
			})
		);
		for (const [target, flags, code] of [
			["PrivateMissingTarget", [], "target_not_found"],
			["Fixture427", ["--culture", "zz-PrivateCulture"], "invalid_selection"]
		] satisfies ReadonlyArray<readonly [string, readonly string[], string]>) {
			yield* Ref.set(output, "");
			yield* runCli([
				"loc",
				"check",
				resolve("fixtures/unreal-427-localization"),
				"--target",
				target,
				...flags
			]).pipe(Effect.provide(runtime));
			const report = Schema.decodeUnknownSync(Schema.fromJsonString(Failure))(
				yield* Ref.get(output)
			);
			expect(report.error.code).toBe(code);
			expect(report.error.message).not.toContain("Private");
			expect(report.error.recovery.length).toBeGreaterThan(0);
			expect(yield* Ref.get(exit)).toBe(2);
		}
	})
);

it.effect("loc check rejects unknown built-in ids at the CLI boundary", () =>
	Effect.gen(function* () {
		const errors = yield* Ref.make("");
		const exit = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: () => Effect.void,
				printError: (text) => Ref.update(errors, (value) => value + text),
				setExitCode: (code) => Ref.set(exit, code)
			})
		);
		yield* runCli([
			"loc",
			"check",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"Fixture427",
			"--check",
			"studio-only"
		]).pipe(Effect.provide(runtime));
		expect(yield* Ref.get(errors)).toContain("--check");
		expect(yield* Ref.get(exit)).toBe(2);
	})
);
