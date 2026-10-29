import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { P4 } from "p4client-ts";
import { MapHistoryError } from "./errors.js";
import { perforceProjectLayer } from "./perforce.js";

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
 * Fetches a changelist's files inside a project at both revisions into a content cache, printing
 * only revisions the cache lacks. A submitted revision never changes, so its
 * cache file is named by its spec; a shelved one by its spec and the digest Perforce reports. It
 * only reads: `describe`, `where` and `print`.
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
	}) {
		const layer = yield* perforceProjectLayer(options.projectRoot).pipe(
			Effect.mapError((cause) =>
				failure(
					"Perforce has no workspace for this project.",
					cause,
					"ambiguous_depot_mapping"
				)
			)
		);
		return yield* Effect.gen(function* () {
			const p4 = yield* P4;
			const step = (name: string) =>
				Effect.mapError((cause: unknown) =>
					failure(`Perforce could not ${name} for changelist ${options.change}.`, cause)
				);
			const description = yield* p4
				.describeChangelist({ change: options.change, shelved: options.shelved })
				.pipe(step("describe the changelist"));
			const mapping = yield* p4
				.whereFiles({ fileSpec: `${options.projectRoot}/...` })
				.pipe(step("map the project folder"));
			const root = mapping.items.find((item) => !item.isExcluded)?.depotFile;
			if (root === undefined)
				return yield* Effect.fail(
					failure(
						"Perforce does not map the project folder.",
						undefined,
						"ambiguous_depot_mapping"
					)
				);
			const prefix = root.replace(/\/\.\.\.$/u, "/");
			const cached = (spec: string, digest: string | null) => {
				const key = createHash("sha256")
					.update(digest === null ? spec : `${spec}\0${digest}`)
					.digest("hex");
				return join(options.directory, key.slice(0, 2), key);
			};
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
					yield* Effect.promise(() => mkdir(join(item.file, ".."), { recursive: true }));
					const temporary = `${item.file}.${process.pid}.tmp`;
					yield* p4
						.runTagged({
							schema: TaggedRecord,
							args: ["print", "-q", "-o", temporary, item.spec]
						})
						.pipe(step("print a shelved add"));
					const written = yield* Effect.promise(async () => {
						await rename(temporary, item.file);
						return (await stat(item.file)).size;
					});
					bytes += written;
					printed++;
				}
				const needed = all.filter((wanted) => !wanted.unnumbered);
				if (needed.length === 0) continue;
				const byDepotFile = new Map(
					needed.map((item) => [item.spec.replace(/[#@].*$/u, ""), item])
				);
				const batch = yield* p4
					.printBatch({ fileSpec: needed.map((item) => item.spec) })
					.pipe(step("print the changed files"));
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
				bytes
			} satisfies ChangelistRevisions;
		}).pipe(
			Effect.provide(layer),
			Effect.mapError((cause) =>
				isMapHistoryError(cause)
					? cause
					: failure(`Perforce could not read changelist ${options.change}.`, cause)
			)
		);
	}
);
