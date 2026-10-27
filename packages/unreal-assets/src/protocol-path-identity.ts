/**
 * Package identity as the native reader sees it. The reader joins each requested path onto the
 * project root without canonicalizing it, enumerates directories beneath it, and de-duplicates the
 * packages one request finds by Rust `Path` equality (`scanner::discover_paths`). That equality
 * compares path components: on Windows `/` and `\` both separate, the drive letter is
 * case-insensitive, empty and `.` segments vanish, and `..` stays a segment. Nothing else folds
 * case, so two spellings that differ in case are two packages to the reader, and to this key.
 */

const windows = process.platform === "win32";

function segments(path: string): string[] {
	return path.split(windows ? /[\\/]/u : /\//u).filter((part) => part !== "" && part !== ".");
}

/** The leading prefix of an absolute path: a drive (`C:`), a UNC share, or POSIX `/`. */
function absolutePrefix(
	path: string
): { readonly prefix: string; readonly rest: string } | undefined {
	if (!windows) return path.startsWith("/") ? { prefix: "/", rest: path } : undefined;
	const drive = /^([A-Za-z]):[\\/]/u.exec(path);
	if (drive) return { prefix: `${drive[1]!.toUpperCase()}:`, rest: path.slice(2) };
	const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/u.exec(path);
	if (unc) return { prefix: `//${unc[1]}/${unc[2]}`, rest: path.slice(unc[0].length) };
	return undefined;
}

/** Segments of `path` joined onto `projectRoot` the way the reader joins a requested path. */
function readerPathSegments(projectRoot: string, path: string): string[] {
	const absolute = absolutePrefix(path);
	if (absolute) return [absolute.prefix, ...segments(absolute.rest)];
	const root = absolutePrefix(projectRoot);
	// A rooted path without a drive keeps the project root's drive, as `Path::join` does.
	if (windows && /^[\\/]/u.test(path)) return [root?.prefix ?? "", ...segments(path)];
	return root
		? [root.prefix, ...segments(root.rest), ...segments(path)]
		: [...segments(projectRoot), ...segments(path)];
}

/** @internal The reader's de-duplication key for a requested or reported package path. */
export function readerPathKey(projectRoot: string, path: string): string {
	return readerPathSegments(projectRoot, path).join("/");
}

/**
 * @internal Indices of the requested paths a batched read sends: the first of each set the reader
 * would treat as one path, and none beneath another requested path. A path is beneath another when
 * the other's segments prefix it and no `..` follows, so the directory's enumeration already holds
 * it. Order is kept.
 */
export function uniqueRequestPathIndices(
	projectRoot: string,
	paths: readonly string[]
): readonly number[] {
	const keyed = paths.map((path) => readerPathSegments(projectRoot, path));
	const requested = new Set(keyed.map((parts) => parts.join("/")));
	const kept: number[] = [];
	const seen = new Set<string>();
	for (const [index, parts] of keyed.entries()) {
		const key = parts.join("/");
		if (seen.has(key)) continue;
		seen.add(key);
		let covered = false;
		// Shortening the prefix grows the remainder; once it holds `..`, no shorter prefix covers.
		for (let length = parts.length - 1; length >= 1 && parts[length] !== ".."; length -= 1) {
			if (requested.has(parts.slice(0, length).join("/"))) {
				covered = true;
				break;
			}
		}
		if (!covered) kept.push(index);
	}
	return kept;
}
