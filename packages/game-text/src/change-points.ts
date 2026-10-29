import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { GameTextContract } from "@ue-shed/protocol";
import {
	gameTextChangePoints,
	type ChangeComparisonTarget,
	type GameTextChange
} from "./change-comparison.js";
import type { GameTextCodeSource } from "./index-contract.js";
import { GameTextIndexSteps } from "./index-steps.js";
import {
	LocalizationGateCheck,
	comparisonGuidance,
	localizationGateComparison,
	type LocalizationGateChange
} from "./localization-gate.js";

/**
 * Files a point reads: saved packages, and the source and config files a gather step may scan.
 * String Table CSVs are not among them: the scan reads those from the project on disk.
 */
const READ = /\.(?:uasset|umap|h|hh|hpp|hxx|inl|c|cc|cpp|cxx|mm|ini)$/iu;

/** Whether a point reads a project file, by its path. */
export const changePointReads = (path: string) => READ.test(path);

/**
 * Changed packages, or code and config files, a point could not read at all, by path. A verdict
 * over a change with any of them could pass what it never saw.
 */
export function unreadableChangePaths(targets: readonly GameTextTargetPoints[]): string[] {
	return [
		...new Set(
			targets.flatMap((target) =>
				[...target.before.entries, ...target.after.entries].flatMap((entry) =>
					entry.status === "failed" ? [entry.path] : []
				)
			)
		)
	];
}

/** One changed project file at both sides, on disk; a side the file lacks is absent. */
export interface GameTextChangedFile {
	/** Relative to the project folder, with `/`. */
	readonly path: string;
	readonly base?: string;
	readonly head?: string;
}

/** One project file at a revision, on disk. */
export interface GameTextRevisionFile {
	/** Relative to the project folder, with `/`. */
	readonly path: string;
	readonly depotPath: string;
	readonly revision: number;
	readonly file: string;
	/**
	 * The server the revision is on, as the host keys it: one depot path and revision name
	 * different bytes on two servers, even when the workspace holds them.
	 */
	readonly server?: string;
}

/** A change's files at both sides, and the files asked for as the change found them. */
export interface GameTextChangeRead {
	readonly files: readonly GameTextChangedFile[];
	/** Changed files inside the project no point reads. */
	readonly skipped: readonly string[];
	/** Changed files outside the project folder. */
	readonly outside: number;
	readonly before?: { readonly files: readonly GameTextRevisionFile[] };
}

/**
 * How a host reads a change's revisions, such as from Perforce with Map History's reads. Each
 * read prints only the files `reads` accepts, and `before` as the change found them.
 */
export interface GameTextChangeRevisions<E> {
	readonly changelist: (input: {
		readonly projectRoot: string;
		readonly change: number;
		readonly shelved: boolean;
		readonly reads: (path: string) => boolean;
		readonly before?: readonly string[];
	}) => Effect.Effect<GameTextChangeRead, E>;
	readonly range: (input: {
		readonly projectRoot: string;
		readonly from: number;
		readonly to: number;
		readonly reads: (path: string) => boolean;
		readonly before?: readonly string[];
	}) => Effect.Effect<GameTextChangeRead, E>;
	/** Project files at the revisions the workspace has. */
	readonly have: (input: {
		readonly projectRoot: string;
		readonly paths: readonly string[];
	}) => Effect.Effect<{ readonly files: readonly GameTextRevisionFile[] }, E>;
}

/** A target's native culture, and its manifest and archives by project-relative path. */
interface TargetOutputs {
	readonly nativeCulture: string;
	readonly manifest: string;
	readonly archives: readonly { readonly culture: string; readonly path: string }[];
}

