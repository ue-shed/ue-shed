import { join } from "node:path";
import { Effect } from "effect";
import { GameTextIndexSteps, type GameTextCodeSource } from "@ue-shed/game-text/index";
import { readChangelistRevisions } from "@ue-shed/map-history";

/**
 * Files a point reads: saved packages, and the source and config files a gather step may scan.
 * String Table CSVs are not among them: the scan reads those from the project on disk.
 */
const READ = /\.(?:uasset|umap|h|hh|hpp|inl|c|cc|cpp|cxx|mm|ini)$/iu;

/**
 * A changelist's two points: its files inside the project before the change and at it. Perforce
 * prints only the revisions the revision cache lacks; the reader reads only the records the
 * record cache lacks. With a target and a code source, the target's code files are read too. The
 * point ids are `depot@<CL>` or `shelved:<CL>`, and `before.` and that for the base, which the
 * change's point names as its base.
 */
export const readChangelistPoints = Effect.fn("Cli.game_text.changelist_points")(function* (input: {
	readonly projectRoot: string;
	readonly change: number;
	readonly shelved: boolean;
	readonly cacheRoot: string;
	readonly targetName?: string;
	readonly code?: GameTextCodeSource;
}) {
	const revisions = yield* readChangelistRevisions({
		projectRoot: input.projectRoot,
		change: input.change,
		shelved: input.shelved,
		directory: join(input.cacheRoot, "revisions"),
		reads: (path) => READ.test(path)
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
