import type { TextLocation, TextOriginKind, TextUnit, TextWhere } from "./schema.js";

export const TEXT_ORIGIN_KINDS = [
	"string_table",
	"data_table",
	"asset",
	"cpp",
	"other_source"
] as const satisfies readonly TextOriginKind[];

/** The names writers see for each origin. */
export const TEXT_ORIGIN_LABELS = {
	string_table: "String table",
	data_table: "Data table",
	asset: "Asset",
	cpp: "C++",
	other_source: "Other source"
} as const satisfies Record<TextOriginKind, string>;

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

const PACKAGE_EXTENSION = /\.(?:uasset|umap|uexp|ubulk|uptnl)$/u;
const GAME_PACKAGE = /^\/game\/([^.:]+)/u;
const SOURCE_LINE = /(?:\(\d+\)|:\d+)$/u;
const ABSOLUTE = /^(?:[a-z]:\/|\/\/|\/)/u;

/**
 * The key a changed file is compared by. Saved packages lose their extension, so `.uasset`,
 * `.umap`, `.uexp` and `.ubulk` of one asset are the same file, and an Unreal package path such
 * as `/Game/UI/WBP_Menu` names the same file as `Content/UI/WBP_Menu.uasset`. Other files keep
 * their extension; a trailing source line, `(12)` or `:12`, is dropped.
 */
export function textFileKey(path: string): string {
	const normalized = normalizeTextPath(path.trim().replace(/^["']|["']$/gu, ""));
	const game = normalized.match(GAME_PACKAGE)?.[1];
	if (game !== undefined) return "content/" + game;
	return normalized.replace(SOURCE_LINE, "").replace(PACKAGE_EXTENSION, "");
}

const GAME_PACKAGE_LABEL = /^\/Game\/([^.:]+)/iu;

/**
 * The same file as `textFileKey`, spelled as the project spells it, for showing: `Content/UI/WBP_Menu`
 * for a saved package or `/Game` path, `Source/Game/Private/Menu.cpp` for a gathered source line.
 */
export function textFileLabel(path: string): string {
	const spelled = path
		.trim()
		.replace(/^["']|["']$/gu, "")
		.replaceAll("\\", "/")
		.replace(/^\.\//u, "");
	const game = spelled.match(GAME_PACKAGE_LABEL)?.[1];
	if (game !== undefined) return "Content/" + game;
	return spelled.replace(SOURCE_LINE, "").replace(/\.(?:uasset|umap|uexp|ubulk|uptnl)$/iu, "");
}

/** The folder holding a file label; empty for a file at the project root. */
export function textFolderLabel(fileLabel: string): string {
	const end = fileLabel.lastIndexOf("/");
	return end < 0 ? "" : fileLabel.slice(0, end);
}

/** A key that names a saved package rather than a source file: no extension remains. */
function isPackageKey(key: string): boolean {
	return !/\.[^/]+$/u.test(key);
}

/**
 * Turns a pasted or exported list into project-relative entries: blank lines and `#` comments
 * are dropped, and absolute paths under `projectRoot` become relative. Absolute paths elsewhere
 * are kept, so the query can count them as outside the project.
 */
export function projectRelativeTextFiles(
	entries: readonly string[],
	projectRoot?: string
): readonly string[] {
	const root = projectRoot === undefined ? undefined : normalizeTextPath(projectRoot);
	const prefix = root === undefined ? undefined : root.endsWith("/") ? root : root + "/";
	return entries.flatMap((entry) => {
		const value = entry.trim();
		if (value === "" || value.startsWith("#")) return [];
		const normalized = normalizeTextPath(value.replace(/^["']|["']$/gu, ""));
		return [
			prefix !== undefined && normalized.startsWith(prefix)
				? normalized.slice(prefix.length)
				: value
		];
	});
}

/** Package-file keys for a unit's saved occurrences. */
export function unitFileKeys(unit: TextUnit): readonly string[] {
	return [...new Set(unit.occurrences.map((occurrence) => textFileKey(occurrence.packageFile)))];
}

/** File keys for gathered manifest paths: the package of an asset path, or the source file. */
export function manifestFileKeys(paths: readonly string[]): readonly string[] {
	return [...new Set(paths.map(textFileKey))];
}

/** A changed-file scope prepared once per request. */
export interface TextFileScope {
	readonly keys: ReadonlySet<string>;
	readonly outside: number;
}

export function textFileScope(files: TextWhere["files"]): TextFileScope | undefined {
	if (files === undefined) return undefined;
	const keys = new Set<string>();
	let outside = 0;
	for (const file of files) {
		const key = textFileKey(file);
		if (key === "") continue;
		// Absolute paths left after project-relative conversion lie outside the project.
		if (ABSOLUTE.test(key)) outside++;
		else keys.add(key);
	}
	return { keys, outside };
}

export function matchesTextFiles(
	fileKeys: readonly string[],
	scope: TextFileScope | undefined
): boolean {
	return scope === undefined || fileKeys.some((key) => scope.keys.has(key));
}

/** How a changed-file list relates to the scanned project. */
export function textFileScopeSummary(
	scope: TextFileScope,
	textFileKeys: Iterable<string>,
	scannedPackages: readonly string[] | undefined
) {
	const withText = new Set([...textFileKeys].filter((key) => scope.keys.has(key)));
	const scanned =
		scannedPackages === undefined ? undefined : new Set(scannedPackages.map(textFileKey));
	return {
		files: scope.keys.size + scope.outside,
		textFiles: withText.size,
		outside: scope.outside,
		...(scanned === undefined
			? undefined
			: {
					notScanned: [...scope.keys].filter(
						(key) => isPackageKey(key) && !scanned.has(key)
					).length
				})
	};
}

/** Unit-level location filter for callers outside the query index, such as `text search`. */
export function unitMatchesTextWhere(unit: TextUnit, where: TextWhere | undefined): boolean {
	return (
		where === undefined ||
		(matchesTextKinds(unitOrigins(unit), where.kinds) &&
			matchesTextPathPrefix(unitPaths(unit), where.pathPrefix) &&
			matchesTextFiles(unitFileKeys(unit), textFileScope(where.files)))
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
