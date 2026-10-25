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

it.effect("loc check rejects unsupported cultures with safe actionable failures", () =>
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
		yield* runCli([
			"loc",
			"check",
			resolve("fixtures/unreal-427-localization"),
			"--target",
			"Fixture427",
			"--culture",
			"zz-PrivateCulture"
		]).pipe(Effect.provide(runtime));
		const report = Schema.decodeUnknownSync(Schema.fromJsonString(Failure))(
			yield* Ref.get(output)
		);
		expect(report.error.code).toBe("invalid_selection");
		expect(report.error.message).not.toContain("Private");
		expect(report.error.recovery.length).toBeGreaterThan(0);
		expect(yield* Ref.get(exit)).toBe(2);
	})
);

/** Runs the CLI, collecting what it prints, its stderr and its exit code. */
const run = (args: readonly string[]) =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const errors = yield* Ref.make("");
		const exit = yield* Ref.make(0);
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (text) => Ref.update(output, (value) => value + text),
				printError: (text) => Ref.update(errors, (value) => value + text),
				setExitCode: (code) => Ref.set(exit, code)
			})
		);
		yield* runCli(args).pipe(Effect.provide(runtime));
		return {
			output: yield* Ref.get(output),
			errors: yield* Ref.get(errors),
			exit: yield* Ref.get(exit)
		};
	});
const Report = Schema.Struct({
	findings: Schema.Array(Schema.Struct({ kind: Schema.String })),
	rules: Schema.Array(Schema.Struct({ ruleId: Schema.String }))
});

it.effect("loc check runs the file --rules names, and says when no rules file ran", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const rules = join(directory, "rules.json");
		yield* fs.writeFileString(
			rules,
			JSON.stringify({
				schemaVersion: 1,
				roles: [],
				rules: [{ kind: "missing_translator_notes" }]
			})
		);
		const project = resolve("fixtures/unreal-427-localization");
		const base = ["loc", "check", project, "--target", "Fixture427"];
		const given = yield* run([...base, "--rules", rules]);
		expect(given.exit).toBe(0);
		expect(given.errors).not.toContain("No rules file");
		const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(given.output);
		expect(report.rules.map((rule) => rule.ruleId)).toEqual([
			"localization.missing_translator_notes"
		]);
		expect(
			report.findings.every((finding) => finding.kind === "missing_translator_notes")
		).toBe(true);
		// The fixture has no rules file of its own: nothing runs, and stderr says why.
		const none = yield* run(base);
		expect(none.exit).toBe(0);
		expect(Schema.decodeUnknownSync(Schema.fromJsonString(Report))(none.output).rules).toEqual(
			[]
		);
		expect(none.errors).toContain("No rules file: no checks ran.");
		const missing = yield* run([...base, "--rules", join(directory, "missing.json")]);
		expect(missing.exit).toBe(2);
		const failure = Schema.decodeUnknownSync(Schema.fromJsonString(Failure))(missing.output);
		expect(failure.error.code).toBe("rules_unreadable");
		expect(failure.error.message).not.toContain(directory);
	}).pipe(Effect.provide(NodeServices.layer))
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
