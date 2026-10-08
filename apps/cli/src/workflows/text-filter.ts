import {
	GameTextLocalizationError,
	TextFilterClause,
	type TextFilter
} from "@ue-shed/game-text/browser";
import { Effect, Schema } from "effect";

const CLAUSE = /^\s*(\S+)\s+(is|is-not|is_not)\s+(.+?)\s*$/u;
const decodeClause = Schema.decodeUnknownEffect(TextFilterClause);

/**
 * Reads `--filter` clauses such as `problem is key-changed,not-gathered` or
 * `folder is-not Content/Prototype/`: a field, `is` or `is-not`, and comma-separated values.
 * Folder values keep their spelling; other values accept hyphens for underscores.
 */
export const parseTextFilter = Effect.fn("Cli.text_filter.parse")(function* (
	clauses: readonly string[]
) {
	const filter: TextFilter[number][] = [];
	for (const text of clauses) {
		const match = CLAUSE.exec(text);
		const field = match?.[1];
		const op = match?.[2];
		const rest = match?.[3];
		if (field === undefined || op === undefined || rest === undefined)
			return yield* invalid(text);
		const values = rest
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value !== "")
			.map((value) => (field === "folder" ? value : value.replaceAll("-", "_")));
		filter.push(
			yield* decodeClause({
				field,
				op: op === "is" ? "is" : "is_not",
				values
			}).pipe(Effect.mapError(() => invalidClause(text)))
		);
	}
	return filter;
});

function invalidClause(text: string) {
	return new GameTextLocalizationError({
		code: "invalid_selection",
		message: `The filter "${text}" is not a valid clause.`,
		recovery:
			"Write a field, is or is-not, and comma-separated values, such as `problem is key-changed,not-gathered`. Fields: problem, finding, translation, origin, folder, editing, notes."
	});
}

const invalid = (text: string) => Effect.fail(invalidClause(text));

/** `--cultures de,fr,ja` as a list; absent when not given. */
export function cultureList(value: string | undefined): readonly string[] | undefined {
	if (value === undefined) return undefined;
	const list = value
		.split(",")
		.map((culture) => culture.trim())
		.filter((culture) => culture !== "");
	return list.length > 0 ? list : undefined;
}
