import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { GameTextIndexSteps, type GameTextCodeSource } from "@ue-shed/game-text/index";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import {
	readChangelistRevisions,
	readRevisionFiles,
	type RevisionFile
} from "@ue-shed/map-history";
import type { GameTextContract } from "@ue-shed/protocol";

/**
 * Files a point reads: saved packages, and the source and config files a gather step may scan.
 * String Table CSVs are not among them: the scan reads those from the project on disk.
 */
const READ = /\.(?:uasset|umap|h|hh|hpp|inl|c|cc|cpp|cxx|mm|ini)$/iu;

/** A target's native culture, and its manifest and archives by project-relative path. */
interface TargetOutputs {
	readonly name: string;
	readonly nativeCulture: string;
	readonly manifest: string;
	readonly archives: readonly { readonly culture: string; readonly path: string }[];
}

/** Each named target's outputs, in order; a target with no manifest has none. */
const targetOutputs = Effect.fnUntraced(function* (input: {
	readonly projectRoot: string;
	readonly targetNames: readonly string[];
}) {
	if (input.targetNames.length === 0) return new Map<string, TargetOutputs>();
	const discovery = yield* LocalizationEvidence.use((evidence) =>
		evidence.discover({ projectRoot: input.projectRoot })
	).pipe(Effect.provide(LocalizationEvidenceNodeLive));
	return new Map(
		input.targetNames.flatMap((name) => {
			const found = discovery.targets.find((item) => item.name === name);
			const manifest = found?.outputPaths.manifest;
			if (found === undefined || manifest === null || manifest === undefined) return [];
			const outputs: TargetOutputs = {
				name,
				nativeCulture: found.nativeCulture ?? "",
				manifest,
				archives: found.cultures.flatMap((culture) => {
					const path = found.outputPaths.archives[culture];
					return path === null || path === undefined ? [] : [{ culture, path }];
				})
			};
			return [[name, outputs] as const];
		})
	);
});

const outputPaths = (outputs: Iterable<TargetOutputs>) => [
	...new Set(
		[...outputs].flatMap((target) => [
			target.manifest,
			...target.archives.map((archive) => archive.path)
		])
	)
];

/**
 * The target's localization at a base, from the files fetched there; a revision is named by its
 * depot path and number, which never change. Undefined without the manifest. A culture whose
 * archive the base lacks has nothing translated.
 */
function baseLocalization(
	outputs: TargetOutputs | undefined,
	files: readonly RevisionFile[]
): GameTextContract.BaseLocalization | undefined {
	const byPath = new Map(files.map((file) => [file.path, file]));
	const revision = (path: string) => {
		const file = byPath.get(path);
		return file === undefined
			? undefined
			: { path, file: file.file, revision: `${file.depotPath}#${file.revision}` };
	};
	const manifest = outputs === undefined ? undefined : revision(outputs.manifest);
	if (outputs === undefined || manifest === undefined) return undefined;
	return {
		nativeCulture: outputs.nativeCulture,
		manifest,
		archives: outputs.archives.flatMap(({ culture, path }) => {
			const archive = revision(path);
			return archive === undefined ? [] : [{ culture, archive }];
		})
	};
}

/**
 * One target's two points and their comparison. `localized` says whether the base had the
 * target's manifest: without it the comparison lists changes but judges nothing.
 */
export interface TargetPoints {
	/** Absent when no target was named: packages only, with no code and no judgment. */
	readonly target?: string;
	readonly before: GameTextContract.PointOutcome;
	readonly after: GameTextContract.PointOutcome;
	readonly comparison: GameTextContract.PointComparison;
	readonly localized: boolean;
}

/** How many findings a comparison returns: the engine's largest page. */
const FINDINGS = { offset: 0, limit: 1000 } as const;

/**
 * Reads a change's two points and compares them for each named target, or once without a target.
 * The points share records, so a second target rereads nothing but its code; they are read one
 * target at a time because a point's id names the change, not the target.
 */
const readTargets = Effect.fnUntraced(function* (input: {
	readonly projectRoot: string;
	readonly point: string;
	readonly base: string;
	readonly targetNames: readonly string[];
	readonly outputs: ReadonlyMap<string, TargetOutputs>;
	readonly localizationFiles: readonly RevisionFile[];
	readonly code?: GameTextCodeSource;
	readonly before: GameTextContract.PointRequest["files"];
	readonly after: GameTextContract.PointRequest["files"];
	readonly changes?: GameTextContract.PageRequest;
}) {
	const steps = yield* GameTextIndexSteps;
	const names: readonly (string | undefined)[] =
		input.targetNames.length === 0 ? [undefined] : input.targetNames;
	return yield* Effect.forEach(names, (targetName) =>
		Effect.gen(function* () {
			const target = {
				...(targetName === undefined ? undefined : { targetName }),
				...(input.code === undefined ? undefined : { code: input.code })
			};
			const before = yield* steps.readPoint({
				projectRoot: input.projectRoot,
				point: input.base,
				files: input.before,
				...target
			});
			const after = yield* steps.readPoint({
				projectRoot: input.projectRoot,
				point: input.point,
				base: input.base,
				files: input.after,
				...target
			});
			const localization =
				targetName === undefined
					? undefined
					: baseLocalization(input.outputs.get(targetName), input.localizationFiles);
			const comparison = yield* steps.comparePoints({
				projectRoot: input.projectRoot,
				point: input.point,
				base: input.base,
				findings: FINDINGS,
				...(input.changes === undefined ? undefined : { changes: input.changes }),
				...(targetName === undefined ? undefined : { targetName }),
				...(localization === undefined ? undefined : { localization })
			});
			return {
				...(targetName === undefined ? undefined : { target: targetName }),
				before,
				after,
				comparison,
				localized: localization !== undefined
			} satisfies TargetPoints;
		})
	);
});

