import type { TextLocation, TextOriginKind, TextUnit, TextWhere } from "./schema.js";

export const TEXT_ORIGIN_KINDS = [
	"string_table",
	"data_table",
	"asset",
	"cpp",
	"other_source"
] as const satisfies readonly TextOriginKind[];

const LOCATION_ORIGINS = {
	asset_property: "asset",
	data_table_cell: "data_table",
	string_table_entry: "string_table"
} as const satisfies Record<TextLocation["kind"], TextOriginKind>;

// Unreal gathers C++ text through GatherTextFromSource; the manifest path names the source file.
const CPP_SOURCE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)(?:[:(]|$)/u;

/** Lowercase with forward slashes, so Windows and Unreal spellings of one path compare equal. */
export function normalizeTextPath(path: string): string {
	return path.trim().replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

/** Where a saved occurrence lives. A String Table reference inside an asset counts as the asset. */
export function textLocationOrigin(location: TextLocation): TextOriginKind {
	return LOCATION_ORIGINS[location.kind];
}

/** Where a gathered manifest path says text lives: C++ source, an asset, or another source. */
export function manifestPathOrigin(path: string): TextOriginKind {
	const normalized = normalizeTextPath(path);
	if (CPP_SOURCE.test(normalized)) return "cpp";
	return normalized.startsWith("/") ? "asset" : "other_source";
}

export function unitOrigins(unit: TextUnit): readonly TextOriginKind[] {
	return [
		...new Set(unit.occurrences.map((occurrence) => textLocationOrigin(occurrence.location)))
	];
}

/** Object paths and project-relative package files, normalized for prefix matching. */
export function unitPaths(unit: TextUnit): readonly string[] {
	return unit.occurrences.flatMap((occurrence) => [
		normalizeTextPath(occurrence.location.objectPath),
		normalizeTextPath(occurrence.packageFile)
	]);
}

export function manifestOrigins(paths: readonly string[]): readonly TextOriginKind[] {
	return [...new Set(paths.map(manifestPathOrigin))];
}

/** True when no kinds are requested, or any of the text's origins is one of them. */
export function matchesTextKinds(
	origins: readonly TextOriginKind[],
	kinds: TextWhere["kinds"]
): boolean {
	return kinds === undefined || origins.some((origin) => kinds.includes(origin));
}

/** True when no prefix is requested, or any normalized path starts with it. */
export function matchesTextPathPrefix(
	normalizedPaths: readonly string[],
	prefix: TextWhere["pathPrefix"]
): boolean {
	if (prefix === undefined) return true;
	const wanted = normalizeTextPath(prefix);
	return normalizedPaths.some((path) => path.startsWith(wanted));
}

/** Unit-level location filter for callers outside the query index, such as `text search`. */
export function unitMatchesTextWhere(unit: TextUnit, where: TextWhere | undefined): boolean {
	return (
		where === undefined ||
		(matchesTextKinds(unitOrigins(unit), where.kinds) &&
			matchesTextPathPrefix(unitPaths(unit), where.pathPrefix))
	);
}

export function emptyTextOriginCounts() {
	return {
		string_table: 0,
		data_table: 0,
		asset: 0,
		cpp: 0,
		other_source: 0
	} satisfies Record<TextOriginKind, number>;
}
