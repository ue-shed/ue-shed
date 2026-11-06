/**
 * Package-text refresh over a generated warm index, through the native writer and the paired
 * reader's record conversion. One process runs one refresh, so revisions can be alternated.
 *
 * Prepare a warm index once (with either revision; both must share `PACKAGE_TEXT_FORMAT`):
 *   node --expose-gc --import tsx scripts/benchmark-game-text-package-refresh.ts --mode prepare
 *     --executable <uasset> --output test-results/package-refresh/template
 * Then run one change against a fresh copy of it:
 *   node --expose-gc --import tsx scripts/benchmark-game-text-package-refresh.ts --mode run
 *     --executable <uasset> --module <checkout>/packages/game-text/src
 *     --template test-results/package-refresh/template --case one|spread|shards|large [--files]
 *     --output test-results/package-refresh/<run>
 *
 * `--module` may name another checkout's `packages/game-text/src`, so a base revision runs with
 * its own packages and its own reader. Packages are generated and read through the refresh's
 * `read` stream, as `benchmark-game-text-incremental.ts` does. With `--files`, the changed text
 * packages are copies of a fixture package on disk, read or staged through the node source.
 * `large` gives one text package in every shard a distinct 256 KiB source.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
	assetReaderLayer,
	type SavedAssetPackageTextRecord
} from "../packages/unreal-assets/dist/index.js";
import { makeGameTextBenchmarkTrace } from "./game-text-benchmark-trace.ts";

const { values } = parseArgs({
	options: {
		mode: { type: "string" },
		module: { type: "string", default: "packages/game-text/src" },
		executable: { type: "string" },
		template: { type: "string" },
		case: { type: "string" },
		output: { type: "string" },
		packages: { type: "string", default: "652257" },
		label: { type: "string", default: "" },
		files: { type: "boolean", default: false }
	}
});
const mode = values.mode;
if (mode !== "prepare" && mode !== "run") throw new Error("--mode must be prepare or run.");
if (!values.executable) throw new Error("Provide --executable, the paired uasset reader.");
if (!values.output) throw new Error("Provide a fresh --output directory under test-results.");
const executable = resolve(values.executable);
const output = resolve(values.output);
const results = resolve("test-results");
const within = relative(results, output);
if (!within || within.startsWith("..") || isAbsolute(within))
	throw new Error("Output must be beneath this worktree's test-results directory.");
await mkdir(output, { recursive: false });
const moduleRoot = resolve(values.module);
const load = (file: string) => pathToFileURL(join(moduleRoot, file)).href;
const { GameTextIndexBuilder }: typeof import("../packages/game-text/src/index-builder.js") =
	await import(load("index-builder.ts"));
const {
	nativeIndexBuilderLayer
}: typeof import("../packages/game-text/src/native-index-builder.js") = await import(
	load("native-index-builder.ts")
);
const {
	SharedIndex,
	sharedIndexNodeLayer
}: typeof import("../packages/game-text/src/shared-index.js") = await import(
	load("shared-index.ts")
);
const {
	decodePackageTextColumns
}: typeof import("../packages/game-text/src/package-text-columns.js") = await import(
	load("package-text-columns.ts")
);
const progressModule: typeof import("../packages/game-text/src/index-progress.js") = await import(
	load("index-progress.ts")
);
const { GameTextIndexProgressReporter, GAME_TEXT_INDEX_PHASE_LABELS } = progressModule;
const { packageTextShard }: typeof import("../packages/game-text/src/package-text-layer.js") =
	await import(load("package-text-layer.ts"));
const { GameTextIndexSource }: typeof import("../packages/game-text/src/index-refresh.js") =
	await import(load("index-refresh.ts"));
const {
	gameTextIndexSourceNodeLayer
}: typeof import("../packages/game-text/src/index-source-node.js") = await import(
	load("index-source-node.ts")
);
const { mountPackageTextEvent }: typeof import("../packages/game-text/src/package-object-path.js") =
	await import(load("package-object-path.ts"));

// The generated project: folders of ordinary packages, one in sixteen with text. A change adds
// World Partition external actors, almost all without text, as a version control sync does.
const TEXT_EVERY = 16;
const header = (selected: boolean) => ({
	packageFlags: selected ? 0x40000 : 0,
	gatherableTextDataCount: selected ? 1 : 0,
	gatherableTextDataOffset: selected ? 1 : 0,
	hasTextProperty: selected
});
const packagePath = (id: number) =>
	`Content/Area${String(id % 97).padStart(2, "0")}/Group${String((id >> 5) % 89).padStart(2, "0")}/P${id}.uasset`;
const actorPath = (id: number) =>
	`Content/__ExternalActors__/Maps/World${id % 7}/${createHash("sha1")
		.update(String(id))
		.digest("hex")
		.slice(0, 2)
		.toUpperCase()}/A${id}.uasset`;
interface Generated {
	readonly path: string;
	readonly signature: string;
	readonly selected: boolean;
	/** Text revision: an edit changes the text, not only the signature. */
	readonly revision: number;
	readonly id: number;
}
const count = Number(values.packages);
if (!Number.isSafeInteger(count) || count < 1000) throw new Error("--packages must be >= 1000.");
const packages = new Map<string, Generated>();
for (let id = 0; id < count; id++) {
	const path = packagePath(id);
	packages.set(path, {
		path,
		signature: `s0-${id}`,
		selected: id % TEXT_EVERY === 0,
		revision: 0,
		id
	});
}
/** A flat string: `repeat` builds a rope that shares its parts and would cost no heap. */
const largeSource = (entry: Generated) => {
	const prefix = `Large text ${entry.id} `;
	return (
		prefix + Buffer.alloc(256 * 1024 - prefix.length, 0x61 + (entry.id % 26)).toString("latin1")
	);
};
const record = (entry: Generated): SavedAssetPackageTextRecord => {
	const name = `P${entry.id}`;
	const object = `/Game/Generated/${name}.${name}`;
	return {
		event: "text_package_record",
		path: entry.path,
		fileBytes: 4096 + entry.id,
		schema_version: 1,
		status: "complete",
		decodeErrors: 0,
		occurrences: Array.from(
			{ length: entry.revision === 2 ? 1 : 1 + (entry.id % 3) },
			(_, slot) => ({
				source:
					entry.revision === 2
						? largeSource(entry)
						: `Generated text ${entry.id % 5000} slot ${slot} revision ${entry.revision}`,
				dev_notes: "",
				identity: {
					status: "resolved",
					namespace: "Generated",
					key: `K${entry.id}-${slot}`
				},
				location: {
					kind: "asset_property",
					object_path: `${object}.Widget${slot}`,
					class_path: "/Script/UMG.TextBlock",
					property_path: "Text"
				},
				edit_capability: "read_only"
			})
		),
		gapCounts: {
			unsupported_text_history: 0,
			legacy_container_element_without_type_information: 0,
			feature_unavailable_for_engine_version: 0,
			property_decoder_rejected: 0
		},
		gapSamples: []
	};
};

