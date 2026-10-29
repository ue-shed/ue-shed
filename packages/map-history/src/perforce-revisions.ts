import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { P4, type P4ClientOptions } from "p4client-ts";
import { MapHistoryError } from "./errors.js";
import { perforceProjectLayer, toMapHistoryError } from "./perforce.js";

/** One file of a changelist inside the project, at its base and at the change, on disk. */
export interface ChangelistRevisionFile {
	/** Relative to the project folder, with `/`. */
	readonly path: string;
	readonly depotPath: string;
	readonly action: string;
	/** The base revision's bytes; absent when the change adds the file. */
	readonly base?: string;
	/** The change's bytes; absent when the change deletes the file. */
	readonly head?: string;
}

/** A changelist's files at both revisions, and what fetching them cost. */
export interface ChangelistRevisions {
	readonly change: number;
	readonly shelved: boolean;
	readonly files: readonly ChangelistRevisionFile[];
	/** Changed files inside the project the caller does not read, by path; not printed. */
	readonly skipped: readonly string[];
	/** Changed files outside the project folder, left out. */
	readonly outside: number;
	/** Revisions printed now, and those the revision cache already held. */
	readonly printed: number;
	readonly reused: number;
	/** Bytes printed now. */
	readonly bytes: number;
	/** The files the caller asked for as the change found them. */
	readonly before?: RevisionFiles;
}

/** One project file at a revision, and where its bytes are on disk. */
export interface RevisionFile {
	/** Relative to the project folder, with `/`. */
	readonly path: string;
	/**
	 * The server the revision is on, as a short key: a depot path and revision name different
	 * bytes on two servers, even when the workspace holds them.
	 */
	readonly server: string;
	readonly depotPath: string;
	readonly revision: number;
	readonly file: string;
	/** Whether `file` is the workspace's own copy, which holds that revision. */
	readonly workspace: boolean;
}

/** Project files at one revision, and what fetching them cost. */
export interface RevisionFiles {
	readonly files: readonly RevisionFile[];
	/** Asked-for paths with no revision there: never added, deleted, or outside the workspace. */
	readonly missing: readonly string[];
	readonly printed: number;
	readonly reused: number;
	readonly bytes: number;
}

/** A revision to print, and the cache file it lands in. */
interface Wanted {
	readonly spec: string;
	readonly file: string;
	/** A shelved add: Perforce names its revision `none`, which typed `print` rejects. */
	readonly unnumbered: boolean;
}

const TaggedRecord = Schema.Record(Schema.String, Schema.Json);
const isMapHistoryError = Schema.is(MapHistoryError);

const ADDS = new Set(["add", "branch", "move/add", "import"]);
const DELETES = new Set(["delete", "move/delete", "purge", "archive"]);

/**
 * The two revisions a changed file is read at. A submitted change compares `#rev-1` with `#rev`;
 * a shelf compares the revision it is based on with `@=<change>`. An add has no base and a delete
 * no head.
 */
export function changelistRevisionSpecs(
	file: { readonly depotPath: string; readonly action: string; readonly revision: number | null },
	change: number,
	shelved: boolean
) {
	const rev = file.revision ?? 0;
	const base = shelved ? rev : rev - 1;
	return {
		...(ADDS.has(file.action) || base < 1 ? undefined : { base: `${file.depotPath}#${base}` }),
		...(DELETES.has(file.action)
			? undefined
			: { head: shelved ? `${file.depotPath}@=${change}` : `${file.depotPath}#${rev}` })
	};
}

/**
 * The two revisions a file a range changes is read at: its revision at the range's start, and its
 * last revision in the range. A file the range adds has no base, one it deletes no head, and one
 * it adds and deletes neither, so it is left out (undefined).
 */
export function rangeRevisionSpecs(
	file: {
		readonly depotPath: string;
		readonly revision: number | null;
		readonly deleted: boolean;
	},
	/** The file's revision at the range's start; absent when it did not exist there. */
	from: number | undefined
) {
	const to = file.deleted || file.revision === null ? undefined : file.revision;
	if (from === undefined && to === undefined) return undefined;
	return {
		action: from === undefined ? "add" : to === undefined ? "delete" : "edit",
		...(from === undefined ? undefined : { base: `${file.depotPath}#${from}` }),
		...(to === undefined ? undefined : { head: `${file.depotPath}#${to}` })
	};
}

