/**
 * Reads changes' two points through Game Text's change reader, with Map History's Perforce reads,
 * and prints each read's wall time and counts as a JSON line. Run it twice over one cache root:
 * the first run prints and parses everything, the second finds every revision and record cached.
 *
 *   node --import tsx scripts/changelist-points-measure.ts <project> <cache-root> <reader> <change>...
 *
 * A change is `1200` (submitted), `1200s` (a shelf), `1100..1200` (the submitted changelists after
 * 1100 up to 1200) or `local=<list>` (the workspace's points for a file list, one project-relative
 * path a line). It only reads Perforce.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConfigProvider, Effect, Layer } from "effect";
import { readGameTextChangePoints } from "../packages/game-text/dist/entry-index.js";
import type { GameTextChange } from "../packages/game-text/dist/entry-schema.js";
import { LocalizationEvidenceNodeLive } from "../packages/localization/dist/index.js";
import {
	perforceChangeRevisions,
	type ChangelistRevisions,
	type RangeRevisions,
	type RevisionFiles
} from "../packages/map-history/dist/index.js";
import { cliGameTextIndexLayer } from "../apps/cli/src/workflows/game-text-index.ts";

const [projectRoot, cacheRoot, reader, ...changes] = process.argv.slice(2);
// `UE_SHED_POINT_TARGET` and `UE_SHED_ENGINE_VERSION` read the target's code too.
const pointTarget = process.env.UE_SHED_POINT_TARGET;
const engine = (["4.27", "5.7", "5.8"] as const).find(
	(line) => line === process.env.UE_SHED_ENGINE_VERSION
);
const code =
	pointTarget === undefined || engine === undefined
		? {}
		: {
				targetNames: [pointTarget],
				code: {
					engine,
					...(process.env.UE_SHED_ENGINE_ROOT === undefined
						? undefined
						: { engineRoot: process.env.UE_SHED_ENGINE_ROOT })
				}
			};
if (projectRoot === undefined || cacheRoot === undefined || reader === undefined)
	throw new Error("Usage: <project> <cache-root> <reader> <change>[s]...");
/** A comparison's counts and stage times, without its rows. */
const summary = (comparison: {
	readonly counts: object;
	readonly complete: boolean;
	readonly findings?: { readonly counts: object; readonly built: boolean };
	readonly stageSeconds: object;
}) => ({
	changes: comparison.counts,
	complete: comparison.complete,
	findings: comparison.findings?.counts,
	lookupBuilt: comparison.findings?.built,
	stages: comparison.stageSeconds
});
const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({ UE_SHED_PROJECT_INDEX_CACHE_ROOT: cacheRoot })
);
const steps = cliGameTextIndexLayer(reader).pipe(Layer.provide(config));

/** A change argument as Game Text names it. */
function changeOf(argument: string): GameTextChange {
	if (argument.startsWith("local="))
		return {
			kind: "local",
			files: readFileSync(argument.slice("local=".length), "utf8")
				.split(/\r?\n/u)
				.filter((line) => line.length > 0)
		};
	const range = /^(\d+)\.\.(\d+)$/u.exec(argument);
	if (range !== null) return { kind: "range", from: Number(range[1]), to: Number(range[2]) };
	const change = Number.parseInt(argument, 10);
	return argument.endsWith("s") ? { kind: "shelved", change } : { kind: "submitted", change };
}

type Fetched = ChangelistRevisions | RangeRevisions | RevisionFiles;
interface FetchedSummary {
	readonly files: number;
	readonly fromWorkspace: number;
	readonly missing?: number;
	readonly outside?: number;
	readonly printed: number;
	readonly printedBytes: number;
	readonly reused: number;
	readonly localization?: FetchedSummary;
}
/** What a revision read printed and found, from Map History's answer. */
function fetchedSummary(fetched: Fetched): FetchedSummary {
	const fromWorkspace = fetched.files.filter(
		(file) => "workspace" in file && file.workspace
	).length;
	return {
		files: fetched.files.length,
		fromWorkspace,
		printed: fetched.printed,
		printedBytes: fetched.bytes,
		reused: fetched.reused,
		...("missing" in fetched ? { missing: fetched.missing.length } : undefined),
		...("outside" in fetched ? { outside: fetched.outside } : undefined),
		...("before" in fetched && fetched.before !== undefined
			? { localization: fetchedSummary(fetched.before) }
			: undefined)
	};
}

await Effect.runPromise(
	Effect.gen(function* () {
		for (const argument of changes) {
			const change = changeOf(argument);
			const perforce = perforceChangeRevisions({ directory: join(cacheRoot, "revisions") });
			let fetched: FetchedSummary | undefined;
			const record = (value: Fetched) =>
				Effect.sync(() => {
					fetched = fetchedSummary(value);
				});
			const started = performance.now();
			const read = yield* Effect.result(
				readGameTextChangePoints({
					projectRoot,
					change,
					revisions: {
						changelist: (input) => perforce.changelist(input).pipe(Effect.tap(record)),
						range: (input) => perforce.range(input).pipe(Effect.tap(record)),
						have: (input) => perforce.have(input).pipe(Effect.tap(record))
					},
					...code
				}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
			);
			// One change's failure is reported and the rest are still measured.
			if (read._tag === "Failure") {
				const { message } = read.failure;
				const cause = "cause" in read.failure ? read.failure.cause : undefined;
				console.log(JSON.stringify({ argument, error: message, cause: String(cause) }));
				continue;
			}
			const { targets, skipped } = read.success;
			const [first] = targets;
			if (first === undefined) continue;
			const statuses: Record<string, number> = {};
			for (const entry of first.after.entries)
				statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
			console.log(
				JSON.stringify({
					argument,
					ms: Math.round(performance.now() - started),
					skipped: skipped.length,
					revisions: fetched,
					recordsRead: first.before.read + first.after.read,
					recordsReused: first.before.reused + first.after.reused,
					hashedBytes: first.before.bytes + first.after.bytes,
					statuses,
					comparisons: targets.map((item) => summary(item.comparison))
				})
			);
		}
	}).pipe(Effect.scoped, Effect.provide(steps))
);
