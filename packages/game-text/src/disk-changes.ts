import { join, posix } from "node:path";
import { LocalizationTargetName } from "@ue-shed/localization/browser";
import type { GameTextContract } from "@ue-shed/protocol";
import { Duration, Effect, Queue, Ref, Schema, Stream } from "effect";
import { DiskWatcher } from "./disk-watcher.js";
import { TextCorpusPublicError } from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The most items one `diskChanges` page lists: the engine's `MAX_DISK_CHANGES_PAGE`. */
export const MAX_DISK_CHANGES_PAGE = 1000;
/** The most paths one `diskChanges` request names: the engine's `MAX_DISK_CHANGE_PATHS`. */
export const MAX_DISK_CHANGE_PATHS = 4096;

/**
 * What on disk differs from the project's Game Text index, read-only. Without `paths`, the
 * reader walks the project's `Content` as the Project Index does; with `paths` (project-relative),
 * it checks only those packages and files. With `target`, that localization target's inputs and
 * review file are checked too. Page with `after`, the `nextCursor` of the previous page.
 */
export const DiskChangesRequest = Schema.Struct({
	projectRoot: Schema.NonEmptyString,
	target: Schema.optionalKey(LocalizationTargetName),
	paths: Schema.optionalKey(
		Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(1024))).check(
			Schema.isMaxLength(MAX_DISK_CHANGE_PATHS)
		)
	),
	after: Schema.optionalKey(Schema.NonEmptyString),
	limit: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(1),
		Schema.isLessThanOrEqualTo(MAX_DISK_CHANGES_PAGE)
	)
});
export type DiskChangesRequest = typeof DiskChangesRequest.Type;

const ChangeCounts = Schema.Struct({ added: Count, changed: Count, removed: Count });
/** Packages and localization files that differ, by how. */
export const DiskChangeCounts = Schema.Struct({
	packages: ChangeCounts,
	localization: ChangeCounts
});
export type DiskChangeCounts = typeof DiskChangeCounts.Type;

/** One path that differs: a saved package (with its sidecars), or a localization input. */
export const DiskChangeItem = Schema.Struct({
	kind: Schema.Literals(["package", "localization"]),
	change: Schema.Literals(["added", "changed", "removed"]),
	path: Schema.String
});
export type DiskChangeItem = typeof DiskChangeItem.Type;

/**
 * The engine's answer: `not_indexed` before the view's first scan, otherwise every count and a
 * page of items in path order.
 */
export const DiskChangesAnswer = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_indexed") }),
	Schema.Struct({
		status: Schema.Literal("ready"),
		counts: DiskChangeCounts,
		items: Schema.Array(DiskChangeItem).check(Schema.isMaxLength(MAX_DISK_CHANGES_PAGE)),
		nextCursor: Schema.optionalKey(Schema.String)
	})
]);
export type DiskChangesAnswer = typeof DiskChangesAnswer.Type;

/** `workspace.diskChanges`'s answer: the engine's, or why there is none. */
export const DiskChangesResult = Schema.Union([
	...DiskChangesAnswer.members,
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type DiskChangesResult = typeof DiskChangesResult.Type;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
// The workspace serves the engine's own request and answer: these fail to compile if they drift.
export type DiskChangesAnswerMatchesEngine = Holds<
	Same<DiskChangesAnswer, GameTextContract.DiskChangesAnswer>
>;
export type DiskChangesRequestMatchesEngine = Holds<
	Same<Omit<DiskChangesRequest, "target">, Omit<GameTextContract.DiskChangesRequest, "target">>
>;

/**
 * The watching stream's state, the shape a "changed since the last scan" badge reads: how many
 * paths differ, the first five by path, every count, and whether a check is queued or running.
 */
export const DiskChangesState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_indexed"), checking: Schema.Boolean }),
	Schema.Struct({
		status: Schema.Literal("ready"),
		changed: Count,
		files: Schema.Array(Schema.String).check(Schema.isMaxLength(5)),
		counts: DiskChangeCounts,
		checking: Schema.Boolean
	})
]);
export type DiskChangesState = typeof DiskChangesState.Type;

export { DiskWatcher, DiskWatcherNodeLive, type DiskWatchListener } from "./disk-watcher.js";

const PACKAGE_EXTENSIONS = new Set(["uasset", "umap"]);
const SIDECAR_EXTENSIONS = new Set(["uexp", "ubulk", "uptnl"]);
const extension = (path: string) => {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
};
/** The packages and files a checked path decides: a sidecar decides its packages. */
const decided = (path: string) => {
	const kind = extension(path);
	if (kind === undefined || !SIDECAR_EXTENSIONS.has(kind)) return [path];
	const stem = path.slice(0, path.length - kind.length - 1);
	return [`${stem}.uasset`, `${stem}.umap`];
};

