import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { P4 } from "p4client-ts";
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
 * Fetches a changelist's files inside a project at both revisions into a content cache, printing
 * only revisions the cache lacks. A submitted revision never changes, so its
 * cache file is named by its spec; a shelved one by its spec and the digest Perforce reports. It
 * only reads: `describe`, `where`, `files` and `print`.
 */
export const readChangelistRevisions = Effect.fn("Perforce.changelistRevisions")(
	function* (options: {
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
	}) {
		const layer = yield* perforceProjectLayer(options.projectRoot).pipe(
			Effect.mapError((cause) =>
				classified("Perforce could not find the project's workspace", cause)
			)
		);
		return yield* Effect.gen(function* () {
			const p4 = yield* P4;
			const step = (name: string) =>
				Effect.mapError((cause: unknown) =>
					classified(`Perforce could not ${name}`, cause)
				);
			const at = options.shelved ? "head" : options.change - 1;
			// Each command is a round trip to the server, so the independent ones run together.
			const [description, prefix, listed] = yield* Effect.all(
				[
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
				cacheFile(options.directory, spec, digest);
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
			const missing = (side: readonly Wanted[]) =>
				Effect.promise(async () => {
					const present = await Promise.all(
						side.map((item) =>
							stat(item.file).then(
								() => true,
								() => false
							)
						)
					);
					return side.filter((_, index) => !present[index]);
				});
			let bytes = 0;
			let printed = 0;
			// One print per side: in a side each depot file appears once, so it names its revision.
			for (const side of [wanted.base, wanted.head]) {
				const all = yield* missing(side);
				// A shelved add is printed straight to its cache file, untyped, one at a time.
				for (const item of all.filter((wanted) => wanted.unnumbered)) {
					bytes += yield* printToFile(item.spec, item.file).pipe(
						step(`print a shelved add in changelist ${options.change}`)
					);
					printed++;
				}
				const needed = all.filter((wanted) => !wanted.unnumbered);
				if (needed.length === 0) continue;
				const byDepotFile = new Map(
					needed.map((item) => [item.spec.replace(/[#@].*$/u, ""), item])
				);
				const batch = yield* p4
					.printBatch({ fileSpec: needed.map((item) => item.spec) })
					.pipe(step(`print the files changelist ${options.change} changes`));
				if (batch.failures.length > 0 || batch.items.length !== needed.length)
					return yield* Effect.fail(
						failure(
							`Perforce printed ${batch.items.length} of ${needed.length} revisions for changelist ${options.change}.`,
							batch.failures
						)
					);
				for (const item of batch.items) {
					const target = byDepotFile.get(item.file.depotFile);
					if (target === undefined)
						return yield* Effect.fail(
							failure(
								`Perforce printed ${item.file.depotFile}, which was not asked for.`
							)
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
			const before =
				options.before === undefined || listed === undefined
					? undefined
					: yield* fetchAt({
							projectRoot: options.projectRoot,
							prefix,
							paths: options.before,
							listed,
							directory: options.directory
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
		}).pipe(
			Effect.provide(layer),
			Effect.mapError((cause) =>
				classified(`Perforce could not read changelist ${options.change}`, cause)
			)
		);
	}
);

/** Lists project files at a revision and at the workspace's, together; local paths need no mapping. */
const listAt = Effect.fnUntraced(function* (
	projectRoot: string,
	paths: readonly string[],
	at: number | "head" | "have"
) {
	const p4 = yield* P4;
	const revision = at === "head" || at === "have" ? `#${at}` : `@${at}`;
	const local = paths.map((path) => `${projectRoot}/${path}`);
	const [found, have] = yield* Effect.all(
		[
			p4.listFiles({ fileSpec: local.map((path) => `${path}${revision}`) }),
			p4.listFiles({ fileSpec: local.map((path) => `${path}#have`) })
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
}) {
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
			files.push({ path, depotPath, revision, file: local, workspace: true });
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
		files.push({ path, depotPath, revision, file, workspace: false });
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
}) {
	const layer = yield* perforceProjectLayer(options.projectRoot).pipe(
		Effect.mapError((cause) =>
			classified("Perforce could not find the project's workspace", cause)
		)
	);
	const where =
		options.at === "head"
			? "the depot's head"
			: options.at === "have"
				? "the workspace's revisions"
				: `changelist ${options.at}`;
	return yield* Effect.gen(function* () {
		const [prefix, listed] = yield* Effect.all(
			[
				projectPrefix(options.projectRoot),
				listAt(options.projectRoot, options.paths, options.at)
			],
			{ concurrency: 2 }
		);
		return yield* fetchAt({ ...options, prefix, listed });
	}).pipe(
		Effect.provide(layer),
		Effect.mapError((cause) => classified(`Perforce could not read files at ${where}`, cause))
	);
});