const change = values.case;
const changed: string[] = [];
if (mode === "run") {
	if (change === "one") {
		const entry = packages.get(packagePath(TEXT_EVERY * 1234))!;
		packages.set(entry.path, { ...entry, signature: `s1-${entry.id}`, revision: 1 });
		changed.push(entry.path);
	} else if (change === "spread") {
		// 1,000 text packages spread evenly over the id space, so over every folder and shard.
		const step = Math.floor(count / TEXT_EVERY / 1000) * TEXT_EVERY;
		for (let n = 0; n < 1000; n++) {
			const entry = packages.get(packagePath(n * step))!;
			packages.set(entry.path, { ...entry, signature: `s1-${entry.id}`, revision: 1 });
			changed.push(entry.path);
		}
	} else if (change === "shards") {
		// The measured sync: 55k added packages, about 99% external actors without text.
		for (let n = 0; n < 55_000; n++) {
			const id = count + n;
			const selected = n % 252 === 0 && n / 252 < 218;
			const path = actorPath(id);
			packages.set(path, { path, signature: `s0-${id}`, selected, revision: 0, id });
			changed.push(path);
		}
	} else if (change === "large") {
		// The first text package of every shard gets a distinct 256 KiB source: 64 MiB of text.
		const seen = new Set<number>();
		for (const entry of packages.values()) {
			const shard = packageTextShard(entry.path);
			if (!entry.selected || seen.has(shard)) continue;
			seen.add(shard);
			packages.set(entry.path, { ...entry, signature: `s2-${entry.id}`, revision: 2 });
			changed.push(entry.path);
		}
	} else throw new Error("--case must be one, spread, shards or large.");
}
/** Fixture copies on disk, with the signatures and headers the node source reports. */
const files = new Map<
	string,
	import("../packages/game-text/src/package-text-layer.js").PackageTextInventoryEntry