/** What one batch of events asks for: specific paths, or a whole walk. */
interface Pending {
	readonly full: boolean;
	readonly paths: ReadonlySet<string>;
}
const nothing: Pending = { full: false, paths: new Set() };

/** The badge state of the differing paths. */
const stateOf = (
	differing: ReadonlyMap<string, DiskChangeItem>,
	checking: boolean
): DiskChangesState => {
	const empty = { added: 0, changed: 0, removed: 0 };
	const counts = { packages: { ...empty }, localization: { ...empty } };
	for (const item of differing.values())
		counts[item.kind === "package" ? "packages" : "localization"][item.change]++;
	const files = [...differing.keys()].sort(ordinal).slice(0, 5);
	return { status: "ready", changed: differing.size, files, counts, checking };
};
/** The engine's path order: UTF-8 bytes. */
const ordinal = (left: string, right: string) =>
	Buffer.compare(Buffer.from(left), Buffer.from(right));

/** What a host watches: its selected project, and optionally one localization target. */
export interface DiskChangesWatchRequest {
	readonly projectRoot: string;
	readonly target?: LocalizationTargetName;
	/** How long a burst of events settles before it is checked; 300 ms by default. */
	readonly settle?: Duration.Input;
}

/** `Content`, and each folder of `files` outside the folders already watched. */
export const watchedFolders = (files: Iterable<string>) => {
	const folders = ["Content"];
	// Shorter paths first, so a parent is kept before its children.
	const candidates = [...new Set([...files].map((file) => posix.dirname(file)))].sort(
		(left, right) => left.length - right.length || (left < right ? -1 : 1)
	);
	for (const folder of candidates) {
		const within = (parent: string) => folder === parent || folder.startsWith(`${parent}/`);
		if (folder !== "." && !folders.some(within)) folders.push(folder);
	}
	return folders;
};

/**
 * What `watchDiskChanges` needs from its caller: how to check one page, which folders to watch,
 * and when a published scan resets the answer. Hosts normally use the workspace's
 * `watchDiskChanges`, which fills these in for the selected project.
 */
export interface DiskChangesWatchOptions<E> {
	/** One `diskChanges` page for the watched project and target. */
	readonly check: (request: {
		readonly paths?: readonly string[];
		readonly after?: string;
		readonly limit: number;
	}) => Effect.Effect<DiskChangesAnswer, E>;
	readonly projectRoot: string;
	/** Project-relative folders to watch recursively: `Content` and the target's folders. */
	readonly folders: readonly string[];
	/** Project-relative localization inputs and review file a target's check covers. */
	readonly localizationFiles: ReadonlySet<string>;
	/** Signals that a refresh published a model: each runs a full check. */
	readonly published: Stream.Stream<unknown>;
	/** How long a burst of events settles before it is checked; 300 ms by default. */
	readonly settle?: Duration.Input;
}

/**
 * The paths that differ between the disk and the index, as they change. The stream runs one full
 * check, then watches `folders`. Changed packages and files are rechecked by path once a burst
 * settles; a folder-level event, an unnamed event or a watcher error schedules one full walk,
 * and so does every `published` signal, so a completed scan resets the state. It holds only the
 * set of differing paths: no snapshot of the disk.
 */
