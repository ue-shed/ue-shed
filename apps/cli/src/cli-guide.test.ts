import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { CLI_GUIDE_NAMES, guideFile } from "./commands/guide.js";

/** Runs the CLI in process and returns what it printed and its exit code. */
const run = (args: readonly string[]) =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const code = yield* Ref.make(0);
		const runtime = Layer.succeed(CliRuntime, {
			print: (value) => Ref.update(output, (text) => text + value),
			printError: (value) => Ref.update(output, (text) => text + value),
			setExitCode: (value) => Ref.set(code, value)
		});
		yield* runCli(args).pipe(Effect.provide(runtime));
		return { output: yield* Ref.get(output), code: yield* Ref.get(code) };
	});

/**
 * The commands a guide names: each `ue-shed` line in its code blocks, and each inline
 * `` `loc …` `` command, as words with the leading `ue-shed` removed.
 */
function guideCommands(markdown: string): string[][] {
	const blocks = [...markdown.matchAll(/```sh\n([\s\S]*?)```/gu)].flatMap((match) =>
		match[1]!.split("\n").filter((line) => line.startsWith("ue-shed "))
	);
	const inline = [...markdown.matchAll(/`((?:loc|guide) [^`]+)`/gu)].map(
		(match) => `ue-shed ${match[1]!}`
	);
	return [...blocks, ...inline].map((line) => line.split(/\s+/u).slice(1));
}

it.effect.each(CLI_GUIDE_NAMES)("every command and flag the %s guide names exists", (name) =>
	Effect.gen(function* () {
		const markdown = readFileSync(fileURLToPath(guideFile(name)), "utf8");
		const commands = guideCommands(markdown);
		expect(commands.length).toBeGreaterThan(3);
		for (const words of commands) {
			const path = words.filter((word, index) =>
				words.slice(0, index + 1).every((part) => /^[a-z][a-z-]*$/u.test(part))
			);
			const flags = words.filter((word) => word.startsWith("--"));
			const help = yield* run([...path, "--help"]);
			expect(help.code, words.join(" ")).toBe(0);
			const usage = /USAGE\n {2}ue-shed ((?:[a-z][a-z-]* ?)+)/u
				.exec(help.output)?.[1]
				?.trim();
			expect(usage, words.join(" ")).toBeDefined();
			const named = usage!.split(" ");
			// The words after the command, such as `prepare` in `loc run prepare`, are arguments.
			expect(path.slice(0, named.length), words.join(" ")).toEqual(named);
			if (path.length > named.length)
				expect(help.output).toMatch(/ARGUMENTS\n {2}\S+ choice/u);
			for (const flag of flags)
				expect(help.output, `${words.join(" ")}: ${flag}`).toMatch(
					new RegExp(`\\n {2}${flag}[ ,]`, "u")
				);
		}
	})
);

it.effect("prints a guide by name and lists them without one", () =>
	Effect.gen(function* () {
		const listed = yield* run(["guide"]);
		expect(listed.output).toContain("changelist-check");
		const guide = yield* run(["guide", "changelist-check"]);
		expect(guide.code).toBe(0);
		expect(guide.output).toContain("# Checking a changelist's text");
	})
);