>();
const cacheRoot = join(output, "cache");
const projectRoot = join(output, "project");
const configuration = { cacheRoot, projectKey: "generated-package-refresh", targetKey: "text" };
if (mode === "run") {
	if (!values.template) throw new Error("Provide --template, a prepared output directory.");
	await cp(join(resolve(values.template), "cache"), cacheRoot, { recursive: true });
}
await mkdir(projectRoot, { recursive: true });

// Retained heap after a forced collection, before the refresh and when its read stream ends.
const retainedHeap = () => {
	globalThis.gc?.();
	return process.memoryUsage().heapUsed;
};
const heapAtReadEnd: number[] = [];
const atReadEnd = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
	stream.pipe(Stream.onEnd(Effect.sync(() => heapAtReadEnd.push(retainedHeap()))));
type RefreshInput =
	import("../packages/game-text/src/package-text-layer.js").PackageTextRefreshInput<
		unknown,
		never
	>;
let readCount = 0;
let stageCount = 0;
let read: RefreshInput["read"] = (paths) => {
	readCount += paths.length;
	return atReadEnd(
		Stream.fromIterable(paths, { chunkSize: 1 }).pipe(
			Stream.map((path) => record(packages.get(path)!))
		)
	);
};
let stage: RefreshInput["stage"];
let disposeSource = async () => {};
if (values.files && mode === "run") {
	// The changed text packages become copies of one fixture package, with their real signatures.
	const fixture = resolve("fixtures/unreal-project");
	await copyFile(
		join(fixture, "UEShedFixture.uproject"),
		join(projectRoot, "UEShedFixture.uproject")
	);
	await cp(join(fixture, "Config"), join(projectRoot, "Config"), { recursive: true });
	const textPackage = join(fixture, "Content/Fixture/GameTextProblems/DT_FixtureItems.uasset");
	for (const path of changed.filter((path) => packages.get(path)!.selected)) {
		await mkdir(dirname(join(projectRoot, path)), { recursive: true });
		await copyFile(textPackage, join(projectRoot, path));
	}
	const sourceLayer = gameTextIndexSourceNodeLayer(join(output, "catalog")).pipe(
		Layer.provideMerge(assetReaderLayer({ executable }))
	);
	// The source's reader stays up for the refresh and is released at the end.
	const runtime = ManagedRuntime.make(sourceLayer);
	disposeSource = () => runtime.dispose();
	const source = await runtime.runPromise(Effect.service(GameTextIndexSource));
	const real = await runtime.runPromise(source.inventory({ projectRoot }));
	for (const entry of real) {
		const generated = packages.get(entry.path);
		if (!generated?.selected) throw new Error(`Unexpected fixture package ${entry.path}.`);
		files.set(entry.path, entry);
	}
	read = (paths) => {
		readCount += paths.length;
		return atReadEnd(
			source
				.read(
					projectRoot,
					paths.map((path) => files.get(path)!)
				)
				.pipe(Stream.map((event) => mountPackageTextEvent(projectRoot, event)))
		);
	};
	stage = {
		projectRoot,
		read: (paths, directory, groups, snapshots) =>
			atReadEnd(
				source.stage!(
					projectRoot,
					paths.map((path) => files.get(path)!),
					{ directory, groups, snapshots }
				).pipe(Stream.tap(() => Effect.sync(() => stageCount++)))
			)
	};
}
const inventory = [...packages.values()]
	.map((entry) => ({ entry, key: Buffer.from(entry.path) }))
	.sort((a, b) => Buffer.compare(a.key, b.key))
	.map(
		({ entry }) =>
			files.get(entry.path) ?? {
				path: entry.path,
				signature: entry.signature,
				headerData: header(entry.selected)
			}
	);