/**
 * Whether the workspace's copy of a file holds a revision: the workspace has that revision and the
 * file is not checked out, which Perforce leaves read-only.
 */
export function workspaceHolds(
	revision: number,
	have: number | undefined,
	writable: boolean
): boolean {
	return have === revision && !writable;
}

const failure = (
	message: string,
	cause?: unknown,
	kind: "perforce_command" | "ambiguous_depot_mapping" = "perforce_command"
) =>
	new MapHistoryError({
		kind,
		message,
		recovery:
			kind === "perforce_command"
				? "Check the Perforce connection and the changelist number, then retry."
				: "Open the project from a Perforce workspace that maps its folder.",
		retrySafe: kind === "perforce_command",
		nextStep: kind === "perforce_command" ? "retry" : "fix_input",
		...(cause === undefined ? undefined : { cause })
	});

/**
 * A failed Perforce command, classified as Map History classifies any, its message saying what was
 * being read. A changelist or file Perforce does not know is the caller's to fix.
 */
const classified = (doing: string, cause: unknown) => {
	if (isMapHistoryError(cause)) return cause;
	const error = toMapHistoryError(doing, cause);
	const notFound =
		cause instanceof Object && "category" in cause && cause.category === "not_found";
	return new MapHistoryError({
		kind: notFound ? "invalid_target" : error.kind,
		message: `${doing}: ${error.message}`,
		recovery: notFound
			? "Check the changelist number, and whether the change is submitted or shelved."
			: error.recovery,
		retrySafe: notFound ? false : error.retrySafe,
		nextStep: notFound ? "fix_input" : error.nextStep,
		cause
	});
};

/** A revision's cache file: a submitted revision never changes, so its spec names it. */
const cacheFile = (directory: string, spec: string, digest: string | null) => {
	const key = createHash("sha256")
		.update(digest === null ? spec : `${spec}\0${digest}`)
		.digest("hex");
	return join(directory, key.slice(0, 2), key);
};

/**
 * The server the client talks to, as a short key, and its revision cache folder. Two servers can
 * hold the same depot path at the same revision with different bytes, so each server's revisions
 * are kept apart.
 */
const serverDirectory = Effect.fnUntraced(function* (directory: string) {
	const p4 = yield* P4;
	const environment = yield* p4.getEnvironment({});
	const address = environment.serverAddress ?? environment.port ?? "unknown";
	const server = createHash("sha256").update(address).digest("hex").slice(0, 16);
	return { directory: join(directory, server), server };
});

/**
 * Revisions one `print` takes. `printBatch` and its watched form hold every printed file in
 * memory (the watched form in an unbounded queue), so a side of large packages prints in batches
 * this size: at most this many files are held, and each batch is one round trip.
 */
const PRINT_BATCH = 16;

/** The depot folder the workspace maps the project folder to, ending in `/`. */
const projectPrefix = Effect.fnUntraced(function* (projectRoot: string) {
	const p4 = yield* P4;
	const mapping = yield* p4.whereFiles({ fileSpec: `${projectRoot}/...` });
	const root = mapping.items.find((item) => !item.isExcluded)?.depotFile;
	if (root === undefined)
		return yield* Effect.fail(
			failure(
				"Perforce does not map the project folder.",
				undefined,
				"ambiguous_depot_mapping"
			)
		);
	return root.replace(/\/\.\.\.$/u, "/");
});

/**
 * Prints one revision straight to a file, never holding it in memory, and returns its size. It
 * goes through the untyped runner, which also takes a shelved add's unnumbered revision.
 */
const printToFile = Effect.fnUntraced(function* (spec: string, file: string) {
	const p4 = yield* P4;
	yield* Effect.promise(() => mkdir(join(file, ".."), { recursive: true }));
	const temporary = `${file}.${process.pid}.tmp`;
	yield* p4.runTagged({ schema: TaggedRecord, args: ["print", "-q", "-o", temporary, spec] });
	return yield* Effect.promise(async () => {
		await rename(temporary, file);
		return (await stat(file)).size;
	});
});

