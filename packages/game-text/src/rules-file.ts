import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { GAME_TEXT_RULES_RELATIVE_PATH, STARTER_GAME_TEXT_RULES } from "./starter-rules.js";

export class TextRulesFileError extends Schema.TaggedErrorClass<TextRulesFileError>()(
	"TextRulesFileError",
	{
		code: Schema.Literals(["already_exists", "write_failed", "invalid_project"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export const createStarterTextRules = Effect.fn("GameText.createStarterTextRules")(function* (
	projectRoot: string,
	output?: string
) {
	const root = resolve(projectRoot);
	const directory = yield* Effect.tryPromise({
		try: () => stat(root),
		catch: () =>
			new TextRulesFileError({
				code: "invalid_project",
				message: "The project directory could not be read.",
				recovery: "Choose an existing project directory and retry."
			})
	});
	if (!directory.isDirectory()) {
		return yield* Effect.fail(
			new TextRulesFileError({
				code: "invalid_project",
				message: "The project root must be a directory.",
				recovery: "Choose an existing project directory and retry."
			})
		);
	}
	const path = resolve(root, output ?? GAME_TEXT_RULES_RELATIVE_PATH);
	yield* Effect.tryPromise({
		try: async () => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(STARTER_GAME_TEXT_RULES, null, "\t") + "\n", {
				encoding: "utf8",
				flag: "wx"
			});
		},
		catch: (cause) => {
			const exists = cause instanceof Object && "code" in cause && cause.code === "EEXIST";
			return new TextRulesFileError({
				code: exists ? "already_exists" : "write_failed",
				message: exists
					? "The Game Text rules file already exists."
					: "Could not create the Game Text rules file.",
				recovery: exists
					? "Load the existing file, or choose another --output file. Existing rules are never overwritten."
					: "Check directory permissions and choose a writable output file."
			});
		}
	});
	return path;
});
