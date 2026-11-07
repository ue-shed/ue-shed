import {
	LocalizationState,
	MAX_TEXT_QUERY_PAGE_SIZE,
	TextGroupBy,
	TextOriginKind,
	type LocalizationLens,
	type TextFilter
} from "@ue-shed/game-text/schema";
import { textWhere } from "@ue-shed/game-text/query";
import { Option } from "effect";
import { Flag } from "effect/cli";

export function localizationFlags() {
	return {
		culture: Flag.String("culture").pipe(Flag.optional),
		state: Flag.Literals("state", LocalizationState.literals).pipe(Flag.optional),
		limit: Flag.Int("limit").pipe(
			Flag.filter(
				(value) => value >= 1 && value <= MAX_TEXT_QUERY_PAGE_SIZE,
				() => `--limit must be between 1 and ${MAX_TEXT_QUERY_PAGE_SIZE}`
			),
			Flag.withDefault(50)
		),
		kinds: Flag.Literals("kind", TextOriginKind.literals).pipe(Flag.atMost(5)),
		path: Flag.String("path").pipe(Flag.optional),
		files: Flag.String("files").pipe(Flag.optional),
		...filterFlags()
	};
}

/** `--filter` clauses (repeatable), `--cultures`, the culture scope, and `--group`. */
export function filterFlags() {
	return {
		filters: Flag.String("filter").pipe(Flag.atMost(32)),
		cultures: Flag.String("cultures").pipe(Flag.optional),
		group: Flag.Literals("group", TextGroupBy.literals).pipe(Flag.optional)
	};
}

/** Command fields for `--filter`, `--cultures` and `--group`; absent when not given. */
export function optionalFilterFlags(
	filters: readonly string[],
	cultures: Option.Option<string>,
	group: Option.Option<TextGroupBy> = Option.none()
) {
	return {
		...(filters.length > 0 ? { filter: filters } : undefined),
		...(Option.isSome(cultures) ? { cultures: cultures.value } : undefined),
		...(Option.isSome(group) ? { group: group.value } : undefined)
	};
}

/** Command fields for `--kind`, `--path` and `--files`; absent when none was given. */
export function optionalWhereFlags(
	kinds: readonly TextOriginKind[],
	path: Option.Option<string>,
	files: Option.Option<string>
) {
	return {
		...(kinds.length > 0 ? { kinds } : undefined),
		...(Option.isSome(path) ? { pathPrefix: path.value } : undefined),
		...(Option.isSome(files) ? { changedFiles: files.value } : undefined)
	};
}

/**
 * A search request's filter for those command fields: `--kind`, `--path`, `--filter` clauses and
 * the localization lens as its `where`, and the read file list as its file scope.
 */
export function textRequestFilter(
	command: {
		readonly kinds?: readonly TextOriginKind[];
		readonly pathPrefix?: string;
	},
	options: {
		readonly files?: readonly string[] | undefined;
		readonly filter?: TextFilter | undefined;
		readonly lens?: LocalizationLens | undefined;
	} = {}
) {
	const where = textWhere({
		kinds: command.kinds,
		pathPrefix: command.pathPrefix,
		filter: options.filter,
		lens: options.lens
	});
	return {
		...(where === undefined ? undefined : { where }),
		...(options.files === undefined ? undefined : { fileScope: options.files })
	};
}

export function optionalLocalizationFlags(
	culture: Option.Option<string>,
	state: Option.Option<LocalizationState>
) {
	return {
		...(Option.isSome(culture) ? { culture: culture.value } : undefined),
		...(Option.isSome(state) ? { state: state.value } : undefined)
	};
}
