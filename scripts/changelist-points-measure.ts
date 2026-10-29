/**
 * Reads changelists' two points through the CLI's workflow and prints each
 * read's wall time and counts as a JSON line. Run it twice over one cache root: the first run
 * prints and parses everything, the second finds every revision and record cached.
 *
 *   node --import tsx scripts/changelist-points-measure.ts <project> <cache-root> <reader> <change>[s]...
 *
 * A trailing `s` reads a shelf. It only reads Perforce.
 */
import { performance } from "node:perf_hooks";
import { ConfigProvider, Effect, Layer } from "effect";
import { readChangelistPoints } from "../apps/cli/src/workflows/changelist-points.ts";
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
					stages: { before: before.stageSeconds, after: after.stageSeconds }
				})
			);
		}
	}).pipe(Effect.scoped, Effect.provide(steps))
);
