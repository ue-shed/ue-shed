import { readFile } from "node:fs/promises";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { CliCommandError, CliRuntime } from "../cli-runtime.js";

/** The guides shipped with the CLI, by name, each a Markdown file in `apps/cli/guides`. */
export const CLI_GUIDES = {
	"changelist-check":
		"Check what a Perforce changelist does to a project's text and translations."
} as const;

/** Where a guide's Markdown lives. */
export const guideFile = (name: keyof typeof CLI_GUIDES) =>
	new URL(`../../guides/${name}.md`, import.meta.url);

/** The guides' names. */
export const CLI_GUIDE_NAMES = Object.keys(CLI_GUIDES).filter(
	(name): name is keyof typeof CLI_GUIDES => Object.hasOwn(CLI_GUIDES, name)
);

export const guideCommand = Command.make(
	"guide",
	{ name: Argument.Literals("name", CLI_GUIDE_NAMES).pipe(Argument.optional) },
	({ name }) =>
		Effect.gen(function* () {
			const runtime = yield* CliRuntime;
			if (Option.isNone(name)) {
				yield* runtime.print(
					`${CLI_GUIDE_NAMES.map((guide) => `${guide}  ${CLI_GUIDES[guide]}`).join("\n")}\n`
				);
				return;
			}
			const text = yield* Effect.tryPromise({
				try: () => readFile(guideFile(name.value), "utf8"),
				catch: (cause) =>
					new CliCommandError({
						cause,
						recovery: "Reinstall UE Shed; the guide ships with the CLI.",
						retrySafe: false,
						nextStep: "escalate",
						code: "cli_command_failed",
						message: `The guide ${name.value} could not be read.`
					})
			});
			yield* runtime.print(text);
		})
).pipe(
	Command.withDescription(
		"Print a guide for people and coding agents; without a name, list the guides."
	)
);