/** Each descendant process's peak working set, sampled while the refresh runs. */
const nativePeaks = new Map<number, { name: string; peak: number }>();
const sampleDescendants = async () => {
	const { stdout } = await promisify(execFile)(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$all = @(Get-CimInstance Win32_Process); $owned = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add(${process.pid}); ` +
				`do { $added = $false; foreach ($p in $all) { if ($owned.Contains($p.ParentProcessId) -and $owned.Add($p.ProcessId)) { $added = $true } } } while ($added); ` +
				`foreach ($p in $all) { if ($owned.Contains($p.ProcessId) -and $p.ProcessId -ne ${process.pid}) { "$($p.ProcessId) $($p.Name) $($p.PeakWorkingSetSize)" } }`
		],
		{ windowsHide: true, timeout: 10_000 }
	);
	for (const line of stdout.trim().split(/\r?\n/u)) {
		const [pid, name, peakKiB] = line.trim().split(/\s+/u);
		if (!pid || !name || !peakKiB || name.toLowerCase().startsWith("powershell")) continue;
		// Win32_Process reports PeakWorkingSetSize in KiB.
		const peak = Number(peakKiB) * 1024;
		const prior = nativePeaks.get(Number(pid));
		if (!prior || prior.peak < peak) nativePeaks.set(Number(pid), { name, peak });
	}
};

const trace = makeGameTextBenchmarkTrace();
interface ProgressEvent {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
	readonly unchanged?: number;
}
const progress: ProgressEvent[] = [];
const reportProgress = (event: ProgressEvent) => {
	const last = progress.at(-1);
	// Keep each phase's first and latest event.
	if (last && last.phase === event.phase && progress.at(-2)?.phase === event.phase)
		progress[progress.length - 1] = { ...event };
	else progress.push({ ...event });
};
const builderLayer = nativeIndexBuilderLayer({
	executable,
	timeoutMs: 3_600_000,
	catalogTimeoutMs: 3_600_000
});

const heapBefore = retainedHeap();
let heapPeak = 0;
let rssPeak = 0;
const sampleMemory = () => {
	const usage = process.memoryUsage();
	heapPeak = Math.max(heapPeak, usage.heapUsed);
	rssPeak = Math.max(rssPeak, usage.rss);
};
sampleMemory();
const memoryTimer = setInterval(sampleMemory, 50);
let sampling = Promise.resolve();
const nativeTimer = setInterval(() => {
	sampling = sampling.then(sampleDescendants).catch(() => undefined);
}, 1000);
const started = performance.now();
const refreshed = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const builder = yield* GameTextIndexBuilder;
			return yield* builder.withSession(
				{ configuration },
				Effect.gen(function* () {
					const result = yield* Effect.scoped(
						builder.refreshPackageTextLayer({
							inventory,
							read,
							...(stage ? { stage } : undefined)
						})
					);
					// The writer process is still leased: take its peak before it is released.
					yield* Effect.promise(() =>
						sampling.then(sampleDescendants).catch(() => undefined)
					);
					return result;
				})
			);
		})
	).pipe(
		Effect.provideService(GameTextIndexProgressReporter, reportProgress),
		Effect.withTracer(trace.tracer),
		Effect.provide(Layer.mergeAll(builderLayer, sharedIndexNodeLayer(configuration)))
	)
);
const wallMs = performance.now() - started;
clearInterval(memoryTimer);
clearInterval(nativeTimer);
await sampling;
sampleMemory();
const spans = trace.drain();

// Index content: every package shard's key and decoded records, in shard and path order.
const content = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const reader = yield* (yield* SharedIndex).open();
			const names = Object.keys(reader.manifest.active)
				.filter((name) => name.startsWith("package-text."))
				.sort((a, b) => Number(a.slice(13)) - Number(b.slice(13)));
			const hash = createHash("sha256");
			let records = 0;
			let withText = 0;
			for (const name of names) {
				hash.update(`${name}=${reader.manifest.active[name]}\n`);
				const rows = yield* decodePackageTextColumns(yield* reader.layer(name));
				for (const row of rows) {
					records++;
					if (row.evidence.event !== "not_gatherable") withText++;
					hash.update(JSON.stringify(row));
					hash.update("\n");
				}
			}
			return { shards: names.length, records, withText, sha256: hash.digest("hex") };
		})
	).pipe(Effect.provide(sharedIndexNodeLayer(configuration)))
);

const sum = (name: string) => {
	const matching = spans.filter((span) => span.name === name);
	return {
		count: matching.length,
		ms: Math.round(matching.reduce((total, span) => total + span.elapsedMs, 0))
	};
};
const refreshSpan = spans.find((span) => span.name === "PackageText.refresh");
const labels: Readonly<Record<string, string>> = GAME_TEXT_INDEX_PHASE_LABELS;
const shown = progress.map((event) => {
	const counts =
		event.total > 0
			? ` · ${event.completed.toLocaleString("en-US")} / ${event.total.toLocaleString("en-US")}`
			: "";
	const unchanged =
		event.unchanged === undefined
			? ""
			: ` · ${event.unchanged.toLocaleString("en-US")} unchanged`;
	return `${labels[event.phase] ?? event.phase}${counts}${unchanged}`;
});
const nativeRows = [...nativePeaks.values()].sort((a, b) => b.peak - a.peak);
const summary = {
	label: values.label,
	mode,
	case: change ?? "prepare",
	node: process.version,
	moduleRoot,
	executable,
	packages: inventory.length,
	changedFiles: changed.length,
	wallMs: Math.round(wallMs),
	result: { ...refreshed, profile: undefined },
	readsRequested: readCount,
	files: values.files,
	packagesStaged: stageCount,
	spanAttributes: refreshSpan?.attributes ?? {},
	spans: Object.fromEntries(
		[
			"PackageText.refresh",
			"PackageText.selection",
			"PackageText.planHere",
			"PackageText.planEntries",
			"PackageText.compare",
			"PackageText.replaceRecords",
			"PackageText.convertChanges",
			"PackageText.convertSpooled",
			"PackageText.spoolReads",
			"PackageText.stagePlanned",
			"PackageText.refreshShards",
			"PackageText.rebuildShards",
			"PackageText.decodeColumns",
			"PackageText.nativeColumns",
			"PackageText.importCold",
			"NativeIndexBuilder.comparePackages",
			"NativeIndexBuilder.replacePackages",
			"NativeIndexBuilder.publish",
			"NativeIndexBuilder.publishCold",
			"NativeIndexBuilder.publishColdFiles"
		].map((name) => [name, sum(name)])
	),
	nativeStageSeconds: spans
		.filter((span) => span.native && span.name === "NativeIndexBuilder.execute")
		.map((span) => ({ action: span.native!.action, stageSeconds: span.native!.stageSeconds })),
	memory: {
		nodeHeapPeakMiB: Math.round(heapPeak / 2 ** 20),
		nodeRssPeakMiB: Math.round(rssPeak / 2 ** 20),
		nodeHeapBeforeMiB: Math.round(heapBefore / 2 ** 20),
		// Retained heap when the read ends, after a forced collection: what the read holds.
		nodeHeapAtReadEndMiB: heapAtReadEnd.map((bytes) => Math.round(bytes / 2 ** 20)),
		nativePeakMiB: Math.round((nativeRows[0]?.peak ?? 0) / 2 ** 20),
		nativeProcesses: nativeRows.length,
		sampling: "Node every 50 ms; native descendants' peak working set every 1 s and at the end."
	},
	progress,
	shown,
	content
};
await writeFile(join(output, "result.json"), JSON.stringify(summary, null, "\t") + "\n");
await writeFile(join(output, "spans.json"), JSON.stringify(spans) + "\n");
console.log(JSON.stringify({ ...summary, progress: undefined, nativeStageSeconds: undefined }));
await disposeSource();
if (mode === "run") await rm(cacheRoot, { recursive: true, force: true });
