/** Generated-only companion to benchmark-game-text-scale.ts; run in fresh processes per revision.
 * node --expose-gc --import tsx scripts/benchmark-game-text-incremental.ts --output test-results/...
 * --module may point at an archived packages/game-text/src directory beneath test-results.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Effect, Schema, Stream } from "effect";
import { LocalizationTarget } from "../packages/localization/dist/index.js";
import type { SavedAssetPackageTextRecord } from "../packages/unreal-assets/dist/index.js";

const { values } = parseArgs({
	options: {
		module: { type: "string", default: "packages/game-text/src" },
		output: { type: "string" },
		lines: { type: "string", default: "238000" }
	}
});
if (!values.output) throw new Error("Provide a fresh --output directory under test-results.");
const output = resolve(values.output);
const within = relative(resolve("test-results"), output);
if (!within || within.startsWith("..") || isAbsolute(within))
	throw new Error("Output must be beneath this worktree's test-results directory.");
await mkdir(output, { recursive: false });
const moduleRoot = resolve(values.module);
const load = (file: string) => pathToFileURL(join(moduleRoot, file)).href;
const {
	SharedIndex,
	sharedIndexNodeLayer
}: typeof import("../packages/game-text/src/shared-index.js") = await import(
	load("shared-index.ts")
);
const {
	refreshJoinedTarget
}: typeof import("../packages/game-text/src/joined-target-reference.test-support.js") =
	await import(load("joined-target-reference.test-support.ts"));
const { readJoinedTarget }: typeof import("../packages/game-text/src/joined-target-reader.js") =
	await import(load("joined-target-reader.ts"));
const {
	refreshPackageTextLayer
}: typeof import("../packages/game-text/src/package-text-layer.js") = await import(
	load("package-text-layer.ts")
);
const {
	importLocalizationFile
}: typeof import("../packages/game-text/src/localization-import.js") = await import(
	load("localization-import.ts")
);
const {
	emptyPackageTextRecord
}: typeof import("../packages/game-text/src/package-text-record.js") = await import(
	load("package-text-record.ts")
);
const {
	target: template
}: typeof import("../packages/game-text/src/localization.test-support.js") = await import(
	load("localization.test-support.ts")
);
const count = Number(values.lines);
if (!Number.isSafeInteger(count) || count < 100 || count > 300000)
	throw new Error("--lines must be 100–300000.");
const projectRoot = join(output, "project");
await mkdir(projectRoot);
const cultures = ["en", "de", "fr", "es", "it", "ja", "ko", "pl", "pt", "zh"];
const target = Schema.decodeUnknownSync(LocalizationTarget)({
	...template,
	name: "Generated",
	cultures,
	outputPaths: {
		...template.outputPaths,
		manifest: "Generated.manifest",
		archives: Object.fromEntries(cultures.map((c) => [c, `${c}.archive`])),
		portableObjects: Object.fromEntries(cultures.map((c) => [c, `${c}.po`]))
	}
});
const records: SavedAssetPackageTextRecord[] = Array.from({ length: 1000 }, (_, i) =>
	emptyPackageTextRecord(join(projectRoot, `Content/Text/P${String(i).padStart(4, "0")}.uasset`))
);
const occurrences: SavedAssetPackageTextRecord["occurrences"][number][][] = records.map(() => []);
const children = [];
for (let i = 0; i < count; i++) {
	const packageRow = i % records.length;
	const key = `K${i}`;
	// Every hundredth pair shares text across identities and places; all edits can use overlays.
	const source = `Generated source text long enough for incremental overlays ${i % 100 === 1 ? i - 1 : i}`;
	const object = `/Game/Text/P${String(packageRow).padStart(4, "0")}.P${String(packageRow).padStart(4, "0")}`;
	for (let copy = 0; copy < (i % 5 === 0 ? 1 : 2); copy++)
		occurrences[packageRow]!.push({
			source,
			dev_notes: "",
			identity: { status: "resolved", namespace: "UI", key },
			location: {
				kind: "asset_property",
				object_path: object,
				class_path: "/Script/Engine.DataAsset",
				property_path: `${key}_${copy}`
			},
			edit_capability: "read_only"
		});
	children.push({ Source: { Text: source }, Keys: [{ Key: key, Path: `${object}.${key}_0` }] });
}
for (let i = 0; i < records.length; i++)
	records[i] = { ...records[i]!, occurrences: occurrences[i]! };
await writeFile(
	join(projectRoot, "Generated.manifest"),
	JSON.stringify({ FormatVersion: 1, Namespace: "UI", Children: children })
);
// Empty translation inputs isolate the joined refresh while exercising all ten culture columns.
for (const culture of cultures) {
	await writeFile(
		join(projectRoot, `${culture}.archive`),
		JSON.stringify({ FormatVersion: 2, Namespace: "UI", Children: [] })
	);
	await writeFile(join(projectRoot, `${culture}.po`), 'msgid ""\nmsgstr ""\n');
}
const cacheRoot = join(output, "cache");
for (const [format, path] of [
	["manifest", target.outputPaths.manifest!],
	...cultures.flatMap(
		(c) =>
			[
				["archive", `${c}.archive`],
				["po", `${c}.po`]
			] as const
	)
] as const)
	await Effect.runPromise(
		importLocalizationFile({
			projectRoot,
			cacheRoot,
			relativePath: path,
			format,
			sharedTargetKey: target.name,
			poFormat: target.poFormat,
			collapseMode: target.collapseMode
		})
	);
let inventory = records.map((record) => ({
	path: record.path,
	signature: "initial",
	headerData: {
		packageFlags: 0x00040000,
		gatherableTextDataCount: 1,
		gatherableTextDataOffset: 1,
		hasTextProperty: true
	}
}));
type JoinResult = Effect.Success<ReturnType<typeof refreshJoinedTarget>>;
interface Measurement {
	wallMs: number;
	maxGapMs: number;
	heapBefore: number;
	heapPeak: number;
	heapRetained: number;
	result: JoinResult;
}
const measurements: Partial<Record<"full" | "incremental", Measurement>> = {};
let signalsSha256 = "";
let fullSignalsSha256 = "";
async function measure(name: "full" | "incremental", run: () => Promise<JoinResult>) {
	globalThis.gc?.();
	let tick = performance.now();
	let maxGapMs = 0;
	let heapPeak = process.memoryUsage().heapUsed;
	const heapBefore = heapPeak;
	const sample = () => {
		const now = performance.now();
		maxGapMs = Math.max(maxGapMs, now - tick);
		tick = now;
		heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
	};
	const timer = setInterval(sample, 1);
	const started = performance.now();
	const result = await run();
	const wallMs = performance.now() - started;
	sample();
	clearInterval(timer);
	globalThis.gc?.();
	measurements[name] = {
		wallMs,
		maxGapMs,
		heapBefore,
		heapPeak,
		heapRetained: process.memoryUsage().heapUsed,
		result
	};
	console.log(name, JSON.stringify(measurements[name]));
	return result;
}
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const store = yield* SharedIndex;
			const refresh = () =>
				refreshPackageTextLayer({
					inventory,
					read: (paths) =>
						Stream.fromIterable(records.filter((r) => paths.includes(r.path)))
				});
			yield* refresh().pipe(Effect.scoped);
			yield* Effect.promise(() =>
				measure("full", () =>
					Effect.runPromise(
						Effect.scoped(
							refreshJoinedTarget({ projectRoot, target }).pipe(
								Effect.provideService(SharedIndex, store)
							)
						)
					)
				)
			);
			const first = records[0]!;
			records[0] = {
				...first,
				occurrences: first.occurrences.map((o, i) =>
					i === 0
						? {
								...o,
								source: "Edited generated source text long enough for incremental overlays"
							}
						: o
				)
			};
			inventory = inventory.map((entry, i) =>
				i === 0 ? { ...entry, signature: "edited" } : entry
			);
			yield* refresh().pipe(Effect.scoped);
			yield* Effect.promise(() =>
				measure("incremental", () =>
					Effect.runPromise(
						Effect.scoped(
							refreshJoinedTarget({ projectRoot, target }).pipe(
								Effect.provideService(SharedIndex, store)
							)
						)
					)
				)
			);
			const reader = yield* store.open();
			const joined = yield* readJoinedTarget(reader);
			const hash = createHash("sha256");
			for (const field of ["query.raw.signals", "query.slice.signals"])
				hash.update(yield* joined.layer.section(field));
			signalsSha256 = hash.digest("hex");
			yield* refreshJoinedTarget({ projectRoot, target, force: true }).pipe(Effect.scoped);
			const full = yield* readJoinedTarget(yield* store.open());
			const fullHash = createHash("sha256");
			for (const field of ["query.raw.signals", "query.slice.signals"])
				fullHash.update(yield* full.layer.section(field));
			fullSignalsSha256 = fullHash.digest("hex");
			if (signalsSha256 !== fullSignalsSha256)
				throw new Error("Incremental signals differ from a full rebuild.");
		})
	).pipe(
		Effect.provide(
			sharedIndexNodeLayer({ projectKey: projectRoot, cacheRoot, targetKey: target.name })
		)
	)
);
await writeFile(
	join(output, "result.json"),
	JSON.stringify(
		{
			node: process.version,
			moduleRoot,
			lines: count,
			occurrences: occurrences.reduce((n, rows) => n + rows.length, 0),
			cultures: cultures.length,
			sampleIntervalMs: 1,
			translationInputs: "Ten empty archives and POs; full manifest and saved occurrences.",
			heapSampling:
				"1 ms timer and end checkpoint; sampled peak is a lower bound during stalls. Explicit GC before and after each measured stage.",
			gapSampling:
				"Longest interval between event-loop timer ticks, including the end checkpoint; includes scheduling and GC.",
			...measurements,
			signalsSha256,
			fullSignalsSha256
		},
		null,
		"\t"
	) + "\n"
);
