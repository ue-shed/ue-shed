import { MAX_TEXT_SCOPE_FILES, projectRelativeTextFiles } from "@ue-shed/game-text/browser";
import { Effect, FileSystem, Metric } from "effect";
import { CliCommandError } from "../cli-runtime.js";

const maxListBytes = 4 * 1024 * 1024;

/**
 * Reads a changed-file list: one path per line, from any version control tool's output. Blank
 * lines and `#` comments are skipped, and absolute paths under the project become relative.
 */
export const readChangedFiles = Effect.fn("Cli.changed_files.read")(function* (
	path: string,
	projectRoot: string
) {
	const fs = yield* FileSystem.FileSystem;
	const unreadable = () =>
		new CliCommandError({
			message: `The changed-file list ${path} could not be read. Pass a UTF-8 text file with one path per line.`
		});
	const stat = yield* fs.stat(path).pipe(Effect.mapError(unreadable));
	if (stat.size > maxListBytes)
		return yield* Effect.fail(
			new CliCommandError({
				message:
					"The changed-file list is larger than 4 MB. Split the change or filter the list."
			})
		);
	const text = yield* fs.readFileString(path).pipe(Effect.mapError(unreadable));
	const files = projectRelativeTextFiles(text.split(/\r?\n/u), projectRoot);
	if (files.length === 0)
		return yield* Effect.fail(
			new CliCommandError({ message: "The changed-file list names no files." })
		);
	if (files.length > MAX_TEXT_SCOPE_FILES)
		return yield* Effect.fail(
			new CliCommandError({
				message: `The changed-file list names more than ${MAX_TEXT_SCOPE_FILES.toLocaleString("en-US")} files. Split the change or filter the list.`
			})
		);
	yield* Metric.update(Metric.counter("cli.text.changed_files"), files.length);
	return files;
});
