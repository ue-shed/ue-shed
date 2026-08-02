export interface ActorExplorerItem {
	readonly badges?: ReadonlyArray<string>;
	readonly classLabel?: string;
	readonly classPath: string;
	readonly key: string;
	readonly label: string;
	readonly packageName: string | undefined;
	readonly path: string | undefined;
	readonly secondary?: string;
	readonly searchFields?: Readonly<Record<string, string | undefined>>;
}

export interface ActorExplorerClassOption {
	readonly classPath: string;
	readonly count: number;
	readonly label?: string;
}

export interface ActorExplorerFilters {
	/** `undefined` means all classes, while an empty list means no classes. */
	readonly classPaths: readonly string[] | undefined;
	readonly query: string;
}

export const noActorExplorerFilters: ActorExplorerFilters = {
	classPaths: undefined,
	query: ""
};

function textIncludes(value: string | undefined, query: string): boolean {
	return value?.toLocaleLowerCase().includes(query) ?? false;
}

function matchesSearchTerm(item: ActorExplorerItem, term: string): boolean {
	const separator = term.indexOf(":");
	const field = separator < 1 ? undefined : term.slice(0, separator).toLocaleLowerCase();
	const query = (separator < 1 ? term : term.slice(separator + 1)).toLocaleLowerCase();
	if (query.length === 0) return true;
	const fields = item.searchFields ?? {
		class: item.classPath,
		label: item.label,
		package: item.packageName,
		path: item.path
	};
	if (field !== undefined) return textIncludes(fields[field], query);
	return Object.values(fields).some((value) => textIncludes(value, query));
}

export function actorExplorerMatchesQuery(item: ActorExplorerItem, query: string): boolean {
	return query
		.trim()
		.split(/\s+/)
		.filter((term) => term.length > 0)
		.every((term) => matchesSearchTerm(item, term));
}

export function actorExplorerMatches(
	item: ActorExplorerItem,
	filters: ActorExplorerFilters
): boolean {
	if (filters.classPaths !== undefined && !filters.classPaths.includes(item.classPath))
		return false;
	return actorExplorerMatchesQuery(item, filters.query);
}
