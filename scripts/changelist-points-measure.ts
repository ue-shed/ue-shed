/**
 * Reads changelists' two points through the CLI's workflow and prints each
 * read's wall time and counts as a JSON line. Run it twice over one cache root: the first run
 * prints and parses everything, the second finds every revision and record cached.
 *
 *   node --import tsx scripts/changelist-points-measure.ts <project> <cache-root> <reader> <change>[s]...
 *
 * A trailing `s` reads a shelf; `local=<list>` reads the workspace's points for a file list, one
 * project-relative path a line. It only reads Perforce.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ConfigProvider, Effect, Layer } from "effect";
import {
	readChangelistPoints,
	readLocalPoints
} from "../apps/cli/src/workflows/changelist-points.ts";
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
				targetName: pointTarget,
				code: {
					engine,
					...(process.env.UE_SHED_ENGINE_ROOT === undefined
						? undefined
						: { engineRoot: process.env.UE_SHED_ENGINE_ROOT })
				}
			};
if (projectRoot === undefined || cacheRoot === undefined || reader === undefined)
	throw new Error("Usage: <project> <cache-root> <reader> <change>[s]...");
const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({ UE_SHED_PROJECT_INDEX_CACHE_ROOT: cacheRoot })
);
const steps = cliGameTextIndexLayer(reader).pipe(Layer.provide(config));

await Effect.runPromise(
	Effect.gen(function* () {
		for (const argument of changes) {
			if (argument.startsWith("local=")) {
				const files = readFileSync(argument.slice("local=".length), "utf8")
					.split(/\r?\n/u)
					.filter((line) => line.length > 0);
				const started = performance.now();
				const local = yield* readLocalPoints({ projectRoot, files, cacheRoot, ...code });
				console.log(
					JSON.stringify({
						local: argument.slice("local=".length),
						ms: Math.round(performance.now() - started),
						files: files.length,
						skipped: local.skipped.length,
						fromWorkspace: local.revisions.files.filter((file) => file.workspace)
							.length,
						missing: local.revisions.missing.length,
						printed: local.revisions.printed,
						printedBytes: local.revisions.bytes,
						recordsRead: local.before.read + local.after.read,
						recordsReused: local.before.reused + local.after.reused
					})
				);
				continue;
			}
			const shelved = argument.endsWith("s");
			const change = Number.parseInt(argument, 10);
			const started = performance.now();
			const read = yield* Effect.result(
				readChangelistPoints({ projectRoot, change, shelved, cacheRoot, ...code })
			);
			// One changelist's failure is reported and the rest are still measured.
			if (read._tag === "Failure") {
				const { message } = read.failure;
				const cause = "cause" in read.failure ? read.failure.cause : undefined;
				console.log(
					JSON.stringify({ change, shelved, error: message, cause: String(cause) })
				);
				continue;
			}
			const { revisions, before, after } = read.success;
			const localization = revisions.before;
			const statuses: Record<string, number> = {};
			for (const entry of after.entries)
				statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
			console.log(
				JSON.stringify({
					change,
					shelved,
					ms: Math.round(performance.now() - started),
					files: revisions.files.length,
					skipped: revisions.skipped.length,
					outside: revisions.outside,
					printed: revisions.printed,
					printedBytes: revisions.bytes,
					revisionsReused: revisions.reused,
					recordsRead: before.read + after.read,
					recordsReused: before.reused + after.reused,
					hashedBytes: before.bytes + after.bytes,
					statuses,
					stages: { before: before.stageSeconds, after: after.stageSeconds },
					...(localization === undefined
						? undefined
						: {
								localization: {
									files: localization.files.length,
									fromWorkspace: localization.files.filter(
										(file) => file.workspace
									).length,
									missing: localization.missing.length,
									printed: localization.printed,
									printedBytes: localization.bytes
								}
							})
				})
			);
		}
	}).pipe(Effect.scoped, Effect.provide(steps))
);
