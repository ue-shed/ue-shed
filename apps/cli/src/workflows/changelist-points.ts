import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { GameTextIndexSteps, type GameTextCodeSource } from "@ue-shed/game-text/index";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { readChangelistRevisions, readRevisionFiles } from "@ue-shed/map-history";

/**
 * Files a point reads: saved packages, and the source and config files a gather step may scan.
 * String Table CSVs are not among them: the scan reads those from the project on disk.
 */
const READ = /\.(?:uasset|umap|h|hh|hpp|inl|c|cc|cpp|cxx|mm|ini)$/iu;

/** A target's manifest and archives, by project-relative path; undefined without a target. */
const targetOutputs = Effect.fnUntraced(function* (input: {
	readonly projectRoot: string;
	readonly targetName?: string;
}) {
	if (input.targetName === undefined) return undefined;
	const discovery = yield* LocalizationEvidence.use((evidence) =>
		evidence.discover({ projectRoot: input.projectRoot })
	).pipe(Effect.provide(LocalizationEvidenceNodeLive));
	const found = discovery.targets.find((item) => item.name === input.targetName);
	if (found === undefined) return undefined;
	return [
		found.outputPaths.manifest,
		...found.cultures.map((culture) => found.outputPaths.archives[culture])
	].flatMap((path) => (path === null || path === undefined ? [] : [path]));
});

/**
 * A changelist's two points: its files inside the project before the change and at it. Perforce
 * prints only the revisions the revision cache lacks; the reader reads only the records the
 * record cache lacks. With a target and a code source, the target's code files are read too. The
 * point ids are `depot@<CL>` or `shelved:<CL>`, and `before.` and that for the base, which the
 * change's point names as its base.
 *
 * With a target, `revisions.before` is the target's manifest and archives as the change found
 * them: at the changelist before a submitted one, and at the depot's head for a shelf. The
 * workspace's copies are read where they hold that revision.
 */
export const readChangelistPoints = Effect.fn("Cli.game_text.changelist_points")(function* (input: {
	readonly projectRoot: string;
	readonly change: number;
	readonly shelved: boolean;
	readonly cacheRoot: string;
	readonly targetName?: string;
	readonly code?: GameTextCodeSource;
}) {
	const found = yield* targetOutputs(input);
	const revisions = yield* readChangelistRevisions({
		projectRoot: input.projectRoot,
		change: input.change,
		shelved: input.shelved,
		directory: join(input.cacheRoot, "revisions"),
		reads: (path) => READ.test(path),
		...(found === undefined ? undefined : { before: found })
	});
	const steps = yield* GameTextIndexSteps;
	const id = input.shelved ? `shelved:${input.change}` : `depot@${input.change}`;
	const side = (pick: "base" | "head") =>
		revisions.files.map((file) => {
			const bytes = file[pick];
			return bytes === undefined ? { path: file.path } : { path: file.path, file: bytes };
		});
	const target = {
		...(input.targetName === undefined ? undefined : { targetName: input.targetName }),
		...(input.code === undefined ? undefined : { code: input.code })
	};
	const before = yield* steps.readPoint({
		projectRoot: input.projectRoot,
		point: `before.${id}`,
		files: side("base"),
		...target
	});
	const after = yield* steps.readPoint({
		projectRoot: input.projectRoot,
		point: id,
		base: `before.${id}`,
		files: side("head"),
		...target
	});
	return { revisions, before, after };
});

/**
 * A workspace's two points for some of its files: `local`, as they are on disk, over
 * `before.local`, the revisions the workspace has. Files the workspace never had are additions.
 * `revisions` holds the files at the workspace's revisions, and with a target its manifest and
 * archives, whose paths are `outputs`. `skipped` are listed files no point reads.
 */
export const readLocalPoints = Effect.fn("Cli.game_text.local_points")(function* (input: {
	readonly projectRoot: string;
	/** Relative to the project folder, with `/`. */
	readonly files: readonly string[];
	readonly cacheRoot: string;
	readonly targetName?: string;
	readonly code?: GameTextCodeSource;
}) {
	const read = input.files.filter((path) => READ.test(path));
	const outputs = (yield* targetOutputs(input)) ?? [];
	const revisions = yield* readRevisionFiles({
		projectRoot: input.projectRoot,
		paths: [...read, ...outputs],
		at: "have",
		directory: join(input.cacheRoot, "revisions")
	});
	const had = new Map(revisions.files.map((file) => [file.path, file.file]));
	const steps = yield* GameTextIndexSteps;
	const target = {
		...(input.targetName === undefined ? undefined : { targetName: input.targetName }),
		...(input.code === undefined ? undefined : { code: input.code })
	};
	const before = yield* steps.readPoint({
		projectRoot: input.projectRoot,
		point: "before.local",
		files: read.map((path) => {
			const file = had.get(path);
			return file === undefined ? { path } : { path, file };
		}),
		...target
	});
	const on = yield* Effect.forEach(read, (path) =>
		Effect.promise(() =>
			stat(join(input.projectRoot, path)).then(
				() => ({ path, file: join(input.projectRoot, path) }),
				() => ({ path })
			)
		)
	);
	const after = yield* steps.readPoint({
		projectRoot: input.projectRoot,
		point: "local",
		base: "before.local",
		files: on,
		...target
	});
	return {
		revisions,
		outputs,
		skipped: input.files.filter((path) => !READ.test(path)),
		before,
		after
	};
});