/**
 * A changelist's two points: its files inside the project before the change and at it. Perforce
 * prints only the revisions the revision cache lacks; the reader reads only the records the
 * record cache lacks. With targets and a code source, each target's code files are read too. The
 * point ids are `depot@<CL>` or `shelved:<CL>`, and `before.` and that for the base, which the
 * change's point names as its base.
 *
 * With targets, `revisions.before` is their manifests and archives as the change found them: at
 * the changelist before a submitted one, and at the depot's head for a shelf. The workspace's
 * copies are read where they hold that revision. Each target's `comparison` judges the change
 * against them by the gate's checks.
 */
export const readChangelistPoints = Effect.fn("Cli.game_text.changelist_points")(function* (input: {
	readonly projectRoot: string;
	readonly change: number;
	readonly shelved: boolean;
	readonly cacheRoot: string;
	readonly targetNames?: readonly string[];
	readonly code?: GameTextCodeSource;
	readonly changes?: GameTextContract.PageRequest;
}) {
	const targetNames = input.targetNames ?? [];
	const outputs = yield* targetOutputs({ projectRoot: input.projectRoot, targetNames });
	const revisions = yield* readChangelistRevisions({
		projectRoot: input.projectRoot,
		change: input.change,
		shelved: input.shelved,
		directory: join(input.cacheRoot, "revisions"),
		reads: (path) => READ.test(path),
		...(outputs.size === 0 ? undefined : { before: outputPaths(outputs.values()) })
	});
	const id = input.shelved ? `shelved:${input.change}` : `depot@${input.change}`;
	const side = (pick: "base" | "head") =>
		revisions.files.map((file) => {
			const bytes = file[pick];
			return bytes === undefined ? { path: file.path } : { path: file.path, file: bytes };
		});
	const targets = yield* readTargets({
		projectRoot: input.projectRoot,
		point: id,
		base: `before.${id}`,
		targetNames,
		outputs,
		localizationFiles: revisions.before?.files ?? [],
		before: side("base"),
		after: side("head"),
		...(input.code === undefined ? undefined : { code: input.code }),
		...(input.changes === undefined ? undefined : { changes: input.changes })
	});
	return { revisions, targets };
});

/**
 * A workspace's two points for some of its files, and their comparison: `local`, as they are on
 * disk, over `before.local`, the revisions the workspace has. Files the workspace never had are
 * additions. `revisions` holds the files at the workspace's revisions, and with targets their
 * manifests and archives. `skipped` are listed files no point reads.
 */
export const readLocalPoints = Effect.fn("Cli.game_text.local_points")(function* (input: {
	readonly projectRoot: string;
	/** Relative to the project folder, with `/`. */
	readonly files: readonly string[];
	readonly cacheRoot: string;
	readonly targetNames?: readonly string[];
	readonly code?: GameTextCodeSource;
	readonly changes?: GameTextContract.PageRequest;
}) {
	const targetNames = input.targetNames ?? [];
	const read = input.files.filter((path) => READ.test(path));
	const outputs = yield* targetOutputs({ projectRoot: input.projectRoot, targetNames });
	const revisions = yield* readRevisionFiles({
		projectRoot: input.projectRoot,
		paths: [...read, ...outputPaths(outputs.values())],
		at: "have",
		directory: join(input.cacheRoot, "revisions")
	});
	const had = new Map(revisions.files.map((file) => [file.path, file.file]));
	const on = yield* Effect.forEach(read, (path) =>
		Effect.promise(() =>
			stat(join(input.projectRoot, path)).then(
				() => ({ path, file: join(input.projectRoot, path) }),
				() => ({ path })
			)
		)
	);
	const targets = yield* readTargets({
		projectRoot: input.projectRoot,
		point: "local",
		base: "before.local",
		targetNames,
		outputs,
		localizationFiles: revisions.files,
		before: read.map((path) => {
			const file = had.get(path);
			return file === undefined ? { path } : { path, file };
		}),
		after: on,
		...(input.code === undefined ? undefined : { code: input.code }),
		...(input.changes === undefined ? undefined : { changes: input.changes })
	});
	return {
		revisions,
		skipped: input.files.filter((path) => !READ.test(path)),
		targets
	};
});
