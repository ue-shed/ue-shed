import { LocalizationState, TextOriginKind, type TextWhere } from "@ue-shed/game-text/browser";
import { Option } from "effect";
import { Flag } from "effect/unstable/cli";

export function localizationFlags() {
	return {
		culture: Flag.string("culture").pipe(Flag.optional),
		state: Flag.choice("state", LocalizationState.literals).pipe(Flag.optional),
		limit: Flag.integer("limit").pipe(
			Flag.filter(
				(value) => value >= 1 && value <= 50,
				() => "--limit must be between 1 and 50"
			),
			Flag.withDefault(50)
		),
		kinds: Flag.choice("kind", TextOriginKind.literals).pipe(Flag.atMost(5)),
		path: Flag.string("path").pipe(Flag.optional),
		files: Flag.string("files").pipe(Flag.optional)
	};
}

/** Command fields for `--kind`, `--path` and `--files`; absent when none was given. */
export function optionalWhereFlags(
	kinds: readonly (typeof TextOriginKind.Type)[],
	path: Option.Option<string>,
	files: Option.Option<string>
) {
	return {
		...(kinds.length > 0 ? { kinds } : undefined),
		...(Option.isSome(path) ? { pathPrefix: path.value } : undefined),
		...(Option.isSome(files) ? { changedFiles: files.value } : undefined)
	};
}

/** The search request's location filter for those command fields and the read file list. */
export function textWhere(
	command: {
		readonly kinds?: readonly (typeof TextOriginKind.Type)[];
		readonly pathPrefix?: string;
	},
	files?: readonly string[]
): TextWhere | undefined {
	if (command.kinds === undefined && command.pathPrefix === undefined && files === undefined)
		return undefined;
	return {
		...(command.kinds === undefined ? undefined : { kinds: command.kinds }),
		...(command.pathPrefix === undefined ? undefined : { pathPrefix: command.pathPrefix }),
		...(files === undefined ? undefined : { files })
	};
}

export function optionalLocalizationFlags(
	culture: Option.Option<string>,
	state: Option.Option<typeof LocalizationState.Type>
) {
	return {
		...(Option.isSome(culture) ? { culture: culture.value } : undefined),
		...(Option.isSome(state) ? { state: state.value } : undefined)
	};
}
