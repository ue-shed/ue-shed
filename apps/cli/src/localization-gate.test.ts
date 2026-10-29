import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { localizationGateSummary } from "./workflows/localization-gate.js";

it.effect.each([
	{ flags: ["--files", "missing.txt"], message: '"not_checked"' },
	{
		flags: ["--files", "missing.txt", "--fail-on", "removed", "--warn-on", "removed"],
		message: "cannot both fail and warn"
	}
])("rejects gate input before project discovery: $message", ({ flags, message }) =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const code = yield* Ref.make(0);
		const runtime = Layer.succeed(CliRuntime, {
			print: (value) => Ref.update(output, (text) => text + value),
			printError: (value) => Ref.update(output, (text) => text + value),
			setExitCode: (value) => Ref.set(code, value)
		});
		yield* runCli(["loc", "gate", "missing-project", ...flags]).pipe(Effect.provide(runtime));
		expect(yield* Ref.get(code)).toBe(2);
		expect(yield* Ref.get(output)).toContain(message);
	})
);

it("formats failing and warning gate findings, omitted lines and skipped targets", () => {
	const target = {
		target: "Game",
		status: "failed" as const,
		lines: 1234,
		checks: {
			key_changed: 1,
			conflicting_source: 0,
			translated_text_changed: 0,
			text_changed: 0,
			not_gathered: 0,
			unresolved_key: 1,
			removed: 0,
			gathered_source: 0,
			partial_read: 0
		},
		items: [
			{
				check: "key_changed" as const,
				severity: "fail" as const,
				namespace: "UI",
				key: "K",
				source: "Play",
				file: "Content/Menu",
				guidance: "Carry translations first."
			},
			{
				check: "unresolved_key" as const,
				severity: "warn" as const,
				namespace: null,
				key: null,
				source: "Quit",
				file: "Content/Menu",
				guidance: "Assign a key."
			}
		],
		omitted: 2,
		fileScope: { files: 3, textFiles: 1, outside: 0 }
	};
	expect(
		localizationGateSummary({
			schemaVersion: 1,
			status: "failed",
			failOn: ["key_changed"],
			targets: [target],
			skipped: [{ target: "Other", reason: "Not gathered" }]
		})
	).toBe(
		[
			"Game: failed. 1,234 lines in 1 of 3 files, 1 failing.",
			'  FAIL  Key changed: UI,K "Play" in Content/Menu',
			"        Carry translations first.",
			'  warn  No reliable key: (no key) "Quit" in Content/Menu',
			"        Assign a key.",
			"  2 more lines not listed.",
			"Other: skipped. Not gathered",
			"Text check failed.",
			""
		].join("\n")
	);
	const { fileScope: _fileScope, ...unscoped } = target;
	expect(
		localizationGateSummary({
			schemaVersion: 1,
			status: "passed",
			failOn: [],
			targets: [{ ...unscoped, status: "passed", items: [], omitted: 0 }],
			skipped: []
		})
	).toContain("Text check passed.");
});