export const watchDiskChanges = <E>(
	options: DiskChangesWatchOptions<E>
): Stream.Stream<DiskChangesState, E, DiskWatcher> =>
	Stream.callback<DiskChangesState, E, DiskWatcher>((output) =>
		Effect.gen(function* () {
			const watcher = yield* DiskWatcher;
			const settle = Duration.fromInputUnsafe(options.settle ?? Duration.millis(300));
			const pending = yield* Ref.make<Pending>({ full: true, paths: new Set() });
			// One wake-up stands for any number of events; the worker reads `pending` whole.
			const wake = yield* Queue.sliding<void>(1);
			/** The differing paths; undefined before the first answer and while not indexed. */
			const differing = yield* Ref.make<ReadonlyMap<string, DiskChangeItem> | undefined>(
				undefined
			);
			const answered = yield* Ref.make(false);
			const checking = yield* Ref.make(true);
			const emit = Effect.gen(function* () {
				const current = yield* Ref.get(differing);
				const busy = yield* Ref.get(checking);
				yield* Queue.offer(
					output,
					current === undefined
						? { status: "not_indexed", checking: busy }
						: stateOf(current, busy)
				);
			});
			const schedule = (next: (current: Pending) => Pending) =>
				Effect.gen(function* () {
					yield* Ref.update(pending, next);
					yield* Queue.offer(wake, undefined);
					const idle = !(yield* Ref.getAndSet(checking, true));
					if (idle && (yield* Ref.get(answered))) yield* emit;
				});
			const full = schedule(() => ({ full: true, paths: new Set() }));
			const named = (path: string) =>
				schedule((current) =>
					current.full
						? current
						: current.paths.size >= MAX_DISK_CHANGE_PATHS
							? { full: true, paths: new Set() }
							: { full: false, paths: new Set([...current.paths, path]) }
				);
			/** An event's project-relative path: rechecked by path, by a walk, or ignored. */
			const classify = (folder: string, relative: string | undefined) => {
				if (relative === undefined) return full;
				const path = posix.join(folder, relative.replaceAll("\\", "/"));
				if (options.localizationFiles.has(path)) return named(path);
				const kind = extension(path);
				// No extension: a folder created, renamed or removed.
				if (kind === undefined) return full;
				if (
					path.startsWith("Content/") &&
					(PACKAGE_EXTENSIONS.has(kind) || SIDECAR_EXTENSIONS.has(kind))
				)
					return named(path);
				return Effect.void;
			};
			const events = yield* Queue.unbounded<
				| { readonly folder: string; readonly path: string | undefined }
				| { readonly error: unknown }
			>();
			for (const folder of options.folders)
				yield* watcher.watch(join(options.projectRoot, folder), {
					change: (path) => Queue.offerUnsafe(events, { folder, path }),
					error: (error) => Queue.offerUnsafe(events, { error })
				});
			yield* Effect.forkScoped(
				Effect.forever(
					Effect.gen(function* () {
						const event = yield* Queue.take(events);
						if (!("error" in event)) return yield* classify(event.folder, event.path);
						yield* Effect.logWarning("A Game Text disk watcher failed", event.error);
						return yield* full;
					})
				)
			);
			yield* Effect.forkScoped(Stream.runForEach(options.published, () => full));
			/** Every page of one check; undefined when the view is not indexed. */
			const pages = Effect.fnUntraced(function* (paths?: readonly string[]) {
				const items: DiskChangeItem[] = [];
				let after: string | undefined;
				do {
					const answer = yield* options.check({
						...(paths === undefined ? undefined : { paths }),
						...(after === undefined ? undefined : { after }),
						limit: MAX_DISK_CHANGES_PAGE
					});
					if (answer.status === "not_indexed") return undefined;
					items.push(...answer.items);
					after = answer.nextCursor;
				} while (after !== undefined);
				return items;
			});
			const run = Effect.gen(function* () {
				const job = yield* Ref.getAndSet(pending, nothing);
				if (!job.full && job.paths.size === 0) return;
				const current = yield* Ref.get(differing);
				if (job.full || current === undefined) {
					const items = yield* pages();
					yield* Ref.set(
						differing,
						items && new Map(items.map((item) => [item.path, item]))
					);
				} else {
					const paths = [...job.paths];
					const items = yield* pages(paths);
					const next = new Map(current);
					for (const path of paths) for (const key of decided(path)) next.delete(key);
					for (const item of items ?? []) next.set(item.path, item);
					yield* Ref.set(differing, items && next);
				}
				yield* Ref.set(answered, true);
				const queued = yield* Ref.get(pending);
				yield* Ref.set(checking, queued.full || queued.paths.size > 0);
				yield* emit;
			});
			// The first check runs at once; later ones wait for their burst to settle.
			yield* Effect.forkScoped(
				Effect.gen(function* () {
					yield* run;
					while (true) {
						yield* Queue.take(wake);
						yield* Effect.sleep(settle);
						yield* run;
					}
				}).pipe(
					// oxlint-disable-next-line anti-slop/no-effect-catch-all -- Any check failure ends the stream with it, typed.
					Effect.catch((error: E) => Queue.fail(output, error))
				)
			);
		})
	).pipe(Stream.changesWith(sameState));

const sameState = (left: DiskChangesState, right: DiskChangesState) =>
	left.status === right.status &&
	left.checking === right.checking &&
	(left.status === "not_indexed" ||
		(right.status === "ready" &&
			left.changed === right.changed &&
			left.files.join("\0") === right.files.join("\0") &&
			JSON.stringify(left.counts) === JSON.stringify(right.counts)));
