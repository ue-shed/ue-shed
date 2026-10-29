import { join } from "node:path";
import { Effect } from "effect";
import { GameTextIndexSteps } from "@ue-shed/game-text/index";
import { readChangelistRevisions } from "@ue-shed/map-history";

/**
 * A changelist's two points: its files inside the project before the change
 * and at it. Perforce prints only the revisions the revision cache lacks; the reader reads only
 * the records the record cache lacks. The point ids are `depot@<CL>` or `shelved:<CL>`, and
 * `before.` and that for the base, which the change's point names as its base.
 */
export const readChangelistPoints = Effect.fn("Cli.game_text.changelist_points")(function* (input: {
	readonly projectRoot: string;
	readonly change: number;
	readonly shelved: boolean;
	readonly cacheRoot: string;
}) {
	const revisions = yield* readChangelistRevisions({
		projectRoot: input.projectRoot,
		change: input.change,
		shelved: input.shelved,
		directory: join(input.cacheRoot, "revisions"),
		// Points read saved packages; code and localization files join them in later steps.
		reads: (path) => /\.(?:uasset|umap)$/iu.test(path)
	});
	const steps = yield* GameTextIndexSteps;
	const id = input.shelved ? `shelved:${input.change}` : `depot@${input.change}`;
	const side = (pick: "base" | "head") =>
		revisions.files.map((file) => {
			const bytes = file[pick];
			return bytes === undefined ? { path: file.path } : { path: file.path, file: bytes };
		});
	const before = yield* steps.readPoint({
		projectRoot: input.projectRoot,
		point: `before.${id}`,
		files: side("base")
	});
	const after = yield* steps.readPoint({
		projectRoot: input.projectRoot,
		point: id,
		base: `before.${id}`,
		files: side("head")
	});
	return { revisions, before, after };
});