/** Each named target's outputs; a target with no manifest has none. */
const targetOutputs = Effect.fnUntraced(function* (
	projectRoot: string,
	targetNames: readonly string[]
) {
	if (targetNames.length === 0) return new Map<string, TargetOutputs>();
	const discovery = yield* (yield* LocalizationEvidence).discover({ projectRoot });
	return new Map(
		targetNames.flatMap((name) => {
			const found = discovery.targets.find((item) => item.name === name);
			const manifest = found?.outputPaths.manifest;
			if (found === undefined || manifest === null || manifest === undefined) return [];
			const outputs: TargetOutputs = {
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
 * depot path and number, which never change on one server, and the server (or, from a host that
 * does not name it, the file it was read from). Undefined without the manifest. A culture whose
 * archive the base lacks has nothing translated.
 */
function baseLocalization(
	outputs: TargetOutputs | undefined,
	files: readonly GameTextRevisionFile[]
): GameTextContract.BaseLocalization | undefined {
	const byPath = new Map(files.map((file) => [file.path, file]));
	const revision = (path: string) => {
		const file = byPath.get(path);
		return file === undefined
			? undefined
			: {
					path,
					file: file.file,
					revision: `${file.depotPath}#${file.revision} ${file.server ?? file.file}`
				};
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
export interface GameTextTargetPoints {
	/** Absent when no target was named: packages only, with no code and no judgment. */
	readonly target?: string;
	readonly before: GameTextContract.PointOutcome;
	readonly after: GameTextContract.PointOutcome;
	readonly comparison: GameTextContract.PointComparison;
	readonly localized: boolean;
}

/** A page of a comparison's changes or findings. */
export interface GameTextChangePage {
	readonly offset: number;
	readonly limit: number;
}

/** A change's points and comparisons, and what it touches in the project. */
export interface GameTextChangePoints {
	readonly targets: readonly GameTextTargetPoints[];
	/** The two points, the files the change touches, how many were read, and whether code was. */
	readonly change: LocalizationGateChange;
	/** Changed files inside the project no point reads. */
	readonly skipped: readonly string[];
}

/** The engine's largest page. */
const WHOLE = { offset: 0, limit: 1000 } as const;

/**
 * Reads a change's two points for each named target, or once without a target, and compares
 * them: a submitted changelist, a shelf or a range through the host's revisions, or listed
 * working-copy files on disk over the revisions the workspace has. With targets, each target's
 * localization as the change found it is read too, and its comparison judges the change by the
 * gate's checks; with a code source, each target's code files are read with that engine.
 *
 * The points share records, so a second target rereads nothing but its code. They are read one
 * target at a time because a point's id names the change, not the target; a host must not read
 * two changes with the same id at once.
 */
export function readGameTextChangePoints<E>(input: {
	readonly projectRoot: string;
	readonly change: GameTextChange;
	readonly revisions: GameTextChangeRevisions<E>;
	readonly targetNames?: readonly string[];
	readonly code?: GameTextCodeSource;
	readonly changes?: GameTextChangePage;
	readonly findings?: GameTextChangePage;
}) {
	return Effect.gen(function* () {
		const targetNames = input.targetNames ?? [];
		const outputs = yield* targetOutputs(input.projectRoot, targetNames);
		const before = outputs.size === 0 ? undefined : outputPaths(outputs.values());
		const sides = yield* readSides(input, before);
		const { point, base } = gameTextChangePoints(input.change);
		const steps = yield* GameTextIndexSteps;
		const names: readonly (string | undefined)[] =
			targetNames.length === 0 ? [undefined] : targetNames;
		const targets = yield* Effect.forEach(names, (targetName) =>
			Effect.gen(function* () {
				const target = {
					...(targetName === undefined ? undefined : { targetName }),
					...(input.code === undefined ? undefined : { code: input.code })
				};
				const beforePoint = yield* steps.readPoint({
					projectRoot: input.projectRoot,
					point: base,
					files: sides.before,
					...target
				});
				const afterPoint = yield* steps.readPoint({
					projectRoot: input.projectRoot,
					point,
					base,
					files: sides.after,
					...target
				});
				const localization =
					targetName === undefined
						? undefined
						: baseLocalization(outputs.get(targetName), sides.localization);
				const comparison = yield* steps.comparePoints({
					projectRoot: input.projectRoot,
					point,
					base,
					changes: input.changes ?? WHOLE,
					findings: input.findings ?? WHOLE,
					...(targetName === undefined ? undefined : { targetName }),
					...(localization === undefined ? undefined : { localization })
				});
				return {
					...(targetName === undefined ? undefined : { target: targetName }),
					before: beforePoint,
					after: afterPoint,
					comparison,
					localized: localization !== undefined
				} satisfies GameTextTargetPoints;
			})
		);
		return {
			targets,
			change: {
				point,
				base,
				files: sides.files,
				read: sides.read,
				outside: sides.outside,
				code: input.code !== undefined
			},
			skipped: sides.skipped
		} satisfies GameTextChangePoints;
	}).pipe(Effect.withSpan("GameText.change_points"));
}

/** The change's files at both sides, and the targets' localization as the change found it. */
function readSides<E>(
	input: {
		readonly projectRoot: string;
		readonly change: GameTextChange;
		readonly revisions: GameTextChangeRevisions<E>;
	},
	before: readonly string[] | undefined
) {
	return Effect.gen(function* () {
		const { change, projectRoot, revisions } = input;
		if (change.kind === "local") {
			const read = change.files.filter(changePointReads);
			const had = yield* revisions.have({
				projectRoot,
				paths: [...read, ...(before ?? [])]
			});
			const byPath = new Map(had.files.map((file) => [file.path, file.file]));
			const onDisk = yield* Effect.forEach(read, (path) =>
				Effect.promise(() =>
					stat(join(projectRoot, path)).then(
						() => ({ path, file: join(projectRoot, path) }),
						() => ({ path })
					)
				)
			);
			return {
				before: read.map((path) => {
					const file = byPath.get(path);
					return file === undefined ? { path } : { path, file };
				}),
				after: onDisk,
				localization: had.files,
				files: change.files.length,
				read: read.length,
				outside: 0,
				skipped: change.files.filter((path) => !changePointReads(path))
			};
		}
		const common = {
			projectRoot,
			reads: changePointReads,
			...(before === undefined ? undefined : { before })
		};
		const fetched =
			change.kind === "range"
				? yield* revisions.range({ ...common, from: change.from, to: change.to })
				: yield* revisions.changelist({
						...common,
						change: change.change,
						shelved: change.kind === "shelved"
					});
		const side = (pick: "base" | "head") =>
			fetched.files.map((file) => {
				const bytes = file[pick];
				return bytes === undefined ? { path: file.path } : { path: file.path, file: bytes };
			});
		return {
			before: side("base"),
			after: side("head"),
			localization: fetched.before?.files ?? [],
			files: fetched.files.length + fetched.skipped.length,
			read: fetched.files.length,
			outside: fetched.outside,
			skipped: fetched.skipped
		};
	});
}

/**
 * A target's comparison as `compareChange` answers it, judged by `failing`: each finding's
 * severity and way forward, failing checks first, and the verdict when the change was judged.
 */
export function changeComparisonTarget(
	points: GameTextTargetPoints,
	failing: readonly LocalizationGateCheck[]
): ChangeComparisonTarget {
	const { comparison } = points;
	const fails = new Set(failing);
	const order = (check: LocalizationGateCheck) =>
		(fails.has(check) ? 0 : LocalizationGateCheck.literals.length) +
		LocalizationGateCheck.literals.indexOf(check);
	const findings = comparison.findings;
	// The verdict counts every finding, not only the page's, as `loc gate` does.
	const status =
		points.localized && findings !== undefined
			? localizationGateComparison({
					target: points.target ?? "",
					comparison,
					failOn: failing
				}).status
			: undefined;
	return {
		...(points.target === undefined ? undefined : { target: points.target }),
		localized: points.localized,
		...(status === undefined ? undefined : { status }),
		counts: comparison.counts,
		complete: comparison.complete,
		total: comparison.total,
		changes: comparison.changes,
		...(findings === undefined
			? undefined
			: {
					findings: {
						counts: findings.counts,
						total: findings.total,
						rows: findings.rows
							.map((finding) => ({
								...finding,
								severity: fails.has(finding.check)
									? ("fail" as const)
									: ("warn" as const),
								guidance: comparisonGuidance(finding)
							}))
							.sort((left, right) => order(left.check) - order(right.check))
					}
				})
	};
}