/**
 * Prints the revisions the cache lacks, side by side, and returns what that cost. A side names
 * each depot file once, so it takes one `print`; a shelved add is printed alone, untyped.
 */
const printMissing = Effect.fnUntraced(function* (
	sides: readonly (readonly Wanted[])[],
	/** What the revisions belong to, such as `changelist 1200`, for the error. */
	what: string
) {
	const p4 = yield* P4;
	const step = (name: string) =>
		Effect.mapError((cause: unknown) => classified(`Perforce could not ${name}`, cause));
	let bytes = 0;
	let printed = 0;
	for (const side of sides) {
		const present = yield* Effect.promise(() =>
			Promise.all(
				side.map((item) =>
					stat(item.file).then(
						() => true,
						() => false
					)
				)
			)
		);
		const all = side.filter((_, index) => !present[index]);
		for (const item of all.filter((wanted) => wanted.unnumbered)) {
			bytes += yield* printToFile(item.spec, item.file).pipe(
				step(`print a shelved add in ${what}`)
			);
			printed++;
		}
		const needed = all.filter((wanted) => !wanted.unnumbered);
		if (needed.length === 0) continue;
		const byDepotFile = new Map(
			needed.map((item) => [item.spec.replace(/[#@].*$/u, ""), item])
		);
		// A print holds its files in memory until it ends, so a side prints `PRINT_BATCH` at a time
		// and each batch is written before the next: memory follows the batch, not the side.
		for (let start = 0; start < needed.length; start += PRINT_BATCH) {
			const chunk = needed.slice(start, start + PRINT_BATCH);
			const batch = yield* p4
				.printBatch({ fileSpec: chunk.map((item) => item.spec) })
				.pipe(step(`print the changed files of ${what}`));
			if (batch.failures.length > 0 || batch.items.length !== chunk.length)
				return yield* Effect.fail(
					failure(
						`Perforce printed ${batch.items.length} of ${chunk.length} revisions for ${what}.`,
						batch.failures
					)
				);
			for (const item of batch.items) {
				const target = byDepotFile.get(item.file.depotFile);
				if (target === undefined)
					return yield* Effect.fail(
						failure(`Perforce printed ${item.file.depotFile}, which was not asked for.`)
					);
				bytes += item.content.byteLength;
				printed++;
				yield* Effect.promise(async () => {
					await mkdir(join(target.file, ".."), { recursive: true });
					const temporary = `${target.file}.${process.pid}.tmp`;
					await writeFile(temporary, item.content);
					await rename(temporary, target.file);
				});
			}
		}
	}
	return { bytes, printed };
});

/** The project's Perforce client: the workspace the host names, else the one holding the project. */
const projectLayer = (projectRoot: string, perforce: P4ClientOptions | undefined) =>
	perforceProjectLayer(projectRoot, perforce).pipe(
		Effect.mapError((cause) =>
			classified("Perforce could not find the project's workspace", cause)
		)
	);

/** What a changelist read takes. */
interface ChangelistRead {
	readonly projectRoot: string;
	readonly change: number;
	readonly shelved: boolean;
	/** The revision cache folder. */
	readonly directory: string;
	/** Whether the caller reads a file, by its project-relative path; only those are printed. */
	readonly reads: (path: string) => boolean;
	/**
	 * Project files to read as the change found them, such as a target's manifest and
	 * archives: at the changelist before a submitted change, at the depot's head for a shelf.
	 */
	readonly before?: readonly string[];
}

/**
 * Fetches a changelist's files inside a project at both revisions into a content cache, printing
 * only revisions the cache lacks. A submitted revision never changes, so its
 * cache file is named by its spec; a shelved one by its spec and the digest Perforce reports. It
 * only reads: `describe`, `where`, `files` and `print`.
 */
export const readChangelistRevisions = Effect.fn("Perforce.changelistRevisions")(function* (
	options: ChangelistRead & {
		/** The host's connection; a workspace it names is used as named. */
		readonly perforce?: P4ClientOptions;
	}
) {
	const layer = yield* projectLayer(options.projectRoot, options.perforce);
	return yield* changelistRevisions(options).pipe(
		Effect.provide(layer),
		Effect.mapError((cause) =>
			classified(`Perforce could not read changelist ${options.change}`, cause)
		)
	);
});

/** {@link readChangelistRevisions} with the Perforce client the caller provides. */
export const changelistRevisions = Effect.fnUntraced(function* (options: ChangelistRead) {
	const p4 = yield* P4;
	const step = (name: string) =>
		Effect.mapError((cause: unknown) => classified(`Perforce could not ${name}`, cause));
	const at = options.shelved ? "head" : options.change - 1;
	// Each command is a round trip to the server, so the independent ones run together.
	const [cache, description, prefix, listed] = yield* Effect.all(
		[
			serverDirectory(options.directory).pipe(step("identify the server")),
			p4
				.describeChangelist({ change: options.change, shelved: options.shelved })
				.pipe(step(`describe changelist ${options.change}`)),
			projectPrefix(options.projectRoot).pipe(step("map the project folder")),
			options.before === undefined
				? Effect.succeed(undefined)
				: listAt(options.projectRoot, options.before, at).pipe(
						step(`list the files changelist ${options.change} changes from`)
					)
		],
		{ concurrency: "unbounded" }
	);
	// A shelf read of a submitted change, or a submitted read of a pending one, would pair
	// the wrong revisions.
	const expected = options.shelved ? "shelved" : "submitted";
	if (description.status !== expected)
		return yield* Effect.fail(
			new MapHistoryError({
				kind: "invalid_target",
				message: `Changelist ${options.change} is ${description.status}, not ${expected}.`,
				recovery:
					"Read a submitted changelist as submitted, and a pending changelist's shelved files as shelved.",
				retrySafe: false,
				nextStep: "fix_input"
			})
		);
	const cached = (spec: string, digest: string | null) =>
		cacheFile(cache.directory, spec, digest);
	const files: ChangelistRevisionFile[] = [];
	const skipped: string[] = [];
	const baseWanted: Wanted[] = [];
	const headWanted: Wanted[] = [];
	const wanted = { base: baseWanted, head: headWanted };
	let outside = 0;
	for (const file of description.files) {
		if (!file.depotFile.startsWith(prefix)) {
			outside++;
			continue;
		}
		const path = file.depotFile.slice(prefix.length);
		if (!options.reads(path)) {
			skipped.push(path);
			continue;
		}
		const specs = changelistRevisionSpecs(
			{ depotPath: file.depotFile, action: file.action, revision: file.revision },
			options.change,
			options.shelved
		);
		const base = specs.base === undefined ? undefined : cached(specs.base, null);
		const head =
			specs.head === undefined
				? undefined
				: cached(specs.head, options.shelved ? file.digest : null);
		if (specs.base !== undefined && base !== undefined)
			wanted.base.push({ spec: specs.base, file: base, unnumbered: false });
		if (specs.head !== undefined && head !== undefined)
			wanted.head.push({
				spec: specs.head,
				file: head,
				unnumbered: options.shelved && ADDS.has(file.action)
			});
		files.push({
			path,
			depotPath: file.depotFile,
			action: file.action,
			...(base === undefined ? undefined : { base }),
			...(head === undefined ? undefined : { head })
		});
	}
	const { bytes, printed } = yield* printMissing(
		[wanted.base, wanted.head],
		`changelist ${options.change}`
	);
	const before =
		options.before === undefined || listed === undefined
			? undefined
			: yield* fetchAt({
					projectRoot: options.projectRoot,
					prefix,
					paths: options.before,
					listed,
					...cache
				}).pipe(step(`print the files changelist ${options.change} changes from`));
	const requested = wanted.base.length + wanted.head.length;
	yield* Effect.annotateCurrentSpan({
		"perforce.files": files.length,
		"perforce.outside": outside,
		"perforce.skipped": skipped.length,
		"perforce.printed": printed,
		"perforce.reused": requested - printed,
		"perforce.bytes": bytes
	});
	return {
		change: options.change,
		shelved: options.shelved,
		files,
		skipped,
		outside,
		printed,
		reused: requested - printed,
		bytes,
		...(before === undefined ? undefined : { before })
	} satisfies ChangelistRevisions;
});

/**
 * Characters of file specs one `p4 files` takes. `files` reads its specs from its command line, and
 * Windows starts a process with at most 32,767 characters of one; a long range's files go in
 * batches that each stay well under it.
 */
const COMMAND_LINE_BUDGET = 24_000;

/** File specs in batches of at most `budget` characters, each spec quoted and spaced. */
export function specBatches(specs: readonly string[], budget = COMMAND_LINE_BUDGET): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const spec of specs) {
		const cost = spec.length + 3;
		if (current.length > 0 && size + cost > budget) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(spec);
		size += cost;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** `p4 files` over any number of specs, a batch at a time, as one result. */
const listFilesBatched = Effect.fnUntraced(function* (specs: readonly string[]) {
	const p4 = yield* P4;
	const results = yield* Effect.forEach(specBatches(specs), (fileSpec) =>
		p4.listFiles({ fileSpec })
	);
	return {
		items: results.flatMap((result) => result.items),
		messages: results.flatMap((result) => result.messages),
		failures: results.flatMap((result) => result.failures)
	};
});

/** Lists project files at a revision and at the workspace's, together; local paths need no mapping. */
const listAt = Effect.fnUntraced(function* (
	projectRoot: string,
	paths: readonly string[],
	at: number | "head" | "have"
) {
	const revision = at === "head" || at === "have" ? `#${at}` : `@${at}`;
	const local = paths.map((path) => `${projectRoot}/${path}`);
	const [found, have] = yield* Effect.all(
		[
			listFilesBatched(local.map((path) => `${path}${revision}`)),
			listFilesBatched(local.map((path) => `${path}#have`))
		],
		{ concurrency: 2 }
	);
	return { found, have };
});

/**
 * Resolves listed files to bytes on disk: the workspace's copy where it holds the revision, else
 * the revision cache, printing what it lacks straight to disk.
 */
const fetchAt = Effect.fnUntraced(function* (options: {
	readonly projectRoot: string;
	readonly prefix: string;
	readonly paths: readonly string[];
	readonly listed: Effect.Success<ReturnType<typeof listAt>>;
	readonly directory: string;
	readonly server: string;
}) {
	const server = options.server;
	const haves = new Map<string, number | null>(
		options.listed.have.items.map((item) => [item.depotFile, item.revision])
	);
	const found = new Map<string, number>();
	for (const item of options.listed.found.items)
		if (!item.isDeletedAtHead && item.revision !== null)
			found.set(item.depotFile, item.revision);
	const files: RevisionFile[] = [];
	const missing: string[] = [];
	let printed = 0;
	let bytes = 0;
	for (const path of options.paths) {
		const depotPath = `${options.prefix}${path}`;
		const revision = found.get(depotPath);
		if (revision === undefined) {
			missing.push(path);
			continue;
		}
		const local = join(options.projectRoot, path);
		const writable = yield* Effect.promise(() =>
			stat(local).then(
				(info) => (info.mode & 0o200) !== 0,
				() => true
			)
		);
		if (workspaceHolds(revision, haves.get(depotPath) ?? undefined, writable)) {
			files.push({ path, depotPath, revision, server, file: local, workspace: true });
			continue;
		}
		const spec = `${depotPath}#${revision}`;
		const file = cacheFile(options.directory, spec, null);
		const present = yield* Effect.promise(() =>
			stat(file).then(
				() => true,
				() => false
			)
		);
		if (!present) {
			bytes += yield* printToFile(spec, file);
			printed++;
		}
		files.push({ path, depotPath, revision, server, file, workspace: false });
	}
	const reused = files.length - printed;
	yield* Effect.annotateCurrentSpan({
		"perforce.at.files": files.length,
		"perforce.at.missing": missing.length,
		"perforce.at.printed": printed,
		"perforce.at.reused": reused,
		"perforce.at.bytes": bytes
	});
	return { files, missing, printed, reused, bytes } satisfies RevisionFiles;
});

/**
 * Fetches project files as they were at a submitted changelist, at the depot's head, or at the
 * revisions the workspace has, which compares a workspace's edits with what it synced. A file the
 * workspace holds at that revision is read where it is; any other revision is printed to the
 * revision cache once, straight to disk, so large files such as a target's manifest and archives
 * are never held in memory. It only reads: `where`, `files` and `print`.
 */
export const readRevisionFiles = Effect.fn("Perforce.revisionFiles")(function* (options: {
	readonly projectRoot: string;
	/** Relative to the project folder, with `/`. */
	readonly paths: readonly string[];
	/** A submitted changelist, the depot's head, or the revisions the workspace has. */
	readonly at: number | "head" | "have";
	/** The revision cache folder. */
	readonly directory: string;
	/** The host's connection; a workspace it names is used as named. */
	readonly perforce?: P4ClientOptions;
}) {
	const layer = yield* projectLayer(options.projectRoot, options.perforce);
	const where =
		options.at === "head"
			? "the depot's head"
			: options.at === "have"
				? "the workspace's revisions"
				: `changelist ${options.at}`;
	return yield* Effect.gen(function* () {
		const [cache, prefix, listed] = yield* Effect.all(
			[
				serverDirectory(options.directory),
				projectPrefix(options.projectRoot),
				listAt(options.projectRoot, options.paths, options.at)
			],
			{ concurrency: 3 }
		);
		return yield* fetchAt({ ...options, ...cache, prefix, listed });
	}).pipe(
		Effect.provide(layer),
		Effect.mapError((cause) => classified(`Perforce could not read files at ${where}`, cause))
	);
});

/** A range's files at both ends, and what fetching them cost. */
export interface RangeRevisions extends Omit<ChangelistRevisions, "change" | "shelved"> {
	readonly from: number;
	readonly to: number;
}

/** The most files a range review prints: past it, a shorter range reads in reasonable time. */
export const RANGE_FILE_LIMIT = 2000;

/**
 * Fetches the project files submitted changelists `from` (exclusive) to `to` change, at both
 * ends, into the content cache. `p4 files` lists each file's last revision in the range and its
 * revision at `from`; a file the range adds has no base, one it deletes no head, and one it adds
 * and deletes is left out. It only reads: `where`, `files` and `print`.
 */
export const readRangeRevisions = Effect.fn("Perforce.rangeRevisions")(function* (options: {
	readonly projectRoot: string;
	readonly from: number;
	readonly to: number;
	/** The revision cache folder. */
	readonly directory: string;
	/** Whether the caller reads a file, by its project-relative path; only those are printed. */
	readonly reads: (path: string) => boolean;
	/** Project files to read at `from`, such as a target's manifest and archives. */
	readonly before?: readonly string[];
	/** The host's connection; a workspace it names is used as named. */
	readonly perforce?: P4ClientOptions;
	/** The most read files; more fails. Defaults to `RANGE_FILE_LIMIT`. */
	readonly limit?: number;
}) {
	const what = `changelists ${options.from} to ${options.to}`;
	if (!Number.isSafeInteger(options.from) || options.from < 1 || options.to <= options.from)
		return yield* Effect.fail(
			new MapHistoryError({
				kind: "invalid_target",
				message: `${what} is not a range: it runs from an earlier submitted changelist to a later one.`,
				recovery: "Name the earlier changelist as the start and the later one as the end.",
				retrySafe: false,
				nextStep: "fix_input"
			})
		);
	const layer = yield* projectLayer(options.projectRoot, options.perforce);
	return yield* Effect.gen(function* () {
		const p4 = yield* P4;
		const step = (name: string) =>
			Effect.mapError((cause: unknown) => classified(`Perforce could not ${name}`, cause));
		const [cache, prefix, listed] = yield* Effect.all(
			[
				serverDirectory(options.directory).pipe(step("identify the server")),
				projectPrefix(options.projectRoot).pipe(step("map the project folder")),
				options.before === undefined
					? Effect.succeed(undefined)
					: listAt(options.projectRoot, options.before, options.from).pipe(
							step(`list the files ${what} change from`)
						)
			],
			{ concurrency: "unbounded" }
		);
		const changed = yield* p4
			.listFiles({
				fileSpec: `${prefix}...@${options.from + 1},@${options.to}`
			})
			.pipe(step(`list the files ${what} change`));
		const skipped: string[] = [];
		const read = changed.items.flatMap((item) => {
			if (!item.depotFile.startsWith(prefix)) return [];
			const path = item.depotFile.slice(prefix.length);
			if (options.reads(path)) return [{ item, path }];
			skipped.push(path);
			return [];
		});
		const limit = options.limit ?? RANGE_FILE_LIMIT;
		if (read.length > limit)
			return yield* Effect.fail(
				new MapHistoryError({
					kind: "invalid_target",
					message: `${what} change ${read.length} files a review reads; it reads at most ${limit}.`,
					recovery: "Pick a shorter range.",
					retrySafe: false,
					nextStep: "fix_input"
				})
			);
		// A file the range adds matches nothing at `from`, which `files` reports apart.
		const earlier =
			read.length === 0
				? undefined
				: yield* listFilesBatched(
						read.map(({ item }) => `${item.depotFile}@${options.from}`)
					).pipe(step(`list the files ${what} change at ${options.from}`));
		const atFrom = new Map(
			(earlier?.items ?? []).flatMap((item) =>
				item.isDeletedAtHead || item.revision === null
					? []
					: [[item.depotFile, item.revision] as const]
			)
		);
		const files: ChangelistRevisionFile[] = [];
		const baseWanted: Wanted[] = [];
		const headWanted: Wanted[] = [];
		const wanted = { base: baseWanted, head: headWanted };
		for (const { item, path } of read) {
			const specs = rangeRevisionSpecs(
				{
					depotPath: item.depotFile,
					revision: item.revision,
					deleted: item.isDeletedAtHead
				},
				atFrom.get(item.depotFile)
			);
			if (specs === undefined) continue;
			const base =
				specs.base === undefined ? undefined : cacheFile(cache.directory, specs.base, null);
			const head =
				specs.head === undefined ? undefined : cacheFile(cache.directory, specs.head, null);
			if (specs.base !== undefined && base !== undefined)
				wanted.base.push({ spec: specs.base, file: base, unnumbered: false });
			if (specs.head !== undefined && head !== undefined)
				wanted.head.push({ spec: specs.head, file: head, unnumbered: false });
			files.push({
				path,
				depotPath: item.depotFile,
				action: specs.action,
				...(base === undefined ? undefined : { base }),
				...(head === undefined ? undefined : { head })
			});
		}
		const { bytes, printed } = yield* printMissing([wanted.base, wanted.head], what);
		const before =
			options.before === undefined || listed === undefined
				? undefined
				: yield* fetchAt({
						projectRoot: options.projectRoot,
						prefix,
						paths: options.before,
						listed,
						...cache
					}).pipe(step(`print the files ${what} change from`));
		const requested = wanted.base.length + wanted.head.length;
		yield* Effect.annotateCurrentSpan({
			"perforce.files": files.length,
			"perforce.skipped": skipped.length,
			"perforce.printed": printed,
			"perforce.reused": requested - printed,
			"perforce.bytes": bytes
		});
		return {
			from: options.from,
			to: options.to,
			files,
			skipped,
			outside: 0,
			printed,
			reused: requested - printed,
			bytes,
			...(before === undefined ? undefined : { before })
		} satisfies RangeRevisions;
	}).pipe(
		Effect.provide(layer),
		Effect.mapError((cause) => classified(`Perforce could not read ${what}`, cause))
	);
});

/**
 * The three reads a change review needs, bound to a revision cache folder and the host's
 * connection: a changelist's or a shelf's files, a range's, and files at the revisions the
 * workspace has. Game Text takes them as its change revisions.
 */
export function perforceChangeRevisions(options: {
	/** The revision cache folder. */
	readonly directory: string;
	readonly perforce?: P4ClientOptions;
}) {
	const common = {
		directory: options.directory,
		...(options.perforce === undefined ? undefined : { perforce: options.perforce })
	};
	return {
		changelist: (
			input: Omit<Parameters<typeof readChangelistRevisions>[0], keyof typeof common>
		) => readChangelistRevisions({ ...input, ...common }),
		range: (input: Omit<Parameters<typeof readRangeRevisions>[0], keyof typeof common>) =>
			readRangeRevisions({ ...input, ...common }),
		have: (input: { readonly projectRoot: string; readonly paths: readonly string[] }) =>
			readRevisionFiles({ ...input, at: "have", ...common })
	};
}
